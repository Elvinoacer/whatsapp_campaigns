import type { DeliveryStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { removeSchedule } from "./queue";
import { isEligible } from "./campaign";
import { isLifecycleSkip } from "./reporting";
import {
  DAY,
  HOUR,
  MAX_TRANSPORT_RECOVERIES,
  TRANSPORT_RECOVERY_MS,
  nextBudgetSlot,
  qualitySignal,
  sendingPolicy,
  sendingSettingsInput,
  type SendingPolicy,
  type SendingSettingsUpdate,
} from "./sending-policy";

export const WORKSPACE_HOLD = "workspace";
export const accountKey = (session: { id: string; phone: string | null }) =>
  session.phone ? "phone:" + session.phone : "session:" + session.id;

function isVerificationSchema() {
  try {
    return new URL(process.env.DATABASE_URL || "").searchParams.get("schema")?.startsWith("verify_") ?? false;
  } catch {
    return false;
  }
}

export async function getSendingPolicy(client: Pick<Prisma.TransactionClient, "sendingSettings"> = db): Promise<SendingPolicy> {
  const saved = await client.sendingSettings?.findUnique({ where: { id: WORKSPACE_HOLD } }).catch(() => null);
  if (saved) {
    return {
      minimumIntervalMs: saved.minimumIntervalMs,
      jitterMs: saved.jitterMs,
      maxPer15Minutes: saved.maxPer15Minutes,
      maxPerHour: saved.maxPerHour,
      maxPerDay: saved.maxPerDay,
      contactCooldownMs: saved.contactCooldownHours * HOUR,
      alwaysOpen: saved.alwaysOpen,
      startHour: saved.startHour,
      endHour: saved.endHour,
      activeDays: saved.activeDays.length ? saved.activeDays : [0, 1, 2, 3, 4, 5, 6],
      timezone: saved.timezone,
      businessName: saved.businessName,
      autoHoldOnQuality: saved.autoHoldOnQuality,
    };
  }
  const envPolicy = sendingPolicy();
  if (isVerificationSchema()) {
    return { ...envPolicy, autoHoldOnQuality: true };
  }
  // Default workspace experience: 24/7 operating hours and zero forced lockouts
  // unless customized in Settings -> Sending Rules.
  return {
    ...envPolicy,
    alwaysOpen: process.env.CAMPAIGN_ALWAYS_OPEN ? envPolicy.alwaysOpen : true,
    contactCooldownMs: 0,
    autoHoldOnQuality: envPolicy.autoHoldOnQuality,
  };
}

export async function updateSendingSettings(raw: SendingSettingsUpdate) {
  const parsed = sendingSettingsInput.parse(raw);
  const activeDays = [...new Set(parsed.activeDays)].sort((a, b) => a - b);
  const saved = await db.sendingSettings.upsert({
    where: { id: WORKSPACE_HOLD },
    create: { id: WORKSPACE_HOLD, ...parsed, activeDays },
    update: { ...parsed, activeDays },
  });
  if (!parsed.autoHoldOnQuality) {
    await db.sendingRecovery.deleteMany({});
  }
  await db.auditLog.create({
    data: { action: "sending.settings_updated", details: { ...parsed, activeDays } },
  });
  return saved;
}

export async function closeDeferredRuns(tx: Prisma.TransactionClient, campaignIds: string[], reason: string) {
  const runs = await tx.campaignRun.findMany({
    where: { campaignId: { in: campaignIds }, status: "RUNNING", nextAttemptAt: { not: null } },
    select: { id: true },
  });
  const skipReason = isLifecycleSkip(reason) ? reason : "Run paused before sending: " + reason;
  await tx.delivery.updateMany({
    where: { runId: { in: runs.map(run => run.id) }, status: "QUEUED" },
    data: { status: "SKIPPED", error: skipReason },
  });
  await tx.campaignRun.updateMany({
    where: { id: { in: runs.map(run => run.id) } },
    data: { status: "PARTIAL", finishedAt: new Date(), nextAttemptAt: null, error: reason },
  });
}

export async function activeSendingHold(key: string, sessionId?: string) {
  return db.sendingHold.findFirst({
    where: { accountKey: { in: [WORKSPACE_HOLD, key, ...(sessionId ? ["session:" + sessionId] : [])] }, releasedAt: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function holdSending(key: string, reason: string, notBefore: Date | null = null) {
  const paused = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const old = await tx.sendingHold.findUnique({ where: { accountKey: key } });
    await tx.sendingHold.upsert({
      where: { accountKey: key },
      create: { accountKey: key, reason, notBefore },
      update: old?.releasedAt === null ? {} : { reason, notBefore, createdAt: new Date(), releasedAt: null },
    });
    const sessions = key === WORKSPACE_HOLD ? null : await tx.waSession.findMany({
      where: key.startsWith("phone:") ? { phone: key.slice(6) } : { id: key.slice(8) },
      select: { id: true },
    });
    const campaigns = await tx.campaign.findMany({
      where: {
        status: { in: ["ACTIVE", "SCHEDULED"] },
        ...(sessions ? { sessionId: { in: sessions.map(session => session.id) } } : {}),
      },
      select: { id: true },
    });
    await tx.campaign.updateMany({ where: { id: { in: campaigns.map(item => item.id) } }, data: { status: "PAUSED" } });
    await closeDeferredRuns(tx, campaigns.map(item => item.id), reason);
    await tx.auditLog.create({
      data: { action: "sending.held", details: { accountKey: key, reason, pausedCampaigns: campaigns.length, notBefore: notBefore?.toISOString() } },
    });
    return campaigns;
  });
  for (const campaign of paused) {
    await removeSchedule(campaign.id).catch(error => console.error("Held campaign schedule cleanup failed", error));
  }
  return paused.length;
}

export async function reviewSendingHold(key: string, note = "Cleared from workspace", now = new Date(), force = false) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const hold = await tx.sendingHold.findUnique({ where: { accountKey: key } });
    if (!hold || hold.releasedAt) throw new Error("There is no active sending hold to clear.");
    if (!force && hold.notBefore && hold.notBefore > now) {
      throw new Error("The local hold has not ended. Respect the restriction shown in WhatsApp and review after " + hold.notBefore.toISOString());
    }
    await tx.sendingHold.update({ where: { accountKey: key }, data: { releasedAt: now } });
    await tx.sendingRecovery?.deleteMany({ where: key === WORKSPACE_HOLD ? {} : { accountKey: key } });
    await tx.auditLog.create({ data: { action: "sending.reviewed", details: { accountKey: key, note, force } } });
  });
}

