import { describe, expect, it } from "vitest";
import { bulkConsentInput } from "../lib/consent";
import { contactWhere } from "../lib/contact-selection";

describe("bulk contact consent selection", () => {
  const valid = {
    selection: { contactIds: ["contact-1", "contact-2"] },
    consent: "OPTED_IN",
    consentMethod: "WHATSAPP_REPLY",
    consentNote: "Each person expressly replied YES on 2026-10-27.",
    confirmed: true,
  };
  it("accepts several specifically selected, evidenced contacts", () => {
    expect(bulkConsentInput.safeParse(valid).success).toBe(true);
  });
  it("accepts all matching filtered contacts from multiple pages", () => {
    expect(bulkConsentInput.safeParse({ ...valid, selection: { filter: { segmentId: "test-segment", consent: "UNKNOWN", phoneAvailability: "usable" } } }).success).toBe(true);
  });
  it("does not silently opt in an unconfirmed selection", () => {
    expect(bulkConsentInput.safeParse({ ...valid, confirmed: false }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, consentNote: "" }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, consentMethod: undefined }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, selection: { contactIds: [] } }).success).toBe(false);
    expect(bulkConsentInput.safeParse({ ...valid, selection: { contactIds: Array(5001).fill("contact") } }).success).toBe(false);
  });
  it("allows changing selected/all-matching records to opted-out or unknown without inventing consent", () => {
    expect(bulkConsentInput.safeParse({ selection: { filter: {} }, consent: "OPTED_OUT" }).success).toBe(true);
    expect(bulkConsentInput.safeParse({ selection: { contactIds: ["a"] }, consent: "UNKNOWN" }).success).toBe(true);
  });
  it("filters identifiable vs unresolved IDs", () => {
    expect(contactWhere({ phoneAvailability: "usable", consent: "UNKNOWN" }).phone).toEqual({ not: null });
    expect(contactWhere({ phoneAvailability: "unavailable" }).phone).toBeNull();
  });
});
