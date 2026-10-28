import { describe, expect, it } from "vitest";
import { campaignInput, contactExclusionReason, isEligible, isOptOut, personalize, sessionInput } from "../lib/campaign";

describe("messaging guardrails", () => {
  it("sends to consented phone addresses independently of discovery session", () => {
    expect(isEligible("UNKNOWN", "254700123456@c.us")).toBe(false);
    expect(isEligible("OPTED_IN", "opaque@lid")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@g.us")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@c.us")).toBe(true);
  });
  it("distinguishes unknown consent, opt-outs and unresolvable group IDs", () => {
    expect(contactExclusionReason("UNKNOWN", "254700123456@c.us")).toBe("NO_OPT_IN");
    expect(contactExclusionReason("OPTED_IN", "opaque@lid")).toBe("INVALID_ID");
    expect(contactExclusionReason("OPTED_OUT", "254700123456@c.us")).toBe("OPTED_OUT");
    expect(contactExclusionReason("OPTED_IN", "254700123456@c.us", true)).toBe("OPTED_OUT");
    expect(contactExclusionReason("OPTED_IN", "254700123456@c.us")).toBeNull();
  });
  it("allows consented private IDs without a phone number and rejects guessed usernames", () => {
    expect(isEligible("OPTED_IN", "123456789012345@lid")).toBe(true);
    expect(contactExclusionReason("UNKNOWN", "123456789012345@lid")).toBe("NO_OPT_IN");
    expect(contactExclusionReason("OPTED_IN", "123456789012345@lid", true)).toBe("OPTED_OUT");
    expect(isEligible("OPTED_IN", "@someone")).toBe(false);
    expect(isEligible("OPTED_IN", "someone@c.us")).toBe(false);
  });
  it("honors unsubscription commands", () => {
    expect(isOptOut(" STOP ")).toBe(true);
    expect(isOptOut("unsubscribe")).toBe(true);
    expect(isOptOut("stop by the shop")).toBe(false);
  });
  it("renders contact placeholders", () => {
    expect(personalize("Hi {{first_name}}, {{phone}}", { name: "Ada Lovelace", phone: "123" })).toBe("Hi Ada, 123");
  });
  it("validates editable account nicknames separately from public sender names", () => {
    expect(sessionInput.parse({ label: "Private account", publicSenderName: "Moi Mashinani Team" })).toMatchObject({ label: "Private account", publicSenderName: "Moi Mashinani Team" });
    expect(sessionInput.safeParse({ label: "x", publicSenderName: "Brand" }).success).toBe(false);
    expect(sessionInput.safeParse({ label: "Private account", publicSenderName: "a".repeat(81) }).success).toBe(false);
    expect(sessionInput.safeParse({ label: "Private account", publicSenderName: "Brand\nHidden text" }).success).toBe(false);
  });
  it("rejects campaigns without an audience", () => {
    expect(campaignInput.safeParse({ name: "Test", message: "Hello", sessionId: "s", audienceType: "CONTACTS" }).success).toBe(false);
  });
});