export async function sendingSafetySummary(now = new Date(), sessionId?: string) {
  const policy = await getSendingPolicy();
  const session = sessionId ? await db.waSession.findUnique({ where: { id: sessionId } }) : null;
  const scopedKey = session ? accountKey(session) : undefined;
  const [holds, attempts, recoveries, savedSettings] = await Promise.all([
    db.sendingHold.findMany({ where: { releasedAt: null }, orderBy: { createdAt: "desc" } }),
    db.sendAttempt.findMany({
      where: {
        attemptedAt: { gt: new Date(now.getTime() - DAY) },
        ...(scopedKey ? { accountKey: scopedKey } : {}),
      },
      select: { attemptedAt: true, accountKey: true },
    }),
    db.sendingRecovery.findMany({ where: { cooldownUntil: { gt: now } }, orderBy: { cooldownUntil: "asc" } }),
    db.sendingSettings.findUnique({ where: { id: WORKSPACE_HOLD } }).catch(() => null),
  ]);
  return {
    policy,
    settings: {
      alwaysOpen: policy.alwaysOpen,
      startHour: savedSettings?.startHour ?? (policy.startHour === 0 && policy.endHour === 24 ? 8 : policy.startHour),
      endHour: savedSettings?.endHour ?? (policy.startHour === 0 && policy.endHour === 24 ? 18 : policy.endHour),
      activeDays: policy.activeDays,
      timezone: policy.timezone,
      minimumIntervalMs: policy.minimumIntervalMs,
      jitterMs: policy.jitterMs,
      maxPer15Minutes: policy.maxPer15Minutes,
      maxPerHour: policy.maxPerHour,
      maxPerDay: policy.maxPerDay,
      contactCooldownHours: Math.round((policy.contactCooldownMs / HOUR) * 100) / 100,
      autoHoldOnQuality: policy.autoHoldOnQuality,
      businessName: policy.businessName,
    },
    holds: holds.map(hold => ({ ...hold, canReview: !hold.notBefore || hold.notBefore <= now })),
    recoveries: recoveries.map(recovery => ({
      accountKey: recovery.accountKey,
      until: recovery.cooldownUntil,
      reason: recovery.reason,
      attempt: recovery.stage,
    })),
    used: {
      last15Minutes: attempts.filter(item => item.attemptedAt.getTime() > now.getTime() - 900000).length,
      lastHour: attempts.filter(item => item.attemptedAt.getTime() > now.getTime() - 3600000).length,
      lastDay: attempts.length,
    },
    nextSlot: nextBudgetSlot(attempts.map(item => item.attemptedAt), now, policy).toISOString(),
    transport: "WHATSAPP_WEB",
    providerQualityAvailable: false,
  };
}

