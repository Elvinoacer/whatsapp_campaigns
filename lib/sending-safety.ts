import type { DeliveryStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { removeSchedule } from "./queue";
import { hasConsentEvidence, isEligible } from "./campaign";
import { DAY, MAX_TRANSPORT_RECOVERIES, TRANSPORT_RECOVERY_MS, nextBudgetSlot, qualitySignal, sendingPolicy } from "./sending-policy";

export const WORKSPACE_HOLD = "workspace";
export const accountKey = (session: { id: string; phone: string | null }) => session.phone ? "phone:" + session.phone : "session:" + session.id;

export async function closeDeferredRuns(tx: Prisma.TransactionClient, campaignIds: string[], reason: string) {
  const runs = await tx.campaignRun.findMany({ where: { campaignId: { in: campaignIds }, status: "RUNNING", nextAttemptAt: { not: null } }, select: { id: true } });
  await tx.delivery.updateMany({ where: { runId: { in: runs.map(run => run.id) }, status: "QUEUED" }, data: { status: "SKIPPED", error: reason } });
  await tx.campaignRun.updateMany({ where: { id: { in: runs.map(run => run.id) } },
    data: { status: "PARTIAL", finishedAt: new Date(), nextAttemptAt: null, error: reason } });
}

export async function activeSendingHold(key: string, sessionId?: string) {
  return db.sendingHold.findFirst({ where: { accountKey: { in: [WORKSPACE_HOLD, key, ...(sessionId ? ["session:" + sessionId] : [])] }, releasedAt: null }, orderBy: { createdAt: "asc" } });
}

export async function holdSending(key: string, reason: string, notBefore: Date | null = null) {
  const paused = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const old = await tx.sendingHold.findUnique({ where: { accountKey: key } });
    // Repeated copies of the same signal do not extend an existing hold.
    await tx.sendingHold.upsert({ where: { accountKey: key }, create: { accountKey: key, reason, notBefore },
      update: old?.releasedAt === null ? {} : { reason, notBefore, createdAt: new Date(), releasedAt: null } });
    const sessions = key === WORKSPACE_HOLD ? null : await tx.waSession.findMany({
      where: key.startsWith("phone:") ? { phone: key.slice(6) } : { id: key.slice(8) }, select: { id: true },
    });
    const campaigns = await tx.campaign.findMany({ where: { status: { in: ["ACTIVE", "SCHEDULED"] },
      ...(sessions ? { sessionId: { in: sessions.map(session => session.id) } } : {}) }, select: { id: true } });
    await tx.campaign.updateMany({ where: { id: { in: campaigns.map(item => item.id) } }, data: { status: "PAUSED" } });
    await closeDeferredRuns(tx, campaigns.map(item => item.id), reason);
    await tx.auditLog.create({ data: { action: "sending.held", details: { accountKey: key, reason, pausedCampaigns: campaigns.length, notBefore: notBefore?.toISOString() } } });
    return campaigns;
  });
  for (const campaign of paused) await removeSchedule(campaign.id).catch(error => console.error("Held campaign schedule cleanup failed", error));
  return paused.length;
}

export async function reviewSendingHold(key: string, note: string, now = new Date()) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const hold = await tx.sendingHold.findUnique({ where: { accountKey: key } });
    if (!hold || hold.releasedAt) throw new Error("There is no active sending hold to review.");
    if (hold.notBefore && hold.notBefore > now) throw new Error("The local hold has not ended. Respect the restriction shown in WhatsApp and review after " + hold.notBefore.toISOString());
    await tx.sendingHold.update({ where: { accountKey: key }, data: { releasedAt: now } });
    await tx.auditLog.create({ data: { action: "sending.reviewed", details: { accountKey: key, note } } });
    // Campaigns remain paused. Review never starts a campaign or clears quotas.
  });
}

export async function sendingSafetySummary(now = new Date()) {
  const policy = sendingPolicy();
  const [holds, attempts, recoveries] = await Promise.all([
    db.sendingHold.findMany({ where: { releasedAt: null }, orderBy: { createdAt: "desc" } }),
    db.sendAttempt.findMany({ where: { attemptedAt: { gt: new Date(now.getTime() - DAY) } }, select: { attemptedAt: true } }),
    db.sendingRecovery.findMany({ where: { cooldownUntil: { gt: now } }, orderBy: { cooldownUntil: "asc" } }),
  ]);
  return { policy, holds: holds.map(hold => ({ ...hold, canReview: !hold.notBefore || hold.notBefore <= now })),
    recoveries: recoveries.map(recovery => ({ accountKey: recovery.accountKey, until: recovery.cooldownUntil, reason: recovery.reason, attempt: recovery.stage })),
    used: { last15Minutes: attempts.filter(item => item.attemptedAt.getTime() > now.getTime() - 900000).length,
    lastHour: attempts.filter(item => item.attemptedAt.getTime() > now.getTime() - 3600000).length, lastDay: attempts.length },
    nextSlot: nextBudgetSlot(attempts.map(item => item.attemptedAt), now, policy).toISOString(),
    transport: "WHATSAPP_WEB", providerQualityAvailable: false };
}

