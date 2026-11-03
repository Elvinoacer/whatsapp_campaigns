import { describe, expect, it } from "vitest";
import { bulkConsentInput } from "../lib/consent";
import { contactWhere } from "../lib/contact-selection";
import { groupExportInput } from "../lib/segments";

describe("streamlined contact reachability & multi-group segment export", () => {
  it("accepts 1-click active / opt-out updates without requiring manual essays", () => {
    const input = { selection: { filter: {} }, consent: "OPTED_IN" };
    expect(bulkConsentInput.safeParse(input).success).toBe(true);
    expect(bulkConsentInput.safeParse({ selection: { contactIds: ["c1", "c2"] }, consent: "OPTED_OUT" }).success).toBe(true);
    expect(bulkConsentInput.safeParse({ selection: { contactIds: [] }, consent: "OPTED_IN" }).success).toBe(false);
  });

  it("supports large centralized phonebook selections up to 100,000 contacts", () => {
    expect(bulkConsentInput.safeParse({ selection: { contactIds: Array(50000).fill("contact") }, consent: "OPTED_IN" }).success).toBe(true);
    expect(bulkConsentInput.safeParse({ selection: { contactIds: Array(100001).fill("contact") }, consent: "OPTED_IN" }).success).toBe(false);
  });

  it("filters active vs opted-out status and multi-group provenance", () => {
    expect(contactWhere({ status: "active" }).consent).toEqual({ not: "OPTED_OUT" });
    expect(contactWhere({ status: "opted_out" }).consent).toBe("OPTED_OUT");
    expect(contactWhere({ groupIds: ["g1", "g2"] }).members).toEqual({ some: { groupId: { in: ["g1", "g2"] } } });
    expect(contactWhere({ phoneAvailability: "usable", consent: "UNKNOWN" }).phone).toEqual({ not: null });
    expect(contactWhere({ phoneAvailability: "unavailable" }).phone).toBeNull();
  });

  it("validates exporting multiple groups into a new or existing segment", () => {
    expect(
      groupExportInput.safeParse({
        groupIds: ["group-1", "group-2", "group-3"],
        newSegment: { name: "Combined VIP Groups", description: "From 3 WhatsApp groups" },
        syncLive: true,
      }).success
    ).toBe(true);
    expect(groupExportInput.safeParse({ groupIds: ["group-1"] }).success).toBe(false);
  });
});
