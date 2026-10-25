import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { operations, command, removeSchedule, scheduleCampaign, redisConnection } from "@/lib/queue";
import { campaignInput, contactInput, segmentInput, sessionInput } from "@/lib/campaign";
import { HttpError, ok, payload, rejectCrossOrigin, requireUser, respondError } from "@/lib/http";
import { resolveRecipients } from "@/lib/audience";
import { z } from "zod";

type Params = { params: Promise<{ path: string[] }> };
const cap = () => Number(process.env.MAX_CAMPAIGN_RECIPIENTS || "200");
const notFound = () => new HttpError(404, "Resource not found");
async function audit(action: string, details?: object) {
  await db.auditLog.create({ data: { action, details: details ?? {} } });
}
async function route(req: NextRequest, p: Params) {
  await requireUser(req);
  rejectCrossOrigin(req);
  const [resource, id, operation] = (await p.params).path;
  const method = req.method;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") || undefined;
  const search = url.searchParams.get("search")?.trim() || "";
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
    if (method === "GET" && !id)
      return ok(await db.waSession.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { contacts: true, groups: true } } } }));
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
      await command(operation === "sync" ? "sync" : operation, { sessionId: id });
      return ok({ queued: true }, 202);
    }
  }
  if (resource === "contacts") {
    if (method === "GET" && !id) {
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const take = Math.min(100, Math.max(1, Number(url.searchParams.get("take")) || 40));
      const consent = url.searchParams.get("consent");
      const groupId = url.searchParams.get("groupId");
      const where = {
        ...(sessionId && { sessionId }),
        ...(groupId && { members: { some: { groupId } } }),
        ...(consent && ["UNKNOWN", "OPTED_IN", "OPTED_OUT"].includes(consent) && { consent: consent as "UNKNOWN" | "OPTED_IN" | "OPTED_OUT" }),
        ...(search && { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { phone: { contains: search } }] }),
      };
      const [items, total] = await Promise.all([
        db.contact.findMany({ where, orderBy: { name: "asc" }, skip: (page - 1) * take, take, include: { session: { select: { label: true } } } }),
        db.contact.count({ where }),
      ]);
      return ok({ items, total, page, take });
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
      const updated = await db.contact.update({ where: { id }, data: {
        consent: input.consent, consentNote: input.consentNote,
        consentAt: input.consent === "OPTED_IN" ? new Date() : null,
      } });
      await audit("contact.consent_changed", { id, from: old.consent, to: input.consent });
      return ok(updated);
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
      return ok(await db.waGroup.findMany({ where: sessionId ? { sessionId } : {},
        include: { session: { select: { label: true } }, _count: { select: { members: true } } }, orderBy: { name: "asc" } }));
    }
    if (method === "POST" && id && operation === "sync-members") {
      const group = await db.waGroup.findUnique({ where: { id } });
      if (!group) throw notFound();
      await command("sync-group-members", { groupId: id });
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
    if (method === "GET" && !id) return ok(await db.segment.findMany({
      include: { _count: { select: { members: true } } }, orderBy: { createdAt: "desc" },
    }));
    if (method === "POST" && !id) return ok(await db.segment.create({ data: segmentInput.parse(await payload(req)) }), 201);
    if (id && !await db.segment.findUnique({ where: { id } })) throw notFound();
    if (method === "GET" && id) return ok(await db.segment.findUnique({
      where: { id }, include: { members: { include: { contact: true }, take: 500 } },
    }));
    if (method === "POST" && id && operation === "members") {
      const input = z.object({ contactIds: z.array(z.string()).max(2000), action: z.enum(["add", "remove"]).default("add") }).parse(await payload(req));
      if (input.action === "add") {
        const count = await db.contact.count({ where: { id: { in: input.contactIds } } });
        if (count !== new Set(input.contactIds).size) throw new HttpError(400, "One or more contacts not found");
        await db.segmentMember.createMany({ data: input.contactIds.map(contactId => ({ segmentId: id, contactId })), skipDuplicates: true });
      } else {
        await db.segmentMember.deleteMany({ where: { segmentId: id, contactId: { in: input.contactIds } } });
      }
      return ok({ success: true });
    }
    if (method === "DELETE" && id && !operation) {
      await db.segment.delete({ where: { id } });
      return ok({ success: true });
    }
  }
  if (resource === "campaigns") {
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
        db.contact.count({ where: { id: { in: input.contactIds }, sessionId: input.sessionId } }),
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
        timezone: input.timezone, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, cron: input.cron,
        contacts: { create: input.contactIds.map(contactId => ({ contactId })) },
        segments: { create: input.segmentIds.map(segmentId => ({ segmentId })) },
        groups: { create: input.groupIds.map(groupId => ({ groupId })) },
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
        db.contact.count({ where: { id: { in: input.contactIds }, sessionId: input.sessionId } }),
        db.segment.count({ where: { id: { in: input.segmentIds } } }),
        db.waGroup.count({ where: { id: { in: input.groupIds }, sessionId: input.sessionId } }),
      ]);
      if (nContacts !== new Set(input.contactIds).size || nSegments !== new Set(input.segmentIds).size || nGroups !== new Set(input.groupIds).size)
        throw new HttpError(400, "Audience contains missing or cross-account targets");
      const updated = await db.campaign.update({ where: { id }, data: {
        name: input.name, message: input.message, sessionId: input.sessionId, mediaKey: input.mediaKey || null,
        mediaMime: input.mediaMime || null, mediaName: input.mediaName || null,
        audienceType: input.audienceType, scheduleType: input.scheduleType, timezone: input.timezone,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, cron: input.cron,
        contacts: { deleteMany: {}, create: input.contactIds.map(contactId => ({ contactId })) },
        segments: { deleteMany: {}, create: input.segmentIds.map(segmentId => ({ segmentId })) },
        groups: { deleteMany: {}, create: input.groupIds.map(groupId => ({ groupId })) },
      } });
      await audit("campaign.edited", { id });
      return ok(updated);
    }
    if (method === "GET" && id && operation === "audience") {
      const recipients = await resolveRecipients(id);
      return ok({ count: recipients.length, sample: recipients.slice(0, 8) });
    }
    if (method === "POST" && id && operation === "action") {
      const { action } = z.object({ action: z.enum(["launch", "pause", "resume", "cancel"]) }).parse(await payload(req));
      const campaign = await db.campaign.findUniqueOrThrow({ where: { id } });
      if (action === "launch") {
        if (campaign.status !== "DRAFT") throw new HttpError(409, "Only draft campaigns may launch");
        const audience = await resolveRecipients(id);
        if (!audience.length) throw new HttpError(400, "No eligible recipients. Obtain opt-in or authorize groups first.");
        if (audience.length > cap()) throw new HttpError(400, "Audience exceeds configured campaign safety limit");
        const status = campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE";
        await db.campaign.update({ where: { id }, data: { status } });
        try { await scheduleCampaign(campaign); }
        catch (error) { await db.campaign.update({ where: { id }, data: { status: "DRAFT" } }); throw error; }
      } else if (action === "pause") {
        if (!["ACTIVE", "SCHEDULED"].includes(campaign.status)) throw new HttpError(409, "Campaign is not active");
        await db.campaign.update({ where: { id }, data: { status: "PAUSED" } });
        await removeSchedule(id);
      } else if (action === "resume") {
        if (campaign.status !== "PAUSED") throw new HttpError(409, "Campaign is not paused");
        await db.campaign.update({ where: { id }, data: { status: campaign.scheduleType === "ONCE" ? "SCHEDULED" : "ACTIVE" } });
        await scheduleCampaign(campaign);
      } else {
        await db.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
        await removeSchedule(id);
      }
      await audit("campaign." + action, { id });
      return ok(await db.campaign.findUnique({ where: { id } }));
    }
    if (method === "DELETE" && id && !operation) {
      const item = await db.campaign.findUniqueOrThrow({ where: { id } });
      if (item.status !== "DRAFT") throw new HttpError(409, "Only drafts may be deleted");
      await db.campaign.delete({ where: { id } });
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
    try { return ok({ database: "connected", redis: await redis.ping(), workers: await operations.getWorkers() }); }
    finally { await redis.quit(); }
  }
  throw notFound();
}
export async function GET(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function POST(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function PATCH(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
export async function DELETE(req: NextRequest, p: Params) { try { return await route(req, p); } catch (e) { return respondError(e); } }
