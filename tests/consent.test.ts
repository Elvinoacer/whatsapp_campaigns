import { describe, expect, it } from "vitest";
import { bulkConsentInput } from "../lib/consent";
import { contactWhere } from "../lib/contact-selection";

describe("verified opt-in recording", () => {
  const valid = {
    contactIds: ["contact-1", "contact-2"],
    consentMethod: "WHATSAPP_REPLY",
    consentNote: "Each recipient explicitly replied YES on 2026-10-27",
    confirmed: true,
  };
  it("accepts a selected, evidenced group of consenting contacts", () => {
    expect(bulkConsentInput.safeParse(valid).success).toBe(true);
  });
  it("does not allow inferred or unevidenced bulk approval", () => {
    expect(bulkConsentInput.safeParse({ ...valid, confirmed: false }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, consentNote: "group member" }).success).toBe(true);
    expect(bulkConsentInput.safeParse({ ...valid, consentNote: "" }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, contactIds: [] }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, contactIds: Array(201).fill("contact") }).success).toBe(false);
  });
  it("filters identifiable vs unresolved WhatsApp records in the contacts directory", () => {
    expect(contactWhere({ phoneAvailability: "usable", consent: "UNKNOWN" }).phone).toEqual({ not: null });
    expect(contactWhere({ phoneAvailability: "unavailable" }).phone).toBeNull();
  });
});
