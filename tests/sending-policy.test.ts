import { describe, expect, it } from "vitest";
import {
  DAY,
  HOUR,
  minimumCampaignDuration,
  nextBudgetSlot,
  nextSendingWindow,
  qualityIssue,
  qualitySignal,
  TRANSPORT_RECOVERY_MS,
  MAX_TRANSPORT_RECOVERIES,
  restrictionSignal,
  sendingPolicy,
  sendingSettingsInput,
} from "../lib/sending-policy";
import { campaignMessage, publicSenderName } from "../lib/message";
import { hasConsentEvidence, isOptOut } from "../lib/campaign";

const defaultPolicy = sendingPolicy({});
const daytimePolicy = sendingPolicy({
  CAMPAIGN_MIN_INTERVAL_MS: "30000",
  CAMPAIGN_MAX_PER_15_MINUTES: "10",
  CAMPAIGN_MAX_PER_HOUR: "30",
  CAMPAIGN_MAX_PER_DAY: "100",
  CAMPAIGN_CONTACT_COOLDOWN_HOURS: "168",
  CAMPAIGN_START_HOUR: "9",
  CAMPAIGN_END_HOUR: "18",
  CAMPAIGN_TIMEZONE: "Africa/Nairobi",
});
const daytime = new Date("2026-10-27T09:00:00Z");

