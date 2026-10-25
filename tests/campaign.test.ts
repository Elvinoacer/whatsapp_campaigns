import { describe, expect, it } from "vitest";
import { campaignInput, isEligible, isOptOut, personalize } from "../lib/campaign";

describe("messaging guardrails", () => {
  it("does not send to unconsented or mismatched contacts", () => {
    expect(isEligible("UNKNOWN", "254700123456@c.us", "a", "a")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@c.us", "a", "b")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@g.us", "a", "a")).toBe(false);
    expect(isEligible("OPTED_IN", "254700123456@c.us", "a", "a")).toBe(true);
  });
  it("honors unsubscription commands", () => {
    expect(isOptOut(" STOP ")).toBe(true);
    expect(isOptOut("unsubscribe")).toBe(true);
    expect(isOptOut("stop by the shop")).toBe(false);
  });
  it("renders contact placeholders", () => {
    expect(personalize("Hi {{first_name}}, {{phone}}", { name: "Ada Lovelace", phone: "123" })).toBe("Hi Ada, 123");
  });
  it("rejects campaigns without an audience", () => {
    expect(campaignInput.safeParse({ name: "Test", message: "Hello", sessionId: "s", audienceType: "CONTACTS" }).success).toBe(false);
  });
});
