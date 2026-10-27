import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import puppeteer from "puppeteer";
import { Worker } from "bullmq";
import { whatsappFixture } from "./whatsapp-fixture";
import { groupSyncStateKey, syncStateKey } from "../lib/sync-state";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(150); }
  throw new Error("Timed out: " + label);
}
function execute(args: string[], env = process.env) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
  });
}
async function main() {
  const originalUrl = process.env.DATABASE_URL;
  assert(originalUrl, "Run npm run setup first");
  const schema = "verify_" + randomUUID().replaceAll("-", "");
  const url = new URL(originalUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.QUEUE_NAME = schema;
  process.env.AUTH_SECRET = randomUUID() + randomUUID();
  process.env.MAX_CAMPAIGN_RECIPIENTS = "200";
  process.env.SEND_INTERVAL_MS = "1500";
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  const queueModule = await import("../lib/queue");
  const { operations, campaigns, queueName, campaignQueueName, redisConnection } = queueModule;
  const { runCampaign } = await import("../worker/campaign");
  const { recordOptOut, recordAcknowledgement } = await import("../worker/events");
  const { sync, syncGroupMembers, trackedSync } = await import("../worker/sync");
  const sharedDb = (await import("../lib/db")).db;
  const connections = [redisConnection(true), redisConnection(true)];
  let web: ChildProcess | undefined;
  let workers: Worker[] = [];
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let directoryClient: import("whatsapp-web.js").Client | undefined;
  const uploads: string[] = [];
  const sent: { to: string; content: unknown }[] = [];
  const client = { sendMessage: async (to: string, content: unknown) => {
    sent.push({ to, content });
    return { id: { _serialized: randomUUID() }, ack: 1 };
  } } as unknown as NonNullable<ReturnType<Parameters<typeof runCampaign>[1]>>;
  try {
    await execute(["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"]);
    const password = randomUUID();
    await db.user.create({ data: { email: "verify@example.test", passwordHash: await bcrypt.hash(password, 4) } });
    const port = await new Promise<number>(resolve => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => { const address = server.address(); assert(address && typeof address === "object"); server.close(() => resolve(address.port)); });
    });
    const base = `http://localhost:${port}`;
    await mkdir(".local/verification", { recursive: true });
    writeFileSync(".local/verification/server.log", "");
    let output = "";
    web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", String(port)], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    for (const stream of [web.stdout, web.stderr]) stream?.on("data", chunk => { output = (output + String(chunk)).slice(-20000); appendFileSync(".local/verification/server.log", String(chunk)); });
    await until(async () => {
      if (web?.exitCode !== null) throw new Error(output);
      try { return (await fetch(base + "/api/auth/me")).status === 401; } catch { return false; }
    }, "web server startup", 120000);
    let cookie = "";
    async function request(path: string, method = "GET", body?: unknown, status = 200, authenticated = true) {
      const res = await fetch(base + path, { method, headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json();
      assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return { data, res };
    }
    await request("/api/v1/sessions", "GET", undefined, 401);
    await request("/api/auth/login", "POST", { email: "verify@example.test", password: "wrong" }, 401);
    const login = await request("/api/auth/login", "POST", { email: "verify@example.test", password });
    cookie = login.res.headers.get("set-cookie")!.split(";")[0];
    assert(login.res.headers.get("set-cookie")?.includes("HttpOnly"));
    const crossOrigin = await fetch(base + "/api/v1/sessions", { method: "POST", headers: { Cookie: cookie, Origin: "https://elsewhere.test", "Content-Type": "application/json" }, body: JSON.stringify({ label: "Rejected" }) });
    assert.equal(crossOrigin.status, 403);
    console.log("✓ Authentication, cookies and cross-origin protection");

    const session = (await request("/api/v1/sessions", "POST", { label: "Verification account" }, 201)).data;
    const second = (await request("/api/v1/sessions", "POST", { label: "Other account" }, 201)).data;
    await request(`/api/v1/sessions/${session.id}/connect`, "POST", {}, 503);
    workers = [new Worker(queueName, async job => {
      if (job.name === "connect") {
        const redis = await operations.client;
        await redis.set("qr:" + job.data.sessionId, "verification-qr", { EX: 30 });
        await db.waSession.update({ where: { id: job.data.sessionId }, data: { status: "QR_READY" } });
      }
      if (job.name === "sync") return trackedSync(job.data.sessionId, "directory", () => sync(job.data.sessionId, directoryClient, () => true), connections[0], queueName);
      if (job.name === "sync-group-members") {
        const group = await db.waGroup.findUniqueOrThrow({ where: { id: job.data.groupId } });
        return trackedSync(group.sessionId, "members", () => syncGroupMembers(group.id, () => directoryClient, job.data.segmentIds || []), connections[0], queueName, group.id);
      }
    }, { connection: connections[0] }), new Worker(campaignQueueName, job => runCampaign(job, () => client, { sleep: async () => {} }), { connection: connections[1] })];
    for (const worker of workers) worker.on("error", console.error);
    await Promise.all(workers.map(worker => worker.waitUntilReady()));
    await until(async () => (await operations.getWorkers()).length > 0 && (await campaigns.getWorkers()).length > 0, "worker registration");
    await request(`/api/v1/sessions/${session.id}/connect`, "POST", {}, 202);
    await until(async () => (await db.waSession.findUnique({ where: { id: session.id } }))?.status === "QR_READY", "session command processed");
    assert.equal((await request(`/api/v1/sessions/${session.id}/qr`)).data.qr, "verification-qr");
    await (await operations.client).del("qr:" + session.id);
    console.log("✓ Session commands, QR retrieval and offline-worker errors");

    const contacts = [{ phone: "254700000001", name: "Ada Test" }, { phone: "254700000002", name: "Grace Test" }];
    await request("/api/v1/contacts/import", "POST", { sessionId: session.id, contacts }, 201);
    const list = (await request("/api/v1/contacts?sessionId=" + session.id)).data.items;
    assert.equal(list.length, 2); assert(list.every((c: { consent: string }) => c.consent === "UNKNOWN"));
    await request("/api/v1/contacts?page=1.2", "GET", undefined, 400);
    await request(`/api/v1/contacts/${list[0].id}`, "PATCH", { consent: "OPTED_IN" }, 400);
    for (const contact of list) await request(`/api/v1/contacts/${contact.id}`, "PATCH", { consent: "OPTED_IN", consentNote: "Test fixture consent" });
    const segment = (await request("/api/v1/segments", "POST", { name: "Verification list" }, 201)).data;
    await request("/api/v1/segments", "POST", { name: "Verification list" }, 409);
    await request(`/api/v1/segments/${segment.id}/members`, "POST", { contactIds: list.map((c: { id: string }) => c.id) });
    assert.equal((await request(`/api/v1/segments/${segment.id}`)).data.members.length, 2);
    const segmentSelection = { filter: { segmentId: segment.id, consent: "OPTED_IN", phoneAvailability: "usable" } };
    const reset = (await request("/api/v1/contacts/consent", "POST", { selection: segmentSelection, consent: "UNKNOWN" })).data;
    assert.equal(reset.selected, 2);
    assert.equal(await db.contact.count({ where: { id: { in: list.map((c: { id: string }) => c.id) }, consent: "UNKNOWN" } }), 2);
    await request("/api/v1/contacts/consent", "POST", {
      selection: { filter: { segmentId: segment.id, consent: "UNKNOWN" } }, consent: "OPTED_IN",
      consentNote: "No opt-in confirmation available", consentMethod: "WHATSAPP_REPLY",
    }, 400);
    const restored = (await request("/api/v1/contacts/consent", "POST", {
      selection: { filter: { segmentId: segment.id, consent: "UNKNOWN", phoneAvailability: "usable" } },
      consent: "OPTED_IN", consentMethod: "WHATSAPP_REPLY",
      consentNote: "Both test recipients explicitly confirmed via fixture", confirmed: true,
    })).data;
    assert.equal(restored.selected, 2);
    assert.equal(await db.contact.count({ where: { id: { in: list.map((c: { id: string }) => c.id) }, consent: "OPTED_IN" } }), 2);
    console.log("✓ Selected/all-matching consent updates, evidence checks and directory filters");
    console.log("✓ CSV import, consent evidence, filtering, lists and duplicate errors");
    const extraSegment = (await request("/api/v1/segments", "POST", { name: "Preserved membership" }, 201)).data;
    const destination = (await request("/api/v1/segments", "POST", { name: "Move destination" }, 201)).data;
    const selection = { contactIds: list.map((c: { id: string }) => c.id) };
    await request("/api/v1/segments/members", "POST", { selection, segmentIds: [extraSegment.id, segment.id] });
    await request("/api/v1/segments/members", "POST", { selection, action: "move", sourceSegmentId: segment.id, segmentIds: [destination.id] });
    assert.equal((await request(`/api/v1/contacts?segmentId=${segment.id}`)).data.total, 0);
    assert.equal((await request(`/api/v1/contacts?segmentId=${destination.id}`)).data.total, 2);
    assert.equal((await request(`/api/v1/contacts?segmentId=${extraSegment.id}`)).data.total, 2);
    await request("/api/v1/segments/members", "POST", { selection, action: "move", segmentIds: ["missing"], newSegment: { name: "Must roll back" } }, 400);
    assert.equal(await db.segment.count({ where: { name: "Must roll back" } }), 0);
    await request("/api/v1/segments/members", "POST", { selection, action: "move", sourceSegmentId: segment.id, newSegment: { name: "Atomic rollback" } }, 409);
    assert.equal(await db.segment.count({ where: { name: "Atomic rollback" } }), 0);

    await request("/api/v1/segments/members", "POST", { selection: { filter: { segmentId: destination.id } }, segmentIds: [segment.id] });
    await request("/api/v1/segments/members", "POST", { selection, action: "remove", segmentIds: [destination.id] });
    await request(`/api/v1/segments/${destination.id}`, "PATCH", { name: "Renamed destination", description: "Shared by all accounts" });
    assert.equal((await request(`/api/v1/segments/${destination.id}`)).data.name, "Renamed destination");
    assert.equal((await request(`/api/v1/contacts?segmentId=${segment.id}&search=Ada`)).data.total, 1);
    console.log("✓ Atomic multi-segment add/move/remove, source-scoped movement, filtered selection, rename and rollback");


    const form = new FormData();
    form.set("file", new Blob(["%PDF-1.4\nverification"], { type: "application/pdf" }), "verification.pdf");
    const mediaResponse = await fetch(base + "/api/v1/media", { method: "POST", headers: { Cookie: cookie }, body: form });
    assert.equal(mediaResponse.status, 201);
    const attachment = await mediaResponse.json(); uploads.push(attachment.mediaKey);
    const invalid = new FormData(); invalid.set("file", new Blob(["invalid"], { type: "image/png" }), "invalid.png");
    assert.equal((await fetch(base + "/api/v1/media", { method: "POST", headers: { Cookie: cookie }, body: invalid })).status, 400);
    const baseCampaign = { name: "Verification campaign", message: "Hello {{first_name}}", sessionId: session.id, audienceType: "CONTACTS", contactIds: [list[0].id, list[0].id], segmentIds: [segment.id] };
    const crossSessionDraft = (await request("/api/v1/campaigns", "POST", { ...baseCampaign, sessionId: second.id }, 201)).data;
    assert.equal((await request(`/api/v1/campaigns/${crossSessionDraft.id}/audience`)).data.count, 2);
    await request("/api/v1/campaigns", "POST", { ...baseCampaign, scheduleType: "CRON", cron: "99 99 * * *" }, 400);
    const draft = (await request("/api/v1/campaigns", "POST", { ...baseCampaign, ...attachment }, 201)).data;
    assert.equal((await request(`/api/v1/campaigns/${draft.id}/audience`)).data.count, 2);
    await request(`/api/v1/campaigns/${draft.id}`, "PATCH", { ...baseCampaign, ...attachment, name: "Updated verification campaign" });
    await request(`/api/v1/campaigns/${draft.id}/action`, "POST", { action: "launch" }, 409);
    await db.waSession.update({ where: { id: session.id }, data: { status: "CONNECTED" } });
    await request(`/api/v1/campaigns/${draft.id}/action`, "POST", { action: "launch" });
    await until(async () => (await db.campaign.findUnique({ where: { id: draft.id } }))?.status === "COMPLETED", "campaign completion");
    assert.equal(sent.length, 2); assert.equal(new Set(sent.map(s => s.to)).size, 2);
    const detail = (await request(`/api/v1/campaigns/${draft.id}`)).data;
    assert.equal(detail.runs[0].status, "COMPLETED"); assert(detail.runs[0].deliveries.every((d: { status: string }) => d.status === "SENT"));
    const delivered = await db.delivery.findFirstOrThrow({ where: { runId: detail.runs[0].id } });
    assert(delivered.messageId);
    await recordAcknowledgement(delivered.messageId, 3);
    await recordAcknowledgement(delivered.messageId, 1);
    assert.equal((await db.delivery.findUnique({ where: { id: delivered.id } }))?.status, "READ");
    await runCampaign({ id: detail.runs[0].jobKey, data: { campaignId: draft.id } }, () => client, { sleep: async () => {} });
    assert.equal(sent.length, 2);
    // Relaunch creates an independent immediate send and leaves the original immutable.
    const relaunched = (await request(`/api/v1/campaigns/${draft.id}/relaunch`, "POST", {}, 201)).data;
    assert.notEqual(relaunched.campaignId, draft.id);
    assert.equal(relaunched.recipients, 2);
    await request(`/api/v1/campaigns/${draft.id}/relaunch`, "POST", {}, 409);
    await until(async () => (await db.campaign.findUnique({ where: { id: relaunched.campaignId } }))?.status === "COMPLETED", "relaunched campaign completion");
    assert.equal(sent.length, 4);
    assert.equal(await db.campaignRun.count({ where: { campaignId: draft.id } }), 1);
    assert.equal(await db.campaignRun.count({ where: { campaignId: relaunched.campaignId } }), 1);
    const copied = await db.campaign.findUniqueOrThrow({ where: { id: relaunched.campaignId } });
    assert.equal(copied.message, "Hello {{first_name}}");
    assert.equal(copied.mediaKey, attachment.mediaKey);
    assert.equal(copied.scheduleType, "NOW");
    await request(`/api/v1/campaigns/${draft.id}`, "PATCH", baseCampaign, 409);
    await request(`/api/v1/campaigns/${relaunched.campaignId}`, "DELETE");
    assert.equal(await db.campaign.findUnique({ where: { id: relaunched.campaignId } }), null);
    assert.equal(await db.campaignRun.count({ where: { campaignId: relaunched.campaignId } }), 0);
    assert.equal(await db.campaignRun.count({ where: { campaignId: draft.id } }), 1);
    console.log("✓ Relaunch sends again as a new campaign, prevents rapid doubles, preserves original reports and deletes terminal history");
        console.log("✓ Media validation, draft editing, audience deduplication, personalized media sends and reports (mock WhatsApp)");

    const scheduled = (await request("/api/v1/campaigns", "POST", { ...baseCampaign, scheduleType: "ONCE", scheduledAt: new Date(Date.now() + 3600000).toISOString() }, 201)).data;
    await request(`/api/v1/campaigns/${scheduled.id}/relaunch`, "POST", {}, 409);
        await request(`/api/v1/campaigns/${scheduled.id}/action`, "POST", { action: "launch" });
    await request(`/api/v1/campaigns/${scheduled.id}/action`, "POST", { action: "pause" });
    await request(`/api/v1/campaigns/${scheduled.id}/action`, "POST", { action: "resume" });
    const scheduledId = await (await campaigns.client).get(queueName + ":campaign-job:" + scheduled.id);
    assert(scheduledId); assert.equal(await (await campaigns.getJob(scheduledId))?.getState(), "delayed");
    await request(`/api/v1/campaigns/${scheduled.id}`, "DELETE", undefined, 409);
    await request(`/api/v1/campaigns/${scheduled.id}/action`, "POST", { action: "cancel" });
    assert.equal(await campaigns.getJob(scheduledId), undefined);
    await request(`/api/v1/campaigns/${scheduled.id}`, "DELETE");
    assert.equal(await db.campaign.findUnique({ where: { id: scheduled.id } }), null);
    const recurring = (await request("/api/v1/campaigns", "POST", { ...baseCampaign, scheduleType: "CRON", cron: "0 9 * * 1", timezone: "Africa/Nairobi" }, 201)).data;
    await request(`/api/v1/campaigns/${recurring.id}/action`, "POST", { action: "launch" });
    assert(await campaigns.getJobScheduler("campaign:" + recurring.id));
    await request(`/api/v1/campaigns/${recurring.id}/action`, "POST", { action: "pause" });
    assert(!(await campaigns.getJobSchedulers()).some(s => s.key === "campaign:" + recurring.id));
    await request(`/api/v1/campaigns/${recurring.id}/action`, "POST", { action: "resume" });
    assert(await campaigns.getJobScheduler("campaign:" + recurring.id));
    await request(`/api/v1/campaigns/${recurring.id}/action`, "POST", { action: "cancel" });
    console.log("✓ Future delivery, cron timezone, pause, resume and cancellation in real Redis queues");

    const group = await db.waGroup.create({ data: { sessionId: session.id, whatsappId: "test@g.us", name: "Verification group" } });
    await request(`/api/v1/groups/${group.id}`, "PATCH", { allowPosting: true });
    await db.groupMember.createMany({ data: list.map((contact: { id: string }) => ({ groupId: group.id, contactId: contact.id })) });
    const noConsentMember = await db.contact.create({ data: {
      sessionId: session.id, whatsappId: "254700099988@c.us", phone: "254700099988",
      name: "No consent fixture", consent: "UNKNOWN",
    } });
    await db.groupMember.create({ data: { groupId: group.id, contactId: noConsentMember.id } });
    const groupSource = { name: "Opted in saved group members", message: "Hello", sessionId: second.id,
      audienceType: "CONTACTS", groupIds: [group.id] };
    const sourcedPreview = (await request("/api/v1/campaigns/preview", "POST", groupSource)).data;
    assert.equal(sourcedPreview.count, 2);
    assert.equal(sourcedPreview.exclusions.missingConsent, 1);
    const sourceRoster = (await request("/api/v1/campaigns/recipients", "POST", {
      ...groupSource, page: 1, take: 1,
    })).data;
    assert.equal(sourceRoster.count, 2);
    assert.equal(sourceRoster.matched, 2);
    assert.equal(sourceRoster.items.length, 1);
    assert(sourceRoster.items[0].sources.includes("Group: Verification group"));
    assert.equal((await request("/api/v1/campaigns/recipients", "POST", {
      ...groupSource, search: "Ada", page: 1, take: 15,
    })).data.matched, 1);
    const groupSourcedCampaign = (await request("/api/v1/campaigns", "POST", groupSource, 201)).data;
    assert.equal((await request(`/api/v1/campaigns/${groupSourcedCampaign.id}/audience`)).data.count, 2);
    await request("/api/v1/campaigns", "POST", { ...groupSource, audienceType: "GROUPS" }, 400);
    console.log("✓ Exact recipient roster, pagination, source groups across sessions and opt-in-only membership filtering");
    const groupCampaign = (await request("/api/v1/campaigns", "POST", { name: "Group announcement", message: "Announcement", sessionId: session.id, audienceType: "GROUPS", groupIds: [group.id] }, 201)).data;
    assert.equal((await request(`/api/v1/campaigns/${groupCampaign.id}/audience`)).data.count, 1);
    await request(`/api/v1/groups/${group.id}`, "PATCH", { allowPosting: false });
    assert.equal((await request(`/api/v1/campaigns/${groupCampaign.id}/audience`)).data.count, 0);
    await request(`/api/v1/campaigns/${groupCampaign.id}/action`, "POST", { action: "launch" }, 400);
    console.log("✓ Group posting permission and audience suppression");

    const recover = async (label: string) => db.campaign.create({ data: { name: label, message: "Hi {{first_name}}", sessionId: session.id, audienceType: "CONTACTS", status: "ACTIVE", contacts: { create: list.map((c: { id: string }) => ({ contactId: c.id })) } } });
    const paused = await recover("Pause in flight");
    let firstSend = true;
    await runCampaign({ id: "pause-original", data: { campaignId: paused.id } }, () => client, { sleep: async () => {
      if (firstSend) { firstSend = false; await db.campaign.update({ where: { id: paused.id }, data: { status: "PAUSED" } }); }
    } });
    assert.equal((await db.campaignRun.findUnique({ where: { jobKey: "pause-original" } }))?.status, "PARTIAL");
    const beforeResume = sent.length;
    await request(`/api/v1/campaigns/${paused.id}/action`, "POST", { action: "resume" });
    await until(async () => (await db.campaign.findUnique({ where: { id: paused.id } }))?.status === "COMPLETED", "resume after active job finished");
    assert.equal(sent.length, beforeResume + 1);
    const uncertain = await recover("Uncertain send");
    const run = await db.campaignRun.create({ data: { campaignId: uncertain.id, jobKey: "stalled-job", deliveries: { create: { recipientKey: "contact:" + list[0].id, recipient: "Ada Test", status: "SENDING" } } } });
    await runCampaign({ id: "stalled-job", data: { campaignId: uncertain.id } }, () => client, { sleep: async () => {} });
    assert.equal((await db.delivery.findFirst({ where: { runId: run.id, recipientKey: "contact:" + list[0].id } }))?.status, "UNKNOWN");
    assert.equal((await db.campaignRun.findUnique({ where: { id: run.id } }))?.status, "PARTIAL");
    const failed = await recover("Disconnected run");
    await assert.rejects(runCampaign({ id: "disconnected-job", data: { campaignId: failed.id } }, () => undefined), /not connected/);
    assert.equal((await db.campaignRun.findUnique({ where: { jobKey: "disconnected-job" } }))?.status, "FAILED");
    console.log("✓ In-flight pause/resume without duplicate sends, crash recovery and failed-run reporting");

    const revoked = await recover("Consent revoked during delivery");
    const revokingClient = { sendMessage: async (to: string, content: unknown) => {
      const other = list.find((c: { whatsappId: string }) => c.whatsappId !== to);
      await recordOptOut(session.id, other.whatsappId, "STOP");
      return client.sendMessage(to, content as string);
    } } as typeof client;
    const beforeRevoke = sent.length;
    await runCampaign({ id: "revoked-job", data: { campaignId: revoked.id } }, () => revokingClient, { sleep: async () => {} });
    assert.equal(sent.length, beforeRevoke + 1);
    assert.equal(await db.delivery.count({ where: { run: { campaignId: revoked.id }, status: "SKIPPED" } }), 1);
    assert.equal(await recordOptOut(session.id, "test@g.us", "STOP"), false);
    console.log("✓ Inbound STOP suppresses a queued recipient; read receipts never downgrade");
    await db.contact.createMany({ data: Array.from({ length: 42 }, (_, i) => ({
      sessionId: session.id, whatsappId: `2547010${String(i).padStart(5, "0")}@c.us`, phone: `2547010${String(i).padStart(5, "0")}`,
      name: `Browser fixture ${String(i).padStart(2, "0")}`, consent: "OPTED_IN", consentNote: "Verification fixture",
    })) });

    await mkdir(".local/verification", { recursive: true });
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const fixturePage = await browser.newPage();
    await fixturePage.evaluate(whatsappFixture);
    const syncClient = { pupPage: fixturePage } as unknown as import("whatsapp-web.js").Client;
    directoryClient = syncClient;
    const directorySession = await db.waSession.create({ data: { label: "Directory verification", status: "CONNECTED" } });
    const optedOut = await db.contact.create({ data: { sessionId: directorySession.id, whatsappId: "254700000001@c.us", consent: "OPTED_OUT", consentNote: "Keep this decision" } });
    const permittedGroup = await db.waGroup.create({ data: { sessionId: directorySession.id, whatsappId: "123@g.us", name: "Before sync", allowPosting: true } });
    assert.match(await sync(directorySession.id, syncClient, () => true), /3 contacts and 1 groups/);
    await sync(directorySession.id, syncClient, () => true);
    assert.equal(await db.contact.count({ where: { sessionId: directorySession.id } }), 3);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: optedOut.id } })).consent, "OPTED_OUT");
    assert.equal((await db.contact.findFirstOrThrow({ where: { sessionId: directorySession.id, whatsappId: "200@lid" } })).phone, null);
    assert.equal((await db.waGroup.findUniqueOrThrow({ where: { id: permittedGroup.id } })).allowPosting, true);
    await syncGroupMembers(permittedGroup.id, () => syncClient);
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 2);
    await fixturePage.evaluate("window.fixtureFailMetadata = false");
    await request(`/api/v1/sessions/${directorySession.id}/sync`, "POST", {}, 202);
    const stateKey = syncStateKey(queueName, directorySession.id);
    await until(async () => {
      const state = await connections[0].get(stateKey);
      return state ? JSON.parse(state).phase === "COMPLETED" : false;
    }, "queued directory sync completion");
    const afterSync = (await request("/api/v1/sessions")).data.find((item: { id: string }) => item.id === directorySession.id);
    assert.match(afterSync.sync.message, /3 contacts and 1 groups/);
    await db.waSession.update({ where: { id: directorySession.id }, data: { status: "DISCONNECTED" } });
    await request(`/api/v1/groups/${permittedGroup.id}/save-contacts`, "POST", {}, 409);
    await db.waSession.update({ where: { id: directorySession.id }, data: { status: "CONNECTED" } });
    await request(`/api/v1/groups/${permittedGroup.id}/save-contacts`, "POST", {}, 202);
    await until(async () => {
      const state = JSON.parse(await connections[0].get(stateKey) || "{}");
      return state.kind === "members" && state.phase === "COMPLETED";
    }, "queued member sync completion");
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 2);
    const savedGroup = (await request("/api/v1/groups")).data.find((item: { id: string }) => item.id === permittedGroup.id);
    assert.equal(savedGroup._count.members, 2);
    assert.equal(savedGroup.sync.phase, "COMPLETED");
    assert.equal((await request("/api/v1/contacts?groupId=" + permittedGroup.id)).data.total, 2);
    await fixturePage.evaluate("window.fixtureFailMetadata = true");
    await assert.rejects(syncGroupMembers(permittedGroup.id, () => syncClient), /Metadata unavailable/);
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 2);
    await fixturePage.evaluate("window.fixtureFailMetadata = true");
    await request(`/api/v1/groups/${permittedGroup.id}/sync-members`, "POST", {}, 202);
    await until(async () => JSON.parse(await connections[0].get(stateKey) || "{}").phase === "FAILED", "failed sync status");
    const failedSync = (await request("/api/v1/sessions")).data.find((item: { id: string }) => item.id === directorySession.id);
    assert.match(failedSync.error, /Metadata unavailable/);
    assert.match(failedSync.sync.message, /Metadata unavailable/);
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 2);
    assert((await operations.getWorkers()).length > 0);
    await fixturePage.evaluate("window.fixtureFailMetadata = false");
    await request(`/api/v1/sessions/${directorySession.id}/sync`, "POST", {}, 202);
    await until(async () => JSON.parse(await connections[0].get(stateKey) || "{}").phase === "COMPLETED", "sync after failed member fetch");
    console.log("✓ API → Redis worker → Chromium discovery → PostgreSQL → API sync status; repeated sync, selected members and permissions preserved");
    const groupSegment = (await request("/api/v1/segments", "POST", { name: "Group destination A" }, 201)).data;
    const groupSegmentTwo = (await request("/api/v1/segments", "POST", { name: "Group destination B" }, 201)).data;
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);
    const browserErrors: string[] = [];
    page.on("pageerror", error => browserErrors.push(String(error)));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(base, { waitUntil: "networkidle2" });
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', "verify@example.test");
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"], form button');
    await page.waitForSelector(".sidebar");
    await page.waitForFunction(() => !document.querySelector(".loading-line"));
    console.log("✓ Real Chromium login");
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.includes("WhatsApp sessions"))?.click());
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".session-card")).some(card => card.textContent?.includes("Synced 3 contacts and 1 groups")));
    await fixturePage.evaluate("window.fixtureExtraGroupMembers = 600");
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.trim() === "Contacts")?.click());
    await page.type('input[aria-label="Search contacts"]', "unrelated filter");
    await page.select('select[aria-label="Consent filter"]', "OPTED_IN");
    await page.select('select[aria-label="Session filter"]', second.id);
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.trim() === "Groups")?.click());
    const groupRow = `[data-group-id="${permittedGroup.id}"]`;
    await page.$eval(groupRow, row => Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Save all to contacts"))!.click());
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes("Saved 602 group contacts to Contacts."), { timeout: 30000 }, groupRow);
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 602);
    assert.equal((await request(`/api/v1/groups/${permittedGroup.id}/members`)).data.length, 500);
    await page.$eval(groupRow, row => Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("View saved contacts"))!.click());
    await page.waitForSelector('select[aria-label="Filter by group"]');
    await page.waitForFunction(() => document.querySelector(".table-footer")?.textContent?.includes("602 contacts"));
    assert.equal(await page.$eval('select[aria-label="Filter by group"]', element => (element as HTMLSelectElement).value), permittedGroup.id);
    assert.equal(await page.$eval('select[aria-label="Consent filter"]', element => (element as HTMLSelectElement).value), "");
    assert.equal(await page.$eval('input[aria-label="Search contacts"]', element => (element as HTMLInputElement).value), "");
    const groupKey = groupSyncStateKey(queueName, permittedGroup.id);
    const previousSave = await connections[0].get(groupKey);
    await request(`/api/v1/groups/${permittedGroup.id}/save-contacts`, "POST", {}, 202);
    await until(async () => {
      const state = await connections[0].get(groupKey);
      return state !== previousSave && JSON.parse(state || "{}").phase === "COMPLETED";
    }, "repeat save of all group contacts");
    assert.equal(await db.contact.count({ where: { sessionId: directorySession.id } }), 603);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: optedOut.id } })).consent, "OPTED_OUT");
    assert.equal((await db.waGroup.findUniqueOrThrow({ where: { id: permittedGroup.id } })).allowPosting, true);
    // Save freshly discovered group members directly into more than one segment.
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.trim() === "Groups")?.click());
    await page.$eval(groupRow, row => Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Save to segments"))!.click());
    await page.waitForSelector('[role="dialog"]');
    await page.evaluate(() => { for (const text of ["Group destination A", "Group destination B"]) Array.from(document.querySelectorAll<HTMLLabelElement>(".organizer-segments label")).find(label => label.textContent?.includes(text))?.click(); });
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-actions button")).find(button => button.textContent?.includes("Save group to segments"))?.click());
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    await until(async () => await db.segmentMember.count({ where: { segmentId: groupSegment.id } }) === 602, "all group members added to chosen segments");
    assert.equal(await db.segmentMember.count({ where: { segmentId: groupSegmentTwo.id } }), 602);
    await page.$eval(groupRow, row => Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("View saved contacts"))!.click());
    await page.waitForFunction(() => document.querySelector(".table-footer")?.textContent?.includes("602 contacts"));
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Select all 602 matching"))?.click());
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("Organize contacts (602)"))?.click());
    await page.waitForSelector('[role="dialog"]');
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".pill-choice button")).find(button => button.textContent?.includes("Move to segments"))?.click());
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLLabelElement>(".modal label")).find(label => label.textContent?.includes("Create a new segment with this selection"))?.click());
    await page.type('input[aria-label="New segment name"]', "Browser moved group");
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-actions button")).find(button => button.textContent?.trim() === "Move contacts")?.click());
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    const moved = await db.segment.findUniqueOrThrow({ where: { name: "Browser moved group" } });
    assert.equal(await db.segmentMember.count({ where: { segmentId: moved.id } }), 602);
    assert.equal(await db.segmentMember.count({ where: { segmentId: groupSegment.id } }), 0);
    assert.equal(await db.segmentMember.count({ where: { segmentId: groupSegmentTwo.id } }), 0);
    assert.equal(await db.groupMember.count({ where: { groupId: permittedGroup.id } }), 602);
    await page.screenshot({ path: ".local/verification/contacts-segments.png", fullPage: true });
    console.log("✓ Chromium: direct group save to two segments and atomic bulk move of all 602 contacts into a new segment");
    await fixturePage.close();
    // Reset the directory filters before the existing navigation checks.
    await page.select('select[aria-label="Filter by group"]', "");
    await page.select('select[aria-label="Session filter"]', "");
    console.log("✓ Save all to contacts imports 602 members beyond the 500-record preview; Contacts navigation, repeat saves and consent preservation pass");
    for (const title of ["WhatsApp sessions", "Contacts", "Groups", "Contact segments", "Campaigns", "Delivery reports", "Settings & help", "Overview"]) {
      await page.evaluate(title => { const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.includes(title)); if (!button) throw new Error("Navigation missing"); button.click(); }, title);
      await delay(120);
      assert(await page.$("h1"));
    }
    await page.screenshot({ path: ".local/verification/desktop.png", fullPage: true });
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.includes("Contacts"))?.click());
    await page.type('input[aria-label="Search contacts"]', "no-matching-contact");
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item")).find(item => item.textContent?.includes("Campaigns"))?.click());
    await page.evaluate(() => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent?.trim() === "Create campaign")?.click());
    await page.waitForSelector('[role="dialog"]');
    await page.select(".modal select", session.id);
    await Promise.all([
      page.waitForResponse(response => response.url().includes("/api/v1/contacts?") && new URL(response.url()).searchParams.get("search") === "Browser fixture" && new URL(response.url()).searchParams.get("page") === "1"),
      page.type('input[aria-label="Search campaign contacts"]', "Browser fixture"),
    ]);
    await page.waitForFunction(() => document.querySelectorAll(".scroll-selection .check-item").length === 40);
    await page.click(".scroll-selection input");
    assert(await page.$eval(".scroll-selection input", input => (input as HTMLInputElement).checked));
    await page.click('button[aria-label="Next campaign contacts"]');
    await page.waitForFunction(() => document.querySelectorAll(".scroll-selection .check-item").length === 2);
    await page.click('button[aria-label="Previous campaign contacts"]');
    await page.waitForFunction(() => document.querySelectorAll(".scroll-selection .check-item").length === 40);
    assert(await page.$eval(".scroll-selection input", input => (input as HTMLInputElement).checked));
    await page.select(".modal select", second.id);
    await page.waitForFunction(() => document.querySelectorAll(".scroll-selection .check-item").length === 40);
    assert(await page.$eval(".scroll-selection input", input => (input as HTMLInputElement).checked));
    // Select multiple shared segments and keep them when changing sending accounts.
    await page.evaluate(() => { for (const text of ["Verification list", "Preserved membership"]) Array.from(document.querySelectorAll<HTMLLabelElement>(".modal .selection-grid label")).find(label => label.textContent?.includes(text))?.click(); });
    await page.type('.campaign-builder input[maxlength="100"]', "Browser shared campaign");
    await page.type('.campaign-builder textarea[maxlength="4096"]', "Hello {{first_name}}");
    await page.waitForFunction(() => document.querySelector(".audience-preview")?.textContent?.includes("unique eligible recipients"));
    await page.waitForFunction(() => !!document.querySelector(".recipient-roster-list .recipient-roster-entry"));
    assert((await page.$eval(".recipient-review", element => element.textContent || "")).includes("Who will receive this campaign?"));
    assert.equal(await page.$$eval('.modal .selection-grid:not(.scroll-selection) input:checked', inputs => inputs.length), 2);
    await page.select(".modal select", session.id);
    assert.equal(await page.$$eval('.modal .selection-grid:not(.scroll-selection) input:checked', inputs => inputs.length), 2);
    await page.$eval(".modal-body", element => { element.scrollTop = element.scrollHeight; });
    await page.screenshot({ path: ".local/verification/campaign-preview.png", fullPage: true });
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { hidden: true });
    console.log("✓ Composer uses shared contacts, paginates independently and preserves selections when the sender changes; Escape closes dialog");
    await page.reload({ waitUntil: "networkidle2" }); await page.waitForSelector(".sidebar");
    await page.waitForFunction(() => !document.querySelector(".loading-line"));
    await page.setViewport({ width: 390, height: 844 });
    await delay(300);
    await page.screenshot({ path: ".local/verification/mobile.png", fullPage: true });
    const overflow = await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth,
      elements: Array.from(document.querySelectorAll("body *")).filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 12).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
    assert(overflow.document <= overflow.width, JSON.stringify(overflow));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.click('button[title="Sign out"]'); await page.waitForSelector('input[type="email"]');
    assert.equal(browserErrors.length, 0, browserErrors.join("\n"));
    await db.waSession.update({ where: { id: second.id }, data: { status: "CONNECTED" } });
    const sharedPhone = "254799999999";
    const sharedA = await db.contact.create({ data: { sessionId: session.id, whatsappId: sharedPhone + "@c.us", phone: sharedPhone, name: "Shared identity A", consent: "OPTED_IN" } });
    const sharedB = await db.contact.create({ data: { sessionId: second.id, whatsappId: sharedPhone + "@c.us", phone: sharedPhone, name: "Shared identity B", consent: "OPTED_IN" } });
    const sharedOne = (await request("/api/v1/segments", "POST", { name: "Shared one" }, 201)).data;
    const sharedTwo = (await request("/api/v1/segments", "POST", { name: "Shared two" }, 201)).data;
    await request("/api/v1/segments/members", "POST", { selection: { contactIds: [sharedA.id, sharedB.id] }, segmentIds: [sharedOne.id, sharedTwo.id] });
    const sharedInput = { name: "Cross source delivery", message: "Hello {{first_name}}", sessionId: second.id, audienceType: "CONTACTS", segmentIds: [sharedOne.id, sharedTwo.id], contactIds: [sharedA.id] };
    const preview = (await request("/api/v1/campaigns/preview", "POST", sharedInput)).data;
    assert.equal(preview.count, 1); assert.equal(preview.duplicates, 1); assert.equal(preview.intervalMs, 5000);
    const sharedDraft = (await request("/api/v1/campaigns", "POST", sharedInput, 201)).data;
    const beforeShared = sent.length;
    await request(`/api/v1/campaigns/${sharedDraft.id}/action`, "POST", { action: "launch" });
    await until(async () => (await db.campaign.findUnique({ where: { id: sharedDraft.id } }))?.status === "COMPLETED", "shared segment campaign completion");
    assert.equal(sent.length, beforeShared + 1);
    // STOP arrives on an account that has no discovery record for this phone.
    await db.contact.delete({ where: { id: sharedB.id } });
    await recordOptOut(second.id, sharedPhone + "@c.us", "STOP");
    assert.equal((await request(`/api/v1/campaigns/${sharedDraft.id}/audience`)).data.count, 0);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: sharedA.id } })).consent, "OPTED_OUT");
    const stale = await recover("Stale execution");
    const beforeStale = sent.length;
    await runCampaign({ id: "stale-revision", data: { campaignId: stale.id, revision: new Date(0).toISOString() } }, () => client, { sleep: async () => {} });
    assert.equal(sent.length, beforeStale);
    assert.equal(await db.campaignRun.count({ where: { campaignId: stale.id } }), 0);
    const timingContact = await db.contact.findFirstOrThrow({ where: { name: "Browser fixture 00" } });
    const oversizedTiming = (await request("/api/v1/campaigns/preview", "POST", { ...baseCampaign, contactIds: [timingContact.id], segmentIds: [], scheduleType: "CRON", cron: "* * * * *", sendIntervalMs: 120000 })).data;
    assert(oversizedTiming.scheduleIssue);
    const overlap = await db.campaign.create({ data: { name: "Overlapping occurrence", message: "Hello", sessionId: second.id, audienceType: "CONTACTS", scheduleType: "CRON", cron: "0 9 * * *", timezone: "Africa/Nairobi", status: "ACTIVE" } });
    const due = Date.now() - 1000;
    await db.campaignRun.create({ data: { campaignId: overlap.id, jobKey: "previous-overlapping", status: "COMPLETED", startedAt: new Date(due - 5000), finishedAt: new Date() } });
    await runCampaign({ id: `repeat:campaign:${overlap.id}:${due}`, data: { campaignId: overlap.id } }, () => client, { sleep: async () => {} });
    assert.equal(await db.campaignRun.count({ where: { campaignId: overlap.id } }), 1);
    assert.equal(await db.auditLog.count({ where: { action: "campaign.occurrence_skipped" } }), 1);
    console.log("✓ Any sender → shared segments, cross-source phone deduplication, global STOP without a sender contact, stale-job suppression, overlapped cron skipping and timing preview");
    await request("/api/auth/logout", "POST", {});
    await request("/api/v1/health");
    await request("/api/v1/audit");
    await request("/api/v1/runs");
    console.log("✓ Real Chromium: login, all eight views, refresh persistence, mobile layout, logout; no browser errors");
    console.log("Integration checks passed. WhatsApp transport was mocked; no messages were sent to WhatsApp.");
  } catch (error) {
    if (browser) {
      const page = (await browser.pages()).at(-1);
      if (page) {
        await page.screenshot({ path: ".local/verification/failure.png", fullPage: true }).catch(() => {});
        writeFileSync(".local/verification/failure.txt", await page.content().catch(() => "Page unavailable"));
      }
    }
    throw error;
  } finally {
    await browser?.close();
    if (web?.pid) {
      try { process.kill(-web.pid, "SIGTERM"); } catch { /* server already exited */ }
      await Promise.race([new Promise(resolve => web?.once("exit", resolve)), delay(5000)]);
    }
    await Promise.all(workers.map(worker => worker.close()));
    for (const queue of [operations, campaigns]) { await queue.obliterate({ force: true }); await queue.close(); }
    for (const connection of connections) connection.disconnect();
    const redis = redisConnection();
    try {
      const keys = [...await redis.keys(queueName + ":campaign-job:*"), ...await redis.keys(queueName + ":session-sync:*"), ...await redis.keys(queueName + ":group-sync:*")];
      if (keys.length) await redis.del(...keys);
    } finally { redis.disconnect(); }
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.all([db.$disconnect(), sharedDb.$disconnect()]);
    for (const key of uploads) await unlink(".uploads/" + key).catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
