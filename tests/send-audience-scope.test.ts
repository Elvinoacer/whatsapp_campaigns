import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), query: vi.fn(), campaign: vi.fn(), contact: vi.fn(), suppressed: vi.fn(),
  existingAttempt: vi.fn(), createAttempt: vi.fn(), updateDelivery: vi.fn(),
}));
vi.mock("../lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("../lib/queue", () => ({ removeSchedule: vi.fn() }));
vi.mock("../lib/sending-policy", async importOriginal => {
  const actual = await importOriginal<typeof import("../lib/sending-policy")>();
  return { ...actual, sendingPolicy: () => actual.sendingPolicy({}) };
});

import { reserveSend } from "../lib/sending-safety";

const now = new Date("2026-10-29T09:00:00Z");
const session = { id: "sender", phone: null, status: "CONNECTED" };
const input = {
  deliveryId: "queued-delivery", campaignId: "selected-campaign", revision: now,
  session, contactId: "private-contact", recipientKeys: ["contact:200@lid"], intervalMs: 30000,
};
const target = (campaignId = input.campaignId) => ({ campaignId });
const segment = (campaignId = input.campaignId) => ({ segment: { targets: [target(campaignId)] } });
const group = (campaignId = input.campaignId) => ({ group: { targets: [target(campaignId)] } });
const contact = () => ({
  id: input.contactId, whatsappId: "200@lid", phone: null, consent: "OPTED_IN",
  consentAt: now, consentNote: "Administrator recorded opt-in",
  targets: [] as ReturnType<typeof target>[], segments: [segment()], members: [] as ReturnType<typeof group>[],
});

// The fake database evaluates the relation query against current memberships.
// Changing fixture data after taking the recipient snapshot therefore exercises
// the reservation's real source union, instead of predetermining its answer.
function matches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (value as Record<string, unknown>[]).every(branch => matches(record, branch));
    if (key === "OR") return (value as Record<string, unknown>[]).some(branch => matches(record, branch));
    if (!value || typeof value !== "object") return record[key] === value;
    const condition = value as Record<string, unknown>;
    if ("in" in condition) return (condition.in as unknown[]).includes(record[key]);
    if ("some" in condition) return Array.isArray(record[key]) && record[key].some(item =>
      matches(item as Record<string, unknown>, condition.some as Record<string, unknown>));
    return !!record[key] && typeof record[key] === "object" && matches(record[key] as Record<string, unknown>, condition);
  });
}
let currentContact: ReturnType<typeof contact>;
beforeEach(() => {
  vi.resetAllMocks();
  currentContact = contact();
  mocks.campaign.mockResolvedValue({ id: input.campaignId, updatedAt: now, status: "ACTIVE", session });
  mocks.contact.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    matches(currentContact, where) ? [currentContact] : []);
  mocks.suppressed.mockResolvedValue(0);
  mocks.existingAttempt.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async operation => operation({
    $queryRaw: mocks.query,
    campaign: { findUnique: mocks.campaign },
    contact: { findMany: mocks.contact, count: mocks.suppressed },
    sendingHold: { findFirst: vi.fn().mockResolvedValue(null) },
    sendingRecovery: { findUnique: vi.fn().mockResolvedValue(null) },
    sendAttempt: {
      findUnique: mocks.existingAttempt, findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]), create: mocks.createAttempt,
    },
    delivery: { update: mocks.updateDelivery },
  }));
});

