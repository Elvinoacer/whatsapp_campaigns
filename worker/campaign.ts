import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "bullmq";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { configuration } from "../lib/config";
import { personalize, isEligible } from "../lib/campaign";
import { resolveRecipients } from "../lib/audience";

const { MessageMedia } = wwebjs;
type WhatsAppClient = InstanceType<typeof wwebjs.Client>;
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
export async function runCampaign(job: Pick<Job, "id" | "data">, getClient: (sessionId: string) => Pick<WhatsAppClient, "sendMessage"> | undefined, options: { sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean } = {}) {
  const { SEND_INTERVAL_MS: sendDelay, MAX_CAMPAIGN_RECIPIENTS: maxRecipients } = configuration();
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const campaignId = job.data.campaignId as string;
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { session: true } });
  if (!campaign || !["ACTIVE", "SCHEDULED"].includes(campaign.status)) return;
  if (campaign.scheduleType !== "CRON" && campaign.runsCompleted) return;
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
    const priorCampaignDeliveries = campaign.scheduleType === "CRON" ? [] : await db.delivery.findMany({ where: { run: { campaignId } }, select: { recipientKey: true, status: true } });
    const alreadyAttempted = new Set(priorCampaignDeliveries.filter(d => ["SENT", "DELIVERED", "READ", "SENDING", "UNKNOWN"].includes(d.status)).map(d => d.recipientKey));
    let interrupted = false;
    for (const recipient of recipients) {
      const latest = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, updatedAt: true, session: { select: { status: true } } } });
      if (options.shouldStop?.() || !latest || !["ACTIVE", "SCHEDULED"].includes(latest.status) || latest.updatedAt.getTime() !== campaign.updatedAt.getTime()) { interrupted = true; break; }
      if (latest.session.status !== "CONNECTED" || getClient(campaign.sessionId) !== client) throw new Error("Selected WhatsApp account disconnected during the campaign");
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
          data: { status: Number(message.ack) >= 3 ? "READ" : Number(message.ack) >= 2 ? "DELIVERED" : "SENT", messageId: message.id?._serialized || null, sentAt: new Date() } });
      } catch (error) {
        // A timeout can occur after WhatsApp has accepted a send: mark UNKNOWN and never auto-resend.
        await db.delivery.update({ where: { id: delivery.id },
          data: { status: "UNKNOWN", error: error instanceof Error ? error.message.slice(0, 400) : "Send state uncertain" } });
      }
      await sleep(sendDelay);
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
    await db.campaignRun.update({ where: { id: run.id }, data: { status: sent ? "PARTIAL" : "FAILED", finishedAt: new Date() } });
    throw error;
  }
}