type ReservationInput = {
  deliveryId: string;
  campaignId: string;
  revision: Date;
  session: { id: string; phone: string | null };
  recipientKeys: string[];
  contactId?: string;
  groupId?: string;
  intervalMs: number;
};
export type SendReservation =
  | { action: "SEND" }
  | { action: "STOP"; reason: string }
  | { action: "SKIP"; reason: string }
  | { action: "WAIT"; until: Date; reason: string };

export async function reserveSend(input: ReservationInput, now = new Date()): Promise<SendReservation> {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    const policy = await getSendingPolicy(tx);
    const campaign = await tx.campaign.findUnique({ where: { id: input.campaignId }, include: { session: true } });
    if (
      !campaign ||
      !["ACTIVE", "SCHEDULED"].includes(campaign.status) ||
      campaign.updatedAt.getTime() !== input.revision.getTime() ||
      campaign.session.status !== "CONNECTED" ||
      accountKey(campaign.session) !== accountKey(input.session)
    ) {
      return { action: "STOP", reason: "Campaign or account changed before sending" };
    }
    const key = accountKey(input.session);
    const hold = await tx.sendingHold.findFirst({
      where: { accountKey: { in: [WORKSPACE_HOLD, key, "session:" + input.session.id] }, releasedAt: null },
    });
    if (hold) return { action: "STOP", reason: hold.reason };
    const recovery = await tx.sendingRecovery.findUnique({ where: { accountKey: key } });
    if (recovery?.cooldownUntil && recovery.cooldownUntil > now) {
      return {
        action: "WAIT",
        until: recovery.cooldownUntil,
        reason: "Automatic transport recovery: " + recovery.reason + ". No uncertain send will be repeated.",
      };
    }
    if (await tx.sendAttempt.findUnique({ where: { deliveryId: input.deliveryId } })) {
      return { action: "SKIP", reason: "This send was already reserved; its receipt must be reconciled before any resend." };
    }
    if (input.contactId) {
      const contacts = await tx.contact.findMany({
        where: {
          AND: [
            {
              OR: [
                { id: input.contactId },
                { whatsappId: { in: input.recipientKeys.filter(k => k.startsWith("contact:")).map(k => k.slice(8)) } },
              ],
            },
            {
              OR: [
                { targets: { some: { campaignId: input.campaignId } } },
                { segments: { some: { segment: { targets: { some: { campaignId: input.campaignId } } } } } },
                ...((campaign.audienceType ?? "CONTACTS") === "CONTACTS"
                  ? [{ members: { some: { group: { targets: { some: { campaignId: input.campaignId } } } } } }]
                  : []),
              ],
            },
          ],
        },
      });
      if (!contacts.length) return { action: "SKIP", reason: "Contact is no longer in this campaign's selected audience." };
      const suppressed = await tx.contact.count({
        where: { whatsappId: { in: input.recipientKeys.map(k => k.replace(/^contact:/, "")) }, consent: "OPTED_OUT" },
      });
      if (!contacts.some(contact => isEligible(contact.consent, contact.whatsappId)) || suppressed) {
        return { action: "SKIP", reason: "Contact opted out, suppressed, or destination is invalid." };
      }
    } else if (input.groupId) {
      const group = await tx.waGroup.findUnique({ where: { id: input.groupId } });
      if (!group?.allowPosting || group.sessionId !== input.session.id) {
        return { action: "SKIP", reason: "Group posting is disabled for this group." };
      }
    }

    // Per-campaign repeat & standby control (applies to DMs and Groups as chosen).
    if (campaign.repeatPolicy === "NO_REPEAT") {
      const prior = await tx.sendAttempt.findFirst({
        where: {
          recipientKeys: { hasSome: input.recipientKeys },
          outcome: { in: ["SENDING", "SENT", "DELIVERED", "READ", "UNKNOWN"] },
        },
        orderBy: { attemptedAt: "desc" },
      });
      if (prior) {
        return {
          action: "SKIP",
          reason: "Skipped: recipient was already messaged in an earlier or standby campaign (No-repeat rule).",
        };
      }
    } else if (campaign.repeatPolicy === "COOLDOWN") {
      const cooldownMs = campaign.repeatCooldownHours > 0
        ? campaign.repeatCooldownHours * HOUR
        : policy.contactCooldownMs || 24 * HOUR;
      const recentAttempt = await tx.sendAttempt.findFirst({
        where: {
          recipientKeys: { hasSome: input.recipientKeys },
          attemptedAt: { gt: new Date(now.getTime() - cooldownMs) },
          outcome: { notIn: ["SKIPPED", "FAILED"] },
        },
        orderBy: { attemptedAt: "desc" },
      });
      if (recentAttempt) {
        return {
          action: "SKIP",
          reason: "Recipient cooldown active until " + new Date(recentAttempt.attemptedAt.getTime() + cooldownMs).toISOString(),
        };
      }
    } else if (input.contactId && campaign.scheduleType !== "CRON" && policy.contactCooldownMs > 0) {
      const recentAttempt = await tx.sendAttempt.findFirst({
        where: {
          recipientKeys: { hasSome: input.recipientKeys },
          attemptedAt: { gt: new Date(now.getTime() - policy.contactCooldownMs) },
        },
        orderBy: { attemptedAt: "desc" },
      });
      if (recentAttempt) {
        return {
          action: "SKIP",
          reason: "Recipient frequency limit: a campaign send was already attempted recently. Next eligible after "
            + new Date(recentAttempt.attemptedAt.getTime() + policy.contactCooldownMs).toISOString(),
        };
      }
    }

    // Scope rate limits to the phone account key (shared if two sessions connect the same number,
    // independent for separate phone numbers).
    const recent = await tx.sendAttempt.findMany({
      where: { accountKey: key, attemptedAt: { gt: new Date(now.getTime() - DAY) } },
      select: { attemptedAt: true },
    });
    const next = nextBudgetSlot(recent.map(item => item.attemptedAt), now, policy, input.intervalMs);
    if (next > now) {
      return { action: "WAIT", until: next, reason: "Pacing budget, minimum interval or operating hours" };
    }
    await tx.sendAttempt.create({
      data: {
        deliveryId: input.deliveryId,
        sessionId: input.session.id,
        accountKey: key,
        recipientKeys: input.recipientKeys,
        attemptedAt: now,
      },
    });
    await tx.delivery.update({ where: { id: input.deliveryId }, data: { status: "SENDING" } });
    return { action: "SEND" };
  }, { timeout: 30000 });
}

