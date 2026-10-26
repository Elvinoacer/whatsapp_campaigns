import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "bullmq";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { configuration } from "../lib/config";
import { personalize, isEligible, estimatedDurationMs, scheduleIssue } from "../lib/campaign";
import { resolveRecipients } from "../lib/audience";
import { removeSchedule } from "../lib/queue";

const { MessageMedia } = wwebjs;
type WhatsAppClient = InstanceType<typeof wwebjs.Client>;
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
export async function runCampaign(job: Pick<Job, "id" | "data">, getClient: (sessionId: string) => Pick<WhatsAppClient, "sendMessage"> | undefined, options: { sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean } = {}) {
  const { SEND_INTERVAL_MS: sendDelay, MAX_CAMPAIGN_RECIPIENTS: maxRecipients } = configuration();
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const campaignId = job.data.campaignId as string;
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { session: true } });
  if (!campaign || !["ACTIVE", "SCHEDULED"].includes(campaign.status)) return;
  if (job.data.revision && job.data.revision !== campaign.updatedAt.toISOString()) return;
  if (campaign.scheduleType !== "CRON" && campaign.runsCompleted) return;
  const intervalMs = Math.max(sendDelay, campaign.sendIntervalMs);
  // Global queue concurrency guarantees that another execution cannot still own
  // these older runs. Reconcile reports and uncertain sends left by a crash.
  const abandoned = await db.campaignRun.findMany({ where: { campaignId, status: "RUNNING", jobKey: { not: String(job.id) } }, select: { id: true } });
  for (const previous of abandoned) {
    await db.delivery.updateMany({ where: { runId: previous.id, status: "SENDING" }, data: { status: "UNKNOWN", error: "Previous worker stopped during send; manual reconciliation required" } });
    const count = await db.delivery.count({ where: { runId: previous.id } });
    await db.campaignRun.update({ where: { id: previous.id }, data: { status: count ? "PARTIAL" : "FAILED", finishedAt: new Date(), error: "Previous execution was interrupted" } });
  }
  if (campaign.scheduleType === "CRON") {
    const dueAt = Number(String(job.id).split(":").at(-1));
    if (Number.isFinite(dueAt) && dueAt > 0 && await db.campaignRun.count({ where: { campaignId, jobKey: { not: String(job.id) }, startedAt: { lte: new Date(dueAt) }, OR: [{ finishedAt: { gte: new Date(dueAt) } }, { status: "RUNNING" }] } })) {
      await db.auditLog.create({ data: { action: "campaign.occurrence_skipped", details: { campaignId, reason: "Previous execution overlapped this occurrence" } } });
      return;
    }
  }
  const jobKey = String(job.id);
  const run = await db.campaignRun.upsert({ where: { jobKey }, create: { campaignId, jobKey }, update: {} });
  if (run.status !== "RUNNING") return;
  // A crashed browser may have accepted a send before its database update.
  await db.delivery.updateMany({ where: { runId: run.id, status: "SENDING" }, data: { status: "UNKNOWN", error: "Worker interrupted during send; manual reconciliation required" } });
  try {
    const client = getClient(campaign.sessionId);
    if (!client || campaign.session.status !== "CONNECTED") throw new Error("Selected WhatsApp account is not connected");
    const recipients = await resolveRecipients(campaignId);
    if (!recipients.length) throw new Error("No permitted recipients");
    if (recipients.length > maxRecipients) throw new Error("Audience exceeds MAX_CAMPAIGN_RECIPIENTS");
    const timingIssue = scheduleIssue(campaign, estimatedDurationMs(recipients.length, intervalMs));
    if (timingIssue) throw new Error(timingIssue);
    const priorCampaignDeliveries = campaign.scheduleType === "CRON" ? [] : await db.delivery.findMany({ where: { run: { campaignId } }, select: { recipientKey: true, status: true } });
    const alreadyAttempted = new Set(priorCampaignDeliveries.filter(d => ["SENT", "DELIVERED", "READ", "SENDING", "UNKNOWN"].includes(d.status)).map(d => d.recipientKey));
    // Older deliveries used discovery-record IDs. Preserve deduplication after upgrade.
    const legacyIds = [...alreadyAttempted].filter(key => key.startsWith("contact:") && !key.includes("@")).map(key => key.slice(8));
    const legacyContacts = await db.contact.findMany({ where: { id: { in: legacyIds } }, select: { whatsappId: true } });
    for (const contact of legacyContacts) alreadyAttempted.add("contact:" + contact.whatsappId);
    let interrupted = false;
    for (const recipient of recipients) {
      const latest = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, updatedAt: true, session: { select: { status: true } } } });
      if (options.shouldStop?.() || !latest || !["ACTIVE", "SCHEDULED"].includes(latest.status) || latest.updatedAt.getTime() !== campaign.updatedAt.getTime()) { interrupted = true; break; }
      if (latest.session.status !== "CONNECTED" || getClient(campaign.sessionId) !== client) throw new Error("Selected WhatsApp account disconnected during the campaign");
      const prior = await db.delivery.findFirst({ where: { runId: run.id, recipientKey: { in: [recipient.key, ...(recipient.contactId ? ["contact:" + recipient.contactId] : [])] } } });
      if (prior && prior.status !== "QUEUED") continue; // No duplicate retries after a send may have occurred.
      const delivery = prior || await db.delivery.create({
        data: { runId: run.id, recipientKey: recipient.key, recipient: recipient.label },
      });
      if (alreadyAttempted.has(recipient.key)) {
        await db.delivery.update({ where: { id: delivery.id }, data: { status: "SKIPPED", error: "Already attempted in a previous run; manual reconciliation required" } });
        continue;
      }
      if (recipient.key.startsWith("contact:")) {
        const contact = await db.contact.findUnique({ where: { id: recipient.contactId! } });
        const optedOut = await db.contact.count({ where: { whatsappId: recipient.chatId, consent: "OPTED_OUT" } });
        if (!contact || !isEligible(contact.consent, contact.whatsappId) || optedOut) {
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
          data: { status: Number(message.ack) >= 3 ? "READ" : Number(message.ack) >= 2 ? "DELIVERED" : "SENT", messageId: message.id?._serialized || null, sentAt: new Date() } });
      } catch (error) {
        // A timeout can occur after WhatsApp has accepted a send: mark UNKNOWN and never auto-resend.
        await db.delivery.update({ where: { id: delivery.id },
          data: { status: "UNKNOWN", error: error instanceof Error ? error.message.slice(0, 400) : "Send state uncertain" } });
      }
      // Include the final cooldown so consecutive campaigns cannot burst sends.
      // Short waits keep pause, cancellation and shutdown responsive with long intervals.
      for (let remaining = intervalMs; remaining > 0; remaining -= 1000) {
        await sleep(Math.min(1000, remaining));
        const state = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, updatedAt: true } });
        if (options.shouldStop?.() || !state || !["ACTIVE", "SCHEDULED"].includes(state.status) || state.updatedAt.getTime() !== campaign.updatedAt.getTime()) { interrupted = true; break; }
      }
      if (interrupted) break;
    }
    const grouped = await db.delivery.groupBy({ by: ["status"], where: { runId: run.id }, _count: true });
    const failure = interrupted || grouped.some(item => ["FAILED", "UNKNOWN", "SENDING", "QUEUED"].includes(item.status));
    const count = grouped.reduce((sum, item) => sum + item._count, 0);
    await db.campaignRun.update({ where: { id: run.id }, data: {
      status: count === 0 ? "FAILED" : failure ? "PARTIAL" : "COMPLETED", finishedAt: new Date(),
    } });
    if (campaign.scheduleType !== "CRON" && !interrupted) {
      await db.campaign.updateMany({ where: { id: campaignId, updatedAt: campaign.updatedAt, status: { in: ["ACTIVE", "SCHEDULED"] } },
        data: { status: "COMPLETED", runsCompleted: true } });
    }
    log("Campaign run complete", campaignId, run.id, count);
  } catch (error) {
    const sent = await db.delivery.count({ where: { runId: run.id, status: { in: ["SENT", "DELIVERED", "READ", "UNKNOWN"] } } });
    await db.campaignRun.update({ where: { id: run.id }, data: { status: sent ? "PARTIAL" : "FAILED", finishedAt: new Date(), error: error instanceof Error ? error.message.slice(0, 400) : "Campaign execution failed" } });
    const paused = await db.campaign.updateMany({ where: { id: campaignId, updatedAt: campaign.updatedAt, status: { in: ["ACTIVE", "SCHEDULED"] } }, data: { status: "PAUSED" } });
    if (paused.count) await removeSchedule(campaignId).catch(scheduleError => log("Could not remove failed campaign schedule", scheduleError));
    throw error;
  }
}
