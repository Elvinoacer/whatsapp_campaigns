import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { operations, campaigns, command, removeSchedule, scheduleCampaign, redisConnection } from "@/lib/queue";
import { campaignInput, contactInput, segmentInput, sessionInput, schedulePreview, scheduleIssue, estimatedDurationMs } from "@/lib/campaign";
import { HttpError, ok, payload, rejectCrossOrigin, requireUser, respondError } from "@/lib/http";
import { resolveAudience, resolveRecipients, getCampaignAudience, explainAudienceBlocker } from "@/lib/audience";
import { z } from "zod";
import { campaignLimit, configuration } from "@/lib/config";
import { groupSyncStateKey, syncStateKey, type SyncState } from "@/lib/sync-state";

import { contactFilterInput, contactWhere } from "@/lib/contact-selection";
import { bulkSegmentInput, organizeContacts } from "@/lib/segments";
import { bulkConsentInput, recordBulkOptIn } from "@/lib/consent";
import { isEligible } from "@/lib/campaign";

type Params = { params: Promise<{ path: string[] }> };
const notFound = () => new HttpError(404, "Resource not found");
async function requireWorker(delivery = false) {
  if (!(await (delivery ? campaigns : operations).getWorkers()).length) throw new HttpError(503, "Background worker is offline. Start npm run dev:all or npm run worker.");
}
async function audit(action: string, details?: object) {
  await db.auditLog.create({ data: { action, details: details ?? {} } });
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
  if (resource === "media" && method === "POST" && !id) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > 8 * 1024 * 1024)
      throw new HttpError(400, "Choose a file up to 8 MB");
    const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
    const ext = extensions[file.type];
    if (!ext) throw new HttpError(400, "Only JPEG, PNG, WebP and PDF attachments are supported");
    const bytes = Buffer.from(await file.arrayBuffer());
    const valid = ext === "jpg" ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : ext === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ext === "webp" ? bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      : bytes.toString("ascii", 0, 5) === "%PDF-";
    if (!valid) throw new HttpError(400, "File contents do not match the claimed file type");
    const mediaKey = randomUUID() + "." + ext;
    const dirname = join(process.cwd(), ".uploads");
    await mkdir(dirname, { recursive: true });
    await writeFile(join(dirname, mediaKey), bytes, { flag: "wx", mode: 0o600 });
    return ok({ mediaKey, mediaMime: file.type, mediaName: file.name.replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 140) }, 201);
  }
  if (method === "GET" && resource === "overview") {
    const [sessions, contacts, optedIn, groups, campaigns, runs, latest] = await Promise.all([
      db.waSession.count(), db.contact.count(), db.contact.count({ where: { consent: "OPTED_IN" } }),
      db.waGroup.count(), db.campaign.count(), db.campaignRun.count(),
      db.campaignRun.findMany({ take: 8, orderBy: { startedAt: "desc" },
        include: { campaign: { select: { name: true } }, deliveries: { select: { status: true } } } }),
    ]);
    return ok({ sessions, contacts, optedIn, groups, campaigns, runs, latest });
  }
  if (resource === "sessions") {
    if (method === "GET" && !id) {
      const sessions = await db.waSession.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { contacts: true, groups: true } } } });
      const redis = redisConnection();
      try {
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        const states = sessions.length ? await redis.mget(...sessions.map(session => syncStateKey(queue, session.id))) : [];
        return ok(sessions.map((session, index) => ({ ...session, sync: states[index] ? JSON.parse(states[index]!) as SyncState : null })));
      } catch { return ok(sessions.map(session => ({ ...session, sync: null }))); }
      finally { redis.disconnect(); }
    }
    if (method === "POST" && !id) {
      const input = sessionInput.parse(await payload(req));
      const session = await db.waSession.create({ data: input });
      await audit("session.created", { sessionId: session.id });
      return ok(session, 201);
    }
    if (!id || !await db.waSession.findUnique({ where: { id } })) throw notFound();
    if (method === "GET" && operation === "qr") {
      const redis = redisConnection();
      try { return ok({ qr: await redis.get("qr:" + id) }); }
      finally { await redis.quit(); }
    }
    if (method === "POST" && ["connect", "disconnect", "sync"].includes(operation)) {
      await requireWorker();
      if (operation === "sync") {
        if ((await db.waSession.findUnique({ where: { id } }))?.status !== "CONNECTED")
          throw new HttpError(409, "Wait for the WhatsApp account to connect before syncing.");
        const redis = redisConnection();
        const key = syncStateKey(process.env.QUEUE_NAME || "campaign-operations", id);
        try {
          const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
          if (!locked) return ok({ queued: true }, 202);
          await redis.set(key, JSON.stringify({ phase: "QUEUED", kind: "directory", message: "Contact and group sync queued…", updatedAt: new Date().toISOString() } satisfies SyncState), "EX", 86400);
          try { await command("sync", { sessionId: id }); }
          catch (error) { await redis.del(key, key + ":queued"); throw error; }
        } finally { redis.disconnect(); }
      } else await command(operation, { sessionId: id });
      return ok({ queued: true }, 202);
    }
  }
  if (resource === "contacts") {
    if (method === "GET" && !id) {
      const page = z.coerce.number().int().min(1).max(1000000).parse(url.searchParams.get("page") ?? 1);
      const take = z.coerce.number().int().min(1).max(100).parse(url.searchParams.get("take") ?? 40);
      const filter = contactFilterInput.parse(Object.fromEntries(
        [...url.searchParams.entries()].filter(([key]) => ["search", "sessionId", "groupId", "segmentId", "consent", "source", "unsegmented", "phoneAvailability"].includes(key))
          .map(([key, value]) => [key, key === "unsegmented" ? value === "true" : value]),
      ));
      const where = contactWhere(filter);
      if (url.searchParams.get("eligible") === "true") {
        const suppressed = await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] });
        where.consent = "OPTED_IN";
        where.AND = [{ whatsappId: { endsWith: "@c.us" } }, { NOT: { whatsappId: { in: suppressed.map(c => c.whatsappId) } } }];
      }
      const [items, total] = await Promise.all([
        db.contact.findMany({ where, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (page - 1) * take, take, include: { session: { select: { label: true } }, segments: { include: { segment: { select: { id: true, name: true } } } }, _count: { select: { members: true } } } }),
        db.contact.count({ where }),
      ]);
      return ok({ items, total, page, take });
    }
    if (method === "POST" && id === "consent" && !operation) {
      return ok(await recordBulkOptIn(bulkConsentInput.parse(await payload(req))));
    }
    if (method === "POST" && !id) {
      const input = z.object({
        sessionId: z.string(),
        phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
        name: z.string().trim().max(150).optional(),
      }).parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      const phone = input.phone.replace(/^\+/, "");
      const contact = await db.contact.upsert({
        where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId: phone + "@c.us" } },
        create: { sessionId: input.sessionId, whatsappId: phone + "@c.us", phone, name: input.name },
        update: { name: input.name },
      });
      return ok(contact, 201);
    }
    if (method === "PATCH" && id && !operation) {
      const input = contactInput.parse(await payload(req));
      const old = await db.contact.findUnique({ where: { id } });
      if (!old) throw notFound();
      if (input.consent === "OPTED_IN" && !isEligible("OPTED_IN", old.whatsappId))
        throw new HttpError(400, "This contact has no usable WhatsApp phone number. Resolve its identifier before recording opt-in.");
      await db.contact.updateMany({ where: { whatsappId: old.whatsappId }, data: {
        consent: input.consent, consentNote: input.consentNote,
        consentAt: input.consent === "OPTED_IN" ? new Date() : null,
      } });
      await audit("contact.consent_changed", { id, from: old.consent, to: input.consent });
      return ok(await db.contact.findUnique({ where: { id } }));
    }
    if (method === "POST" && id === "import") {
      const input = z.object({ sessionId: z.string(), contacts: z.array(z.object({
        phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
        name: z.string().max(150).optional(),
      })).min(1).max(2000) }).parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      let count = 0;
      for (const entry of input.contacts) {
        const phone = entry.phone.replace(/^\+/, "");
        await db.contact.upsert({
          where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId: phone + "@c.us" } },
          create: { sessionId: input.sessionId, whatsappId: phone + "@c.us", phone, name: entry.name },
          update: { name: entry.name },
        });
        count++;
      }
      await audit("contacts.imported", { sessionId: input.sessionId, count });
      return ok({ count }, 201);
    }
  }
  if (resource === "groups") {
    if (method === "GET" && !id) {
      const groups = await db.waGroup.findMany({ where: sessionId ? { sessionId } : {},
        include: { session: { select: { label: true, status: true } }, _count: { select: { members: true } } }, orderBy: { name: "asc" } });
      const redis = redisConnection();
      try {
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        const states = groups.length ? await redis.mget(...groups.map(group => groupSyncStateKey(queue, group.id))) : [];
        return ok(groups.map((group, index) => ({ ...group, sync: states[index] ? JSON.parse(states[index]!) as SyncState : null })));
      } catch { return ok(groups.map(group => ({ ...group, sync: null }))); }
      finally { redis.disconnect(); }
    }
    if (method === "POST" && id && ["sync-members", "save-contacts"].includes(operation)) {
      const group = await db.waGroup.findUnique({ where: { id }, include: { session: { select: { status: true } } } });
      if (!group) throw notFound();
      await requireWorker();
      if (group.session.status !== "CONNECTED") throw new HttpError(409, "Connect this group's WhatsApp account before saving its contacts.");
      const input = z.object({ segmentIds: z.array(z.string().min(1)).max(100).default([]) }).parse(await payload(req));
      const segmentIds = [...new Set(input.segmentIds)];
      if (await db.segment.count({ where: { id: { in: segmentIds } } }) !== segmentIds.length) throw new HttpError(400, "One or more segments no longer exist");
      const redis = redisConnection();
      const key = groupSyncStateKey(process.env.QUEUE_NAME || "campaign-operations", id);
      try {
        const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
        if (!locked) throw new HttpError(409, "This group is already being saved. Wait for it to finish before choosing segments.");
        await redis.set(key, JSON.stringify({ phase: "QUEUED", kind: "members", message: "Saving group contacts queued…", updatedAt: new Date().toISOString() } satisfies SyncState), "EX", 86400);
        try { await command("sync-group-members", { groupId: id, segmentIds }); }
        catch (error) { await redis.del(key, key + ":queued"); throw error; }
      } finally { redis.disconnect(); }
      return ok({ queued: true }, 202);
    }
    if (method === "GET" && id && operation === "members") {
      if (!await db.waGroup.findUnique({ where: { id } })) throw notFound();
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
    if (method === "POST" && id === "members" && !operation) return ok(await organizeContacts(bulkSegmentInput.parse(await payload(req))));
    if (method === "GET" && !id) return ok(await db.segment.findMany({
      include: { _count: { select: { members: true } } }, orderBy: { createdAt: "desc" },
    }));
    if (method === "POST" && !id) return ok(await db.segment.create({ data: segmentInput.parse(await payload(req)) }), 201);
    if (id && !await db.segment.findUnique({ where: { id } })) throw notFound();
    if (method === "PATCH" && id && !operation) return ok(await db.segment.update({ where: { id }, data: segmentInput.parse(await payload(req)) }));
    if (method === "GET" && id) return ok(await db.segment.findUnique({
      where: { id }, include: { members: { include: { contact: true }, take: 500 } },
    }));
    if (method === "POST" && id && operation === "members") {
      const input = z.object({ contactIds: z.array(z.string()).max(2000), action: z.enum(["add", "remove"]).default("add") }).parse(await payload(req));
      if (input.contactIds.length) await organizeContacts({ selection: { contactIds: input.contactIds }, segmentIds: [id], action: input.action });
      return ok({ success: true });
    }
    if (method === "DELETE" && id && !operation) {
      if (await db.campaignSegment.count({ where: { segmentId: id, campaign: { status: { in: ["ACTIVE", "SCHEDULED", "PAUSED"] } } } }))
        throw new HttpError(409, "This segment is used by a running or paused campaign. Cancel the campaign before deleting it.");
      await db.segment.delete({ where: { id } });
      return ok({ success: true });
    }
  }
  if (resource === "campaigns") {
    if (method === "POST" && id === "preview" && !operation) {
      const input = campaignInput.parse(await payload(req));
      const audience = await resolveAudience(input);
      const intervalMs = Math.max(configuration().SEND_INTERVAL_MS, input.sendIntervalMs);
      const durationMs = estimatedDurationMs(audience.recipients.length, intervalMs);
      return ok({ count: audience.recipients.length, total: audience.total, duplicates: audience.duplicates, excluded: audience.excluded,
        exclusions: audience.exclusions, sample: audience.recipients.slice(0, 8), intervalMs, durationMs, limit: campaignLimit(),
        nextRuns: schedulePreview(input), scheduleIssue: scheduleIssue(input, durationMs) });
    }
    if (method === "GET" && !id) return ok(await db.campaign.findMany({
      include: { session: { select: { label: true, status: true } },
        _count: { select: { contacts: true, groups: true, segments: true, runs: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 1, include: { _count: { select: { deliveries: true } } } } },
      orderBy: { createdAt: "desc" },
    }));
    if (method === "POST" && !id) {
      const input = campaignInput.parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      if (input.mediaKey) { try { await access(join(process.cwd(), ".uploads", input.mediaKey)); } catch { throw new HttpError(400, "Attachment missing; upload it again"); } }
      if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
      const [contactCount, segmentCount, groupCount] = await Promise.all([
        db.contact.count({ where: { id: { in: input.contactIds } } }),
        db.segment.count({ where: { id: { in: input.segmentIds } } }),
        db.waGroup.count({ where: { id: { in: input.groupIds }, sessionId: input.sessionId } }),
      ]);
      if (contactCount !== new Set(input.contactIds).size ||
          segmentCount !== new Set(input.segmentIds).size ||
          groupCount !== new Set(input.groupIds).size)
        throw new HttpError(400, "Audience contains missing or cross-account targets");
      const campaign = await db.campaign.create({ data: {
        name: input.name, message: input.message, sessionId: input.sessionId,
        mediaKey: input.mediaKey, mediaMime: input.mediaMime, mediaName: input.mediaName,
        audienceType: input.audienceType, scheduleType: input.scheduleType,
        timezone: input.timezone, sendIntervalMs: input.sendIntervalMs, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, cron: input.cron,
        contacts: { create: [...new Set(input.contactIds)].map(contactId => ({ contactId })) },
        segments: { create: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId })) },
        groups: { create: [...new Set(input.groupIds)].map(groupId => ({ groupId })) },
      } });
      await audit("campaign.created", { id: campaign.id });
      return ok(campaign, 201);
    }
    if (id && !await db.campaign.findUnique({ where: { id } })) throw notFound();
    if (method === "GET" && id && !operation) return ok(await db.campaign.findUnique({
      where: { id }, include: { contacts: true, groups: true, segments: true,
        runs: { take: 15, orderBy: { startedAt: "desc" },
          include: { deliveries: { take: 200, orderBy: { updatedAt: "desc" } } } } },
    }));
    if (method === "PATCH" && id && !operation) {
      const current = await db.campaign.findUniqueOrThrow({ where: { id } });
      if (current.status !== "DRAFT") throw new HttpError(409, "Only drafts can be edited");
      const input = campaignInput.parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      if (input.mediaKey) { try { await access(join(process.cwd(), ".uploads", input.mediaKey)); } catch { throw new HttpError(400, "Attachment missing; upload again"); } }
      if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
      const [nContacts, nSegments, nGroups] = await Promise.all([
        db.contact.count({ where: { id: { in: input.contactIds } } }),
        db.segment.count({ where: { id: { in: input.segmentIds } } }),
        db.waGroup.count({ where: { id: { in: input.groupIds }, sessionId: input.sessionId } }),
      ]);
      if (nContacts !== new Set(input.contactIds).size || nSegments !== new Set(input.segmentIds).size || nGroups !== new Set(input.groupIds).size)
        throw new HttpError(400, "Audience contains missing or cross-account targets");
      const updated = await db.campaign.update({ where: { id }, data: {
        name: input.name, message: input.message, sessionId: input.sessionId, mediaKey: input.mediaKey || null,
        mediaMime: input.mediaMime || null, mediaName: input.mediaName || null,
        audienceType: input.audienceType, scheduleType: input.scheduleType, timezone: input.timezone, sendIntervalMs: input.sendIntervalMs,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, cron: input.cron,
        contacts: { deleteMany: {}, create: [...new Set(input.contactIds)].map(contactId => ({ contactId })) },
        segments: { deleteMany: {}, create: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId })) },
        groups: { deleteMany: {}, create: [...new Set(input.groupIds)].map(groupId => ({ groupId })) },
      } });
      await audit("campaign.edited", { id });
      return ok(updated);
    }
    if (method === "GET" && id && operation === "audience") {
      const audience = await getCampaignAudience(id);
      return ok({ count: audience.recipients.length, total: audience.total, duplicates: audience.duplicates,
        excluded: audience.excluded, exclusions: audience.exclusions, sample: audience.recipients.slice(0, 8) });
    }
    if (method === "POST" && id && operation === "relaunch") {
      // A relaunch deliberately creates a NEW one-off campaign. Prior reports and
      // delivery deduplication remain attached to the original campaign.
      const source = await db.campaign.findUnique({
        where: { id }, include: { contacts: true, segments: true, groups: true, session: true },
      });
      if (!source) throw notFound();
      if (!["COMPLETED", "CANCELLED"].includes(source.status))
        throw new HttpError(409, "Relaunch is available for completed or cancelled campaigns. Launch a draft, or pause/resume an active campaign.");
      if (await db.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } }))
        throw new HttpError(409, "An earlier execution is still stopping. Check delivery reports before relaunching.");
      if (source.session.status !== "CONNECTED")
        throw new HttpError(409, "Connect the original sending WhatsApp account before relaunching.");
      if (source.mediaKey) {
        try { await access(join(process.cwd(), ".uploads", source.mediaKey)); }
        catch { throw new HttpError(400, "The original attachment is no longer available. Use Edit to create a draft with a new attachment."); }
      }
      const audience = await getCampaignAudience(id);
      if (!audience.recipients.length) throw new HttpError(400, explainAudienceBlocker(audience));
      if (audience.recipients.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
      await requireWorker(true);

      // Keep a short-lived success guard to prevent double clicks / repeated HTTP
      // submissions from generating multiple copies and double-messaging recipients.
      const redis = redisConnection();
      const lockKey = "campaign:relaunch:guard:" + id;
      let reserved = false;
      let success = false;
      try {
        reserved = (await redis.set(lockKey, "1", "EX", 45, "NX")) === "OK";
        if (!reserved) throw new HttpError(409, "This campaign was just relaunched. Check the campaign list before sending again.");
        const clone = await db.$transaction(async tx => {
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
          const current = await tx.campaign.findUnique({ where: { id }, select: { status: true } });
          if (!current || !["COMPLETED", "CANCELLED"].includes(current.status))
            throw new HttpError(409, "Campaign status changed. Refresh and try again.");
          return tx.campaign.create({ data: {
            name: source.name.slice(0, 85) + " (Relaunch)", message: source.message,
            mediaKey: source.mediaKey, mediaMime: source.mediaMime, mediaName: source.mediaName,
            sessionId: source.sessionId, audienceType: source.audienceType, scheduleType: "NOW",
            timezone: source.timezone, sendIntervalMs: source.sendIntervalMs,
            contacts: { create: source.contacts.map(x => ({ contactId: x.contactId })) },
            segments: { create: source.segments.map(x => ({ segmentId: x.segmentId })) },
            groups: { create: source.groups.map(x => ({ groupId: x.groupId })) },
          } });
        }, { timeout: 30000 });
        const started = await db.campaign.update({ where: { id: clone.id }, data: { status: "ACTIVE" } });
        try { await scheduleCampaign(started); }
        catch {
          await db.campaign.updateMany({ where: { id: clone.id, updatedAt: started.updatedAt, status: "ACTIVE" }, data: { status: "DRAFT" } });
          throw new HttpError(503, "An editable relaunch draft was created, but scheduling failed. Find it in Campaigns and launch manually.");
        }
        await audit("campaign.relaunched", { sourceId: id, campaignId: clone.id, recipients: audience.recipients.length });
        success = true;
        return ok({ campaignId: clone.id, recipients: audience.recipients.length }, 201);
      } finally {
        if (reserved && !success) await redis.del(lockKey);
        redis.disconnect();
      }
    }
    if (method === "POST" && id && operation === "action") {
      const { action } = z.object({ action: z.enum(["launch", "pause", "resume", "cancel"]) }).parse(await payload(req));
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        // The transaction holds only the lifecycle lock. State commits before Redis can
        // start a job, so an immediate send can read the new status and revision.
        const campaign = await db.campaign.findUniqueOrThrow({ where: { id } });
        if (action === "launch") {
          if (campaign.status !== "DRAFT") throw new HttpError(409, "Only draft campaigns may launch");
          const audience = await resolveRecipients(id);
          if (!audience.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
          const timingIssue = scheduleIssue(campaign, estimatedDurationMs(audience.length, Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs)));
          if (timingIssue) throw new HttpError(400, timingIssue);
          if (audience.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
          if (campaign.scheduleType === "ONCE" && (!campaign.scheduledAt || campaign.scheduledAt.getTime() <= Date.now())) throw new HttpError(400, "Scheduled time has passed. Edit the draft and choose a future date.");
          if ((await db.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") throw new HttpError(409, "Connect the sending WhatsApp account before launching");
          await requireWorker(true);
          const status = campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE";
          const changed = await db.campaign.updateMany({ where: { id, status: "DRAFT" }, data: { status } });
          if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
          const scheduled = await db.campaign.findUniqueOrThrow({ where: { id } });
          try { await scheduleCampaign(scheduled); }
          catch (error) { await db.campaign.updateMany({ where: { id, updatedAt: scheduled.updatedAt }, data: { status: "DRAFT" } }); throw error; }
        } else if (action === "pause") {
          if (!["ACTIVE", "SCHEDULED"].includes(campaign.status)) throw new HttpError(409, "Campaign is not active");
          await db.campaign.update({ where: { id }, data: { status: "PAUSED" } });
          await removeSchedule(id);
        } else if (action === "resume") {
          if (campaign.status !== "PAUSED") throw new HttpError(409, "Campaign is not paused");
          if ((await db.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") throw new HttpError(409, "Reconnect the sending WhatsApp account before resuming");
          const recipients = await resolveRecipients(id);
          if (!recipients.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
           if (recipients.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
          const timingIssue = scheduleIssue(campaign, estimatedDurationMs(recipients.length, Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs)));
          if (timingIssue) throw new HttpError(400, timingIssue);
          await requireWorker(true);
          const changed = await db.campaign.updateMany({ where: { id, status: "PAUSED" }, data: { status: campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE" } });
          if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
          const scheduled = await db.campaign.findUniqueOrThrow({ where: { id } });
          try { await scheduleCampaign(scheduled); }
          catch (error) { await db.campaign.updateMany({ where: { id, updatedAt: scheduled.updatedAt }, data: { status: "PAUSED" } }); throw error; }
        } else {
          if (!["ACTIVE", "SCHEDULED", "PAUSED"].includes(campaign.status))
            throw new HttpError(409, "Only active, scheduled or paused campaigns can be cancelled.");
          await db.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
          await removeSchedule(id);
        }
      }, { timeout: 30000 });
      await audit("campaign." + action, { id });
      return ok(await db.campaign.findUnique({ where: { id } }));
    }
    if (method === "DELETE" && id && !operation) {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        const item = await tx.campaign.findUnique({ where: { id }, include: { _count: { select: { runs: true } } } });
        if (!item) throw notFound();
        if (!["DRAFT", "COMPLETED", "CANCELLED"].includes(item.status))
          throw new HttpError(409, "Cancel the active, scheduled or paused campaign before deleting it.");
        if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } }))
          throw new HttpError(409, "A delivery is still stopping. Retry deletion after its run finishes.");
        await removeSchedule(id);
        await tx.campaign.delete({ where: { id } });
        await tx.auditLog.create({ data: { action: "campaign.deleted", details: {
          id, name: item.name, status: item.status, deletedRuns: item._count.runs,
        } } });
      }, { timeout: 30000 });
      return ok({ success: true });
    }
  }
  if (resource === "runs" && method === "GET") {
    return ok(await db.campaignRun.findMany({ take: 100, orderBy: { startedAt: "desc" },
      include: { campaign: { select: { name: true } },
        deliveries: { select: { status: true } } } }));
  }
  if (resource === "audit" && method === "GET") return ok(await db.auditLog.findMany({ take: 100, orderBy: { createdAt: "desc" } }));
  if (resource === "health" && method === "GET") {
    const redis = redisConnection();
    try {
      const [ping, workers, deliveryWorkers] = await Promise.all([redis.ping(), operations.getWorkers(), campaigns.getWorkers()]);
      return ok({ database: "connected", redis: ping, workers, deliveryWorkers, workerReady: workers.length > 0 && deliveryWorkers.length > 0 });
    }
    finally { await redis.quit(); }
  }
  throw notFound();
}
export async function GET(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function POST(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function PATCH(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function DELETE(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