export async function evaluateSendingQuality(key: string, now = new Date()) {
  const action = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const policy = await getSendingPolicy(tx);
    if (!policy.autoHoldOnQuality) {
      await tx.sendingRecovery?.deleteMany({ where: { accountKey: key } });
      return null;
    }
    const holds = await tx.sendingHold.findMany({ where: { accountKey: { in: [WORKSPACE_HOLD, key] } } });
    if (holds.some(hold => !hold.releasedAt)) return null;
    const recovery = await tx.sendingRecovery.findUnique({ where: { accountKey: key } });
    if (recovery?.cooldownUntil && recovery.cooldownUntil > now) return null;
    const recoveredRecently = !!recovery && recovery.updatedAt.getTime() > now.getTime() - DAY;
    const baseline = recoveredRecently ? recovery.baselineAt.getTime() : 0;
    const since = new Date(Math.max(now.getTime() - DAY, ...holds.map(hold => hold.releasedAt?.getTime() || 0)));
    const allAttempts = await tx.sendAttempt.findMany({
      where: { accountKey: key, OR: [{ attemptedAt: { gt: since } }, { optedOutAt: { gt: since } }] },
      orderBy: { attemptedAt: "desc" },
    });
    const consentSignal = qualitySignal(allAttempts);
    if (consentSignal?.kind === "CONSENT") {
      return { hold: consentSignal.reason };
    }
    const attempts = allAttempts.filter(attempt => attempt.attemptedAt.getTime() > baseline);
    const signal = qualitySignal(attempts);
    if (!signal) {
      if (recovery && attempts.some(attempt => ["SENT", "DELIVERED", "READ"].includes(attempt.outcome))) {
        await tx.sendingRecovery?.deleteMany({ where: { accountKey: key } });
      }
      return null;
    }
    if (recoveredRecently && recovery.stage >= MAX_TRANSPORT_RECOVERIES) {
      return { hold: signal.reason + " Automatic recovery was attempted but new sends still failed. Check WhatsApp and reconcile receipts before resuming." };
    }

    const lastAttempt = attempts[0]?.attemptedAt?.getTime() || now.getTime();
    const until = new Date(Math.max(now.getTime(), lastAttempt) + TRANSPORT_RECOVERY_MS);
    const nextBaseline = new Date(Math.max(now.getTime(), lastAttempt));
    const stage = recoveredRecently ? recovery.stage + 1 : 1;
    await tx.sendingRecovery.upsert({
      where: { accountKey: key },
      create: { accountKey: key, stage, reason: signal.reason, cooldownUntil: until, baselineAt: nextBaseline },
      update: { stage, reason: signal.reason, cooldownUntil: until, baselineAt: nextBaseline },
    });
    await tx.auditLog.create({
      data: {
        action: "sending.automatic_recovery",
        details: {
          accountKey: key,
          stage,
          until: until.toISOString(),
          reason: signal.reason,
          attempted: attempts.length,
          policy: "Unknown attempts are never automatically resent",
        },
      },
    });
    return null;
  }, { timeout: 30000 });
  if (action?.hold) await holdSending(key, action.hold);
}