describe("configurable operating hours & shared sending policy", () => {
  it("defaults to 24/7 operating hours and per-campaign repeat control while supporting custom hours", () => {
    expect(defaultPolicy).toMatchObject({
      alwaysOpen: true,
      startHour: 0,
      endHour: 24,
      minimumIntervalMs: 15000,
      maxPer15Minutes: 10,
      maxPerHour: 35,
      maxPerDay: 250,
      contactCooldownMs: 0,
      timezone: "Africa/Nairobi",
    });
    expect(daytimePolicy).toMatchObject({
      alwaysOpen: false,
      minimumIntervalMs: 30000,
      maxPer15Minutes: 10,
      maxPerHour: 30,
      maxPerDay: 100,
      contactCooldownMs: 7 * DAY,
      startHour: 9,
      endHour: 18,
      timezone: "Africa/Nairobi",
    });
  });

  it("allows immediate sending at any hour when 24/7 mode (alwaysOpen or 0..24) is enabled", () => {
    const allDay = sendingPolicy({ CAMPAIGN_ALWAYS_OPEN: "true" });
    const midnightUtc = new Date("2026-10-27T23:30:00Z");
    expect(nextSendingWindow(midnightUtc, allDay).toISOString()).toBe(midnightUtc.toISOString());

    const fullRange = sendingPolicy({ CAMPAIGN_START_HOUR: "0", CAMPAIGN_END_HOUR: "24" });
    expect(fullRange.alwaysOpen).toBe(true);
    expect(nextSendingWindow(midnightUtc, fullRange).toISOString()).toBe(midnightUtc.toISOString());
  });

  it("supports overnight operating windows (e.g. 20:00–06:00) and active day filters", () => {
    const overnight = sendingPolicy({ CAMPAIGN_START_HOUR: "20", CAMPAIGN_END_HOUR: "6", CAMPAIGN_TIMEZONE: "UTC" });
    expect(nextSendingWindow(new Date("2026-10-27T22:15:00Z"), overnight).toISOString()).toBe("2026-10-27T22:15:00.000Z");
    expect(nextSendingWindow(new Date("2026-10-28T03:00:00Z"), overnight).toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(nextSendingWindow(new Date("2026-10-28T10:00:00Z"), overnight).toISOString()).toBe("2026-10-28T20:00:00.000Z");

    // 2026-10-25 is Sunday (day 0); weekdays-only [1..5] advances to Monday 09:00 UTC.
    const weekdaysOnly = sendingPolicy({
      CAMPAIGN_START_HOUR: "9",
      CAMPAIGN_END_HOUR: "17",
      CAMPAIGN_ACTIVE_DAYS: "1,2,3,4,5",
      CAMPAIGN_TIMEZONE: "UTC",
    });
    expect(nextSendingWindow(new Date("2026-10-25T11:00:00Z"), weekdaysOnly).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("enforces the minimum interval and rolling 15-minute / hourly budgets", () => {
    expect(nextBudgetSlot([daytime], new Date(daytime.getTime() + 1000), daytimePolicy).getTime()).toBe(daytime.getTime() + 30000);
    const strict3Per15m = { ...daytimePolicy, alwaysOpen: true, maxPer15Minutes: 3, minimumIntervalMs: 30000 };
    const threeAttempts = [0, 30000, 60000].map(offset => new Date(daytime.getTime() - offset));
    expect(nextBudgetSlot(threeAttempts, new Date(daytime.getTime() + 1000), strict3Per15m).getTime()).toBe(
      threeAttempts[2].getTime() + 900000
    );
    const hourly = { ...daytimePolicy, maxPer15Minutes: 1000, maxPerHour: 2 };
    expect(nextBudgetSlot([daytime, new Date(daytime.getTime() - 600000)], new Date(daytime.getTime() + 1000), hourly).getTime()).toBe(
      daytime.getTime() - 600000 + HOUR
    );
  });

  it("opens at Nairobi business hours using the configured timezone and handles DST", () => {
    expect(nextSendingWindow(new Date("2026-10-27T03:00:00Z"), daytimePolicy).toISOString()).toBe("2026-10-27T06:00:00.000Z");
    expect(nextSendingWindow(new Date("2026-10-27T15:00:00Z"), daytimePolicy).toISOString()).toBe("2026-10-28T06:00:00.000Z");
    const dst = { ...daytimePolicy, timezone: "America/New_York" };
    expect(nextSendingWindow(new Date("2026-11-01T05:30:00Z"), dst).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("estimates campaign duration and rejects zero-width windows or invalid timezones", () => {
    expect(minimumCampaignDuration(1500, 5000, daytimePolicy)).toBeGreaterThanOrEqual(14 * DAY);
    expect(minimumCampaignDuration(0, 5000, daytimePolicy)).toBe(0);
    expect(() => sendingPolicy({ CAMPAIGN_START_HOUR: "9", CAMPAIGN_END_HOUR: "9" })).toThrow();
    expect(() => sendingPolicy({ CAMPAIGN_TIMEZONE: "Somewhere/Nowhere" })).toThrow();
    expect(sendingSettingsInput.safeParse({ alwaysOpen: false, startHour: 12, endHour: 12, timezone: "UTC" }).success).toBe(false);
    expect(sendingSettingsInput.safeParse({ alwaysOpen: true, maxPer15Minutes: 3, timezone: "UTC" }).success).toBe(true);
    expect(sendingSettingsInput.parse({ alwaysOpen: true, maxPer15Minutes: 3, timezone: "UTC", businessName: null }).businessName).toBe("");
    expect(sendingSettingsInput.parse({ alwaysOpen: true, maxPer15Minutes: 3, timezone: "UTC", businessName: "  Acme Corp  " }).businessName).toBe("Acme Corp");
    expect(sendingSettingsInput.parse({ alwaysOpen: true, maxPer15Minutes: 3, timezone: "UTC", businessName: undefined }).businessName).toBe("");
    expect(sendingSettingsInput.safeParse({ alwaysOpen: true, maxPer15Minutes: 3, timezone: "UTC", businessName: "a".repeat(81) }).success).toBe(false);
  });
});

describe("account quality circuit breakers", () => {
  const good = { outcome: "SENT", optedOutAt: null };
  const failed = { outcome: "UNKNOWN", optedOutAt: null };
  it("classifies consecutive missing receipts as technical recovery, not a direct restriction", () => {
    expect(qualityIssue([failed, failed, failed])).toMatch(/Three consecutive/);
    expect(qualitySignal([failed, failed, failed])?.kind).toBe("TRANSPORT");
    expect(qualityIssue([failed, failed, good])).toBeNull();
    expect(TRANSPORT_RECOVERY_MS).toBe(15 * 60_000);
    expect(MAX_TRANSPORT_RECOVERIES).toBe(1);
  });
  it("detects elevated opt-outs and explicit restriction signals", () => {
    const optedOut = { outcome: "DELIVERED", optedOutAt: daytime };
    expect(qualitySignal([...Array(3).fill(optedOut), ...Array(17).fill(failed)])?.kind).toBe("CONSENT");
    expect(restrictionSignal(new Error("429 Too many requests"))).toBe(true);
    expect(restrictionSignal(new Error("Execution context was destroyed"))).toBe(false);
  });
});

describe("optional message footer & opt-out detection", () => {
  it("supports optional DM footers and clean custom template messages without throwing", () => {
    expect(hasConsentEvidence({ consentAt: daytime, consentNote: "Explicit signup permission" })).toBe(true);
    expect(campaignMessage("Hello", "Example business", true, true)).toBe("Hello\n\nExample business\nReply STOP to unsubscribe.");
    expect(campaignMessage("Hello", "", true, true)).toBe("Hello\n\nReply STOP to unsubscribe.");
    expect(campaignMessage("Custom template body", "", true, false)).toBe("Custom template body");
    expect(campaignMessage("Announcement", "Example business", false)).toBe("Announcement");
    const account = { label: "second_account", publicSenderName: "Moi Mashinani Team" };
    expect(publicSenderName(account, "Workspace Business")).toBe("Moi Mashinani Team");
  });

  it.each(["STOP!", "unsubscribe me", "please stop messaging me", "remove me from your list", "don't contact me again", "opt-out"])(
    "honors explicit request %s",
    text => {
      expect(isOptOut(text)).toBe(true);
    }
  );
});
