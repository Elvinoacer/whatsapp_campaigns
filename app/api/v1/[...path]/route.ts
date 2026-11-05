import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { operations, campaigns, command, removeSchedule, scheduleCampaign, redisConnection } from "@/lib/queue";
import {
  campaignInput,
  contactInput,
  estimatedDurationMs,
  isEligible,
  scheduleIssue,
  schedulePreview,
  segmentInput,
  sessionInput,
  templateInput,
} from "@/lib/campaign";
import { HttpError, ok, payload, rejectCrossOrigin, requireUser, respondError } from "@/lib/http";
import { resolveAudience, resolveRecipients, getCampaignAudience, explainAudienceBlocker } from "@/lib/audience";
import { z } from "zod";
import { campaignLimit, configuration } from "@/lib/config";
import { groupSyncStateKey, syncStateKey, type SyncState } from "@/lib/sync-state";
import { contactFilterInput, contactWhere } from "@/lib/contact-selection";
import { bulkSegmentInput, exportGroupsToSegments, groupExportInput, organizeContacts } from "@/lib/segments";
import { bulkConsentInput, recordBulkOptIn } from "@/lib/consent";
import { deliveryTotals } from "@/lib/reporting";
import {
  campaignDeliverySummaries,
  runDeliverySummaries,
  recordedOptOutsForRuns,
  workspaceReportSummary,
} from "@/lib/reporting-data";
import {
  accountKey,
  activeSendingHold,
  closeDeferredRuns,
  getSendingPolicy,
  holdSending,
  reviewSendingHold,
  sendingSafetySummary,
  updateSendingSettings,
  WORKSPACE_HOLD,
} from "@/lib/sending-safety";
import { DAY, HOUR, minimumCampaignDuration, sendingSettingsInput } from "@/lib/sending-policy";
import { campaignMessage, publicSenderName } from "@/lib/message";
import { formatContactCsv } from "@/lib/csv";

type Params = { params: Promise<{ path: string[] }> };
const notFound = () => new HttpError(404, "Resource not found");

const STARTER_TEMPLATES = [
  {
    name: "Group Hourly / Interval Update",
    category: "Groups",
    audienceMode: "GROUPS",
    body: "📢 *Update for {{group_name}}* ({{date}})\n\nHere is our latest announcement for everyone in the group. Reply directly in the chat if you have any questions!",
    includeFooter: false,
  },
  {
    name: "Personal Direct Outreach",
    category: "Outreach",
    audienceMode: "CONTACTS",
    body: "Hi {{first_name}},\n\nQuick update for you today — let us know if you would like more details or assistance!",
    includeFooter: false,
  },
  {
    name: "Promo & Event Invite",
    category: "Promotions",
    audienceMode: "ALL",
    body: "✨ *Special Highlight — {{date}}*\n\nHello {{first_name}}, we have an upcoming session and exclusive offer open now. Reply *YES* to reserve your spot.",
    includeFooter: true,
  },
];

async function ensureStarterTemplates() {
  if (await db.auditLog.findFirst({ where: { action: "templates.seeded_v1" }, select: { id: true } })) return;
  const existing = await db.messageTemplate.count();
  if (existing === 0) {
    await db.messageTemplate.createMany({ data: STARTER_TEMPLATES, skipDuplicates: true });
  }
  await db.auditLog.create({ data: { action: "templates.seeded_v1", details: { seeded: existing === 0 ? STARTER_TEMPLATES.length : 0 } } });
}

async function requireWorker(delivery = false) {
  if (!(await (delivery ? campaigns : operations).getWorkers()).length) {
    throw new HttpError(503, "Background worker is offline. Start npm run dev:all or npm run worker.");
  }
}

async function hasOnlineWorker(delivery = false) {
  try {
    return (await (delivery ? campaigns : operations).getWorkers()).length > 0;
  } catch {
    return false;
  }
}

async function audit(action: string, details?: object) {
  await db.auditLog.create({ data: { action, details: details ?? {} } });
}

async function checkSendingAccount(sessionId: string, autoClearReady = false) {
  const session = await db.waSession.findUniqueOrThrow({ where: { id: sessionId } });
  const hold = await activeSendingHold(accountKey(session), sessionId);
  if (hold) {
    const now = new Date();
    if (autoClearReady && hold.accountKey !== WORKSPACE_HOLD && (!hold.notBefore || hold.notBefore <= now)) {
      await reviewSendingHold(hold.accountKey, "Automatically cleared when administrator started or resumed campaign", now, false);
      return;
    }
    throw new HttpError(423, "Campaign sending is on hold: " + hold.reason + " Clear the hold in Settings or the Campaigns banner.");
  }
}

function parseContactFilterFromUrl(url: URL) {
  const groupIdsParam = url.searchParams.get("groupIds");
  const raw = Object.fromEntries(
    [...url.searchParams.entries()]
      .filter(([key]) =>
        [
          "search",
          "sessionId",
          "groupId",
          "segmentId",
          "consent",
          "status",
          "source",
          "unsegmented",
          "phoneAvailability",
          "destinationAvailability",
        ].includes(key),
      )
      .map(([key, value]) => [key, key === "unsegmented" ? value === "true" : value]),
  );
  return contactFilterInput.parse({
    ...raw,
    ...(groupIdsParam ? { groupIds: groupIdsParam.split(",").map(s => s.trim()).filter(Boolean) } : {}),
  });
}

