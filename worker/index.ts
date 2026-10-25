import { readFile } from "node:fs/promises";
import { join } from "node:path";
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { queueName, redisConnection } from "../lib/queue";
import { personalize, isEligible, isOptOut } from "../lib/campaign";
import { resolveRecipients } from "../lib/audience";

const { Client, LocalAuth, MessageMedia } = wwebjs;
type WhatsAppClient = InstanceType<typeof Client>;
const active = new Map<string, WhatsAppClient>();
const redis = redisConnection();
const sendDelay = Math.max(1500, Number(process.env.SEND_INTERVAL_MS || "3000"));
const maxRecipients = Math.min(5000, Math.max(1, Number(process.env.MAX_CAMPAIGN_RECIPIENTS || "200")));

function log(...args: unknown[]) { console.log(new Date().toISOString(), ...args); }
async function setStatus(id: string, status: "DISCONNECTED" | "CONNECTING" | "QR_READY" | "CONNECTED" | "ERROR", error?: string) {
  await db.waSession.updateMany({ where: { id }, data: { status, error: error?.slice(0, 400) ?? null,
    ...(status === "CONNECTED" ? { lastSeen: new Date() } : {}) } });
}
async function connect(sessionId: string) {
  if (active.has(sessionId)) return;
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  await setStatus(sessionId, "CONNECTING");
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: process.env.SESSION_DIR || ".wwebjs_auth" }),
    puppeteer: { headless: true, executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });
  active.set(sessionId, client);
  client.on("qr", async (qr: string) => {
    try {
      await redis.set("qr:" + sessionId, qr, "EX", 120);
      await setStatus(sessionId, "QR_READY");
      log("QR ready for", session.label);
    } catch (e) { log("QR update error:", e); }
  });
  client.on("ready", async () => {
    try {
      await redis.del("qr:" + sessionId);
      const wid = client.info?.wid?.user;
      await db.waSession.updateMany({ where: { id: sessionId },
        data: { status: "CONNECTED", phone: wid || null, lastSeen: new Date(), error: null } });
      log("WhatsApp ready", session.label);
    } catch (e) { log("ready event error", e); }
  });
  client.on("auth_failure", async (message: string) => {
    log("Authentication failed", session.label, message);
    await setStatus(sessionId, "ERROR", message);
  });
  client.on("disconnected", async (reason: string) => {
    log("Disconnected", session.label, reason);
    active.delete(sessionId);
    await redis.del("qr:" + sessionId);
    await setStatus(sessionId, "DISCONNECTED", String(reason));
    try { await client.destroy(); } catch { /* browser already stopped */ }
  });
  client.on("message", async message => {
    // Inbound STOP always takes effect. Discovering a number in a group never grants marketing consent.
    if (message.from.endsWith("@c.us") && isOptOut(message.body || "")) {
      try {
        await db.contact.updateMany({ where: { sessionId, whatsappId: message.from },
          data: { consent: "OPTED_OUT", consentNote: "Inbound STOP/unsubscribe", consentAt: null } });
        log("Opted out", message.from);
      } catch (e) { log("Opt-out update failed:", e); }
    }
  });
  client.on("message_ack", async (message, ack) => {
    if (!message.fromMe || !message.id?._serialized) return;
    try {
      const status = Number(ack) >= 3 ? "READ" : Number(ack) >= 2 ? "DELIVERED" : Number(ack) >= 1 ? "SENT" : null;
      if (status) {
        const current = await db.delivery.findFirst({ where: { messageId: message.id._serialized } });
        if (current && !["FAILED", "SKIPPED", "READ"].includes(current.status)) {
          const rank = { QUEUED: 0, SENDING: 0, UNKNOWN: 0, SENT: 1, DELIVERED: 2, READ: 3 };
          if ((rank[current.status as keyof typeof rank] ?? 0) <= (rank[status] ?? 0))
            await db.delivery.update({ where: { id: current.id }, data: { status } });
        }
      }
    } catch (e) { log("Ack update failed", e); }
  });
  // Initialization is asynchronous; the queue must not block while a human scans a QR code.
  void client.initialize().catch(async (error: Error) => {
    active.delete(sessionId);
    await setStatus(sessionId, "ERROR", error.message);
    log("Initialization failed", session.label, error.message);
    try { await client.destroy(); } catch { /* ignored */ }
  });
}
async function disconnect(sessionId: string) {
  const client = active.get(sessionId);
  active.delete(sessionId);
  await redis.del("qr:" + sessionId);
  await setStatus(sessionId, "DISCONNECTED");
  if (client) {
    try { await client.destroy(); } catch (e) { log("destroy failed", e); }
  }
}
function phoneFromId(id: string): string | null {
  if (!id.endsWith("@c.us")) return null;
  const phone = id.split("@")[0];
  return /^\d{8,15}$/.test(phone) ? phone : null;
}
async function sync(sessionId: string) {
  const client = active.get(sessionId);
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the WhatsApp session first");
  const [contacts, chats] = await Promise.all([client.getContacts(), client.getChats()]);
  let importedContacts = 0;
  let importedGroups = 0;
  for (const item of contacts) {
    const whatsappId = item.id?._serialized;
    if (!whatsappId || !whatsappId.endsWith("@c.us")) continue;
    await db.contact.upsert({
      where: { sessionId_whatsappId: { sessionId, whatsappId } },
      create: { sessionId, whatsappId, phone: phoneFromId(whatsappId),
        name: item.name || item.pushname || null, isMyContact: item.isMyContact },
      update: { phone: phoneFromId(whatsappId),
        name: item.name || item.pushname || undefined, isMyContact: item.isMyContact, lastSyncedAt: new Date() },
    });
    importedContacts++;
  }
  for (const chat of chats) {
    if (!chat.isGroup) continue;
    const whatsappId = chat.id._serialized;
    const participants = "participants" in chat
      ? (chat as unknown as { participants?: Array<{ id: { _serialized: string } }> }).participants : undefined;
    const count = participants?.length;
    await db.waGroup.upsert({
      where: { sessionId_whatsappId: { sessionId, whatsappId } },
      create: { sessionId, whatsappId, name: chat.name, participantCount: count ?? 0 },
      update: { name: chat.name, ...(count === undefined ? {} : { participantCount: count }), lastSyncedAt: new Date() },
    });
    importedGroups++;
  }
  await db.auditLog.create({ data: { action: "session.synced", details: { sessionId, importedContacts, importedGroups } } });
  log("Sync complete", sessionId, { importedContacts, importedGroups });
}
async function syncGroupMembers(groupId: string) {
  const group = await db.waGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new Error("Group does not exist");
  const client = active.get(group.sessionId);
  const session = await db.waSession.findUnique({ where: { id: group.sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the group WhatsApp session first");
  const chat = await client.getChatById(group.whatsappId);
  if (!chat.isGroup) throw new Error("Selected chat is no longer a group");
  const participants = "participants" in chat
    ? (chat as unknown as { participants?: Array<{ id: { _serialized: string } }> }).participants : undefined;
  if (!participants) throw new Error("WhatsApp Web did not expose the participant list for this group");
  const memberIds: string[] = [];
  for (const participant of participants) {
    const whatsappId = participant.id?._serialized;
    if (!whatsappId) continue;
    const contact = await db.contact.upsert({
      where: { sessionId_whatsappId: { sessionId: group.sessionId, whatsappId } },
      create: { sessionId: group.sessionId, whatsappId, phone: phoneFromId(whatsappId) },
      update: {},
    });
    memberIds.push(contact.id);
  }
  await db.$transaction(async tx => {
    await tx.groupMember.deleteMany({ where: { groupId } });
    if (memberIds.length)
      await tx.groupMember.createMany({ data: memberIds.map(contactId => ({ groupId, contactId })), skipDuplicates: true });
    await tx.waGroup.update({ where: { id: groupId }, data: { participantCount: participants.length, lastSyncedAt: new Date() } });
  });
  await db.auditLog.create({ data: { action: "group.members_synced", details: { groupId, count: memberIds.length } } });
  log("Selected group members synced", group.name, memberIds.length);
}
async function runCampaign(job: Job) {
  const campaignId = job.data.campaignId as string;
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { session: true } });
  if (!campaign || !["ACTIVE", "SCHEDULED"].includes(campaign.status)) return;
  if (campaign.scheduleType !== "CRON" && campaign.runsCompleted) return;
  const client = active.get(campaign.sessionId);
  if (!client || campaign.session.status !== "CONNECTED") throw new Error("Selected WhatsApp account is not connected");
  const recipients = await resolveRecipients(campaignId);
  if (!recipients.length) throw new Error("No permitted recipients");
  if (recipients.length > maxRecipients) throw new Error("Audience exceeds MAX_CAMPAIGN_RECIPIENTS");
  const jobKey = String(job.id ?? "unknown:" + Date.now());
  const priorCampaignDeliveries = campaign.scheduleType === "CRON" ? [] : await db.delivery.findMany({ where: { run: { campaignId } }, select: { recipientKey: true, status: true } });
  const alreadyAttempted = new Set(priorCampaignDeliveries.filter(d => ["SENT", "DELIVERED", "READ", "SENDING", "UNKNOWN"].includes(d.status)).map(d => d.recipientKey));
  const run = await db.campaignRun.upsert({
    where: { jobKey }, create: { campaignId, jobKey }, update: {},
  });
  for (const recipient of recipients) {
    const latest = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!latest || !["ACTIVE", "SCHEDULED"].includes(latest.status)) break;
    const prior = await db.delivery.findUnique({ where: { runId_recipientKey: { runId: run.id, recipientKey: recipient.key } } });
    if (prior && prior.status !== "QUEUED") continue; // No duplicate retries after a send may have occurred.
    const delivery = prior || await db.delivery.create({
      data: { runId: run.id, recipientKey: recipient.key, recipient: recipient.label },
    });
    if (alreadyAttempted.has(recipient.key)) {
      await db.delivery.update({ where: { id: delivery.id }, data: { status: "SKIPPED", error: "Already attempted in a previous run; manual reconciliation required" } });
      continue;
    }
    if (recipient.key.startsWith("contact:")) {
      const contact = await db.contact.findUnique({ where: { id: recipient.key.slice(8) } });
      if (!contact || !isEligible(contact.consent, contact.whatsappId, contact.sessionId, campaign.sessionId)) {
        await db.delivery.update({ where: { id: delivery.id }, data: { status: "SKIPPED", error: "Consent revoked or contact unavailable" } });
        continue;
      }
    } else {
      const group = await db.waGroup.findUnique({ where: { id: recipient.key.slice(6) } });
      if (!group || !group.allowPosting || group.sessionId !== campaign.sessionId) {
        await db.delivery.update({ where: { id: delivery.id }, data: { status: "SKIPPED", error: "Group sending permission disabled" } });
        continue;
      }
    }
    await db.delivery.update({ where: { id: delivery.id }, data: { status: "SENDING" } });
    try {
      const text = personalize(campaign.message, recipient);
      const message = campaign.mediaKey && campaign.mediaMime
        ? await client.sendMessage(recipient.chatId,
          new MessageMedia(campaign.mediaMime, (await readFile(join(process.cwd(), ".uploads", campaign.mediaKey))).toString("base64"), campaign.mediaName || campaign.mediaKey),
          { caption: text, sendMediaAsDocument: campaign.mediaMime === "application/pdf" })
        : await client.sendMessage(recipient.chatId, text);
      await db.delivery.update({ where: { id: delivery.id },
        data: { status: "SENT", messageId: message.id?._serialized || null, sentAt: new Date() } });
    } catch (error) {
      // A timeout can occur after WhatsApp has accepted a send: mark UNKNOWN and never auto-resend.
      await db.delivery.update({ where: { id: delivery.id },
        data: { status: "UNKNOWN", error: error instanceof Error ? error.message.slice(0, 400) : "Send state uncertain" } });
    }
    await new Promise(resolve => setTimeout(resolve, sendDelay));
  }
  const grouped = await db.delivery.groupBy({ by: ["status"], where: { runId: run.id }, _count: true });
  const failure = grouped.some(item => ["FAILED", "UNKNOWN"].includes(item.status));
  const count = grouped.reduce((sum, item) => sum + item._count, 0);
  await db.campaignRun.update({ where: { id: run.id }, data: {
    status: count === 0 ? "FAILED" : failure ? "PARTIAL" : "COMPLETED", finishedAt: new Date(),
  } });
  if (campaign.scheduleType !== "CRON") {
    await db.campaign.updateMany({ where: { id: campaignId, status: { in: ["ACTIVE", "SCHEDULED"] } },
      data: { status: "COMPLETED", runsCompleted: true } });
  }
  log("Campaign run complete", campaignId, run.id, count);
}
const worker = new Worker(queueName, async job => {
  switch (job.name) {
    case "connect": return connect(job.data.sessionId);
    case "disconnect": return disconnect(job.data.sessionId);
    case "sync": return sync(job.data.sessionId);
    case "sync-group-members": return syncGroupMembers(job.data.groupId);
    case "run-campaign": return runCampaign(job);
    default: throw new Error("Unknown operation: " + job.name);
  }
}, { connection: new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null }), concurrency: 1 });
worker.on("failed", (job, error) => {
  log("Job failed", job?.name, job?.id, error.message);
  if (job?.name === "run-campaign" && job.data.campaignId) {
    void db.campaign.updateMany({ where: { id: job.data.campaignId, status: { in: ["ACTIVE", "SCHEDULED"] } }, data: { status: "PAUSED" } })
      .then(() => db.auditLog.create({ data: { action: "campaign.execution_failed", details: { campaignId: job.data.campaignId, message: error.message.slice(0, 400) } } }))
      .catch(e => log("Failed to record campaign error", e));
  }
});
worker.on("ready", () => log("Worker is ready"));
async function restore() {
  const sessions = await db.waSession.findMany({ where: { status: { in: ["CONNECTED", "CONNECTING", "QR_READY"] } } });
  for (const session of sessions) await connect(session.id);
}
async function shutdown() {
  log("Shutting down WhatsApp worker...");
  await worker.close();
  for (const sessionId of active.keys()) {
    const client = active.get(sessionId);
    if (client) { try { await client.destroy(); } catch { /* ignored */ } }
  }
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
void restore().catch(error => log("Restore error", error));