describe("current audience membership at dispatch", () => {
  it.each(["removed", "moved"])("skips a queued contact %s from the assigned segment", async action => {
    currentContact.segments = action === "moved" ? [segment("unrelated-campaign")] : [];
    expect(await reserveSend(input, now)).toMatchObject({ action: "SKIP", reason: expect.stringContaining("selected audience") });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.updateDelivery).not.toHaveBeenCalled();
  });

  it("skips a queued group member removed by a later member sync", async () => {
    currentContact.segments = [];
    currentContact.members = [group()];
    const queuedInput = { ...input };
    currentContact.members = [group("another-campaign")];
    expect(await reserveSend(queuedInput, now)).toMatchObject({ action: "SKIP" });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
  });

  it.each(["explicit contact", "another assigned segment", "selected group's member"])(
    "keeps the recipient when still selected through %s", async source => {
      currentContact.segments = [segment("unrelated-campaign")];
      if (source === "explicit contact") currentContact.targets = [target()];
      if (source === "another assigned segment") currentContact.segments.push(segment());
      if (source === "selected group's member") currentContact.members = [group()];
      expect(await reserveSend(input, now)).toEqual({ action: "SEND" });
      expect(mocks.createAttempt).toHaveBeenCalledOnce();
      expect(mocks.updateDelivery).toHaveBeenCalledWith({ where: { id: input.deliveryId }, data: { status: "SENDING" } });
    },
  );

  it("does not expand the audience to another contact with matching source membership", async () => {
    currentContact.id = "different-contact";
    currentContact.whatsappId = "another@lid";
    expect(await reserveSend(input, now)).toMatchObject({ action: "SKIP" });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
  });

  it("keeps a selected duplicate identity saved through another source account", async () => {
    currentContact.id = "same-person-on-another-account";
    expect(await reserveSend(input, now)).toEqual({ action: "SEND" });
    expect(mocks.createAttempt).toHaveBeenCalledOnce();
  });

  it("continues honoring opt-out even when the contact is explicitly selected", async () => {
    currentContact.targets = [target()];
    mocks.suppressed.mockResolvedValue(1);
    expect(await reserveSend(input, now)).toMatchObject({ action: "SKIP", reason: expect.stringContaining("suppressed") });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
  });

  it("serializes membership before consent in the same order as group sync", async () => {
    mocks.contact.mockImplementationOnce(async () => {
      const locks = mocks.query.mock.calls.map(([sql]) => Array.from(sql).join(""));
      expect(locks).toEqual([
        "SELECT 1 FROM pg_advisory_xact_lock(7342103)",
        "SELECT 1 FROM pg_advisory_xact_lock(7342101)",
        "SELECT 1 FROM pg_advisory_xact_lock(7342102)",
      ]);
      return [currentContact];
    });
    expect(await reserveSend(input, now)).toEqual({ action: "SEND" });
  });

  it("does not reserve a previously attempted delivery again after membership changes", async () => {
    mocks.existingAttempt.mockResolvedValue({ deliveryId: input.deliveryId });
    currentContact.segments = [];
    expect(await reserveSend(input, now)).toMatchObject({ action: "SKIP", reason: expect.stringContaining("already reserved") });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
  });

  it("enforces NO_REPEAT across standby campaigns while allowing repeats under ALLOW_REPEAT", async () => {
    const findFirstAttempt = vi.fn().mockResolvedValue({ attemptedAt: new Date(now.getTime() - 48 * 3600_000) });
    mocks.transaction.mockImplementationOnce(async operation => operation({
      $queryRaw: mocks.query,
      campaign: {
        findUnique: vi.fn().mockResolvedValue({
          id: input.campaignId,
          updatedAt: now,
          status: "ACTIVE",
          audienceType: "CONTACTS",
          scheduleType: "NOW",
          repeatPolicy: "NO_REPEAT",
          repeatCooldownHours: 0,
          session,
        }),
      },
      contact: { findMany: mocks.contact, count: mocks.suppressed },
      sendingHold: { findFirst: vi.fn().mockResolvedValue(null) },
      sendingRecovery: { findUnique: vi.fn().mockResolvedValue(null) },
      sendAttempt: {
        findUnique: mocks.existingAttempt,
        findFirst: findFirstAttempt,
        findMany: vi.fn().mockResolvedValue([]),
        create: mocks.createAttempt,
      },
      delivery: { update: mocks.updateDelivery },
    }));
    expect(await reserveSend(input, now)).toMatchObject({
      action: "SKIP",
      reason: expect.stringContaining("No-repeat"),
    });

    mocks.transaction.mockImplementationOnce(async operation => operation({
      $queryRaw: mocks.query,
      campaign: {
        findUnique: vi.fn().mockResolvedValue({
          id: input.campaignId,
          updatedAt: now,
          status: "ACTIVE",
          audienceType: "CONTACTS",
          scheduleType: "CRON",
          repeatPolicy: "ALLOW_REPEAT",
          repeatCooldownHours: 0,
          session,
        }),
      },
      contact: { findMany: mocks.contact, count: mocks.suppressed },
      sendingHold: { findFirst: vi.fn().mockResolvedValue(null) },
      sendingRecovery: { findUnique: vi.fn().mockResolvedValue(null) },
      sendAttempt: {
        findUnique: mocks.existingAttempt,
        findFirst: findFirstAttempt,
        findMany: vi.fn().mockResolvedValue([]),
        create: mocks.createAttempt,
      },
      delivery: { update: mocks.updateDelivery },
    }));
    expect(await reserveSend(input, now)).toEqual({ action: "SEND" });
  });
});