async function route(req: NextRequest, p: Params) {
  await requireUser(req);
  rejectCrossOrigin(req);
  const path = (await p.params).path;
  if (path.length > 3) throw notFound();
  const [resource, id, operation] = path;
  if (["overview", "runs", "audit", "health"].includes(resource) && id) throw notFound();
  const method = req.method;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") || undefined;

  if (resource === "safety") {
    if (method === "GET" && !id) return ok(await sendingSafetySummary(new Date(), sessionId));
    if (method === "PATCH" && !id) {
      const input = sendingSettingsInput.parse(await payload(req));
      await updateSendingSettings(input);
      return ok(await sendingSafetySummary(new Date(), sessionId));
    }
    if (method === "POST" && id === "hold") {
      const input = z.object({
        sessionId: z.string().min(1).optional(),
        reason: z.string().trim().min(3).max(400),
        restriction: z.boolean().default(false),
      }).parse(await payload(req));
      const key = input.sessionId
        ? accountKey(await db.waSession.findUniqueOrThrow({ where: { id: input.sessionId } }))
        : WORKSPACE_HOLD;
      const count = await holdSending(key, input.reason, input.restriction ? new Date(Date.now() + DAY) : null);
      return ok({ pausedCampaigns: count });
    }
    if (method === "POST" && id === "review") {
      const input = z.object({
        accountKey: z.string().min(1),
        confirmed: z.boolean().default(true),
        note: z.string().trim().max(500).default("Cleared from workspace"),
        force: z.boolean().default(false),
      }).refine(val => val.confirmed === true, { message: "Confirm hold review to proceed", path: ["confirmed"] }).parse(await payload(req));
      try {
        await reviewSendingHold(input.accountKey, input.note || "Cleared from workspace", new Date(), input.force);
      } catch (error) {
        throw new HttpError(423, error instanceof Error ? error.message : "Sending review failed");
      }
      return ok({
        reviewed: true,
        message: "Sending hold cleared. You can now launch or resume your campaigns.",
      });
    }
    throw notFound();
  }

  if (resource === "templates") {
    if (method === "GET" && !id) {
      await ensureStarterTemplates();
      const items = await db.messageTemplate.findMany({
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        include: { _count: { select: { campaigns: true } } },
      });
      return ok(items);
    }
    if (method === "POST" && !id) {
      const input = templateInput.parse(await payload(req));
      if (input.mediaKey) {
        try { await access(join(process.cwd(), ".uploads", input.mediaKey)); }
        catch { throw new HttpError(400, "Attachment missing; upload it again"); }
      }
      if (await db.messageTemplate.findUnique({ where: { name: input.name } })) {
        throw new HttpError(409, "A template with this name already exists");
      }
      const created = await db.messageTemplate.create({
        data: {
          name: input.name,
          category: input.category,
          audienceMode: input.audienceMode,
          body: input.body,
          includeFooter: input.includeFooter,
          mediaKey: input.mediaKey || null,
          mediaMime: input.mediaMime || null,
          mediaName: input.mediaName || null,
        },
      });
      await audit("template.created", { id: created.id, name: created.name });
      return ok(created, 201);
    }
    if (!id || !(await db.messageTemplate.findUnique({ where: { id } }))) throw notFound();
    if (method === "PATCH" && !operation) {
      const input = templateInput.parse(await payload(req));
      if (input.mediaKey) {
        try { await access(join(process.cwd(), ".uploads", input.mediaKey)); }
        catch { throw new HttpError(400, "Attachment missing; upload it again"); }
      }
      const duplicate = await db.messageTemplate.findFirst({ where: { name: input.name, id: { not: id } } });
      if (duplicate) throw new HttpError(409, "Another template already uses this name");
      const updated = await db.messageTemplate.update({
        where: { id },
        data: {
          name: input.name,
          category: input.category,
          audienceMode: input.audienceMode,
          body: input.body,
          includeFooter: input.includeFooter,
          mediaKey: input.mediaKey || null,
          mediaMime: input.mediaMime || null,
          mediaName: input.mediaName || null,
        },
      });
      await audit("template.updated", { id: updated.id, name: updated.name });
      return ok(updated);
    }
    if (method === "DELETE" && !operation) {
      await db.messageTemplate.delete({ where: { id } });
      await audit("template.deleted", { id });
      return ok({ success: true });
    }
    throw notFound();
  }

  if (resource === "media" && method === "POST" && !id) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > 8 * 1024 * 1024) {
      throw new HttpError(400, "Choose a file up to 8 MB");
    }
    const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
    const ext = extensions[file.type];
    if (!ext) throw new HttpError(400, "Only JPEG, PNG, WebP and PDF attachments are supported");
    const bytes = Buffer.from(await file.arrayBuffer());
    const valid = ext === "jpg"
      ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : ext === "png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === "webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
          : bytes.toString("ascii", 0, 5) === "%PDF-";
    if (!valid) throw new HttpError(400, "File contents do not match the claimed file type");
    const mediaKey = randomUUID() + "." + ext;
    const dirname = join(process.cwd(), ".uploads");
    await mkdir(dirname, { recursive: true });
    await writeFile(join(dirname, mediaKey), bytes, { flag: "wx", mode: 0o600 });
    return ok({ mediaKey, mediaMime: file.type, mediaName: file.name.replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 140) }, 201);
  }

  if (method === "GET" && resource === "overview") {
    const [sessions, contacts, groups, segments, templates, campaignsCount, runs, metrics, latest] = await Promise.all([
      db.waSession.count(),
      db.contact.count(),
      db.waGroup.count(),
      db.segment.count(),
      db.messageTemplate.count(),
      db.campaign.count(),
      db.campaignRun.count(),
      workspaceReportSummary(),
      db.campaignRun.findMany({
        take: 8,
        orderBy: { startedAt: "desc" },
        include: {
          campaign: { select: { id: true, name: true, audienceType: true, scheduleType: true, intervalHours: true } },
          deliveries: {
            select: {
              id: true,
              status: true,
              error: true,
              replies: { where: { isOptOut: true }, select: { isOptOut: true } },
              _count: { select: { replies: true } },
            },
          },
        },
      }),
    ]);
    const optOuts = await recordedOptOutsForRuns(latest.map(run => run.id));
    return ok({
      sessions,
      contacts,
      uniquePeople: metrics.uniquePeople,
      optedIn: metrics.activePeople,
      optedOut: metrics.directoryOptedOut,
      groups,
      segments,
      templates,
      campaigns: campaignsCount,
      runs,
      metrics,
      latest: latest.map(run => ({
        ...run,
        deliveries: run.deliveries.map(d => ({ ...d, optedOutAt: optOuts.get(d.id) ?? null })),
      })),
    });
  }

  if (resource === "sessions") {
    if (method === "GET" && !id) {
      const sessions = await db.waSession.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { contacts: true, groups: true } } },
      });
      const holds = await db.sendingHold.findMany({ where: { releasedAt: null } });
      const withSafety = sessions.map(session => ({
        ...session,
        accountKey: accountKey(session),
        sendingHold: holds.find(hold => [WORKSPACE_HOLD, accountKey(session), "session:" + session.id].includes(hold.accountKey)) || null,
      }));
      const redis = redisConnection();
      try {
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        const states = sessions.length ? await redis.mget(...sessions.map(session => syncStateKey(queue, session.id))) : [];
        return ok(withSafety.map((session, index) => ({ ...session, sync: states[index] ? (JSON.parse(states[index]!) as SyncState) : null })));
      } catch {
        return ok(withSafety.map(session => ({ ...session, sync: null })));
      } finally {
        redis.disconnect();
      }
    }
    if (method === "POST" && !id) {
      const input = sessionInput.parse(await payload(req));
      const session = await db.waSession.create({ data: { label: input.label, publicSenderName: input.publicSenderName || null } });
      await audit("session.created", { sessionId: session.id });
      return ok(session, 201);
    }
    if (!id || !(await db.waSession.findUnique({ where: { id } }))) throw notFound();
    if (method === "PATCH" && !operation) {
      const input = sessionInput.parse(await payload(req));
      const previous = await db.waSession.findUniqueOrThrow({ where: { id } });
      const updated = await db.waSession.update({
        where: { id },
        data: { label: input.label, publicSenderName: input.publicSenderName || null },
      });
      await audit("session.settings_updated", {
        sessionId: id,
        previousLabel: previous.label,
        label: updated.label,
        senderIdentityChanged: previous.publicSenderName !== updated.publicSenderName,
      });
      return ok(updated);
    }
    if (operation === "reconcile-history" && ["GET", "POST"].includes(method)) {
      const redis = redisConnection();
      const key = "history:status:" + id;
      try {
        if (method === "GET") {
          const state = await redis.get(key);
          return ok(state ? (JSON.parse(state) as object) : { phase: "IDLE" });
        }
        const session = await db.waSession.findUniqueOrThrow({ where: { id } });
        if (session.status !== "CONNECTED") {
          throw new HttpError(409, "Connect this WhatsApp account before checking its saved message history.");
        }
        await requireWorker();
        if ((await redis.set(key + ":queued", "1", "EX", 900, "NX")) !== "OK") {
          return ok({ queued: true, message: "Reconciliation is already queued or running for this account." }, 202);
        }
        await redis.set(
          key,
          JSON.stringify({ phase: "QUEUED", message: "Reconciliation queued. No messages will be sent.", updatedAt: new Date().toISOString() }),
          "EX",
          86400,
        );
        try {
          await command("reconcile-history", { sessionId: id });
        } catch (error) {
          await redis.del(key, key + ":queued");
          throw error;
        }
        return ok({ queued: true, message: "Read-only WhatsApp history reconciliation queued." }, 202);
      } finally {
        redis.disconnect();
      }
    }
    if (method === "GET" && operation === "qr") {
      const redis = redisConnection();
      try {
        return ok({ qr: await redis.get("qr:" + id) });
      } finally {
        await redis.quit();
      }
    }
    if (method === "POST" && ["connect", "disconnect", "sync"].includes(operation)) {
      await requireWorker();
      if (operation === "sync") {
        if ((await db.waSession.findUnique({ where: { id } }))?.status !== "CONNECTED") {
          throw new HttpError(409, "Wait for the WhatsApp account to connect before syncing.");
        }
        const redis = redisConnection();
        const key = syncStateKey(process.env.QUEUE_NAME || "campaign-operations", id);
        try {
          const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
          if (!locked) return ok({ queued: true }, 202);
          await redis.set(
            key,
            JSON.stringify({ phase: "QUEUED", kind: "directory", message: "Contact and group sync queued…", updatedAt: new Date().toISOString() } satisfies SyncState),
            "EX",
            86400,
          );
          try {
            await command("sync", { sessionId: id });
          } catch (error) {
            await redis.del(key, key + ":queued");
            throw error;
          }
        } finally {
          redis.disconnect();
        }
      } else {
        await command(operation, { sessionId: id });
      }
      return ok({ queued: true }, 202);
    }
  }

  if (resource === "contacts") {
    if (method === "GET" && id === "export" && !operation) {
      const filter = parseContactFilterFromUrl(url);
      const rows = await db.contact.findMany({
        where: contactWhere(filter),
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 50000,
        include: {
          session: { select: { label: true } },
          segments: { include: { segment: { select: { name: true } } } },
          members: { include: { group: { select: { name: true } } } },
        },
      });
      const byWa = new Map<string, {
        phone: string | null;
        name: string | null;
        whatsappId: string;
        consent: string;
        segments: Set<string>;
        groups: Set<string>;
        sessions: Set<string>;
      }>();
      for (const row of rows) {
        const existing = byWa.get(row.whatsappId);
        if (!existing) {
          byWa.set(row.whatsappId, {
            phone: row.phone,
            name: row.name,
            whatsappId: row.whatsappId,
            consent: row.consent,
            segments: new Set(row.segments.map(s => s.segment.name)),
            groups: new Set(row.members.map(m => m.group.name)),
            sessions: new Set([row.session.label]),
          });
        } else {
          if (!existing.phone && row.phone) existing.phone = row.phone;
          if (!existing.name && row.name) existing.name = row.name;
          if (row.consent === "OPTED_OUT") existing.consent = "OPTED_OUT";
          for (const s of row.segments) existing.segments.add(s.segment.name);
          for (const m of row.members) existing.groups.add(m.group.name);
          existing.sessions.add(row.session.label);
        }
      }
      const csv = formatContactCsv(
        [...byWa.values()].map(item => ({
          ...item,
          segments: [...item.segments],
          groups: [...item.groups],
          sessions: [...item.sessions],
        })),
      );
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="phonebook-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    if (method === "GET" && !id) {
      const page = z.coerce.number().int().min(1).max(1000000).parse(url.searchParams.get("page") ?? 1);
      const take = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get("take") ?? 40);
      const deduplicate = url.searchParams.get("deduplicate") === "true";
      const filter = parseContactFilterFromUrl(url);
      const where = contactWhere(filter);
      if (url.searchParams.get("eligible") === "true") {
        const suppressed = await db.contact.findMany({
          where: { consent: "OPTED_OUT" },
          select: { whatsappId: true },
          distinct: ["whatsappId"],
        });
        where.consent = { not: "OPTED_OUT" };
        const valid = await db.$queryRaw<{ whatsappId: string }[]>`
          SELECT DISTINCT "whatsappId" FROM "Contact"
          WHERE "whatsappId" ~ '^([0-9]{8,15}@c[.]us|[0-9]{1,30}@lid)$'
        `;
        where.AND = [
          { whatsappId: { in: valid.map(c => c.whatsappId) } },
          { NOT: { whatsappId: { in: suppressed.map(c => c.whatsappId) } } },
        ];
      }

      if (deduplicate) {
        const allMatching = await db.contact.findMany({
          where,
          orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          include: {
            session: { select: { id: true, label: true } },
            segments: { include: { segment: { select: { id: true, name: true } } } },
            members: { include: { group: { select: { id: true, name: true } } } },
          },
        });
        const suppressedGlobal = new Set(
          (await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] }))
            .map(item => item.whatsappId),
        );
        const grouped = new Map<string, {
          id: string;
          contactIds: string[];
          sessionId: string;
          whatsappId: string;
          phone: string | null;
          name: string | null;
          isMyContact: boolean;
          consent: "OPTED_IN" | "OPTED_OUT" | "UNKNOWN";
          session: { label: string };
          sessions: { id: string; label: string }[];
          segments: { segment: { id: string; name: string } }[];
          groups: { id: string; name: string }[];
          _count: { members: number };
        }>();
        for (const item of allMatching) {
          const current = grouped.get(item.whatsappId);
          const effectiveConsent = suppressedGlobal.has(item.whatsappId) || item.consent === "OPTED_OUT" ? "OPTED_OUT" : "OPTED_IN";
          if (!current) {
            grouped.set(item.whatsappId, {
              id: item.id,
              contactIds: [item.id],
              sessionId: item.sessionId,
              whatsappId: item.whatsappId,
              phone: item.phone,
              name: item.name,
              isMyContact: item.isMyContact,
              consent: effectiveConsent,
              session: { label: item.session.label },
              sessions: [{ id: item.session.id, label: item.session.label }],
              segments: item.segments.map(s => ({ segment: s.segment })),
              groups: item.members.map(m => m.group),
              _count: { members: item.members.length },
            });
          } else {
            current.contactIds.push(item.id);
            if (!current.phone && item.phone) current.phone = item.phone;
            if (!current.name && item.name) current.name = item.name;
            if (item.isMyContact) current.isMyContact = true;
            if (effectiveConsent === "OPTED_OUT") current.consent = "OPTED_OUT";
            if (!current.sessions.some(s => s.id === item.session.id)) {
              current.sessions.push({ id: item.session.id, label: item.session.label });
            }
            for (const s of item.segments) {
              if (!current.segments.some(existing => existing.segment.id === s.segment.id)) {
                current.segments.push({ segment: s.segment });
              }
            }
            for (const m of item.members) {
              if (!current.groups.some(existing => existing.id === m.group.id)) {
                current.groups.push(m.group);
              }
            }
            current._count.members = current.groups.length;
          }
        }
        const merged = [...grouped.values()];
        const start = (page - 1) * take;
        return ok({
          items: merged.slice(start, start + take),
          total: merged.length,
          rawTotal: allMatching.length,
          page,
          take,
          deduplicated: true,
        });
      }

      const [items, total] = await Promise.all([
        db.contact.findMany({
          where,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          skip: (page - 1) * take,
          take,
          include: {
            session: { select: { id: true, label: true } },
            segments: { include: { segment: { select: { id: true, name: true } } } },
            members: { take: 6, include: { group: { select: { id: true, name: true } } } },
            _count: { select: { members: true } },
          },
        }),
        db.contact.count({ where }),
      ]);
      return ok({
        items: items.map(item => ({
          ...item,
          contactIds: [item.id],
          sessions: [{ id: item.session.id, label: item.session.label }],
          groups: item.members.map(m => m.group),
        })),
        total,
        page,
        take,
      });
    }

    if (method === "POST" && id === "consent" && !operation) {
      return ok(await recordBulkOptIn(bulkConsentInput.parse(await payload(req))));
    }
    if (method === "POST" && !id) {
      const input = z.object({
        sessionId: z.string(),
        phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
        name: z.string().trim().max(150).optional(),
        segmentIds: z.array(z.string().min(1)).max(100).default([]),
      }).parse(await payload(req));
      if (!(await db.waSession.findUnique({ where: { id: input.sessionId } }))) throw notFound();
      const phone = input.phone.replace(/^\+/, "");
      const whatsappId = phone + "@c.us";
      const optedOut = await db.contact.count({ where: { whatsappId, consent: "OPTED_OUT" } });
      const contact = await db.contact.upsert({
        where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId } },
        create: {
          sessionId: input.sessionId,
          whatsappId,
          phone,
          name: input.name,
          consent: optedOut ? "OPTED_OUT" : "OPTED_IN",
          consentAt: optedOut ? null : new Date(),
          consentNote: optedOut ? "Preserved global opt-out" : "Added to phonebook",
        },
        update: { name: input.name || undefined },
      });
      if (input.segmentIds.length) {
        await db.segmentMember.createMany({
          data: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId, contactId: contact.id })),
          skipDuplicates: true,
        });
      }
      return ok(contact, 201);
    }
    if (method === "PATCH" && id && !operation) {
      const input = contactInput.parse(await payload(req));
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
        const old = await tx.contact.findUnique({ where: { id } });
        if (!old) throw notFound();
        if (input.consent === "OPTED_IN" && !isEligible("OPTED_IN", old.whatsappId)) {
          throw new HttpError(400, "This contact has an invalid WhatsApp destination.");
        }
        const isCurrentlyOptedOut = (await tx.contact.count({ where: { whatsappId: old.whatsappId, consent: "OPTED_OUT" } })) > 0;
        if (input.consent === "OPTED_IN" && isCurrentlyOptedOut && input.reoptIn === false) {
          throw new HttpError(409, "This WhatsApp contact opted out. Confirm restoration to re-enable.");
        }
        await tx.contact.updateMany({
          where: { whatsappId: old.whatsappId },
          data: {
            consent: input.consent,
            consentNote: input.consentNote || (input.consent === "OPTED_OUT" ? "Suppressed in phonebook" : "Active in phonebook"),
            consentAt: input.consent === "OPTED_IN" ? new Date() : null,
          },
        });
        await tx.auditLog.create({ data: { action: "contact.consent_changed", details: { id, from: old.consent, to: input.consent } } });
      });
      return ok(await db.contact.findUnique({ where: { id } }));
    }
    if (method === "POST" && id === "import") {
      const input = z.object({
        sessionId: z.string(),
        contacts: z.array(
          z.object({
            phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
            name: z.string().max(150).optional(),
          }),
        ).min(1).max(25000),
        segmentIds: z.array(z.string().min(1)).max(100).default([]),
        newSegment: segmentInput.optional(),
      }).parse(await payload(req));
      if (!(await db.waSession.findUnique({ where: { id: input.sessionId } }))) throw notFound();
      if (input.newSegment && (await db.segment.findUnique({ where: { name: input.newSegment.name } }))) {
        throw new HttpError(409, "A segment with that name already exists");
      }
      const createdSegment = input.newSegment ? await db.segment.create({ data: input.newSegment }) : null;
      const targetSegments = [...new Set([...input.segmentIds, ...(createdSegment ? [createdSegment.id] : [])])];
      const suppressedSet = new Set(
        (await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] }))
          .map(item => item.whatsappId),
      );
      const importedIds: string[] = [];
      const now = new Date();
      for (const entry of input.contacts) {
        const phone = entry.phone.replace(/^\+/, "");
        const whatsappId = phone + "@c.us";
        const isSuppressed = suppressedSet.has(whatsappId);
        const saved = await db.contact.upsert({
          where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId } },
          create: {
            sessionId: input.sessionId,
            whatsappId,
            phone,
            name: entry.name,
            consent: isSuppressed ? "OPTED_OUT" : "OPTED_IN",
            consentAt: isSuppressed ? null : now,
            consentNote: isSuppressed ? "Preserved global opt-out" : "CSV phonebook import",
          },
          update: { name: entry.name || undefined },
          select: { id: true },
        });
        importedIds.push(saved.id);
      }
      for (const segId of targetSegments) {
        for (let start = 0; start < importedIds.length; start += 1000) {
          await db.segmentMember.createMany({
            data: importedIds.slice(start, start + 1000).map(contactId => ({ segmentId: segId, contactId })),
            skipDuplicates: true,
          });
        }
      }
      await audit("contacts.imported", { sessionId: input.sessionId, count: importedIds.length, segmentIds: targetSegments });
      return ok({ count: importedIds.length, segment: createdSegment }, 201);
    }
  }

  if (resource === "groups") {
    if (method === "GET" && !id) {
      const groups = await db.waGroup.findMany({
        where: sessionId ? { sessionId } : {},
        include: { session: { select: { id: true, label: true, status: true } }, _count: { select: { members: true } } },
        orderBy: { name: "asc" },
      });
      const redis = redisConnection();
      try {
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        const states = groups.length ? await redis.mget(...groups.map(group => groupSyncStateKey(queue, group.id))) : [];
        return ok(groups.map((group, index) => ({ ...group, sync: states[index] ? (JSON.parse(states[index]!) as SyncState) : null })));
      } catch {
        return ok(groups.map(group => ({ ...group, sync: null })));
      } finally {
        redis.disconnect();
      }
    }
    if (method === "POST" && id === "export-segment" && !operation) {
      const input = groupExportInput.parse(await payload(req));
      const exported = await exportGroupsToSegments(input);
      let queuedLiveSync = 0;
      if (input.syncLive && exported.connectedGroups.length && (await hasOnlineWorker(false))) {
        const redis = redisConnection();
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        try {
          for (const group of exported.connectedGroups) {
            const key = groupSyncStateKey(queue, group.id);
            const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
            if (!locked) continue;
            await redis.set(
              key,
              JSON.stringify({
                phase: "QUEUED",
                kind: "members",
                message: "Syncing live group participants into segment…",
                updatedAt: new Date().toISOString(),
              } satisfies SyncState),
              "EX",
              86400,
            );
            try {
              await command("sync-group-members", { groupId: group.id, segmentIds: exported.destinationIds });
              queuedLiveSync++;
            } catch {
              await redis.del(key, key + ":queued");
            }
          }
        } finally {
          redis.disconnect();
        }
      }
      return ok({
        segment: exported.segment,
        destinationIds: exported.destinationIds,
        savedContactsExported: exported.savedContactsExported,
        uniquePeople: exported.uniquePeople,
        added: exported.added,
        queuedLiveSync,
      }, exported.segment ? 201 : 200);
    }
    if (method === "POST" && id === "permissions" && !operation) {
      const input = z.object({
        groupIds: z.array(z.string().min(1)).min(1).max(500),
        allowPosting: z.boolean(),
      }).parse(await payload(req));
      const updated = await db.waGroup.updateMany({
        where: { id: { in: [...new Set(input.groupIds)] } },
        data: { allowPosting: input.allowPosting },
      });
      for (const groupId of [...new Set(input.groupIds)]) {
        await audit("group.permission", { groupId, allowPosting: input.allowPosting });
      }
      return ok({ updated: updated.count });
    }
    if (method === "POST" && id && ["sync-members", "save-contacts"].includes(operation)) {
      const group = await db.waGroup.findUnique({ where: { id }, include: { session: { select: { status: true } } } });
      if (!group) throw notFound();
      await requireWorker();
      if (group.session.status !== "CONNECTED") {
        throw new HttpError(409, "Connect this group's WhatsApp account to live-sync fresh members, or use Export to Segment to export already-saved members.");
      }
      const input = z.object({
        segmentIds: z.array(z.string().min(1)).max(500).default([]),
        newSegment: segmentInput.optional(),
      }).parse(await payload(req));
      if (input.newSegment && (await db.segment.findUnique({ where: { name: input.newSegment.name } }))) {
        throw new HttpError(409, "A segment with that name already exists. Select it below or choose another name.");
      }
      const segmentIds = [...new Set(input.segmentIds)];
      if ((await db.segment.count({ where: { id: { in: segmentIds } } })) !== segmentIds.length) {
        throw new HttpError(400, "One or more segments no longer exist");
      }
      const redis = redisConnection();
      const key = groupSyncStateKey(process.env.QUEUE_NAME || "campaign-operations", id);
      try {
        const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
        if (!locked) throw new HttpError(409, "This group is already being saved. Wait for it to finish.");
        await redis.set(
          key,
          JSON.stringify({ phase: "QUEUED", kind: "members", message: "Saving group contacts queued…", updatedAt: new Date().toISOString() } satisfies SyncState),
          "EX",
          86400,
        );
        try {
          await command("sync-group-members", { groupId: id, segmentIds, newSegment: input.newSegment });
        } catch (error) {
          await redis.del(key, key + ":queued");
          throw error;
        }
      } finally {
        redis.disconnect();
      }
      return ok({ queued: true }, 202);
    }
    if (method === "GET" && id && operation === "members") {
      if (!(await db.waGroup.findUnique({ where: { id } }))) throw notFound();
      return ok(await db.groupMember.findMany({ where: { groupId: id }, include: { contact: true }, take: 500 }));
    }
    if (method === "PATCH" && id && !operation) {
      const { allowPosting } = z.object({ allowPosting: z.boolean() }).parse(await payload(req));
      const group = await db.waGroup.update({ where: { id }, data: { allowPosting } });
      await audit("group.permission", { groupId: id, allowPosting });
      return ok(group);
    }
  }

  if (resource === "segments") {
    if (method === "POST" && id === "members" && !operation) {
      return ok(await organizeContacts(bulkSegmentInput.parse(await payload(req))));
    }
    if (method === "GET" && !id) {
      const segments = await db.segment.findMany({
        include: { _count: { select: { members: true, targets: true } } },
        orderBy: { createdAt: "desc" },
      });
      const suppressed = new Set(
        (await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] }))
          .map(c => c.whatsappId),
      );
      const memberships = await db.segmentMember.findMany({
        select: {
          segmentId: true,
          contact: {
            select: {
              consent: true,
              whatsappId: true,
              _count: { select: { members: true } },
            },
          },
        },
      });
      const eligible = new Map<string, Set<string>>();
      const uniqueTotal = new Map<string, Set<string>>();
      const optedOutMap = new Map<string, Set<string>>();
      const fromGroupsMap = new Map<string, Set<string>>();
      for (const member of memberships) {
        const contact = member.contact;
        const allSet = uniqueTotal.get(member.segmentId) || new Set<string>();
        allSet.add(contact.whatsappId);
        uniqueTotal.set(member.segmentId, allSet);
        if (contact._count.members > 0) {
          const grpSet = fromGroupsMap.get(member.segmentId) || new Set<string>();
          grpSet.add(contact.whatsappId);
          fromGroupsMap.set(member.segmentId, grpSet);
        }
        if (suppressed.has(contact.whatsappId) || contact.consent === "OPTED_OUT") {
          const optSet = optedOutMap.get(member.segmentId) || new Set<string>();
          optSet.add(contact.whatsappId);
          optedOutMap.set(member.segmentId, optSet);
          continue;
        }
        if (!isEligible(contact.consent, contact.whatsappId)) continue;
        const phones = eligible.get(member.segmentId) || new Set<string>();
        phones.add(contact.whatsappId);
        eligible.set(member.segmentId, phones);
      }
      return ok(
        segments.map(segment => ({
          ...segment,
          eligibleCount: eligible.get(segment.id)?.size || 0,
          uniqueCount: uniqueTotal.get(segment.id)?.size || 0,
          optedOutCount: optedOutMap.get(segment.id)?.size || 0,
          fromGroupsCount: fromGroupsMap.get(segment.id)?.size || 0,
        })),
      );
    }
    if (method === "POST" && !id) return ok(await db.segment.create({ data: segmentInput.parse(await payload(req)) }), 201);
    if (id && !(await db.segment.findUnique({ where: { id } }))) throw notFound();
    if (method === "PATCH" && id && !operation) {
      return ok(await db.segment.update({ where: { id }, data: segmentInput.parse(await payload(req)) }));
    }
    if (method === "GET" && id) {
      return ok(
        await db.segment.findUnique({
          where: { id },
          include: { members: { include: { contact: true }, take: 500 } },
        }),
      );
    }
    if (method === "POST" && id && operation === "members") {
      const input = z.object({
        contactIds: z.array(z.string()).max(50000),
        action: z.enum(["add", "remove"]).default("add"),
      }).parse(await payload(req));
      if (input.contactIds.length) {
        await organizeContacts({ selection: { contactIds: input.contactIds }, segmentIds: [id], action: input.action });
      }
      return ok({ success: true });
    }
    if (method === "DELETE" && id && !operation) {
      if (await db.campaignSegment.count({ where: { segmentId: id, campaign: { status: { in: ["ACTIVE", "SCHEDULED", "PAUSED"] } } } })) {
        throw new HttpError(409, "This segment is used by a running or paused campaign. Cancel the campaign before deleting it.");
      }
      await db.segment.delete({ where: { id } });
      return ok({ success: true });
    }
  }

  if (resource === "campaigns") {
    const lifecycleRedis = id && !["preview", "recipients"].includes(id) && method !== "GET" ? redisConnection() : null;
    const lifecycleKey = "campaign:lifecycle:" + id;
    const lifecycleToken = randomUUID();
    let ownsLifecycle = false;
    try {
      if (lifecycleRedis) {
        ownsLifecycle = (await lifecycleRedis.set(lifecycleKey, lifecycleToken, "EX", 60, "NX")) === "OK";
        if (!ownsLifecycle) throw new HttpError(409, "This campaign is being updated. Wait a moment, then refresh.");
      }

      if (method === "POST" && id === "recipients" && !operation) {
        const input = z.object({
          audienceType: z.enum(["CONTACTS", "GROUPS", "BOTH"]),
          sessionId: z.string().min(1),
          contactIds: z.array(z.string()).max(50000).default([]),
          segmentIds: z.array(z.string()).max(500).default([]),
          groupIds: z.array(z.string()).max(500).default([]),
          page: z.number().int().min(1).max(10000).default(1),
          take: z.number().int().min(1).max(50).default(15),
          search: z.string().trim().max(120).default(""),
        }).parse(await payload(req));
        const audience = await resolveAudience(input);
        const term = input.search.toLocaleLowerCase();
        const matches = term
          ? audience.recipients.filter(recipient =>
            [recipient.label, recipient.phone, recipient.chatId, ...(recipient.sources || [])]
              .some(value => value?.toLocaleLowerCase().includes(term)),
          )
          : audience.recipients;
        const offset = (input.page - 1) * input.take;
        return ok({
          count: audience.recipients.length,
          limit: campaignLimit(),
          total: audience.total,
          excluded: audience.excluded,
          duplicates: audience.duplicates,
          exclusions: audience.exclusions,
          page: input.page,
          take: input.take,
          matched: matches.length,
          items: matches.slice(offset, offset + input.take).map(recipient => ({
            key: recipient.key,
            label: recipient.label,
            phone: recipient.phone,
            chatId: recipient.chatId,
            sources: recipient.sources || [],
          })),
        });
      }

      if (method === "POST" && id === "preview" && !operation) {
        const input = campaignInput.parse(await payload(req));
        const audience = await resolveAudience(input);
        const policy = await getSendingPolicy();
        const intervalMs = Math.max(configuration().SEND_INTERVAL_MS, input.sendIntervalMs, policy.minimumIntervalMs);
        const directDurationMs = estimatedDurationMs(audience.recipients.length, intervalMs);
        const durationMs = minimumCampaignDuration(audience.recipients.length, intervalMs, policy);
        const session = await db.waSession.findUniqueOrThrow({ where: { id: input.sessionId } });

        const targetKeys = audience.recipients.map(recipient => (recipient.contactId ? "contact:" : "group:") + recipient.chatId);
        let contacted: { recipientKeys: string[] }[] = [];
        if (targetKeys.length) {
          if (input.repeatPolicy === "NO_REPEAT") {
            contacted = await db.sendAttempt.findMany({
              where: {
                recipientKeys: { hasSome: targetKeys },
                outcome: { in: ["SENDING", "SENT", "DELIVERED", "READ", "UNKNOWN"] },
              },
              select: { recipientKeys: true },
            });
          } else if (input.repeatPolicy === "COOLDOWN") {
            const cooldownMs = input.repeatCooldownHours > 0
              ? input.repeatCooldownHours * HOUR
              : policy.contactCooldownMs || 24 * HOUR;
            contacted = await db.sendAttempt.findMany({
              where: {
                attemptedAt: { gt: new Date(Date.now() - cooldownMs) },
                recipientKeys: { hasSome: targetKeys },
                outcome: { notIn: ["SKIPPED", "FAILED"] },
              },
              select: { recipientKeys: true },
            });
          } else if (input.scheduleType !== "CRON" && policy.contactCooldownMs > 0) {
            const contactOnlyKeys = targetKeys.filter(k => k.startsWith("contact:"));
            if (contactOnlyKeys.length) {
              contacted = await db.sendAttempt.findMany({
                where: {
                  attemptedAt: { gt: new Date(Date.now() - policy.contactCooldownMs) },
                  recipientKeys: { hasSome: contactOnlyKeys },
                },
                select: { recipientKeys: true },
              });
            }
          }
        }
        const [safety, hold] = await Promise.all([
          sendingSafetySummary(new Date(), session.id),
          activeSendingHold(accountKey(session), session.id),
        ]);
        const recentKeys = new Set(contacted.flatMap(item => item.recipientKeys));
        const senderName = publicSenderName(session, policy.businessName);
        const messagePreview = campaignMessage(
          input.message,
          senderName,
          input.audienceType !== "GROUPS",
          input.includeFooter,
        );
        return ok({
          count: audience.recipients.length,
          total: audience.total,
          duplicates: audience.duplicates,
          excluded: audience.excluded,
          exclusions: audience.exclusions,
          sample: audience.recipients.slice(0, 8),
          intervalMs,
          durationMs,
          directDurationMs,
          limit: campaignLimit(),
          nextRuns: schedulePreview(input),
          scheduleIssue: messagePreview.length > 4096
            ? "Shorten the message so it stays within WhatsApp's 4,096-character limit."
            : scheduleIssue(input, directDurationMs),
          senderName: senderName || null,
          messagePreview,
          safety: {
            ...safety,
            hold,
            frequencyLimited: audience.recipients.filter(recipient =>
              recentKeys.has((recipient.contactId ? "contact:" : "group:") + recipient.chatId),
            ).length,
          },
        });
      }

      if (method === "GET" && !id) {
        const items = await db.campaign.findMany({
          include: {
            session: { select: { id: true, label: true, status: true } },
            template: { select: { id: true, name: true } },
            _count: { select: { contacts: true, groups: true, segments: true, runs: true } },
            runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true, startedAt: true, status: true, nextAttemptAt: true } },
          },
          orderBy: { createdAt: "desc" },
        });
        const [summaries, latest] = await Promise.all([
          campaignDeliverySummaries(items.map(item => item.id)),
          runDeliverySummaries(items.flatMap(item => item.runs.map(run => run.id))),
        ]);
        return ok(
          items.map(item => ({
            ...item,
            summary: summaries.get(item.id) ?? deliveryTotals([]),
            runs: item.runs.map(run => ({ ...run, summary: latest.get(run.id) ?? deliveryTotals([]) })),
          })),
        );
      }

      if (method === "POST" && !id) {
        const input = campaignInput.parse(await payload(req));
        if (!(await db.waSession.findUnique({ where: { id: input.sessionId } }))) throw notFound();
        if (input.mediaKey) {
          try { await access(join(process.cwd(), ".uploads", input.mediaKey)); }
          catch { throw new HttpError(400, "Attachment missing; upload it again"); }
        }
        if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
        const [contactCount, segmentCount, groupCount] = await Promise.all([
          db.contact.count({ where: { id: { in: input.contactIds } } }),
          db.segment.count({ where: { id: { in: input.segmentIds } } }),
          db.waGroup.count({
            where: {
              id: { in: input.groupIds },
              ...(input.audienceType !== "CONTACTS" ? { sessionId: input.sessionId } : {}),
            },
          }),
        ]);
        if (
          contactCount !== new Set(input.contactIds).size ||
          segmentCount !== new Set(input.segmentIds).size ||
          groupCount !== new Set(input.groupIds).size
        ) {
          throw new HttpError(400, "Audience contains missing contacts, segments, or groups, or group destinations from another sender account");
        }
        const campaign = await db.campaign.create({
          data: {
            name: input.name,
            message: input.message,
            sessionId: input.sessionId,
            mediaKey: input.mediaKey || null,
            mediaMime: input.mediaMime || null,
            mediaName: input.mediaName || null,
            audienceType: input.audienceType,
            scheduleType: input.scheduleType,
            timezone: input.timezone,
            sendIntervalMs: input.sendIntervalMs,
            scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
            cron: input.intervalHours ? null : (input.cron || null),
            intervalHours: input.scheduleType === "CRON" ? (input.intervalHours || null) : null,
            runImmediately: input.runImmediately,
            repeatPolicy: input.repeatPolicy,
            repeatCooldownHours: input.repeatCooldownHours,
            includeFooter: input.includeFooter,
            templateId: input.templateId || null,
            contacts: { create: [...new Set(input.contactIds)].map(contactId => ({ contactId })) },
            segments: { create: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId })) },
            groups: { create: [...new Set(input.groupIds)].map(groupId => ({ groupId })) },
          },
        });
        await audit("campaign.created", { id: campaign.id });
        return ok(campaign, 201);
      }

      if (id && !(await db.campaign.findUnique({ where: { id } }))) throw notFound();

      if (method === "GET" && id && !operation) {
        const [detail, summaries] = await Promise.all([
          db.campaign.findUnique({
            where: { id },
            include: {
              contacts: true,
              groups: true,
              segments: true,
              template: { select: { id: true, name: true } },
              _count: { select: { runs: true } },
              runs: {
                take: 25,
                ...(url.searchParams.get("runId") ? { where: { id: url.searchParams.get("runId")! } } : {}),
                orderBy: { startedAt: "desc" },
                include: {
                  deliveries: {
                    orderBy: { updatedAt: "desc" },
                    include: {
                      replies: { orderBy: { receivedAt: "desc" } },
                      _count: { select: { replies: true } },
                    },
                  },
                },
              },
            },
          }),
          campaignDeliverySummaries([id]),
        ]);
        const optOuts = await recordedOptOutsForRuns(detail?.runs.map(run => run.id) ?? []);
        return ok({
          ...detail,
          runs: detail?.runs.map(run => ({
            ...run,
            deliveries: run.deliveries.map(delivery => ({
              ...delivery,
              optedOutAt: optOuts.get(delivery.id) ?? null,
            })),
          })),
          summary: summaries.get(id) ?? deliveryTotals([]),
        });
      }

      if (method === "PATCH" && id && !operation) {
        const current = await db.campaign.findUniqueOrThrow({ where: { id } });
        if (!["DRAFT", "COMPLETED", "CANCELLED", "PAUSED"].includes(current.status)) {
          throw new HttpError(409, "Pause this campaign before editing it");
        }
        const input = campaignInput.parse(await payload(req));
        if (!(await db.waSession.findUnique({ where: { id: input.sessionId } }))) throw notFound();
        if (input.mediaKey) {
          try { await access(join(process.cwd(), ".uploads", input.mediaKey)); }
          catch { throw new HttpError(400, "Attachment missing; upload again"); }
        }
        if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
        const [nContacts, nSegments, nGroups] = await Promise.all([
          db.contact.count({ where: { id: { in: input.contactIds } } }),
          db.segment.count({ where: { id: { in: input.segmentIds } } }),
          db.waGroup.count({
            where: {
              id: { in: input.groupIds },
              ...(input.audienceType !== "CONTACTS" ? { sessionId: input.sessionId } : {}),
            },
          }),
        ]);
        if (
          nContacts !== new Set(input.contactIds).size ||
          nSegments !== new Set(input.segmentIds).size ||
          nGroups !== new Set(input.groupIds).size
        ) {
          throw new HttpError(400, "Audience contains missing contacts, segments, or groups, or group destinations from another sender account");
        }
        const updated = await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
          const latest = await tx.campaign.findUniqueOrThrow({ where: { id } });
          if (latest.updatedAt.getTime() !== current.updatedAt.getTime()) {
            throw new HttpError(409, "Campaign changed. Reopen the editor to get the latest version.");
          }
          if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } })) {
            throw new HttpError(409, "The previous run is still stopping. Wait for it to finish before editing.");
          }
          await removeSchedule(id);
          return tx.campaign.update({
            where: { id },
            data: {
              status: current.status === "PAUSED" ? "PAUSED" : "DRAFT",
              name: input.name,
              message: input.message,
              sessionId: input.sessionId,
              mediaKey: input.mediaKey || null,
              mediaMime: input.mediaMime || null,
              mediaName: input.mediaName || null,
              audienceType: input.audienceType,
              scheduleType: input.scheduleType,
              timezone: input.timezone,
              sendIntervalMs: input.sendIntervalMs,
              scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
              cron: input.intervalHours ? null : (input.cron || null),
              intervalHours: input.scheduleType === "CRON" ? (input.intervalHours || null) : null,
              runImmediately: input.runImmediately,
              repeatPolicy: input.repeatPolicy,
              repeatCooldownHours: input.repeatCooldownHours,
              includeFooter: input.includeFooter,
              templateId: input.templateId || null,
              contacts: { deleteMany: {}, create: [...new Set(input.contactIds)].map(contactId => ({ contactId })) },
              segments: { deleteMany: {}, create: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId })) },
              groups: { deleteMany: {}, create: [...new Set(input.groupIds)].map(groupId => ({ groupId })) },
            },
          });
        }, { timeout: 30000 });
        await audit("campaign.edited", { id });
        return ok(updated);
      }

      if (method === "GET" && id && operation === "audience") {
        const audience = await getCampaignAudience(id);
        return ok({
          count: audience.recipients.length,
          total: audience.total,
          duplicates: audience.duplicates,
          excluded: audience.excluded,
          exclusions: audience.exclusions,
          sample: audience.recipients.slice(0, 8),
        });
      }

      if (method === "POST" && id && operation === "reconcile") {
        const input = z.object({
          deliveryId: z.string().min(1),
          note: z.string().trim().max(500).default("Confirmed sent in WhatsApp"),
          confirmed: z.boolean().default(true),
        }).refine(v => v.confirmed === true, { message: "Confirm before updating status" }).parse(await payload(req));
        const result = await db.$transaction(async tx => {
          const delivery = await tx.delivery.findFirst({ where: { id: input.deliveryId, run: { campaignId: id } } });
          if (!delivery) throw notFound();
          if (delivery.status !== "UNKNOWN") {
            throw new HttpError(409, "Only an unconfirmed send can be confirmed manually. Refresh the results.");
          }
          const attempt = await tx.sendAttempt.findUnique({ where: { deliveryId: delivery.id } });
          const changed = await tx.delivery.updateMany({
            where: { id: delivery.id, status: "UNKNOWN" },
            data: {
              status: "SENT",
              sentAt: delivery.sentAt ?? attempt?.attemptedAt ?? new Date(),
              error: "Manually confirmed sent in WhatsApp.",
            },
          });
          if (!changed.count) throw new HttpError(409, "A WhatsApp receipt just updated this result. Refresh the results.");
          await tx.sendAttempt.updateMany({ where: { deliveryId: delivery.id, outcome: "UNKNOWN" }, data: { outcome: "SENT" } });
          await tx.auditLog.create({
            data: {
              action: "delivery.manually_confirmed_sent",
              details: { campaignId: id, runId: delivery.runId, deliveryId: delivery.id, previousStatus: "UNKNOWN", note: input.note },
            },
          });
          return { confirmed: true };
        });
        return ok(result);
      }

      if (method === "POST" && id && operation === "relaunch") {
        const redis = redisConnection();
        const lockKey = "campaign:relaunch:guard:" + id;
        let reserved = false;
        let success = false;
        let started: Awaited<ReturnType<typeof db.campaign.findUniqueOrThrow>> | undefined;
        let count = 0;
        try {
          reserved = (await redis.set(lockKey, "1", "EX", 45, "NX")) === "OK";
          if (!reserved) throw new HttpError(409, "This campaign was just relaunched. Check its latest run before sending again.");
          started = await db.$transaction(async tx => {
            await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
            const source = await tx.campaign.findUniqueOrThrow({ where: { id }, include: { session: true } });
            if (!["COMPLETED", "CANCELLED"].includes(source.status)) {
              throw new HttpError(409, "Launch the draft or resume the paused campaign. Relaunch is for completed or cancelled campaigns.");
            }
            if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } })) {
              throw new HttpError(409, "An earlier execution is still stopping. Wait for it to finish.");
            }
            if (source.session.status !== "CONNECTED") {
              throw new HttpError(409, "Connect the sending WhatsApp account before relaunching.");
            }
            await checkSendingAccount(source.sessionId, true);
            if (source.mediaKey) {
              try { await access(join(process.cwd(), ".uploads", source.mediaKey)); }
              catch { throw new HttpError(400, "Attachment missing. Edit this campaign and upload it again."); }
            }
            const audience = await getCampaignAudience(id);
            count = audience.recipients.length;
            if (!count) throw new HttpError(400, explainAudienceBlocker(audience));
            if (count > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
            await requireWorker(true);
            await removeSchedule(id);
            const keepCron = source.scheduleType === "CRON" && Boolean(source.intervalHours || source.cron);
            return tx.campaign.update({
              where: { id },
              data: {
                status: "ACTIVE",
                scheduleType: keepCron ? "CRON" : "NOW",
                scheduledAt: null,
                runsCompleted: false,
                launchVersion: { increment: 1 },
              },
            });
          }, { timeout: 30000 });
          try {
            await scheduleCampaign(started);
          } catch {
            await db.campaign.updateMany({ where: { id, updatedAt: started.updatedAt, status: "ACTIVE" }, data: { status: "PAUSED" } });
            throw new HttpError(503, "Scheduling failed. This campaign is paused; resume it to retry.");
          }
          await audit("campaign.relaunched", { campaignId: id, recipients: count, launchVersion: started.launchVersion });
          success = true;
          return ok({ campaignId: id, recipients: count }, 201);
        } finally {
          if (reserved && !success) await redis.del(lockKey);
          redis.disconnect();
        }
      }

      if (method === "POST" && id && operation === "action") {
        const { action } = z.object({ action: z.enum(["launch", "pause", "resume", "cancel"]) }).parse(await payload(req));
        let queued: Awaited<ReturnType<typeof db.campaign.findUniqueOrThrow>> | undefined;
        let fallback: "DRAFT" | "PAUSED" = "DRAFT";
        const policy = await getSendingPolicy();
        await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
          const campaign = await tx.campaign.findUniqueOrThrow({ where: { id } });
          if (action === "launch") {
            if (campaign.status !== "DRAFT") throw new HttpError(409, "Only draft campaigns may launch");
            const audience = await resolveRecipients(id);
            if (!audience.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
            await checkSendingAccount(campaign.sessionId, true);
            const intervalMs = Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs, policy.minimumIntervalMs);
            const timingIssue = scheduleIssue(campaign, estimatedDurationMs(audience.length, intervalMs));
            if (timingIssue) throw new HttpError(400, timingIssue);
            if (audience.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
            if (campaign.scheduleType === "ONCE" && (!campaign.scheduledAt || campaign.scheduledAt.getTime() <= Date.now())) {
              throw new HttpError(400, "Scheduled time has passed. Edit the draft and choose a future date.");
            }
            if ((await tx.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") {
              throw new HttpError(409, "Connect the sending WhatsApp account before launching");
            }
            await requireWorker(true);
            const status = campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE";
            const changed = await tx.campaign.updateMany({
              where: { id, status: "DRAFT" },
              data: { status, runsCompleted: false, launchVersion: { increment: 1 } },
            });
            if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
            queued = await tx.campaign.findUniqueOrThrow({ where: { id } });
          } else if (action === "pause") {
            if (!["ACTIVE", "SCHEDULED"].includes(campaign.status)) throw new HttpError(409, "Campaign is not active");
            await tx.campaign.update({ where: { id }, data: { status: "PAUSED" } });
            await closeDeferredRuns(tx, [id], "Campaign paused");
            await removeSchedule(id);
          } else if (action === "resume") {
            if (!["PAUSED", "DRAFT"].includes(campaign.status)) throw new HttpError(409, "Campaign is not paused");
            if (campaign.status === "DRAFT" && (!campaign.launchVersion || campaign.runsCompleted)) {
              throw new HttpError(409, "Campaign has not been launched yet. Launch this draft instead.");
            }
            if ((await tx.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") {
              throw new HttpError(409, "Reconnect the sending WhatsApp account before resuming");
            }
            const recipients = await resolveRecipients(id);
            if (!recipients.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
            if (recipients.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
            await checkSendingAccount(campaign.sessionId, true);
            const intervalMs = Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs, policy.minimumIntervalMs);
            const timingIssue = scheduleIssue(campaign, estimatedDurationMs(recipients.length, intervalMs));
            if (timingIssue) throw new HttpError(400, timingIssue);
            await requireWorker(true);
            const changed = await tx.campaign.updateMany({
              where: { id, status: campaign.status },
              data: { status: campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE" },
            });
            if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
            queued = await tx.campaign.findUniqueOrThrow({ where: { id } });
            fallback = campaign.status === "PAUSED" ? "PAUSED" : "DRAFT";
          } else {
            if (!["ACTIVE", "SCHEDULED", "PAUSED"].includes(campaign.status)) {
              throw new HttpError(409, "Only active, scheduled or paused campaigns can be cancelled.");
            }
            await tx.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
            await closeDeferredRuns(tx, [id], "Campaign cancelled");
            await removeSchedule(id);
          }
        }, { timeout: 30000 });
        if (queued) {
          const scheduled = queued as Awaited<ReturnType<typeof db.campaign.findUniqueOrThrow>>;
          try {
            await scheduleCampaign(scheduled);
          } catch (error) {
            await db.campaign.updateMany({ where: { id, updatedAt: scheduled.updatedAt }, data: { status: fallback } });
            throw error;
          }
          const latest = await db.campaign.findUniqueOrThrow({ where: { id } });
          if (latest.updatedAt.getTime() !== scheduled.updatedAt.getTime()) await removeSchedule(id);
        }
        await audit("campaign." + action, { id });
        return ok(await db.campaign.findUnique({ where: { id } }));
      }

      if (method === "DELETE" && id && !operation) {
        await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
          const item = await tx.campaign.findUnique({ where: { id }, include: { _count: { select: { runs: true } } } });
          if (!item) throw notFound();
          if (!["DRAFT", "COMPLETED", "CANCELLED"].includes(item.status)) {
            throw new HttpError(409, "Cancel the active, scheduled or paused campaign before deleting it.");
          }
          if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } })) {
            throw new HttpError(409, "A delivery is still stopping. Retry deletion after its run finishes.");
          }
          await removeSchedule(id);
          await tx.campaign.delete({ where: { id } });
          await tx.auditLog.create({
            data: { action: "campaign.deleted", details: { id, name: item.name, status: item.status, deletedRuns: item._count.runs } },
          });
        }, { timeout: 30000 });
        return ok({ success: true });
      }
    } finally {
      if (lifecycleRedis) {
        try {
          if (ownsLifecycle) {
            await lifecycleRedis.eval(
              "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
              1,
              lifecycleKey,
              lifecycleToken,
            );
          }
        } finally {
          lifecycleRedis.disconnect();
        }
      }
    }
  }

  if (resource === "report-summary" && method === "GET" && !id) {
    return ok(await workspaceReportSummary());
  }

  if (resource === "runs" && method === "GET") {
    const runs = await db.campaignRun.findMany({
      take: 100,
      orderBy: { startedAt: "desc" },
      include: {
        campaign: { select: { id: true, name: true, audienceType: true, scheduleType: true, intervalHours: true, cron: true } },
        deliveries: {
          select: {
            id: true,
            status: true,
            error: true,
            recipientKey: true,
            replies: { where: { isOptOut: true }, select: { isOptOut: true } },
            _count: { select: { replies: true } },
          },
        },
      },
    });
    const optOuts = await recordedOptOutsForRuns(runs.map(run => run.id));
    return ok(
      runs.map(run => ({
        ...run,
        deliveries: run.deliveries.map(delivery => ({ ...delivery, optedOutAt: optOuts.get(delivery.id) ?? null })),
      })),
    );
  }

  if (resource === "audit" && method === "GET") {
    return ok(await db.auditLog.findMany({ take: 100, orderBy: { createdAt: "desc" } }));
  }

  if (resource === "health" && method === "GET") {
    const redis = redisConnection();
    try {
      const [ping, workers, deliveryWorkers] = await Promise.all([
        redis.ping(),
        operations.getWorkers(),
        campaigns.getWorkers(),
      ]);
      return ok({
        database: "connected",
        redis: ping,
        workers,
        deliveryWorkers,
        workerReady: workers.length > 0 && deliveryWorkers.length > 0,
      });
    } finally {
      await redis.quit();
    }
  }

  throw notFound();
}

export async function GET(req: NextRequest, p: Params) {
  try { return await route(req, p); } catch (e) { return respondError(e); }
}
export async function POST(req: NextRequest, p: Params) {
  try { return await route(req, p); } catch (e) { return respondError(e); }
}
export async function PATCH(req: NextRequest, p: Params) {
  try { return await route(req, p); } catch (e) { return respondError(e); }
}
export async function DELETE(req: NextRequest, p: Params) {
  try { return await route(req, p); } catch (e) { return respondError(e); }
}
