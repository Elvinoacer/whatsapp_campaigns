import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "bullmq";
import wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { configuration } from "../lib/config";
import { estimatedDurationMs, personalize, isEligible, scheduleIssue } from "../lib/campaign";
import { resolveRecipients } from "../lib/audience";
import { removeSchedule, deferCampaign } from "../lib/queue";
import { contactIds, type IdentityClient } from "./identity";
import { sendResult } from "./send-result";
import { lookupReceipt, persistSendResult, prepareReceipt, reconcileSessionReceipts, type ReceiptClient } from "./receipts";
import { campaignMessage, publicSenderName } from "../lib/message";
import { restrictionSignal, DAY } from "../lib/sending-policy";
import {
  accountKey,
  activeSendingHold,
  closeDeferredRuns,
  evaluateSendingQuality,
  getSendingPolicy,
  holdSending,
  reserveSend,
} from "../lib/sending-safety";

const { MessageMedia } = wwebjs;
type WhatsAppClient = InstanceType<typeof wwebjs.Client>;
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export async function runCampaign(
  job: Pick<Job, "id" | "data">,
  getClient: (sessionId: string) => (Pick<WhatsAppClient, "sendMessage"> & IdentityClient & ReceiptClient) | undefined,
  options: { sleep?: (ms: number) => Promise<void>; shouldStop?: () => boolean; now?: () => Date } = {},
) {
  const { SEND_INTERVAL_MS: sendDelay, MAX_CAMPAIGN_RECIPIENTS: maxRecipients } = configuration();
  const customSleep = Boolean(options.sleep);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const campaignId = job.data.campaignId as string;
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { session: true } });
  if (!campaign || !["ACTIVE", "SCHEDULED"].includes(campaign.status)) return;
  if (job.data.revision && job.data.revision !== campaign.updatedAt.toISOString()) return;
  if (campaign.scheduleType !== "CRON" && campaign.runsCompleted) return;
  const policy = await getSendingPolicy();
  const intervalMs = Math.max(sendDelay, campaign.sendIntervalMs, policy.minimumIntervalMs);
  const jobKey = String(job.data.continuationRunKey || job.id);

  const initialClient = getClient(campaign.sessionId);
  const abandoned = await db.campaignRun.findMany({
    where: { campaignId, status: "RUNNING", nextAttemptAt: null, jobKey: { not: jobKey } },
    select: { id: true },
  });
  if (abandoned.length && initialClient) {
    await reconcileSessionReceipts(campaign.sessionId, initialClient).catch(() => null);
  }
  for (const previous of abandoned) {
    await db.delivery.updateMany({
      where: { runId: previous.id, status: "SENDING" },
      data: { status: "UNKNOWN", error: "Previous worker stopped during send; manual reconciliation required" },
    });
    await db.delivery.updateMany({
      where: { runId: previous.id, status: "QUEUED" },
      data: { status: "SKIPPED", error: "Previous execution was interrupted before sending" },
    });
    const count = await db.delivery.count({ where: { runId: previous.id } });
    await db.campaignRun.update({
      where: { id: previous.id },
      data: { status: count ? "PARTIAL" : "FAILED", finishedAt: new Date(), error: "Previous execution was interrupted" },
    });
  }
  if (campaign.scheduleType === "CRON" && !job.data.continuationRunKey) {
    const dueAt = Number(String(job.id).split(":").at(-1));
    if (
      Number.isFinite(dueAt) &&
      dueAt > 0 &&
      (await db.campaignRun.count({
        where: {
          campaignId,
          jobKey: { not: String(job.id) },
          startedAt: { lte: new Date(dueAt) },
          OR: [{ finishedAt: { gte: new Date(dueAt) } }, { status: "RUNNING" }],
        },
      }))
    ) {
      await db.auditLog.create({
        data: { action: "campaign.occurrence_skipped", details: { campaignId, reason: "Previous execution overlapped this occurrence" } },
      });
      return;
    }
  }
  const run = await db.campaignRun.upsert({
    where: { jobKey },
    create: {
      campaignId,
      jobKey,
      launchVersion: campaign.launchVersion,
      sessionIdSnapshot: campaign.sessionId,
      messageSnapshot: campaign.message,
      mediaNameSnapshot: campaign.mediaName,
    },
    update: {},
  });
  if (run.status !== "RUNNING") return;

  const waitForConnection = async () => {
    const session = await db.waSession.findUnique({ where: { id: campaign.sessionId }, select: { status: true } });
    if (!session || session.status === "DISCONNECTED" || Date.now() - run.startedAt.getTime() >= DAY) {
      throw new Error("WhatsApp account is disconnected or has not recovered within 24 hours. Reconnect and resume the campaign.");
    }
    const until = new Date(Date.now() + 120_000);
    await db.campaignRun.update({
      where: { id: run.id },
      data: {
        nextAttemptAt: until,
        error: "WhatsApp is reconnecting. The existing run will continue automatically after connection is restored.",
      },
    });
    await deferCampaign({ campaignId, revision: campaign.updatedAt, runKey: jobKey, until });
    const latest = await db.campaign.findUnique({ where: { id: campaignId } });
    if (!latest || !["ACTIVE", "SCHEDULED"].includes(latest.status) || latest.updatedAt.getTime() !== campaign.updatedAt.getTime()) {
      await db.$transaction(tx => closeDeferredRuns(tx, [campaignId], "Campaign changed while waiting for WhatsApp reconnection"));
      await removeSchedule(campaignId);
    }
  };

  await db.campaignRun.update({ where: { id: run.id }, data: { nextAttemptAt: null, error: null } });
  if (initialClient) {
    const stuckInRun = await db.delivery.count({ where: { runId: run.id, status: "SENDING" } });
    if (stuckInRun) await reconcileSessionReceipts(campaign.sessionId, initialClient).catch(() => null);
  }
  await db.delivery.updateMany({
    where: { runId: run.id, status: "SENDING" },
    data: { status: "UNKNOWN", error: "Worker interrupted during send; manual reconciliation required" },
  });
  const uncertain = await db.delivery.findMany({
    where: { runId: { in: [run.id, ...abandoned.map(item => item.id)] }, status: "UNKNOWN" },
    select: { id: true },
  });
  await db.sendAttempt.updateMany({
    where: { deliveryId: { in: uncertain.map(item => item.id) }, outcome: "SENDING" },
    data: { outcome: "UNKNOWN" },
  });

  try {
    const client = getClient(campaign.sessionId);
    if (!client || campaign.session.status !== "CONNECTED") {
      await waitForConnection();
      return;
    }
    if (job.data.continuationRunKey) {
      await reconcileSessionReceipts(campaign.sessionId, client).catch(error =>
        log("Receipt reconciliation unavailable; uncertain sends remain reserved", campaignId, error),
      );
    }
    const recipients = await resolveRecipients(campaignId);
    if (!recipients.length) throw new Error("No permitted recipients");
    if (recipients.length > maxRecipients) throw new Error("Audience exceeds MAX_CAMPAIGN_RECIPIENTS");
    const senderName = publicSenderName(campaign.session, policy.businessName);
    const hold = await activeSendingHold(accountKey(campaign.session), campaign.sessionId);
    if (hold) throw new Error("Campaign sending is on hold: " + hold.reason);
    const timingIssue = scheduleIssue(campaign, estimatedDurationMs(recipients.length, intervalMs));
    if (timingIssue) throw new Error(timingIssue);

    const priorCampaignDeliveries = campaign.scheduleType === "CRON"
      ? []
      : await db.delivery.findMany({
        where: { run: { campaignId, launchVersion: campaign.launchVersion } },
        select: { recipientKey: true, status: true },
      });
    const alreadyAttempted = new Set(
      priorCampaignDeliveries
        .filter(d => ["SENT", "DELIVERED", "READ", "SENDING", "UNKNOWN"].includes(d.status))
        .map(d => d.recipientKey),
    );
    const legacyIds = [...alreadyAttempted]
      .filter(key => key.startsWith("contact:") && !key.includes("@"))
      .map(key => key.slice(8));
    if (legacyIds.length) {
      const legacyContacts = await db.contact.findMany({ where: { id: { in: legacyIds } }, select: { whatsappId: true } });
      for (const contact of legacyContacts) alreadyAttempted.add("contact:" + contact.whatsappId);
    }

    const snapshotMessage = campaignMessage(
      campaign.message,
      senderName,
      campaign.audienceType !== "GROUPS",
      campaign.includeFooter,
    );
    await db.campaignRun.update({
      where: { id: run.id },
      data: {
        audienceCount: Math.max(run.audienceCount, recipients.length),
        messageSnapshot: snapshotMessage,
      },
    });
    const legacyRows = await db.delivery.findMany({ where: { runId: run.id }, select: { recipientKey: true } });
    const legacyKeys = new Set(legacyRows.map(row => row.recipientKey));
    await db.delivery.createMany({
      data: recipients
        .filter(recipient => !recipient.contactId || !legacyKeys.has("contact:" + recipient.contactId))
        .map(recipient => ({
          runId: run.id,
          recipientKey: recipient.key,
          recipient: recipient.label,
        })),
      skipDuplicates: true,
    });

    let interrupted = false;
    for (const recipient of recipients) {
      const latest = await db.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true, updatedAt: true, session: { select: { status: true } } },
      });
      if (
        options.shouldStop?.() ||
        !latest ||
        !["ACTIVE", "SCHEDULED"].includes(latest.status) ||
        latest.updatedAt.getTime() !== campaign.updatedAt.getTime()
      ) {
        interrupted = true;
        break;
      }
      if (latest.session.status !== "CONNECTED" || getClient(campaign.sessionId) !== client) {
        await waitForConnection();
        return;
      }
      const prior = await db.delivery.findFirst({
        where: {
          runId: run.id,
          recipientKey: { in: [recipient.key, ...(recipient.contactId ? ["contact:" + recipient.contactId] : [])] },
        },
      });
      if (prior && prior.status !== "QUEUED") continue;
      const delivery = prior || await db.delivery.create({
        data: { runId: run.id, recipientKey: recipient.key, recipient: recipient.label },
      });
      const isDirect = Boolean(recipient.contactId);
      const identities = isDirect ? await contactIds(client, recipient.chatId) : [recipient.chatId];
      if (
        alreadyAttempted.has(recipient.key) ||
        (isDirect && identities.some(id => alreadyAttempted.has("contact:" + id)))
      ) {
        await db.delivery.update({
          where: { id: delivery.id },
          data: { status: "SKIPPED", error: "Already attempted in a previous run; manual reconciliation required" },
        });
        continue;
      }
      if (isDirect) {
        const contact = await db.contact.findUnique({ where: { id: recipient.contactId! } });
        const optedOut = await db.contact.count({ where: { whatsappId: { in: identities }, consent: "OPTED_OUT" } });
        if (!contact || !isEligible(contact.consent, contact.whatsappId) || optedOut) {
          await db.delivery.update({
            where: { id: delivery.id },
            data: { status: "SKIPPED", error: "Contact opted out or unavailable" },
          });
          continue;
        }
      } else {
        const groupId = recipient.groupId || recipient.key.slice(6);
        const group = await db.waGroup.findUnique({ where: { id: groupId } });
        if (!group || !group.allowPosting || group.sessionId !== campaign.sessionId) {
          await db.delivery.update({
            where: { id: delivery.id },
            data: { status: "SKIPPED", error: "Group posting disabled for this group" },
          });
          continue;
        }
      }
      const attemptTime = options.now?.() || new Date();
      const personalized = personalize(campaign.message, {
        ...recipient,
        timezone: campaign.timezone,
        now: attemptTime,
      });
      const text = campaignMessage(personalized, senderName, isDirect, campaign.includeFooter);
      if (text.length > 4096) {
        throw new Error("The personalized message exceeds 4,096 characters. Shorten the campaign message.");
      }
      const media = campaign.mediaKey && campaign.mediaMime
        ? new MessageMedia(
          campaign.mediaMime,
          (await readFile(join(process.cwd(), ".uploads", campaign.mediaKey))).toString("base64"),
          campaign.mediaName || campaign.mediaKey,
        )
        : null;
      await evaluateSendingQuality(accountKey(campaign.session), attemptTime);
      const reservation = await reserveSend(
        {
          deliveryId: delivery.id,
          campaignId,
          revision: campaign.updatedAt,
          session: campaign.session,
          recipientKeys: identities.map(id => (isDirect ? "contact:" : "group:") + id),
          contactId: recipient.contactId,
          groupId: isDirect ? undefined : (recipient.groupId || recipient.key.slice(6)),
          intervalMs,
        },
        attemptTime,
      );
      if (reservation.action === "STOP") {
        interrupted = true;
        break;
      }
      if (reservation.action === "SKIP") {
        await db.delivery.update({ where: { id: delivery.id }, data: { status: "SKIPPED", error: reservation.reason } });
        continue;
      }
      if (reservation.action === "WAIT") {
        await db.campaignRun.update({
          where: { id: run.id },
          data: {
            nextAttemptAt: reservation.until,
            error: reservation.reason + ". Next check: " + reservation.until.toISOString(),
          },
        });
        await deferCampaign({ campaignId, revision: campaign.updatedAt, runKey: jobKey, until: reservation.until });
        const state = await db.campaign.findUnique({ where: { id: campaignId } });
        if (!state || !["ACTIVE", "SCHEDULED"].includes(state.status) || state.updatedAt.getTime() !== campaign.updatedAt.getTime()) {
          await db.$transaction(tx => closeDeferredRuns(tx, [campaignId], "Campaign stopped while waiting for the next sending window"));
          await removeSchedule(campaignId);
        }
        return;
      }

      let prepared: Awaited<ReturnType<typeof prepareReceipt>> = null;
      try {
        prepared = await prepareReceipt(client);
        if (prepared) {
          await db.$transaction([
            db.delivery.updateMany({ where: { id: delivery.id, status: "SENDING" }, data: { messageId: prepared.messageId } }),
            db.sendAttempt.updateMany({ where: { deliveryId: delivery.id, outcome: "SENDING" }, data: { messageId: prepared.messageId } }),
          ]);
        }
        const receiptOptions = { waitUntilMsgSent: true, ...(prepared ? { extra: { campaignStanzaId: prepared.stanza } } : {}) };
        let message = media
          ? await client.sendMessage(recipient.chatId, media, {
            caption: text,
            sendMediaAsDocument: campaign.mediaMime === "application/pdf",
            ...receiptOptions,
          })
          : await client.sendMessage(recipient.chatId, text, receiptOptions);

        // WhatsApp Web often resolves sendMsgResultPromise with ack === 0 just milliseconds
        // before server ACK_SERVER (ack >= 1) lands in WAWebCollections.Msg. Poll briefly
        // so confirmed sends immediately record as SENT/DELIVERED/READ instead of SENDING.
        if (prepared && (!message || !(Number(message.ack) >= 1))) {
          for (let check = 0; check < 3; check++) {
            if (check > 0) await sleep(350);
            const refreshed = await lookupReceipt(client, prepared.messageId, identities).catch(() => null);
            if (refreshed?.id?._serialized) {
              message = refreshed as typeof message;
              if (Number(refreshed.ack) >= 1) break;
            }
          }
        }
        if (!message) {
          await persistSendResult(delivery.id, {
            status: "FAILED",
            messageId: prepared?.messageId || null,
            error: "Recipient chat not found or cannot be opened in WhatsApp.",
            sentAt: null,
          });
        } else {
          await persistSendResult(delivery.id, sendResult(message, prepared?.messageId));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message.slice(0, 400) : "Send state uncertain";
        const isDefinitiveFailure = /chat not found|not registered|invalid (?:wid|jid|destination)|user not found|no permitted recipients/i.test(errorMsg);
        await persistSendResult(delivery.id, isDefinitiveFailure ? {
          status: "FAILED",
          messageId: prepared?.messageId || null,
          error: errorMsg,
          sentAt: null,
        } : {
          status: "UNKNOWN",
          messageId: prepared?.messageId || null,
          error: errorMsg,
          sentAt: null,
        });
        if (prepared && !isDefinitiveFailure) {
          const receipt = await lookupReceipt(client, prepared.messageId, identities).catch(() => null);
          if (receipt) await persistSendResult(delivery.id, sendResult(receipt, prepared.messageId));
        }
        if (restrictionSignal(error)) {
          await holdSending(
            accountKey(campaign.session),
            "WhatsApp reported a restriction or rate limit. Verify the account in WhatsApp before clearing this hold.",
            new Date(Date.now() + DAY),
          );
        }
      }
      await evaluateSendingQuality(accountKey(campaign.session), attemptTime);
      if (isDirect) {
        for (const id of identities) alreadyAttempted.add("contact:" + id);
      } else {
        alreadyAttempted.add(recipient.key);
      }

      const jitter = !customSleep && policy.jitterMs > 0 ? Math.floor(Math.random() * policy.jitterMs) : 0;
      for (let remaining = intervalMs + jitter; remaining > 0; remaining -= 1000) {
        await sleep(Math.min(1000, remaining));
        const state = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, updatedAt: true } });
        if (
          options.shouldStop?.() ||
          !state ||
          !["ACTIVE", "SCHEDULED"].includes(state.status) ||
          state.updatedAt.getTime() !== campaign.updatedAt.getTime()
        ) {
          interrupted = true;
          break;
        }
      }
      if (interrupted) break;
    }

    // Reconcile any remaining SENDING receipts after the final cooldown before closing the run.
    const unresolvedInRun = await db.delivery.count({ where: { runId: run.id, status: { in: ["SENDING", "UNKNOWN"] } } });
    if (unresolvedInRun) {
      await reconcileSessionReceipts(campaign.sessionId, client).catch(() => null);
    }

    await db.delivery.updateMany({
      where: { runId: run.id, status: "QUEUED" },
      data: {
        status: "SKIPPED",
        error: interrupted
          ? "Run stopped before this recipient was sent. Resume continues eligible unattempted recipients."
          : "Recipient is no longer in the permitted audience.",
      },
    });
    const grouped = await db.delivery.groupBy({ by: ["status"], where: { runId: run.id }, _count: true });
    const failure = interrupted || grouped.some(item => ["FAILED", "UNKNOWN", "SENDING", "QUEUED"].includes(item.status));
    const count = grouped.reduce((sum, item) => sum + item._count, 0);
    await db.campaignRun.update({
      where: { id: run.id },
      data: {
        status: count === 0 ? "FAILED" : failure ? "PARTIAL" : "COMPLETED",
        finishedAt: new Date(),
      },
    });
    if (campaign.scheduleType !== "CRON" && !interrupted) {
      await db.campaign.updateMany({
        where: { id: campaignId, updatedAt: campaign.updatedAt, status: { in: ["ACTIVE", "SCHEDULED"] } },
        data: { status: "COMPLETED", runsCompleted: true },
      });
    }
    log("Campaign run complete", campaignId, run.id, count);
  } catch (error) {
    await db.delivery.updateMany({
      where: { runId: run.id, status: "QUEUED" },
      data: { status: "SKIPPED", error: "Run ended before this recipient was sent" },
    });
    const sent = await db.delivery.count({ where: { runId: run.id, status: { in: ["SENT", "DELIVERED", "READ", "UNKNOWN"] } } });
    await db.campaignRun.update({
      where: { id: run.id },
      data: {
        status: sent ? "PARTIAL" : "FAILED",
        finishedAt: new Date(),
        error: error instanceof Error ? error.message.slice(0, 400) : "Campaign execution failed",
      },
    });
    const paused = await db.campaign.updateMany({
      where: { id: campaignId, updatedAt: campaign.updatedAt, status: { in: ["ACTIVE", "SCHEDULED"] } },
      data: { status: "PAUSED" },
    });
    if (paused.count) {
      await removeSchedule(campaignId).catch(scheduleError => log("Could not remove failed campaign schedule", scheduleError));
    }
    throw error;
  }
}
