import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { runCampaign } from "../worker/campaign";
import { recordOptOut } from "../worker/events";
import { accountKey, activeSendingHold, evaluateSendingQuality, reserveSend, reviewSendingHold } from "../lib/sending-safety";
import { removeSchedule } from "../lib/queue";
import { DAY } from "../lib/sending-policy";

type Request = (path: string, method?: string, body?: unknown, status?: number) => Promise<unknown>;
export async function checkSendingSafety(request: Request) {
  assert(new URL(process.env.DATABASE_URL!).searchParams.get("schema")?.startsWith("verify_"), "Safety checks require an isolated verification schema");
  const names = ["CAMPAIGN_MAX_PER_15_MINUTES", "CAMPAIGN_MAX_PER_HOUR", "CAMPAIGN_MAX_PER_DAY", "CAMPAIGN_CONTACT_COOLDOWN_HOURS"];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const stamp = randomUUID().slice(0, 8);
  const session = await db.waSession.create({ data: { label: "Safety account", status: "CONNECTED", phone: "254799888777" } });
  const second = await db.waSession.create({ data: { label: "Same account, another connection", status: "CONNECTED", phone: session.phone } });
  const contacts = await db.contact.createManyAndReturn({ data: Array.from({ length: 8 }, (_, i) => ({ sessionId: session.id,
    whatsappId: `2547998877${String(i).padStart(2, "0")}@c.us`, phone: `2547998877${String(i).padStart(2, "0")}`,
    name: `Safety recipient ${i}`, consent: "OPTED_IN" as const, consentNote: "Explicit verification signup", consentAt: new Date(),
  })) });
  const makeCampaign = (name: string, ids = contacts.slice(0, 2).map(contact => contact.id)) => db.campaign.create({ data: {
    name, message: "An expected update", sessionId: session.id, status: "ACTIVE", audienceType: "CONTACTS",
    contacts: { create: ids.map(contactId => ({ contactId })) },
  } });
  const client = { sendMessage: async () => ({ id: { _serialized: randomUUID() }, ack: 1 }) } as unknown as NonNullable<ReturnType<Parameters<typeof runCampaign>[1]>>;
  try {
    // Clear only this disposable schema's earlier test ledger. Never production.
    await db.sendAttempt.deleteMany();
    process.env.CAMPAIGN_MAX_PER_15_MINUTES = "1";
    const campaign = await makeCampaign("Staged bulk delivery");
    let sends = 0;
    const sendingClient = { sendMessage: async (to: string, content: string) => { sends++; assert.match(content, /Reply STOP to unsubscribe/); return client.sendMessage(to, content); } } as typeof client;
    let now = new Date();
    await runCampaign({ id: "safety-stage-" + stamp, data: { campaignId: campaign.id } }, () => sendingClient, { sleep: async () => {}, now: () => { now = new Date(now.getTime() + 6000); return now; } });
    assert.equal(sends, 1);
    const waiting = await db.campaignRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
    assert.equal(waiting.status, "RUNNING"); assert(waiting.nextAttemptAt);
    assert.equal(await db.delivery.count({ where: { runId: waiting.id, status: "QUEUED" } }), 1);
    assert.equal(await db.delivery.count({ where: { runId: waiting.id, status: "SKIPPED" } }), 0);
    // Continue the SAME run after the budget window, without another first send.
    now = new Date(waiting.nextAttemptAt.getTime() + 1000);
    await runCampaign({ id: "safety-continue-" + stamp, data: { campaignId: campaign.id, continuationRunKey: waiting.jobKey } }, () => sendingClient,
      { sleep: async () => {}, now: () => now });
    assert.equal(sends, 2); assert.equal(await db.campaignRun.count({ where: { campaignId: campaign.id } }), 1);
    assert.equal((await db.campaignRun.findUniqueOrThrow({ where: { id: waiting.id } })).status, "COMPLETED");
    await removeSchedule(campaign.id);
    const attempts = await db.sendAttempt.findMany({ where: { sessionId: session.id }, orderBy: { attemptedAt: "desc" } });
    assert.equal(attempts.length, 2);
    const nextCampaign = await makeCampaign("Global reservations", [contacts[2].id]);
    const nextRun = await db.campaignRun.create({ data: { campaignId: nextCampaign.id, jobKey: "reserve-" + stamp } });
    const delivery = await db.delivery.create({ data: { runId: nextRun.id, recipient: "Reserved", recipientKey: "contact:" + contacts[2].whatsappId } });
    const input = { deliveryId: delivery.id, campaignId: nextCampaign.id, revision: nextCampaign.updatedAt, session,
      recipientKeys: ["contact:" + contacts[2].whatsappId], contactId: contacts[2].id, intervalMs: 1500 };
    await db.sendAttempt.update({ where: { id: attempts[0].id }, data: { outcome: "UNKNOWN" } });
    assert.equal((await reserveSend(input, now)).action, "WAIT", "Unknown sends consume shared capacity");
    // Moving the campaign to another connection cannot multiply the budget.
    const moved = await db.campaign.update({ where: { id: nextCampaign.id }, data: { sessionId: second.id } });
    assert.equal((await reserveSend({ ...input, revision: moved.updatedAt, session: second }, now)).action, "WAIT");
    await db.campaign.delete({ where: { id: campaign.id } });
    assert.equal(await db.sendAttempt.count({ where: { sessionId: session.id } }), 2, "Campaign deletion preserves reservations");
    process.env.CAMPAIGN_MAX_PER_15_MINUTES = "100000";
    process.env.CAMPAIGN_CONTACT_COOLDOWN_HOURS = "168";
    const cooldownDelivery = await db.delivery.create({ data: { runId: nextRun.id, recipient: "Repeated recipient", recipientKey: "contact:" + contacts[0].whatsappId } });
    assert.equal((await reserveSend({ ...input, revision: moved.updatedAt, session: second, deliveryId: cooldownDelivery.id,
      contactId: contacts[0].id, recipientKeys: ["contact:" + contacts[0].whatsappId] }, new Date(now.getTime() + DAY))).action, "SKIP");
    process.env.CAMPAIGN_CONTACT_COOLDOWN_HOURS = "0";
    await request("/api/v1/safety/hold", "POST", { sessionId: session.id, reason: "Restriction reported during isolated verification", restriction: true });
    assert(await activeSendingHold(accountKey(second), second.id));
    assert.equal((await reserveSend({ ...input, revision: moved.updatedAt, session: second }, new Date(now.getTime() + DAY))).action, "STOP");
    await request(`/api/v1/campaigns/${moved.id}/action`, "POST", { action: "resume" }, 423);
    await request("/api/v1/safety/review", "POST", { accountKey: accountKey(session), confirmed: false, note: "Verified account access" }, 400);
    await request("/api/v1/safety/review", "POST", { accountKey: accountKey(session), confirmed: true, note: "Verified account access" }, 423);
    // Simulate expiry; expiry alone never removes the hold.
    await db.sendingHold.update({ where: { accountKey: accountKey(session) }, data: { notBefore: new Date(Date.now() - 1000) } });
    assert(await activeSendingHold(accountKey(second), second.id));
    await request("/api/v1/safety/review", "POST", { accountKey: accountKey(session), confirmed: true, note: "Checked restriction ended, consent, relevance and frequency" });
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: moved.id } })).status, "PAUSED");
    assert.equal(await db.sendAttempt.count({ where: { sessionId: session.id } }), 2);
    console.log("✓ Safety: durable staged continuation, shared budgets across connections, uncertainty accounting, deletion-proof counters, frequency caps and restriction review");

    await db.sendAttempt.deleteMany();
    process.env.CAMPAIGN_MAX_PER_15_MINUTES = "1";
    const pausedWait = await makeCampaign("Pause deferred delivery", contacts.slice(4, 6).map(contact => contact.id));
    let pausedSends = 0; let pausedClock = Date.now();
    const pausedClient = { sendMessage: async (to: string, content: string) => { pausedSends++; return client.sendMessage(to, content); } } as typeof client;
    await runCampaign({ id: "safety-pause-wait-" + stamp, data: { campaignId: pausedWait.id } }, () => pausedClient,
      { sleep: async () => {}, now: () => new Date(pausedClock += 6000) });
    const pausedRun = await db.campaignRun.findFirstOrThrow({ where: { campaignId: pausedWait.id } });
    assert(pausedRun.nextAttemptAt); assert.equal(pausedSends, 1);
    await request(`/api/v1/campaigns/${pausedWait.id}/action`, "POST", { action: "pause" });
    const stoppedRun = await db.campaignRun.findUniqueOrThrow({ where: { id: pausedRun.id } });
    assert.equal(stoppedRun.status, "PARTIAL"); assert.equal(stoppedRun.nextAttemptAt, null);
    assert.equal(await db.delivery.count({ where: { runId: pausedRun.id, status: "QUEUED" } }), 0);
    await runCampaign({ id: "safety-stale-continuation-" + stamp, data: { campaignId: pausedWait.id,
      revision: pausedWait.updatedAt.toISOString(), continuationRunKey: pausedRun.jobKey } }, () => pausedClient,
      { sleep: async () => {}, now: () => new Date(pausedRun.nextAttemptAt!.getTime() + 1000) });
    assert.equal(pausedSends, 1, "Pausing a deferred campaign makes its continuation inert");
    console.log("✓ Safety: pausing a deferred run removes pending work and prevents its stale continuation from sending");

    await db.sendAttempt.deleteMany();
    process.env.CAMPAIGN_MAX_PER_15_MINUTES = "100000";
    const unhealthy = await makeCampaign("Failure circuit breaker", contacts.slice(0, 4).map(contact => contact.id));
    let failedSends = 0; let clock = Date.now();
    const missingClient = { sendMessage: async () => { failedSends++; return undefined; } } as unknown as typeof client;
    await runCampaign({ id: "safety-failure-" + stamp, data: { campaignId: unhealthy.id } }, () => missingClient,
      { sleep: async () => {}, now: () => new Date(clock += 6000) });
    assert.equal(failedSends, 3, "Three uncertain sends trigger an automatic cooldown before a fourth attempt");
    assert.equal(await activeSendingHold(accountKey(session)), null, "Recoverable technical uncertainty must not immediately require manual review");
    const recovery = await db.sendingRecovery.findUniqueOrThrow({ where: { accountKey: accountKey(session) } });
    assert.equal(recovery.stage, 1);
    assert(recovery.cooldownUntil && recovery.cooldownUntil > new Date(clock));
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: unhealthy.id } })).status, "ACTIVE");
    const recoveryRun = await db.campaignRun.findFirstOrThrow({ where: { campaignId: unhealthy.id } });
    assert.equal(recoveryRun.status, "RUNNING");
    assert(recoveryRun.nextAttemptAt);
    assert.equal(await db.delivery.count({ where: { runId: recoveryRun.id, status: "QUEUED" } }), 1);
    // The same underlying phone must observe the cooldown through another session.
    const crossRun = await db.campaignRun.findUniqueOrThrow({ where: { id: nextRun.id } });
    const samePhoneDelivery = await db.delivery.create({ data: { runId: crossRun.id, recipient: "Other connection", recipientKey: "contact:" + contacts[7].whatsappId } });
    const pausedAcrossSessions = await reserveSend({ ...input, campaignId: nextCampaign.id, revision: moved.updatedAt,
      session: second, deliveryId: samePhoneDelivery.id, contactId: contacts[7].id,
      recipientKeys: ["contact:" + contacts[7].whatsappId] }, new Date(clock + 1000));
    assert.equal(pausedAcrossSessions.action, "WAIT");
    if (pausedAcrossSessions.action === "WAIT") assert.equal(pausedAcrossSessions.until.getTime(), recovery.cooldownUntil.getTime());
    // A delayed job continues the same run; it never retries the first three uncertain sends.
    clock = recovery.cooldownUntil.getTime() + 1000;
    await runCampaign({ id: "safety-recovered-" + stamp, data: { campaignId: unhealthy.id,
      continuationRunKey: recoveryRun.jobKey } }, () => missingClient,
      { sleep: async () => {}, now: () => new Date(clock += 6000) });
    assert.equal(failedSends, 4);
    assert.equal(await db.campaignRun.count({ where: { campaignId: unhealthy.id } }), 1);
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: unhealthy.id } })).status, "COMPLETED");
    assert.equal((await db.campaignRun.findUniqueOrThrow({ where: { id: recoveryRun.id } })).status, "PARTIAL");

    // A second new set of uncertain sends after recovery escalates to a genuine
    // manual hold instead of indefinitely probing a possibly restricted account.
    const unhealthyAgain = await makeCampaign("Repeated failure after automatic recovery", contacts.slice(4, 8).map(contact => contact.id));
    let newFailures = 0;
    const stillBroken = { sendMessage: async () => { newFailures++; return undefined; } } as unknown as typeof client;
    await runCampaign({ id: "safety-failure-repeat-" + stamp, data: { campaignId: unhealthyAgain.id } },
      () => stillBroken, { sleep: async () => {}, now: () => new Date(clock += 6000) });
    assert.equal(newFailures, 2, "Repeated new failures after a recovery attempt trigger the hard hold before a third");
    assert(await activeSendingHold(accountKey(session)));
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: unhealthyAgain.id } })).status, "PAUSED");
    await reviewSendingHold(accountKey(session), "Verified the account and repaired missing-receipt handling", new Date(clock + 1000));
    await evaluateSendingQuality(accountKey(session), new Date(clock + 1000));
    assert.equal(await activeSendingHold(accountKey(session)), null, "Old failures do not immediately retrigger after a review");

    await db.sendAttempt.deleteMany();
    const feedback = await db.waSession.create({ data: { label: "Opt-out feedback", phone: "254799666555", status: "CONNECTED" } });
    await db.sendAttempt.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ deliveryId: "feedback-" + stamp + "-" + i,
      accountKey: accountKey(feedback), sessionId: feedback.id, recipientKeys: ["contact:" + `2547996655${String(i).padStart(2, "0")}@c.us`],
      attemptedAt: new Date(Date.now() - 60000), outcome: "SENT" as const,
    })) });
    await recordOptOut(feedback.id, "254799665500@c.us", "please stop messaging me");
    await recordOptOut(feedback.id, "254799665500@c.us", "STOP");
    assert.equal(await activeSendingHold(accountKey(feedback)), null);
    assert.equal(await db.sendAttempt.count({ where: { accountKey: accountKey(feedback), optedOutAt: { not: null } } }), 1);
    await recordOptOut(feedback.id, "254799665501@c.us", "remove me from your list");
    await recordOptOut(feedback.id, "254799665502@c.us", "unsubscribe");
    assert(await activeSendingHold(accountKey(feedback)));
    console.log("✓ Safety: transient failures auto-defer across accounts and continue without duplication; repeated failures and opt-outs still require manual review");
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
}