type ReservationInput = {
  deliveryId: string; campaignId: string; revision: Date; session: { id: string; phone: string | null };
  recipientKeys: string[]; contactId?: string; groupId?: string; intervalMs: number;
};
export type SendReservation = { action: "SEND" } | { action: "STOP"; reason: string }
  | { action: "SKIP"; reason: string } | { action: "WAIT"; until: Date; reason: string };

export async function reserveSend(input: ReservationInput, now = new Date()): Promise<SendReservation> {
  const policy = sendingPolicy();
  return db.$transaction(async tx => {
    // The reservation precedes every network call. It survives crashes, unknown
    // receipts, campaign deletion, restarts and switching sending accounts.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    // Membership edits and group refreshes use this lock before the consent
    // lock. Their committed removals must be visible before reserving a send.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    const campaign = await tx.campaign.findUnique({ where: { id: input.campaignId }, include: { session: true } });
    if (!campaign || !["ACTIVE", "SCHEDULED"].includes(campaign.status) || campaign.updatedAt.getTime() !== input.revision.getTime()
      || campaign.session.status !== "CONNECTED" || accountKey(campaign.session) !== accountKey(input.session))
      return { action: "STOP", reason: "Campaign or account changed before sending" };
    const hold = await tx.sendingHold.findFirst({ where: { accountKey: { in: [WORKSPACE_HOLD, accountKey(input.session), "session:" + input.session.id] }, releasedAt: null } });
    if (hold) return { action: "STOP", reason: hold.reason };
    const recovery = await tx.sendingRecovery.findUnique({ where: { accountKey: accountKey(input.session) } });
    if (recovery?.cooldownUntil && recovery.cooldownUntil > now)
      return { action: "WAIT", until: recovery.cooldownUntil, reason: "Automatic transport recovery: " + recovery.reason + ". No uncertain send will be repeated." };
    if (await tx.sendAttempt.findUnique({ where: { deliveryId: input.deliveryId } }))
      return { action: "SKIP", reason: "This send was already reserved; its receipt must be reconciled before any resend." };
    if (input.contactId) {
      // A queued delivery is a reporting snapshot, not a permanent audience
      // grant. Keep the complete selected-source union, including explicit
      // contacts, but revoke unsent recipients who left every selected source.
      const contacts = await tx.contact.findMany({ where: { AND: [{ OR: [
        { id: input.contactId }, { whatsappId: { in: input.recipientKeys.filter(key => key.startsWith("contact:")).map(key => key.slice(8)) } },
      ] }, { OR: [
        { targets: { some: { campaignId: input.campaignId } } },
        { segments: { some: { segment: { targets: { some: { campaignId: input.campaignId } } } } } },
        { members: { some: { group: { targets: { some: { campaignId: input.campaignId } } } } } },
      ] }] } });
      if (!contacts.length) return { action: "SKIP", reason: "Contact is no longer in this campaign's selected audience." };
      const suppressed = await tx.contact.count({ where: { whatsappId: { in: input.recipientKeys.map(key => key.slice(8)) }, consent: "OPTED_OUT" } });
      if (!contacts.some(contact => isEligible(contact.consent, contact.whatsappId) && hasConsentEvidence(contact)) || suppressed)
        return { action: "SKIP", reason: "Verified consent was revoked, missing, or the contact is suppressed." };
    } else if (input.groupId) {
      const group = await tx.waGroup.findUnique({ where: { id: input.groupId } });
      if (!group?.allowPosting || group.sessionId !== input.session.id) return { action: "SKIP", reason: "Group posting permission was revoked." };
    }
    if (policy.contactCooldownMs > 0) {
      const recent = await tx.sendAttempt.findFirst({ where: { recipientKeys: { hasSome: input.recipientKeys },
        attemptedAt: { gt: new Date(now.getTime() - policy.contactCooldownMs) } }, orderBy: { attemptedAt: "desc" } });
      if (recent) return { action: "SKIP", reason: "Recipient frequency limit: a campaign send was already attempted recently. Next eligible after "
        + new Date(recent.attemptedAt.getTime() + policy.contactCooldownMs).toISOString() };
    }
    const recent = await tx.sendAttempt.findMany({ where: { attemptedAt: { gt: new Date(now.getTime() - DAY) } }, select: { attemptedAt: true } });
    const next = nextBudgetSlot(recent.map(item => item.attemptedAt), now, policy, input.intervalMs);
    if (next > now) return { action: "WAIT", until: next, reason: "Shared sending budget, minimum interval or permitted sending hours" };
    await tx.sendAttempt.create({ data: { deliveryId: input.deliveryId, sessionId: input.session.id,
      accountKey: accountKey(input.session), recipientKeys: input.recipientKeys, attemptedAt: now } });
    await tx.delivery.update({ where: { id: input.deliveryId }, data: { status: "SENDING" } });
    return { action: "SEND" };
  }, { timeout: 30000 });
}

