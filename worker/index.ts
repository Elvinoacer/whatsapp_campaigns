import { projectRoot, sessionDirectory } from "./environment";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "bullmq";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { queueName, campaignQueueName, operations, campaigns, redisConnection } from "../lib/queue";
import { configuration } from "../lib/config";
import { runCampaign } from "./campaign";
import { recordOptOut, recordAcknowledgement, recordReply } from "./events";
import { errorMessage } from "./browser";
import { sync, syncGroupMembers, trackedSync } from "./sync";
import { groupSyncStateKey, syncStateKey, type SyncState } from "../lib/sync-state";
import { lockWhatsAppWorker, prepareSessionProfile } from "../scripts/platform-processes.mjs";
import { reconnectDelayMs, requiresPairing, shouldRestoreSession } from "./session-state";
import { contactIds } from "./identity";
import { accountKey, holdSending, initializeSendingSafety } from "../lib/sending-safety";
import { DAY, restrictionSignal } from "../lib/sending-policy";
import { deferCampaign } from "../lib/queue";
import { reconcileSessionHistory, reconcileSessionReceipts } from "./receipts";

const { Client, LocalAuth } = wwebjs;
type WhatsAppClient = InstanceType<typeof Client>;
const active = new Map<string, WhatsAppClient>();
const ready = new Set<string>();
const desired = new Set<string>();
const reconnects = new Map<string, ReturnType<typeof setTimeout>>();
const connecting = new Set<string>();
const initializing = new Map<WhatsAppClient, Promise<void>>();
const closing = new Map<string, Promise<void>>();
const redis = redisConnection();
configuration();
let stopping = false;
let releaseWorker: (() => Promise<void>) | undefined;

