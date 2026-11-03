import { describe, expect, it } from "vitest";
import { campaignInput, contactExclusionReason, isEligible, isOptOut, personalize, sessionInput, templateInput } from "../lib/campaign";

describe("messaging guardrails, templates & flexible destinations", () => {
  it("treats active phonebook contacts as reachable by default unless opted out or invalid", () => {
    expect(isEligible("UNKNOWN", "254700123456@c.us")).toBe(true);
    expect(isEligible("OPTED_IN", "254700123456@c.us")).toBe(true);
    expect(isEligible("OPTED_OUT", "254700123456@c.us")).toBe(false);
    expect(isEligible("OPTED_IN", "opaque@lid")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@g.us")).toBe(false);
  });

  it("distinguishes opt-outs and invalid IDs while never blocking reachable contacts", () => {
    expect(contactExclusionReason("UNKNOWN", "254700123456@c.us")).toBeNull();
    expect(contactExclusionReason("OPTED_IN", "opaque@lid")).toBe("INVALID_ID");
    expect(contactExclusionReason("OPTED_OUT", "254700123456@c.us")).toBe("OPTED_OUT");
    expect(contactExclusionReason("OPTED_IN", "254700123456@c.us", true)).toBe("OPTED_OUT");
    expect(contactExclusionReason("OPTED_IN", "254700123456@c.us")).toBeNull();
  });

  it("allows private @lid IDs without a phone number and rejects guessed usernames", () => {
    expect(isEligible("OPTED_IN", "123456789012345@lid")).toBe(true);
    expect(contactExclusionReason("UNKNOWN", "123456789012345@lid")).toBeNull();
    expect(contactExclusionReason("OPTED_IN", "123456789012345@lid", true)).toBe("OPTED_OUT");
    expect(isEligible("OPTED_IN", "@someone")).toBe(false);
    expect(isEligible("OPTED_IN", "someone@c.us")).toBe(false);
  });

  it("honors unsubscription commands", () => {
    expect(isOptOut(" STOP ")).toBe(true);
    expect(isOptOut("unsubscribe")).toBe(true);
    expect(isOptOut("stop by the shop")).toBe(false);
  });

  it("renders contact, group, and date placeholders cleanly", () => {
    expect(
      personalize(
        "Hi {{first_name}} ({{name}}), {{phone}} in {{group_name}} on {{date}}",
        { name: "Ada Lovelace", phone: "123", groupName: "VIP Builders", now: new Date("2026-11-03T12:00:00Z") }
      )
    ).toContain("Hi Ada (Ada Lovelace), 123 in VIP Builders on Nov 3, 2026");
  });

  it("validates editable account nicknames separately from public sender names", () => {
    expect(sessionInput.parse({ label: "Private account", publicSenderName: "Moi Mashinani Team" })).toMatchObject({
      label: "Private account",
      publicSenderName: "Moi Mashinani Team",
    });
    expect(sessionInput.safeParse({ label: "x", publicSenderName: "Brand" }).success).toBe(false);
    expect(sessionInput.safeParse({ label: "Private account", publicSenderName: "a".repeat(81) }).success).toBe(false);
    expect(sessionInput.safeParse({ label: "Private account", publicSenderName: "Brand\nHidden text" }).success).toBe(false);
  });

  it("supports CONTACTS, GROUPS, and combined BOTH campaign destinations", () => {
    expect(campaignInput.safeParse({ name: "Test", message: "Hello", sessionId: "s", audienceType: "CONTACTS" }).success).toBe(false);
    expect(
      campaignInput.safeParse({
        name: "Combined Blast",
        message: "Hello {{first_name}}",
        sessionId: "s",
        audienceType: "BOTH",
        groupIds: ["g1"],
        segmentIds: ["seg1"],
        repeatPolicy: "NO_REPEAT",
      }).success
    ).toBe(true);
  });

  it("validates custom reusable message templates", () => {
    expect(
      templateInput.safeParse({
        name: "Hourly Group Promo",
        category: "Groups",
        body: "Hello *{{group_name}}*! Fresh offers at {{date}}.",
        includeFooter: false,
      }).success
    ).toBe(true);
    expect(templateInput.safeParse({ name: "x", body: "" }).success).toBe(false);
  });
});