export async function initializeSendingSafety() {
  // Upgrade legacy groups that were imported when allowPosting defaulted to false
  // and were never explicitly disabled by the user.
  if (!await db.auditLog.findFirst({ where: { action: "groups.default_posting_enabled_v2" }, select: { id: true } })) {
    const manualGroupPermissions = await db.auditLog.findMany({
      where: { action: "group.permission" },
      select: { details: true },
    });
    const explicitlyDisabled = new Set(
      manualGroupPermissions
        .map(entry => entry.details as { groupId?: string; allowPosting?: boolean } | null)
        .filter(details => details?.allowPosting === false && details.groupId)
        .map(details => details!.groupId!),
    );
    await db.waGroup.updateMany({
      where: { allowPosting: false, ...(explicitlyDisabled.size ? { id: { notIn: [...explicitlyDisabled] } } : {}) },
      data: { allowPosting: true },
    });
    await db.auditLog.create({ data: { action: "groups.default_posting_enabled_v2", details: {} } });
  }

  if (await db.auditLog.findFirst({ where: { action: "sending_safety.initialized" }, select: { id: true } })) return;
  const [sessions, contacts, groups] = await Promise.all([
    db.waSession.findMany(),
    db.contact.findMany({ select: { id: true, whatsappId: true } }),
    db.waGroup.findMany({ select: { id: true, whatsappId: true } }),
  ]);
  const policy = await getSendingPolicy();
  const since = new Date(Date.now() - Math.max(DAY, policy.contactCooldownMs));
  const deliveries = await db.delivery.findMany({
    where: {
      status: { in: ["SENDING", "SENT", "DELIVERED", "READ", "UNKNOWN", "FAILED"] },
      OR: [{ sentAt: { gte: since } }, { sentAt: null, updatedAt: { gte: since } }],
    },
    include: { run: { select: { sessionIdSnapshot: true, campaign: { select: { sessionId: true } } } } },
  });
  const bySession = new Map(sessions.map(item => [item.id, item]));
  const contactIds = new Map(contacts.map(item => [item.id, item.whatsappId]));
  const groupIds = new Map(groups.map(item => [item.id, item.whatsappId]));
  const rows = deliveries.map(delivery => {
    const sessionId = delivery.run.sessionIdSnapshot || delivery.run.campaign.sessionId;
    const session = bySession.get(sessionId);
    const sourceId = delivery.recipientKey.replace(/^(contact|group):/, "");
    const id = sourceId.includes("@")
      ? sourceId
      : delivery.recipientKey.startsWith("contact:")
        ? contactIds.get(sourceId)
        : groupIds.get(sourceId);
    return {
      deliveryId: delivery.id,
      accountKey: session ? accountKey(session) : "session:" + sessionId,
      sessionId,
      recipientKeys: id ? [(delivery.recipientKey.startsWith("contact:") ? "contact:" : "group:") + id] : [],
      attemptedAt: delivery.sentAt || delivery.updatedAt,
      outcome: delivery.status as DeliveryStatus,
      messageId: delivery.messageId,
    };
  });
  for (let start = 0; start < rows.length; start += 500) {
    await db.sendAttempt.createMany({ data: rows.slice(start, start + 500), skipDuplicates: true });
  }
  await db.auditLog.create({ data: { action: "sending_safety.initialized", details: { importedAttempts: rows.length } } });
}
