import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { operations, campaigns, command, removeSchedule, scheduleCampaign, redisConnection } from "@/lib/queue";
import { campaignInput, contactInput, segmentInput, sessionInput, schedulePreview, scheduleIssue, hasConsentEvidence } from "@/lib/campaign";
import { HttpError, ok, payload, rejectCrossOrigin, requireUser, respondError } from "@/lib/http";
import { resolveAudience, resolveRecipients, getCampaignAudience, explainAudienceBlocker } from "@/lib/audience";
import { z } from "zod";
import { campaignLimit, configuration } from "@/lib/config";
import { groupSyncStateKey, syncStateKey, type SyncState } from "@/lib/sync-state";

import { contactFilterInput, contactWhere } from "@/lib/contact-selection";
import { bulkSegmentInput, organizeContacts } from "@/lib/segments";
import { bulkConsentInput, recordBulkOptIn } from "@/lib/consent";
import { deliveryTotals } from "@/lib/reporting";
import { campaignDeliverySummaries, runDeliverySummaries, combineDeliverySummaries, recordedOptOutsForRuns } from "@/lib/reporting-data";
import { isEligible } from "@/lib/campaign";
import { accountKey, activeSendingHold, closeDeferredRuns, holdSending, reviewSendingHold, sendingSafetySummary, WORKSPACE_HOLD } from "@/lib/sending-safety";
import { DAY, minimumCampaignDuration, sendingPolicy } from "@/lib/sending-policy";
import { MISSING_SENDER_NAME, campaignMessage, publicSenderName } from "@/lib/message";

