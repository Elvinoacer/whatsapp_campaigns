import "dotenv/config";
import { Worker } from "bullmq";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { queueName, campaignQueueName, operations, campaigns, redisConnection } from "../lib/queue";
import { configuration } from "../lib/config";
import { runCampaign } from "./campaign";
import { recordOptOut, recordAcknowledgement } from "./events";
import { errorMessage } from "./browser";
import { sync, syncGroupMembers, trackedSync } from "./sync";
import { groupSyncStateKey, syncStateKey, type SyncState } from "../lib/sync-state";

const { Client, LocalAuth } = wwebjs;
type WhatsAppClient = InstanceType<typeof Client>;
const active = new Map<string, WhatsAppClient>();
const ready = new Set<string>();
const desired = new Set<string>();
const reconnects = new Map<string, ReturnType<typeof setTimeout>>();
const redis = redisConnection();
configuration();
let stopping = false;

function log(...args: unknown[]) { console.log(new Date().toISOString(), ...args); }
async function setStatus(id: string, status: "DISCONNECTED" | "CONNECTING" | "QR_READY" | "CONNECTED" | "ERROR", error?: string) {
  await db.waSession.updateMany({ where: { id }, data: { status, error: error?.slice(0, 400) ?? null,
    ...(status === "CONNECTED" ? { lastSeen: new Date() } : {}) } });
}
async function connect(sessionId: string, recoveryAttempt = 0) {
  if (stopping || active.has(sessionId)) return;
  desired.add(sessionId);
  clearTimeout(reconnects.get(sessionId));
  reconnects.delete(sessionId);
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  await setStatus(sessionId, "CONNECTING");
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const client = new Client({
    authTimeoutMs: 60000,
    authStrategy: new LocalAuth({ clientId: sessionId, dataPath: process.env.SESSION_DIR || ".wwebjs_auth" }),
    puppeteer: { headless: true, executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });
  active.set(sessionId, client);
  let lifecycle = Promise.resolve();
  const updateLifecycle = (action: () => Promise<void>) => {
    lifecycle = lifecycle.then(action).catch(error => { log("Session update failed", session.label, errorMessage(error)); });
  };
  const recover = async (error: unknown) => {
    if (active.get(sessionId) !== client || stopping) return;
    active.delete(sessionId);
    ready.delete(sessionId);
    const retry = recoveryAttempt < 3;
    const message = errorMessage(error);
    log("WhatsApp browser interrupted", session.label, message, retry ? "Reconnecting" : "Reconnect from Sessions");
    await redis.del("qr:" + sessionId);
    await setStatus(sessionId, retry ? "CONNECTING" : "ERROR", retry ? "Browser interrupted; reconnecting automatically…" : "WhatsApp browser could not recover: " + message);
    try { await client.destroy(); } catch { /* The browser may already be closed. */ }
    if (retry && !stopping && desired.has(sessionId)) reconnects.set(sessionId, setTimeout(() => {
      reconnects.delete(sessionId);
      void connect(sessionId, recoveryAttempt + 1).catch(e => log("Reconnect failed", errorMessage(e)));
    }, 2000 * (recoveryAttempt + 1)));
  };
  // These events come from the versioned SDK patch in patches/.
  client.on("session_loading", () => {
    if (active.get(sessionId) !== client) return;
    ready.delete(sessionId);
    updateLifecycle(async () => {
      if (active.get(sessionId) === client) await setStatus(sessionId, "CONNECTING");
    });
  });
  client.on("session_error", error => updateLifecycle(() => recover(error)));
  client.on("qr", async (qr: string) => {
    try {
      if (active.get(sessionId) !== client) return;
      await redis.set("qr:" + sessionId, qr, "EX", 120);
      await setStatus(sessionId, "QR_READY");
      log("QR ready for", session.label);
    } catch (e) { log("QR update error:", e); }
  });
  client.on("ready", () => {
    updateLifecycle(async () => {
      if (active.get(sessionId) !== client) return;
      await redis.del("qr:" + sessionId);
      const wid = client.info?.wid?.user;
      await db.waSession.updateMany({ where: { id: sessionId },
        data: { status: "CONNECTED", phone: wid || null, lastSeen: new Date(), error: null } });
      ready.add(sessionId);
      log("WhatsApp ready", session.label);
    });
  });
  client.on("auth_failure", async (message: string) => {
    try {
      if (active.get(sessionId) !== client) return;
      active.delete(sessionId);
      ready.delete(sessionId);
      desired.delete(sessionId);
      await redis.del("qr:" + sessionId);
      await setStatus(sessionId, "ERROR", message);
      await client.destroy();
    } catch (e) { log("Authentication cleanup failed", e); }
  });
  client.on("disconnected", async (reason: string) => {
    if (active.get(sessionId) !== client) return;
    active.delete(sessionId);
    ready.delete(sessionId);
    desired.delete(sessionId);
    try {
      await redis.del("qr:" + sessionId);
      await setStatus(sessionId, "DISCONNECTED", String(reason));
      await client.destroy();
    } catch (e) { log("Disconnect cleanup failed", e); }
  });
  client.on("message", async message => {
    // Inbound STOP always takes effect. Discovering a number in a group never grants marketing consent.
    try { if (await recordOptOut(sessionId, message.from, message.body || "")) log("Inbound opt-out recorded", session.label); }
    catch (e) { log("Opt-out update failed:", e); }
  });
  client.on("message_ack", async (message, ack) => {
    if (!message.fromMe || !message.id?._serialized) return;
    try {
      await recordAcknowledgement(message.id._serialized, Number(ack));
    } catch (e) { log("Ack update failed", e); }
  });
  // Initialization is asynchronous; the queue must not block while a human scans a QR code.
  void client.initialize().then(async () => {
    if (active.get(sessionId) !== client) { try { await client.destroy(); } catch { /* initialization was cancelled */ } }
    else {
      client.pupPage?.on("error", error => updateLifecycle(() => recover(error)));
      client.pupBrowser?.on("disconnected", () => updateLifecycle(() => recover(new Error("Chromium disconnected"))));
    }
  }).catch(error => updateLifecycle(() => recover(error)));
}
async function disconnect(sessionId: string) {
  desired.delete(sessionId);
  clearTimeout(reconnects.get(sessionId));
  reconnects.delete(sessionId);
  const client = active.get(sessionId);
  active.delete(sessionId);
  ready.delete(sessionId);
  await redis.del("qr:" + sessionId);
  await setStatus(sessionId, "DISCONNECTED");
  if (client) {
    try { await client.destroy(); } catch (e) { log("destroy failed", e); }
  }
}
const sendingClient = (id: string) => ready.has(id) ? active.get(id) : undefined;
const controlConnection = redisConnection(true);
const deliveryConnection = redisConnection(true);
const worker = new Worker(queueName, async job => {
  switch (job.name) {
    case "connect": return connect(job.data.sessionId);
    case "disconnect": return disconnect(job.data.sessionId);
    case "sync": {
      const client = active.get(job.data.sessionId);
      return trackedSync(job.data.sessionId, "directory", () => sync(job.data.sessionId, client, () => active.get(job.data.sessionId) === client), redis, queueName);
    }
    case "sync-group-members": {
      const group = await db.waGroup.findUniqueOrThrow({ where: { id: job.data.groupId } });
      return trackedSync(group.sessionId, "members", () => syncGroupMembers(group.id, id => active.get(id)), redis, queueName, group.id);
    }
    case "run-campaign": return runCampaign(job, sendingClient, { shouldStop: () => stopping });
    default: throw new Error("Unknown operation: " + job.name);
  }
}, { connection: controlConnection, concurrency: 1, autorun: false });
const deliveryWorker = new Worker(campaignQueueName, job => runCampaign(job, sendingClient, { shouldStop: () => stopping }), { connection: deliveryConnection, concurrency: 1, autorun: false });
for (const instance of [worker, deliveryWorker]) {
  instance.on("error", error => log("Worker error", error.message));
  instance.on("failed", (job, error) => {
    log("Job failed", job?.name, job?.id, error.message);
    if (job?.name === "run-campaign" && job.data.campaignId) {
      void db.campaign.updateMany({ where: { id: job.data.campaignId, status: { in: ["ACTIVE", "SCHEDULED"] } }, data: { status: "PAUSED" } })
        .then(() => db.auditLog.create({ data: { action: "campaign.execution_failed", details: { campaignId: job.data.campaignId, message: error.message.slice(0, 400) } } }))
        .catch(e => log("Failed to record campaign error", e));
    }
  });
  instance.on("ready", () => log("Worker is ready", instance.name));
}
async function restore() {
  const [all, groups] = await Promise.all([
    db.waSession.findMany({ select: { id: true } }), db.waGroup.findMany({ select: { id: true } }),
  ]);
  const keys = [...all.map(session => syncStateKey(queueName, session.id)), ...groups.map(group => groupSyncStateKey(queueName, group.id))];
  for (const key of keys) {
    const state = await redis.get(key);
    if (state && ["QUEUED", "RUNNING"].includes((JSON.parse(state) as SyncState).phase)) {
      await redis.set(key, JSON.stringify({ ...JSON.parse(state), phase: "FAILED", message: "Worker restarted during sync. Please try again once connected.", updatedAt: new Date().toISOString() } satisfies SyncState), "EX", 86400);
      await redis.del(key + ":queued");
    }
  }
  const sessions = await db.waSession.findMany({ where: { status: { in: ["CONNECTED", "CONNECTING", "QR_READY"] } } });
  for (const session of sessions) await connect(session.id);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const timer of reconnects.values()) clearTimeout(timer);
  reconnects.clear();
  log("Shutting down WhatsApp worker...");
  await Promise.all([worker.close(), deliveryWorker.close()]);
  for (const sessionId of active.keys()) {
    const client = active.get(sessionId);
    active.delete(sessionId);
    if (client) { try { await client.destroy(); } catch { /* ignored */ } }
  }
  await Promise.all([operations.close(), campaigns.close()]);
  await Promise.all([controlConnection.quit(), deliveryConnection.quit()]);
  await redis.quit();
  await db.$disconnect();
  process.exitCode = 0;
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
async function start() {
  await db.$queryRaw`SELECT 1`;
  await redis.ping();
  await restore();
  await Promise.all([worker.run(), deliveryWorker.run()]);
}
void start().catch(async error => {
  log("Worker startup failed. Run npm run doctor:", error.message);
  await shutdown();
  process.exitCode = 1;
});