function log(...args: unknown[]) { console.log(new Date().toISOString(), ...args); }
async function setStatus(id: string, status: "DISCONNECTED" | "CONNECTING" | "QR_READY" | "CONNECTED" | "ERROR", error?: string) {
  await db.waSession.updateMany({ where: { id }, data: { status, error: error?.slice(0, 400) ?? null,
    ...(status === "CONNECTED" ? { lastSeen: new Date() } : {}) } });
}
function scheduleReconnect(sessionId: string, attempt: number) {
  if (stopping || !desired.has(sessionId)) return;
  clearTimeout(reconnects.get(sessionId));
  const delay = reconnectDelayMs(attempt);
  reconnects.set(sessionId, setTimeout(() => {
    reconnects.delete(sessionId);
    if (stopping || !desired.has(sessionId)) return;
    void connect(sessionId, attempt).catch(error => log("Reconnect failed", sessionId, errorMessage(error)));
  }, delay));
  return delay;
}
async function closeClient(id: string, client: WhatsAppClient) {
  const previous = closing.get(id);
  const task = (async () => {
    await previous;
    const closeBrowser = async () => {
      try { await client.destroy(); } catch { /* Initialization may still be in flight. */ }
      const browserProcess = client.pupBrowser?.process();
      if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) browserProcess.kill("SIGTERM");
    };
    await closeBrowser();
    const pending = initializing.get(client);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([pending.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 10000); })]); }
      finally { clearTimeout(timer); }
      await closeBrowser();
    }
  })();
  closing.set(id, task);
  try { await task; }
  finally { if (closing.get(id) === task) closing.delete(id); }
}
async function connect(sessionId: string, recoveryAttempt = 0) {
  if (stopping || active.has(sessionId) || connecting.has(sessionId)) return;
  connecting.add(sessionId);
  desired.add(sessionId);
  clearTimeout(reconnects.get(sessionId));
  reconnects.delete(sessionId);
  try {
    await closing.get(sessionId);
    const session = await db.waSession.findUnique({ where: { id: sessionId } });
    if (!session) { desired.delete(sessionId); return; }
    // Connectivity is independent of the account's campaign-sending hold.
    // Holds remain enforced by the campaign API and reserveSend().
    await setStatus(sessionId, "CONNECTING");
    await prepareSessionProfile(join(sessionDirectory, "session-" + sessionId), { log });
    if (stopping || !desired.has(sessionId)) return;
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    const client = new Client({
      authTimeoutMs: 60000,
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: sessionDirectory }),
      puppeteer: { headless: true, executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    });
    active.set(sessionId, client);
    let recoveryCount = recoveryAttempt;
    let lifecycle = Promise.resolve();
    const updateLifecycle = (action: () => Promise<void>) => {
      lifecycle = lifecycle.then(action).catch(error => { log("Session update failed", session.label, errorMessage(error)); });
    };
    const recover = async (error: unknown) => {
      if (active.get(sessionId) !== client || stopping) return;
      active.delete(sessionId);
      ready.delete(sessionId);
      const cleanup = closeClient(sessionId, client);
      const message = errorMessage(error);
      const needsPairing = requiresPairing(message);
      if (needsPairing) desired.delete(sessionId);
      const attempt = recoveryCount + 1;
      const delay = reconnectDelayMs(attempt);
      log("WhatsApp browser interrupted", session.label, message,
        needsPairing ? "Pairing required" : "Reconnecting in " + delay + "ms");
      // An actual restriction still pauses sending, but does not revoke access
      // to contacts or incoming opt-outs. Database/Redis errors must not strand
      // a recoverable browser session without another attempt.
      try {
        if (restrictionSignal(error)) {
          const current = await db.waSession.findUnique({ where: { id: sessionId } });
          if (current) await holdSending(accountKey(current), "WhatsApp reported a restriction. Check the account on your phone before reviewing the sending hold.", new Date(Date.now() + DAY));
        }
      } catch (cause) { log("Restriction review recording failed", session.label, errorMessage(cause)); }
      try { await redis.del("qr:" + sessionId); }
      catch (cause) { log("QR cleanup failed", session.label, errorMessage(cause)); }
      try {
        await setStatus(sessionId, needsPairing ? "DISCONNECTED" : "CONNECTING",
          needsPairing ? "WhatsApp requires the device to be linked again: " + message
            : "WhatsApp connection interrupted: " + message + ". Reconnecting automatically.");
      } catch (cause) { log("Recovery status update failed", session.label, errorMessage(cause)); }
      try { await cleanup; }
      catch (cause) { log("Browser cleanup failed", session.label, errorMessage(cause)); }
      if (!needsPairing) scheduleReconnect(sessionId, attempt);
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
    client.on("change_state", state => {
      if (restrictionSignal(state)) updateLifecycle(async () => {
        const current = await db.waSession.findUniqueOrThrow({ where: { id: sessionId } });
        await holdSending(accountKey(current), "WhatsApp reported account state " + state + ". Verify account access before reviewing the hold.", new Date(Date.now() + DAY));
      });
    });
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
        recoveryCount = 0;
        clearTimeout(reconnects.get(sessionId));
        reconnects.delete(sessionId);
        log("WhatsApp ready", session.label);
        void queueAutomaticMaintenance(sessionId).catch(error => log("Automatic sync could not be queued", errorMessage(error)));
      });
    });
    client.on("auth_failure", async (message: string) => {
      try {
        if (active.get(sessionId) !== client) return;
        active.delete(sessionId);
        ready.delete(sessionId);
        desired.delete(sessionId);
        await redis.del("qr:" + sessionId);
        await setStatus(sessionId, "DISCONNECTED", "WhatsApp needs a new device link: " + message);
        await closeClient(sessionId, client);
      } catch (e) { log("Authentication cleanup failed", e); }
    });
    client.on("disconnected", async (reason: string) => {
      if (active.get(sessionId) !== client) return;
      if (!requiresPairing(String(reason))) {
        updateLifecycle(() => recover(new Error("WhatsApp disconnected: " + reason)));
        return;
      }
      active.delete(sessionId);
      ready.delete(sessionId);
      desired.delete(sessionId);
      try {
        await redis.del("qr:" + sessionId);
        await setStatus(sessionId, "DISCONNECTED", String(reason));
        await closeClient(sessionId, client);
      } catch (e) { log("Disconnect cleanup failed", e); }
    });
    client.on("message", async message => {
      if (message.fromMe) return;
      try {
        const receivedAt = message.timestamp ? new Date(message.timestamp * 1000) : new Date();
        // Suppress the actual sender first, even if an optional alias lookup fails.
        const optedOut = await recordOptOut(sessionId, message.from, message.body || "", [], receivedAt);
        const identities = await contactIds(client, message.from);
        if (optedOut) {
          if (identities.length > 1) await recordOptOut(sessionId, message.from, message.body || "", identities, receivedAt);
          log("Inbound opt-out recorded", session.label);
        }
        let quotedMessageId: string | undefined;
        if (message.hasQuotedMsg) {
          try { quotedMessageId = (await message.getQuotedMessage()).id?._serialized; }
          catch { return; } // Do not guess attribution when the quote cannot be resolved.
        }
        await recordReply({ sessionId, from: message.from, messageId: message.id?._serialized,
          body: message.body || "", hasMedia: message.hasMedia, quotedMessageId, author: message.author || undefined, contactIds: identities,
          receivedAt });
      } catch (error) { log("Inbound message recording failed", error); }
    });
    client.on("message_ack", async (message, ack) => {
      if (!message.fromMe || !message.id?._serialized) return;
      try {
        await recordAcknowledgement(message.id._serialized, Number(ack), { sessionId,
          receivedAt: message.timestamp ? new Date(message.timestamp * 1000) : undefined });
      } catch (e) { log("Ack update failed", e); }
    });
    client.on("message_create", async message => {
      if (!message.fromMe || !message.id?._serialized) return;
      try {
        await recordAcknowledgement(message.id._serialized, Number(message.ack), { sessionId,
          receivedAt: message.timestamp ? new Date(message.timestamp * 1000) : undefined });
      } catch (error) { log("Outgoing receipt recording failed", errorMessage(error)); }
    });
    // Initialization is asynchronous; the queue must not block while a human scans a QR code.
    const initialization = client.initialize();
    initializing.set(client, initialization);
    void initialization.then(async () => {
      if (active.get(sessionId) !== client) { try { await client.destroy(); } catch { /* initialization was cancelled */ } }
      else {
        client.pupPage?.on("error", error => updateLifecycle(() => recover(error)));
        client.pupBrowser?.on("disconnected", () => updateLifecycle(() => recover(new Error("Chromium disconnected"))));
      }
    }).catch(error => updateLifecycle(() => recover(error))).finally(() => initializing.delete(client));
  } catch (error) {
    const client = active.get(sessionId);
    if (client) {
      active.delete(sessionId);
      ready.delete(sessionId);
      try { await closeClient(sessionId, client); }
      catch (cause) { log("Failed to close interrupted browser", sessionId, errorMessage(cause)); }
    }
    if (!stopping && desired.has(sessionId)) {
      const attempt = recoveryAttempt + 1;
      const delay = scheduleReconnect(sessionId, attempt);
      log("Session connection failed", sessionId, errorMessage(error), "Retry in " + delay + "ms");
      try {
        await setStatus(sessionId, "CONNECTING", "Could not establish WhatsApp connection: " + errorMessage(error) + ". Retrying automatically.");
      } catch (cause) { log("Reconnect status update failed", sessionId, errorMessage(cause)); }
    } else if (!stopping) {
      log("Session connection failed", sessionId, errorMessage(error));
    }
  } finally { connecting.delete(sessionId); }
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
    try { await closeClient(sessionId, client); } catch (e) { log("destroy failed", e); }
  }
}
async function queueAutomaticMaintenance(sessionId: string, historyOnly = false) {
  if (stopping || !ready.has(sessionId)) return;
  const work = [
    { name: "reconcile-history", key: "history:status:" + sessionId, throttle: "history:auto:" + sessionId, seconds: 300 },
    ...(!historyOnly ? [{ name: "sync", key: syncStateKey(queueName, sessionId), throttle: "directory:auto:" + sessionId, seconds: 1800 }] : []),
  ];
  for (const item of work) {
    if (await redis.set(item.throttle, "1", "EX", item.seconds, "NX") !== "OK") continue;
    if (await redis.set(item.key + ":queued", "1", "EX", 900, "NX") !== "OK") continue;
    try {
      await redis.set(item.key, JSON.stringify({ phase: "QUEUED", kind: "directory", message: item.name === "sync" ? "Updating contacts and groups automatically…" : "Checking receipts and replies automatically…", updatedAt: new Date().toISOString() }), "EX", 86400);
      await operations.add(item.name, { sessionId, automatic: true });
    } catch (error) { await redis.del(item.throttle, item.key + ":queued"); throw error; }
  }
}
let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
let maintenanceRunning = false;
async function maintainConnectedSessions() {
  if (stopping || maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    for (const sessionId of ready) {
      const client = sendingClient(sessionId);
      if (client) await reconcileSessionReceipts(sessionId, client).catch(() => null);
      await queueAutomaticMaintenance(sessionId);
    }
  }
  catch (error) { log("Automatic maintenance unavailable", errorMessage(error)); }
  finally { maintenanceRunning = false; }
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
    case "reconcile-history": {
      const sessionId = String(job.data.sessionId);
      const client = sendingClient(sessionId);
      const key = "history:status:" + sessionId;
      const lock = key + ":queued";
      const save = async (phase: string, details: object = {}) => redis.set(key,
        JSON.stringify({ phase, updatedAt: new Date().toISOString(), ...details }), "EX", 86400);
      try {
        if (!client) throw new Error("WhatsApp must be connected before reconciling history.");
        await save("RUNNING", { message: "Checking existing message receipts and recent chat history…" });
        const result = await reconcileSessionHistory(sessionId, client, {
          maxChats: job.data.automatic ? 40 : 150,
          chatOffset: job.data.automatic ? Number(await redis.get("history:cursor:" + sessionId)) || 0 : 0, progress: async progress => { await save("RUNNING", { ...progress,
            message: `Checked ${progress.scannedChats} chats. ${progress.confirmed} sends and ${progress.replies} replies recovered.` }); },
        });
        if (job.data.automatic) await redis.incrby("history:cursor:" + sessionId, result.scannedChats);
        await save("COMPLETED", { ...result, message:
          `History checked: ${result.confirmed} confirmed sends, ${result.replies} replies, ${result.unresolved} still unconfirmed. No messages were sent.` });
        await db.auditLog.create({ data: { action: "campaign.history_reconciled", details: { sessionId, ...result } } });
        return result;
      } catch (error) {
        await save("FAILED", { message: errorMessage(error) });
        throw error;
      } finally { await redis.del(lock); }
    }
    case "sync-group-members": {
      const group = await db.waGroup.findUniqueOrThrow({ where: { id: job.data.groupId } });
      return trackedSync(group.sessionId, "members", () => syncGroupMembers(group.id, id => active.get(id), job.data.segmentIds || [], job.data.newSegment), redis, queueName, group.id);
    }
    case "run-campaign": return campaigns.add("run-campaign", job.data, { jobId: "legacy-" + String(job.id).replaceAll(":", "-") });
    default: throw new Error("Unknown operation: " + job.name);
  }
}, { connection: controlConnection, concurrency: 1, autorun: false });
const deliveryWorker = new Worker(campaignQueueName, async job => {
  const result = await runCampaign(job, sendingClient, { shouldStop: () => stopping });
  const campaign = await db.campaign.findUnique({ where: { id: job.data.campaignId }, select: { sessionId: true } });
  if (campaign) void queueAutomaticMaintenance(campaign.sessionId, true).catch(error => log("Receipt check unavailable", errorMessage(error)));
  return result;
}, { connection: deliveryConnection, concurrency: 1, autorun: false });
for (const instance of [worker, deliveryWorker]) {
  instance.on("error", error => log("Worker error", error.message));
  instance.on("failed", (job, error) => {
    log("Job failed", job?.name, job?.id, error.message);
    if (job?.name === "run-campaign" && job.data.campaignId) {
      void db.campaign.updateMany({ where: { id: job.data.campaignId, ...(job.data.revision && { updatedAt: new Date(job.data.revision) }), status: { in: ["ACTIVE", "SCHEDULED"] } }, data: { status: "PAUSED" } })
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
  const sessions = await db.waSession.findMany({ where: { status: { in: ["CONNECTED", "CONNECTING", "QR_READY", "ERROR"] } } });
  for (const session of sessions) {
    const exists = await access(join(sessionDirectory, "session-" + session.id, "Default")).then(() => true, () => false);
    if (!shouldRestoreSession(session, exists)) continue;
    try { await connect(session.id); }
    catch (error) { log("Saved session could not reopen", session.label, errorMessage(error)); }
  }
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceTimer);
  for (const timer of reconnects.values()) clearTimeout(timer);
  reconnects.clear();
  log("Shutting down WhatsApp worker...");
  await Promise.all([worker.close(), deliveryWorker.close()]);
  for (const sessionId of active.keys()) {
    const client = active.get(sessionId);
    active.delete(sessionId);
    if (client) { try { await closeClient(sessionId, client); } catch { /* ignored */ } }
  }
  await Promise.allSettled([...closing.values()]);
  await Promise.all([operations.close(), campaigns.close()]);
  await Promise.all([controlConnection.quit(), deliveryConnection.quit()]);
  await redis.quit();
  await db.$disconnect();
  await releaseWorker?.();
  process.exitCode = 0;
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
async function start() {
  releaseWorker = await lockWhatsAppWorker(sessionDirectory, () => { log("WhatsApp worker ownership lock was lost; stopping safely"); void shutdown(); });
  log("Using persistent WhatsApp sessions from this project", projectRoot);
  await db.$queryRaw`SELECT 1`;
  await redis.ping();
  await campaigns.setGlobalConcurrency(1);
  await initializeSendingSafety();
  await restore();
  const deferred = await db.campaignRun.findMany({ where: { status: "RUNNING", nextAttemptAt: { not: null }, campaign: { status: { in: ["ACTIVE", "SCHEDULED"] } } }, include: { campaign: true } });
  for (const run of deferred) await deferCampaign({ campaignId: run.campaignId, revision: run.campaign.updatedAt, runKey: run.jobKey, until: run.nextAttemptAt! });
  maintenanceTimer = setInterval(() => { void maintainConnectedSessions(); }, 60000);
  await Promise.all([worker.run(), deliveryWorker.run()]);
}
void start().catch(async error => {
  log("Worker startup failed. Run npm run doctor:", error.message);
  await shutdown();
  process.exitCode = 1;
});