type Params = { params: Promise<{ path: string[] }> };
const notFound = () => new HttpError(404, "Resource not found");
async function requireWorker(delivery = false) {
  if (!(await (delivery ? campaigns : operations).getWorkers()).length) throw new HttpError(503, "Background worker is offline. Start npm run dev:all or npm run worker.");
}
async function audit(action: string, details?: object) {
  await db.auditLog.create({ data: { action, details: details ?? {} } });
}
async function checkSendingAccount(sessionId: string, audienceType = "CONTACTS") {
  const session = await db.waSession.findUniqueOrThrow({ where: { id: sessionId } });
  if (audienceType === "CONTACTS" && !publicSenderName(session, sendingPolicy().businessName))
    throw new HttpError(400, MISSING_SENDER_NAME);
  const hold = await activeSendingHold(accountKey(session), sessionId);
  if (hold) throw new HttpError(423, "Campaign sending is on hold: " + hold.reason + " Review it in Settings after checking WhatsApp.");
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
    if (method === "GET" && !id) return ok(await sendingSafetySummary());
    if (method === "POST" && id === "hold") {
      const input = z.object({ sessionId: z.string().min(1).optional(), reason: z.string().trim().min(10).max(400), restriction: z.boolean().default(false) }).parse(await payload(req));
      const key = input.sessionId ? accountKey(await db.waSession.findUniqueOrThrow({ where: { id: input.sessionId } })) : WORKSPACE_HOLD;
      const count = await holdSending(key, input.reason, input.restriction ? new Date(Date.now() + DAY) : null);
      return ok({ pausedCampaigns: count });
    }
    if (method === "POST" && id === "review") {
      const input = z.object({ accountKey: z.string().min(1), confirmed: z.literal(true), note: z.string().trim().min(10).max(500) }).parse(await payload(req));
      try { await reviewSendingHold(input.accountKey, input.note); }
      catch (error) { throw new HttpError(423, error instanceof Error ? error.message : "Sending review failed"); }
      return ok({ reviewed: true, message: "Hold reviewed. Campaigns remain paused until you resume them; sending budgets and frequency limits still apply." });
    }
    throw notFound();
  }
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
      const holds = await db.sendingHold.findMany({ where: { releasedAt: null } });
      const withSafety = sessions.map(session => ({ ...session, accountKey: accountKey(session),
        sendingHold: holds.find(hold => [WORKSPACE_HOLD, accountKey(session), "session:" + session.id].includes(hold.accountKey)) || null }));
      const redis = redisConnection();
      try {
        const queue = process.env.QUEUE_NAME || "campaign-operations";
        const states = sessions.length ? await redis.mget(...sessions.map(session => syncStateKey(queue, session.id))) : [];
        return ok(withSafety.map((session, index) => ({ ...session, sync: states[index] ? JSON.parse(states[index]!) as SyncState : null })));
      } catch { return ok(withSafety.map(session => ({ ...session, sync: null }))); }
      finally { redis.disconnect(); }
    }
    if (method === "POST" && !id) {
      const input = sessionInput.parse(await payload(req));
      const session = await db.waSession.create({ data: { label: input.label, publicSenderName: input.publicSenderName || null } });
      await audit("session.created", { sessionId: session.id });
      return ok(session, 201);
    }
    if (!id || !await db.waSession.findUnique({ where: { id } })) throw notFound();
    if (method === "PATCH" && !operation) {
      const input = sessionInput.parse(await payload(req));
      const previous = await db.waSession.findUniqueOrThrow({ where: { id } });
      const updated = await db.waSession.update({ where: { id }, data: {
        label: input.label, publicSenderName: input.publicSenderName || null,
      } });
      await audit("session.settings_updated", { sessionId: id, previousLabel: previous.label, label: updated.label,
        senderIdentityChanged: previous.publicSenderName !== updated.publicSenderName });
      return ok(updated);
    }
    if (operation === "reconcile-history" && ["GET", "POST"].includes(method)) {
      const redis = redisConnection();
      const key = "history:status:" + id;
      try {
        if (method === "GET") {
          const state = await redis.get(key);
          return ok(state ? JSON.parse(state) as object : { phase: "IDLE" });
        }
        const session = await db.waSession.findUniqueOrThrow({ where: { id } });
        if (session.status !== "CONNECTED") throw new HttpError(409, "Connect this WhatsApp account before checking its saved message history.");
        await requireWorker();
        if (await redis.set(key + ":queued", "1", "EX", 900, "NX") !== "OK")
          return ok({ queued: true, message: "Reconciliation is already queued or running for this account." }, 202);
        await redis.set(key, JSON.stringify({ phase: "QUEUED", message: "Reconciliation queued. No messages will be sent.",
          updatedAt: new Date().toISOString() }), "EX", 86400);
        try { await command("reconcile-history", { sessionId: id }); }
        catch (error) { await redis.del(key, key + ":queued"); throw error; }
        return ok({ queued: true, message: "Read-only WhatsApp history reconciliation queued." }, 202);
      } finally { redis.disconnect(); }
    }
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
        [...url.searchParams.entries()].filter(([key]) => ["search", "sessionId", "groupId", "segmentId", "consent", "source", "unsegmented", "phoneAvailability", "destinationAvailability"].includes(key))
          .map(([key, value]) => [key, key === "unsegmented" ? value === "true" : value]),
      ));
      const where = contactWhere(filter);
      if (url.searchParams.get("eligible") === "true") {
        const suppressed = await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] });
        where.consent = "OPTED_IN";
        where.consentAt = { not: null };
        where.consentNote = { not: "" };
        const valid = await db.$queryRaw<{ whatsappId: string }[]>`SELECT DISTINCT "whatsappId" FROM "Contact" WHERE "whatsappId" ~ '^([0-9]{8,15}@c[.]us|[0-9]{1,30}@lid)$'`;
        where.AND = [{ whatsappId: { in: valid.map(c => c.whatsappId) } }, { NOT: { whatsappId: { in: suppressed.map(c => c.whatsappId) } } }];
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
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
        const old = await tx.contact.findUnique({ where: { id } });
        if (!old) throw notFound();
        if (input.consent === "OPTED_IN" && !isEligible("OPTED_IN", old.whatsappId))
          throw new HttpError(400, "This contact has an invalid WhatsApp destination. Sync its identifier before recording opt-in. A phone number is not required for private WhatsApp IDs.");
        if (input.consent === "OPTED_IN" && await tx.contact.count({ where: { whatsappId: old.whatsappId, consent: "OPTED_OUT" } }))
          throw new HttpError(409, "This WhatsApp contact opted out. Suppression cannot be silently overridden.");
        await tx.contact.updateMany({ where: { whatsappId: old.whatsappId, ...(input.consent !== "OPTED_OUT" ? { consent: { not: "OPTED_OUT" } } : {}) }, data: {
          consent: input.consent, consentNote: input.consentNote,
          consentAt: input.consent === "OPTED_IN" ? new Date() : null,
        } });
        await tx.auditLog.create({ data: { action: "contact.consent_changed", details: { id, from: old.consent, to: input.consent } } });
      });
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
      const input = z.object({ segmentIds: z.array(z.string().min(1)).max(100).default([]), newSegment: segmentInput.optional() }).parse(await payload(req));
      if (input.newSegment && await db.segment.findUnique({ where: { name: input.newSegment.name } }))
        throw new HttpError(409, "A segment with that name already exists. Select it below or choose another name.");
      const segmentIds = [...new Set(input.segmentIds)];
      if (await db.segment.count({ where: { id: { in: segmentIds } } }) !== segmentIds.length) throw new HttpError(400, "One or more segments no longer exist");
      const redis = redisConnection();
      const key = groupSyncStateKey(process.env.QUEUE_NAME || "campaign-operations", id);
      try {
        const locked = await redis.set(key + ":queued", "1", "EX", 600, "NX");
        if (!locked) throw new HttpError(409, "This group is already being saved. Wait for it to finish before choosing segments.");
        await redis.set(key, JSON.stringify({ phase: "QUEUED", kind: "members", message: "Saving group contacts queued…", updatedAt: new Date().toISOString() } satisfies SyncState), "EX", 86400);
        try { await command("sync-group-members", { groupId: id, segmentIds, newSegment: input.newSegment }); }
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
    if (method === "GET" && !id) {
      // Count unique sendable destinations with exactly the same rules as preview/send.
      const segments = await db.segment.findMany({ include: { _count: { select: { members: true } } }, orderBy: { createdAt: "desc" } });
      const suppressed = new Set((await db.contact.findMany({ where: { consent: "OPTED_OUT" }, select: { whatsappId: true }, distinct: ["whatsappId"] })).map(c => c.whatsappId));
      const memberships = await db.segmentMember.findMany({ select: { segmentId: true, contact: { select: { consent: true, whatsappId: true, consentAt: true, consentNote: true } } } });
      const eligible = new Map<string, Set<string>>();
      for (const member of memberships) {
        const contact = member.contact;
        if (!isEligible(contact.consent, contact.whatsappId) || !hasConsentEvidence(contact) || suppressed.has(contact.whatsappId)) continue;
        const phones = eligible.get(member.segmentId) || new Set<string>();
        phones.add(contact.whatsappId); eligible.set(member.segmentId, phones);
      }
      return ok(segments.map(segment => ({ ...segment, eligibleCount: eligible.get(segment.id)?.size || 0 })));
    }
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
    // Serialize lifecycle changes through the database commit AND queue update.
    // Otherwise a late launch scheduler can overwrite a newer pause/resume.
    const lifecycleRedis = id && !["preview", "recipients"].includes(id) && method !== "GET" ? redisConnection() : null;
    const lifecycleKey = "campaign:lifecycle:" + id;
    const lifecycleToken = randomUUID();
    let ownsLifecycle = false;
    try {
      if (lifecycleRedis) {
        ownsLifecycle = await lifecycleRedis.set(lifecycleKey, lifecycleToken, "EX", 60, "NX") === "OK";
        if (!ownsLifecycle) throw new HttpError(409, "This campaign is being updated. Wait a moment, then refresh.");
      }
    if (method === "POST" && id === "recipients" && !operation) {
      const input = z.object({
        audienceType: z.enum(["CONTACTS", "GROUPS"]),
        sessionId: z.string().min(1),
        contactIds: z.array(z.string()).max(1500).default([]),
        segmentIds: z.array(z.string()).max(100).default([]),
        groupIds: z.array(z.string()).max(100).default([]),
        page: z.number().int().min(1).max(10000).default(1),
        take: z.number().int().min(1).max(50).default(15),
        search: z.string().trim().max(120).default(""),
      }).parse(await payload(req));
      const audience = await resolveAudience(input);
      const term = input.search.toLocaleLowerCase();
      const matches = term ? audience.recipients.filter(recipient =>
        [recipient.label, recipient.phone, recipient.chatId, ...(recipient.sources || [])]
          .some(value => value?.toLocaleLowerCase().includes(term))) : audience.recipients;
      const offset = (input.page - 1) * input.take;
      return ok({
        count: audience.recipients.length, limit: campaignLimit(), total: audience.total, excluded: audience.excluded,
        duplicates: audience.duplicates, exclusions: audience.exclusions,
        page: input.page, take: input.take, matched: matches.length,
        items: matches.slice(offset, offset + input.take).map(recipient => ({
          key: recipient.key, label: recipient.label, phone: recipient.phone,
          chatId: recipient.chatId, sources: recipient.sources || [],
        })),
      });
    }
    if (method === "POST" && id === "preview" && !operation) {
      const input = campaignInput.parse(await payload(req));
      const audience = await resolveAudience(input);
      const policy = sendingPolicy();
      const intervalMs = Math.max(configuration().SEND_INTERVAL_MS, input.sendIntervalMs, policy.minimumIntervalMs);
      const durationMs = minimumCampaignDuration(audience.recipients.length, intervalMs, policy);
      const session = await db.waSession.findUniqueOrThrow({ where: { id: input.sessionId } });
      const [safety, hold, contacted] = await Promise.all([sendingSafetySummary(), activeSendingHold(accountKey(session), session.id),
        db.sendAttempt.findMany({ where: { attemptedAt: { gt: new Date(Date.now() - policy.contactCooldownMs) },
          recipientKeys: { hasSome: audience.recipients.map(recipient => (recipient.contactId ? "contact:" : "group:") + recipient.chatId) } }, select: { recipientKeys: true } })]);
      const recentKeys = new Set(contacted.flatMap(item => item.recipientKeys));
      const senderName = publicSenderName(session, policy.businessName);
      const missingIdentity = input.audienceType === "CONTACTS" && !senderName;
      // Preview a placeholder only; no worker can send it as a real identity.
      const messagePreview = missingIdentity
        ? input.message.trim() + "\n\n[Public sender name required]\nReply STOP to unsubscribe."
        : campaignMessage(input.message, senderName, input.audienceType === "CONTACTS");
      return ok({ count: audience.recipients.length, total: audience.total, duplicates: audience.duplicates, excluded: audience.excluded,
        exclusions: audience.exclusions, sample: audience.recipients.slice(0, 8), intervalMs, durationMs, limit: campaignLimit(),
        nextRuns: schedulePreview(input), scheduleIssue: missingIdentity ? MISSING_SENDER_NAME
          : messagePreview.length > 4096 ? "Shorten the message to leave room for the sender and unsubscribe footer." : scheduleIssue(input, durationMs),
        senderName: senderName || null, messagePreview, safety: { ...safety, hold, frequencyLimited: audience.recipients.filter(recipient => recentKeys.has((recipient.contactId ? "contact:" : "group:") + recipient.chatId)).length } });
    }
    if (method === "GET" && !id) {
      const items = await db.campaign.findMany({
      include: { session: { select: { label: true, status: true } },
        _count: { select: { contacts: true, groups: true, segments: true, runs: true } },
        runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true } } },
      orderBy: { createdAt: "desc" },
      });
      const [summaries, latest] = await Promise.all([
        campaignDeliverySummaries(items.map(item => item.id)), runDeliverySummaries(items.flatMap(item => item.runs.map(run => run.id))),
      ]);
      return ok(items.map(item => ({ ...item, summary: summaries.get(item.id) ?? deliveryTotals([]),
        runs: item.runs.map(run => ({ ...run, summary: latest.get(run.id) ?? deliveryTotals([]) })),
      })));
    }
    if (method === "POST" && !id) {
      const input = campaignInput.parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      if (input.mediaKey) { try { await access(join(process.cwd(), ".uploads", input.mediaKey)); } catch { throw new HttpError(400, "Attachment missing; upload it again"); } }
      if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
      const [contactCount, segmentCount, groupCount] = await Promise.all([
        db.contact.count({ where: { id: { in: input.contactIds } } }),
        db.segment.count({ where: { id: { in: input.segmentIds } } }),
        db.waGroup.count({ where: { id: { in: input.groupIds }, ...(input.audienceType === "GROUPS" ? { sessionId: input.sessionId } : {}) } }),
      ]);
      if (contactCount !== new Set(input.contactIds).size ||
          segmentCount !== new Set(input.segmentIds).size ||
          groupCount !== new Set(input.groupIds).size)
        throw new HttpError(400, "Audience contains missing contacts, segments, or groups, or group destinations from the wrong sender account");
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
    if (method === "GET" && id && !operation) {
      const [detail, summaries] = await Promise.all([db.campaign.findUnique({
      where: { id }, include: { contacts: true, groups: true, segments: true, _count: { select: { runs: true } },
        runs: { take: 15, ...(url.searchParams.get("runId") ? { where: { id: url.searchParams.get("runId")! } } : {}), orderBy: { startedAt: "desc" },
          include: { deliveries: { orderBy: { updatedAt: "desc" }, include: { replies: { orderBy: { receivedAt: "desc" } }, _count: { select: { replies: true } } } } } } },
      }), campaignDeliverySummaries([id])]);
      const optOuts = await recordedOptOutsForRuns(detail?.runs.map(run => run.id) ?? []);
      return ok({ ...detail, runs: detail?.runs.map(run => ({ ...run,
        deliveries: run.deliveries.map(delivery => ({ ...delivery, optedOutAt: optOuts.get(delivery.id) ?? null })),
      })), summary: summaries.get(id) ?? deliveryTotals([]) });
    }
    if (method === "PATCH" && id && !operation) {
      const current = await db.campaign.findUniqueOrThrow({ where: { id } });
      if (!["DRAFT", "COMPLETED", "CANCELLED", "PAUSED"].includes(current.status)) throw new HttpError(409, "Pause this campaign before editing it");
      const input = campaignInput.parse(await payload(req));
      if (!await db.waSession.findUnique({ where: { id: input.sessionId } })) throw notFound();
      if (input.mediaKey) { try { await access(join(process.cwd(), ".uploads", input.mediaKey)); } catch { throw new HttpError(400, "Attachment missing; upload again"); } }
      if (!!input.mediaKey !== !!input.mediaMime) throw new HttpError(400, "Attachment metadata missing");
      const [nContacts, nSegments, nGroups] = await Promise.all([
        db.contact.count({ where: { id: { in: input.contactIds } } }),
        db.segment.count({ where: { id: { in: input.segmentIds } } }),
        db.waGroup.count({ where: { id: { in: input.groupIds }, ...(input.audienceType === "GROUPS" ? { sessionId: input.sessionId } : {}) } }),
      ]);
      if (nContacts !== new Set(input.contactIds).size || nSegments !== new Set(input.segmentIds).size || nGroups !== new Set(input.groupIds).size)
        throw new HttpError(400, "Audience contains missing contacts, segments, or groups, or group destinations from the wrong sender account");
      const updated = await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        const latest = await tx.campaign.findUniqueOrThrow({ where: { id } });
        if (latest.updatedAt.getTime() !== current.updatedAt.getTime()) throw new HttpError(409, "Campaign changed. Reopen the editor to get the latest version.");
        if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } })) throw new HttpError(409, "The previous run is still stopping. Wait for it to finish before editing.");
        await removeSchedule(id);
        return tx.campaign.update({ where: { id }, data: {
        status: current.status === "PAUSED" ? "PAUSED" : "DRAFT",
        name: input.name, message: input.message, sessionId: input.sessionId, mediaKey: input.mediaKey || null,
        mediaMime: input.mediaMime || null, mediaName: input.mediaName || null,
        audienceType: input.audienceType, scheduleType: input.scheduleType, timezone: input.timezone, sendIntervalMs: input.sendIntervalMs,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, cron: input.cron,
        contacts: { deleteMany: {}, create: [...new Set(input.contactIds)].map(contactId => ({ contactId })) },
        segments: { deleteMany: {}, create: [...new Set(input.segmentIds)].map(segmentId => ({ segmentId })) },
        groups: { deleteMany: {}, create: [...new Set(input.groupIds)].map(groupId => ({ groupId })) },
      } });
      }, { timeout: 30000 });
      await audit("campaign.edited", { id });
      return ok(updated);
    }
    if (method === "GET" && id && operation === "audience") {
      const audience = await getCampaignAudience(id);
      return ok({ count: audience.recipients.length, total: audience.total, duplicates: audience.duplicates,
        excluded: audience.excluded, exclusions: audience.exclusions, sample: audience.recipients.slice(0, 8) });
    }
    if (method === "POST" && id && operation === "reconcile") {
      const input = z.object({ deliveryId: z.string().min(1), note: z.string().trim().min(10).max(500), confirmed: z.literal(true) }).parse(await payload(req));
      const result = await db.$transaction(async tx => {
        const delivery = await tx.delivery.findFirst({ where: { id: input.deliveryId, run: { campaignId: id } } });
        if (!delivery) throw notFound();
        if (delivery.status !== "UNKNOWN") throw new HttpError(409, "Only an unconfirmed send can be confirmed manually. Refresh the results.");
        const attempt = await tx.sendAttempt.findUnique({ where: { deliveryId: delivery.id } });
        const changed = await tx.delivery.updateMany({ where: { id: delivery.id, status: "UNKNOWN" }, data: {
          status: "SENT", sentAt: delivery.sentAt ?? attempt?.attemptedAt ?? new Date(),
          error: "Manually confirmed sent in WhatsApp. Delivery and read receipts remain unavailable until received.",
        } });
        if (!changed.count) throw new HttpError(409, "A WhatsApp receipt just updated this result. Refresh the results.");
        await tx.sendAttempt.updateMany({ where: { deliveryId: delivery.id, outcome: "UNKNOWN" }, data: { outcome: "SENT" } });
        await tx.auditLog.create({ data: { action: "delivery.manually_confirmed_sent", details: {
          campaignId: id, runId: delivery.runId, deliveryId: delivery.id, previousStatus: "UNKNOWN", note: input.note,
        } } });
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
          if (!["COMPLETED", "CANCELLED"].includes(source.status)) throw new HttpError(409, "Launch the draft or resume the paused campaign. Relaunch is for completed or cancelled campaigns.");
          if (await tx.campaignRun.count({ where: { campaignId: id, status: "RUNNING" } })) throw new HttpError(409, "An earlier execution is still stopping. Wait for it to finish.");
          if (source.session.status !== "CONNECTED") throw new HttpError(409, "Connect the sending WhatsApp account before relaunching.");
          await checkSendingAccount(source.sessionId, source.audienceType);
          if (source.mediaKey) { try { await access(join(process.cwd(), ".uploads", source.mediaKey)); } catch { throw new HttpError(400, "Attachment missing. Edit this campaign and upload it again."); } }
          const audience = await getCampaignAudience(id);
          count = audience.recipients.length;
          if (!count) throw new HttpError(400, explainAudienceBlocker(audience));
          if (count > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
          await requireWorker(true);
          await removeSchedule(id);
          return tx.campaign.update({ where: { id }, data: { status: "ACTIVE", scheduleType: "NOW", scheduledAt: null, cron: null, runsCompleted: false, launchVersion: { increment: 1 } } });
        }, { timeout: 30000 });
        // Commit state before an immediate queue job can start reading it.
        try { await scheduleCampaign(started); }
        catch { await db.campaign.updateMany({ where: { id, updatedAt: started.updatedAt, status: "ACTIVE" }, data: { status: "PAUSED" } }); throw new HttpError(503, "Scheduling failed. This campaign is paused; resume it to retry."); }
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
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        // The transaction holds only the lifecycle lock. State commits before Redis can
        // start a job, so an immediate send can read the new status and revision.
        const campaign = await tx.campaign.findUniqueOrThrow({ where: { id } });
        if (action === "launch") {
          if (campaign.status !== "DRAFT") throw new HttpError(409, "Only draft campaigns may launch");
          const audience = await resolveRecipients(id);
          if (!audience.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
          await checkSendingAccount(campaign.sessionId, campaign.audienceType);
          const timingIssue = scheduleIssue(campaign, minimumCampaignDuration(audience.length, Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs), sendingPolicy()));
          if (timingIssue) throw new HttpError(400, timingIssue);
          if (audience.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
          if (campaign.scheduleType === "ONCE" && (!campaign.scheduledAt || campaign.scheduledAt.getTime() <= Date.now())) throw new HttpError(400, "Scheduled time has passed. Edit the draft and choose a future date.");
          if ((await tx.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") throw new HttpError(409, "Connect the sending WhatsApp account before launching");
          await requireWorker(true);
          const status = campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE";
          const changed = await tx.campaign.updateMany({ where: { id, status: "DRAFT" }, data: { status, runsCompleted: false, launchVersion: { increment: 1 } } });
          if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
          queued = await tx.campaign.findUniqueOrThrow({ where: { id } });
        } else if (action === "pause") {
          if (!["ACTIVE", "SCHEDULED"].includes(campaign.status)) throw new HttpError(409, "Campaign is not active");
          await tx.campaign.update({ where: { id }, data: { status: "PAUSED" } });
          await closeDeferredRuns(tx, [id], "Campaign paused while waiting for its sending window");
          await removeSchedule(id);
        } else if (action === "resume") {
          if (!["PAUSED", "DRAFT"].includes(campaign.status)) throw new HttpError(409, "Campaign is not paused");
          if (campaign.status === "DRAFT" && (!campaign.launchVersion || campaign.runsCompleted)) throw new HttpError(409, "Campaign has not been launched yet. Launch this draft instead.");
          if ((await tx.waSession.findUnique({ where: { id: campaign.sessionId } }))?.status !== "CONNECTED") throw new HttpError(409, "Reconnect the sending WhatsApp account before resuming");
          const recipients = await resolveRecipients(id);
          if (!recipients.length) throw new HttpError(400, explainAudienceBlocker(await getCampaignAudience(id)));
           if (recipients.length > campaignLimit()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
          await checkSendingAccount(campaign.sessionId, campaign.audienceType);
          const timingIssue = scheduleIssue(campaign, minimumCampaignDuration(recipients.length, Math.max(configuration().SEND_INTERVAL_MS, campaign.sendIntervalMs), sendingPolicy()));
          if (timingIssue) throw new HttpError(400, timingIssue);
          await requireWorker(true);
          const changed = await tx.campaign.updateMany({ where: { id, status: campaign.status }, data: { status: campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE" } });
          if (!changed.count) throw new HttpError(409, "Campaign was already changed. Refresh and try again.");
          queued = await tx.campaign.findUniqueOrThrow({ where: { id } });
          fallback = campaign.status === "PAUSED" ? "PAUSED" : "DRAFT";
        } else {
          if (!["ACTIVE", "SCHEDULED", "PAUSED"].includes(campaign.status))
            throw new HttpError(409, "Only active, scheduled or paused campaigns can be cancelled.");
          await tx.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
          await closeDeferredRuns(tx, [id], "Campaign cancelled while waiting for its sending window");
          await removeSchedule(id);
        }
      }, { timeout: 30000 });
      if (queued) {
        const scheduled = queued as Awaited<ReturnType<typeof db.campaign.findUniqueOrThrow>>;
        try { await scheduleCampaign(scheduled); }
        catch (error) {
          await db.campaign.updateMany({ where: { id, updatedAt: scheduled.updatedAt }, data: { status: fallback } });
          throw error;
        }
        // A concurrent pause/edit can commit while Redis is scheduling; stale jobs
        // cannot send because workers check the revision, and its scheduler is removed.
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
    } finally {
      if (lifecycleRedis) {
        try { if (ownsLifecycle) await lifecycleRedis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lifecycleKey, lifecycleToken); }
        finally { lifecycleRedis.disconnect(); }
      }
    }
  }
  if (resource === "report-summary" && method === "GET" && !id) {
    return ok(combineDeliverySummaries((await campaignDeliverySummaries()).values()));
  }
  if (resource === "runs" && method === "GET") {
    const runs = await db.campaignRun.findMany({ take: 100, orderBy: { startedAt: "desc" },
      include: { campaign: { select: { name: true } },
        deliveries: { select: { id: true, status: true, replies: { where: { isOptOut: true }, select: { isOptOut: true } }, _count: { select: { replies: true } } } } } });
    const optOuts = await recordedOptOutsForRuns(runs.map(run => run.id));
    return ok(runs.map(run => ({ ...run, deliveries: run.deliveries.map(delivery => ({ ...delivery, optedOutAt: optOuts.get(delivery.id) ?? null })) })));
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
