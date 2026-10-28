import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  contactFindMany: vi.fn(), updateMany: vi.fn(), count: vi.fn(), audit: vi.fn(), query: vi.fn(), transaction: vi.fn(),
}));
vi.mock("../lib/db", () => ({ db: {
  contact: { findMany: mocks.contactFindMany },
  $transaction: mocks.transaction,
} }));

import { resolveAudience } from "../lib/audience";
import { bulkConsentInput, updateBulkContactConsent } from "../lib/consent";
import { isDirectWhatsAppId } from "../lib/whatsapp-id";
import { contactIds, stableContactIdentity } from "../worker/identity";
import { saveDiscoveredContacts } from "../worker/sync";

const phone = "254700000001@c.us";
const lid = "123456789012345@lid";
const consentAt = new Date("2026-10-27T10:00:00Z");
const optedIn = { consent: "OPTED_IN", consentAt, consentNote: "Replied YES in WhatsApp" };
const contact = (id: string, whatsappId: string, values: object = {}) => ({
  id, sessionId: "session-a", whatsappId, phone: null, name: "Private contact", ...optedIn, segments: [], members: [], ...values,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation({
    $queryRaw: mocks.query,
    contact: { findMany: mocks.contactFindMany, count: mocks.count, updateMany: mocks.updateMany },
    auditLog: { create: mocks.audit },
  }));
});

describe("private WhatsApp identities", () => {
  it("accepts a saved private ID independently of phone visibility, without guessing usernames", () => {
    expect(isDirectWhatsAppId(lid)).toBe(true);
    for (const guessed of ["@alice", "alice@lid", "alice@c.us", "123@g.us", "123:1@lid", "123@newsletter"])
      expect(isDirectWhatsAppId(guessed)).toBe(false);
  });

  it("keeps a valid private destination when the SDK returns no phone or invalid aliases", async () => {
    expect(await contactIds({ getContactLidAndPhone: async () => [{ lid }] }, lid)).toEqual([lid]);
    expect(await contactIds({ getContactLidAndPhone: async () => [{ lid, pn: "alice@c.us" }] }, lid)).toEqual([lid]);
    expect(await contactIds({ getContactLidAndPhone: async () => [{ lid, pn: phone }] }, lid)).toEqual([lid, phone]);
  });

  it("resolves an opted-in LID with no phone into one campaign recipient", async () => {
    mocks.contactFindMany.mockResolvedValueOnce([
      contact("private", lid), contact("duplicate", lid),
      contact("unknown", "200@lid", { consent: "UNKNOWN", consentAt: null, consentNote: null }),
      contact("invalid", "alice@lid"),
    ]).mockResolvedValueOnce([]);
    const audience = await resolveAudience({ audienceType: "CONTACTS", sessionId: "sender", contactIds: ["private", "duplicate", "unknown", "invalid"], segmentIds: [], groupIds: [] });
    expect(audience.recipients).toEqual([expect.objectContaining({ contactId: "private", key: "contact:" + lid, chatId: lid, phone: null })]);
    expect(audience.duplicates).toBe(1);
    expect(audience.exclusions).toMatchObject({ missingConsent: 1, unusablePhone: 1 });
  });

  it("still requires evidence and respects a private-ID opt-out on another session", async () => {
    mocks.contactFindMany.mockResolvedValueOnce([
      contact("suppressed", lid), contact("no-evidence", "200@lid", { consentNote: "" }),
    ]).mockResolvedValueOnce([{ whatsappId: lid }]);
    const audience = await resolveAudience({ audienceType: "CONTACTS", sessionId: "sender", contactIds: ["suppressed", "no-evidence"], segmentIds: [], groupIds: [] });
    expect(audience.recipients).toEqual([]);
    expect(audience.exclusions).toMatchObject({ missingConsent: 1, optedOut: 1 });
  });

  it("records evidenced opt-in for a selected private ID without requiring a phone", async () => {
    mocks.contactFindMany.mockResolvedValueOnce([contact("private", lid, { consent: "UNKNOWN", consentAt: null, consentNote: null })]);
    const result = await updateBulkContactConsent(bulkConsentInput.parse({
      selection: { contactIds: ["private"] }, consent: "OPTED_IN", consentMethod: "WHATSAPP_REPLY",
      consentNote: "The person replied YES in WhatsApp on 27 October.", confirmed: true,
    }));
    expect(result).toEqual({ selected: 1, uniqueDestinations: 1, affectedRecords: 1 });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { whatsappId: { in: [lid] }, consent: { not: "OPTED_OUT" } },
      data: expect.objectContaining({ consent: "OPTED_IN", consentAt: expect.any(Date) }),
    }));
  });
});

describe("stable discovered contact records", () => {
  it("prefers existing suppression, then evidenced opt-in when aliases appear", () => {
    const privateRecord = contact("private", lid);
    const unknown = contact("unknown", phone, { consent: "UNKNOWN", consentAt: null });
    expect(stableContactIdentity([phone, lid], [unknown, privateRecord])).toBe(privateRecord);
    const suppressed = contact("suppressed", phone, { consent: "OPTED_OUT", consentAt: null });
    expect(stableContactIdentity([phone, lid], [privateRecord, suppressed])).toBe(suppressed);
  });

  it("keeps the opted-in private record and its links when WhatsApp reveals its phone", async () => {
    const old = contact("private-with-segment-links", lid);
    const findMany = vi.fn().mockResolvedValue([old]);
    const upsert = vi.fn().mockResolvedValue(old);
    const updateMany = vi.fn();
    const tx = { contact: { findMany, upsert, updateMany } } as unknown as Parameters<typeof saveDiscoveredContacts>[0];
    expect(await saveDiscoveredContacts(tx, "session-a", [{ whatsappId: phone, aliases: [lid, phone], name: "Private contact", isMyContact: false }]))
      .toEqual(["private-with-segment-links"]);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId_whatsappId: { sessionId: "session-a", whatsappId: lid } },
      update: expect.objectContaining({ phone: "254700000001" }),
    }));
    expect(upsert.mock.calls[0][0].update).not.toHaveProperty("consent");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("propagates another account's STOP across only verified discovered aliases", async () => {
    const old = contact("private", lid);
    const findMany = vi.fn().mockResolvedValue([old, contact("other-session", phone, { sessionId: "session-b", consent: "OPTED_OUT" })]);
    const upsert = vi.fn().mockResolvedValue(old);
    const updateMany = vi.fn();
    const tx = { contact: { findMany, upsert, updateMany } } as unknown as Parameters<typeof saveDiscoveredContacts>[0];
    await saveDiscoveredContacts(tx, "session-a", [{ whatsappId: phone, aliases: [lid, phone, "alice@lid"], name: null, isMyContact: false }]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { whatsappId: { in: expect.arrayContaining([phone, lid]) }, consent: { not: "OPTED_OUT" } },
      data: expect.objectContaining({ consent: "OPTED_OUT", consentAt: null }),
    });
    expect(updateMany.mock.calls[0][0].where.whatsappId.in).not.toContain("alice@lid");
    expect(upsert.mock.calls[0][0].update.consent).toBe("OPTED_OUT");
  });
});