export async function evaluateSendingQuality(key: string, now = new Date()) {
  // Real restrictions and consent-quality holds remain manual. Transport
  // instability gets exactly one durable automatic cooldown per 24h window;
  // a second failing probe escalates to review rather than sending indefinitely.
  const action = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342103)`;
    const holds = await tx.sendingHold.findMany({ where: { accountKey: { in: [WORKSPACE_HOLD, key] } } });
    if (holds.some(hold => !hold.releasedAt)) return null;
    const recovery = await tx.sendingRecovery.findUnique({ where: { accountKey: key } });
    if (recovery?.cooldownUntil && recovery.cooldownUntil > now) return null;
    const recoveredRecently = !!recovery && recovery.updatedAt.getTime() > now.getTime() - DAY;
    const baseline = recoveredRecently ? recovery.baselineAt.getTime() : 0;
    // Consent problems always use the full post-review 24h sample, regardless
    // of technical recovery. A transport baseline must never hide opt-outs.
    const since = new Date(Math.max(now.getTime() - DAY, ...holds.map(hold => hold.releasedAt?.getTime() || 0)));
    const allAttempts = await tx.sendAttempt.findMany({ where: { accountKey: key,
      OR: [{ attemptedAt: { gt: since } }, { optedOutAt: { gt: since } }] }, orderBy: { attemptedAt: "desc" } });
    const consentSignal = qualitySignal(allAttempts);
    if (consentSignal?.kind === "CONSENT") return { hold: consentSignal.reason };
    const attempts = allAttempts.filter(attempt => attempt.attemptedAt.getTime() > baseline);
    const signal = qualitySignal(attempts);
    if (!signal) return null;
    if (recoveredRecently && recovery.stage >= MAX_TRANSPORT_RECOVERIES)
      return { hold: signal.reason + " Automatic recovery was attempted but new sends still failed. Check WhatsApp and reconcile receipts before resuming." };

    const lastAttempt = attempts[0]?.attemptedAt?.getTime() || now.getTime();
    const until = new Date(Math.max(now.getTime(), lastAttempt) + TRANSPORT_RECOVERY_MS);
    // Use the last evaluated attempt as the baseline: previously uncertain sends
    // never count as fresh failures on resume, even on a simulated clock.
    const nextBaseline = new Date(Math.max(now.getTime(), lastAttempt));
    const stage = recoveredRecently ? recovery.stage + 1 : 1;
    await tx.sendingRecovery.upsert({ where: { accountKey: key },
      create: { accountKey: key, stage, reason: signal.reason, cooldownUntil: until, baselineAt: nextBaseline },
      update: { stage, reason: signal.reason, cooldownUntil: until, baselineAt: nextBaseline } });
    await tx.auditLog.create({ data: { action: "sending.automatic_recovery", details: {
      accountKey: key, stage, until: until.toISOString(), reason: signal.reason,
      attempted: attempts.length, policy: "Unknown attempts are never automatically resent",
    } } });
    return null;
  }, { timeout: 30000 });
  if (action?.hold) await holdSending(key, action.hold);
}

export async function initializeSendingSafety() {
  if (await db.auditLog.findFirst({ where: { action: "sending_safety.initialized" }, select: { id: true } })) return;
  const [sessions, contacts, groups] = await Promise.all([
    db.waSession.findMany(), db.contact.findMany({ select: { id: true, whatsappId: true } }), db.waGroup.findMany({ select: { id: true, whatsappId: true } }),
  ]);
  const policy = sendingPolicy();
  const since = new Date(Date.now() - Math.max(DAY, policy.contactCooldownMs));
  const deliveries = await db.delivery.findMany({ where: { status: { in: ["SENDING", "SENT", "DELIVERED", "READ", "UNKNOWN", "FAILED"] },
    OR: [{ sentAt: { gte: since } }, { sentAt: null, updatedAt: { gte: since } }] }, include: { run: { select: { sessionIdSnapshot: true, campaign: { select: { sessionId: true } } } } } });
  const bySession = new Map(sessions.map(item => [item.id, item]));
  const contactIds = new Map(contacts.map(item => [item.id, item.whatsappId]));
  const groupIds = new Map(groups.map(item => [item.id, item.whatsappId]));
  const rows = deliveries.map(delivery => {
    const sessionId = delivery.run.sessionIdSnapshot || delivery.run.campaign.sessionId;
    const session = bySession.get(sessionId);
    const sourceId = delivery.recipientKey.replace(/^(contact|group):/, "");
    const id = sourceId.includes("@") ? sourceId : delivery.recipientKey.startsWith("contact:")
      ? contactIds.get(sourceId) : groupIds.get(sourceId);
    return { deliveryId: delivery.id, accountKey: session ? accountKey(session) : "session:" + sessionId, sessionId,
      recipientKeys: id ? [(delivery.recipientKey.startsWith("contact:") ? "contact:" : "group:") + id] : [],
      attemptedAt: delivery.sentAt || delivery.updatedAt, outcome: delivery.status as DeliveryStatus, messageId: delivery.messageId };
  });
  for (let start = 0; start < rows.length; start += 500) await db.sendAttempt.createMany({ data: rows.slice(start, start + 500), skipDuplicates: true });
  await db.auditLog.create({ data: { action: "sending_safety.initialized", details: { importedAttempts: rows.length } } });
}
