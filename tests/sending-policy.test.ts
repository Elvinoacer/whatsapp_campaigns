import { describe, expect, it } from "vitest";
import { DAY, HOUR, minimumCampaignDuration, nextBudgetSlot, nextSendingWindow, qualityIssue, restrictionSignal, sendingPolicy } from "../lib/sending-policy";
import { campaignMessage, publicSenderName, MISSING_SENDER_NAME } from "../lib/message";
import { hasConsentEvidence, isOptOut } from "../lib/campaign";

const policy = sendingPolicy({});
const daytime = new Date("2026-10-27T09:00:00Z");
describe("shared campaign sending policy", () => {
  it("defaults to shared rolling budgets, a week between contact attempts and local sending hours", () => {
    expect(policy).toMatchObject({ minimumIntervalMs: 30000, maxPer15Minutes: 10, maxPerHour: 30, maxPerDay: 100,
      contactCooldownMs: 7 * DAY, startHour: 9, endHour: 18, timezone: "Africa/Nairobi" });
  });
  it("enforces the minimum interval across campaigns and restarts", () => {
    expect(nextBudgetSlot([daytime], new Date(daytime.getTime() + 1000), policy).getTime()).toBe(daytime.getTime() + 30000);
  });
  it("uses rolling windows rather than resetting at the clock hour or midnight", () => {
    const attempts = Array.from({ length: 10 }, (_, i) => new Date(daytime.getTime() - i * 30000));
    expect(nextBudgetSlot(attempts, new Date(daytime.getTime() + 1000), policy).getTime()).toBe(attempts[9].getTime() + 900000);
    const hourly = { ...policy, maxPer15Minutes: 1000, maxPerHour: 2 };
    expect(nextBudgetSlot([daytime, new Date(daytime.getTime() - 600000)], new Date(daytime.getTime() + 1000), hourly).getTime()).toBe(daytime.getTime() - 600000 + HOUR);
  });
  it("waits for enough reservations to expire even if an earlier version exceeded the budget", () => {
    const attempts = [0, 1000, 2000, 3000, 4000].map(delta => new Date(daytime.getTime() - delta));
    expect(nextBudgetSlot(attempts, daytime, { ...policy, maxPer15Minutes: 2 }).getTime()).toBe(daytime.getTime() - 1000 + 900000);
  });
  it("opens at Nairobi business hours using the configured timezone", () => {
    expect(nextSendingWindow(new Date("2026-10-27T03:00:00Z"), policy).toISOString()).toBe("2026-10-27T06:00:00.000Z");
    expect(nextSendingWindow(new Date("2026-10-27T15:00:00Z"), policy).toISOString()).toBe("2026-10-28T06:00:00.000Z");
  });
  it("handles a DST change and applies sending hours after budget deferral", () => {
    const dst = { ...policy, timezone: "America/New_York" };
    expect(nextSendingWindow(new Date("2026-11-01T05:30:00Z"), dst).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    const closed = new Date("2026-10-27T14:59:59Z");
    expect(nextBudgetSlot([closed], closed, policy).toISOString()).toBe("2026-10-28T06:00:00.000Z");
  });
  it("estimates multi-day budgets without presenting a large campaign as a quick burst", () => {
    expect(minimumCampaignDuration(1500, 5000, policy)).toBeGreaterThanOrEqual(14 * DAY);
    expect(minimumCampaignDuration(0, 5000, policy)).toBe(0);
  });
  it("rejects an empty sending window or invalid timezone", () => {
    expect(() => sendingPolicy({ CAMPAIGN_START_HOUR: "18", CAMPAIGN_END_HOUR: "9" })).toThrow();
    expect(() => sendingPolicy({ CAMPAIGN_TIMEZONE: "Somewhere/Nowhere" })).toThrow();
  });
});

describe("account quality circuit breakers", () => {
  const good = { outcome: "SENT", optedOutAt: null };
  const failed = { outcome: "UNKNOWN", optedOutAt: null };
  it("holds after three consecutive failures or uncertain sends", () => {
    expect(qualityIssue([failed, failed, failed])).toMatch(/Three consecutive/);
    expect(qualityIssue([failed, failed, good])).toBeNull();
  });
  it("holds on a poor delivery sample, without treating unread messages as failures", () => {
    expect(qualityIssue([failed, good, failed, ...Array(7).fill(good)])).toMatch(/20%/);
    expect(qualityIssue(Array(20).fill(good))).toBeNull();
  });
  it("holds on elevated opt-outs after a minimum number of recipients", () => {
    const optedOut = { outcome: "DELIVERED", optedOutAt: daytime };
    expect(qualityIssue([...Array(3).fill(optedOut), ...Array(17).fill(good)])).toMatch(/opting out/);
    expect(qualityIssue([...Array(2).fill(optedOut), ...Array(18).fill(good)])).toBeNull();
  });
  it.each(["SMB_TOS_BLOCK", "TOS_BLOCK", "Account temporarily banned", "429 Too many requests", "Rate limit reached"])("recognizes explicit restriction signal %s", signal => {
    expect(restrictionSignal(new Error(signal))).toBe(true);
  });
  it("does not label an ordinary navigation interruption as a restriction", () => {
    expect(restrictionSignal(new Error("Execution context was destroyed"))).toBe(false);
  });
});

describe("recipient expectations and opt-outs", () => {
  it("requires a record of when and how permission was obtained", () => {
    expect(hasConsentEvidence({ consentAt: daytime, consentNote: "Explicit signup permission" })).toBe(true);
    expect(hasConsentEvidence({ consentAt: daytime, consentNote: " " })).toBe(false);
    expect(hasConsentEvidence({ consentNote: "Permission" })).toBe(false);
  });
  it.each(["STOP!", "unsubscribe me", "please stop messaging me", "remove me from your list", "don't contact me again", "opt-out"])("honors explicit request %s", text => {
    expect(isOptOut(text)).toBe(true);
  });
  it.each(["don't stop", "stop by the shop", "I can't stop thinking about it"])("does not misread conversation %s", text => {
    expect(isOptOut(text)).toBe(false);
  });
  it("adds a clear identity and opt-out footer to individual campaigns, preserving group messages", () => {
    expect(campaignMessage("Hello", "Example business")).toBe("Hello\n\nExample business\nReply STOP to unsubscribe.");
    expect(campaignMessage("Announcement", "Example business", false)).toBe("Announcement");
  });
  it("never exposes the internal account nickname when composing direct messages", () => {
    const account = { label: "second_account", publicSenderName: "Moi Mashinani Team" };
    expect(publicSenderName(account, "Workspace Business")).toBe("Moi Mashinani Team");
    expect(campaignMessage("Hello", publicSenderName(account, "Workspace Business"))).toBe("Hello\n\nMoi Mashinani Team\nReply STOP to unsubscribe.");
    expect(publicSenderName({ publicSenderName: "" }, "Workspace Business")).toBe("Workspace Business");
    expect(publicSenderName({ publicSenderName: null }, "")).toBe("");
    expect(() => campaignMessage("Hello", "")).toThrow(MISSING_SENDER_NAME);
    expect(campaignMessage("Group notice", "", false)).toBe("Group notice");
  });
});
