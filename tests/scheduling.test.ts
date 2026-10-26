import { describe, expect, it } from "vitest";
import { campaignInput, estimatedDurationMs, scheduleIssue, schedulePreview } from "../lib/campaign";
import { dateTimeInZone, zonedDateTimeToIso } from "../lib/timezone";

const base = { name: "Shared segment campaign", message: "Hello", sessionId: "sender", audienceType: "CONTACTS", segmentIds: ["segment"] };
describe("campaign timing", () => {
  it("accepts shared segment audiences with bounded pacing", () => {
    expect(campaignInput.parse(base).sendIntervalMs).toBe(5000);
    expect(campaignInput.safeParse({ ...base, sendIntervalMs: 500 }).success).toBe(false);
    expect(campaignInput.safeParse({ ...base, sendIntervalMs: 1500 }).success).toBe(true);
  });
  it("rejects sub-minute recurring campaigns", () => {
    expect(campaignInput.safeParse({ ...base, scheduleType: "CRON", cron: "*/5 * * * * *" }).success).toBe(false);
    expect(campaignInput.safeParse({ ...base, scheduleType: "CRON", cron: "0 */5 * * * *" }).success).toBe(true);
  });
  it("previews the next occurrence in the selected timezone", () => {
    const next = schedulePreview({ scheduleType: "CRON", cron: "0 9 * * *", timezone: "Africa/Nairobi" }, new Date("2026-10-26T05:00:00Z"));
    expect(next[0]).toBe("2026-10-26T06:00:00.000Z");
    expect(next).toHaveLength(5);
  });
  it("prevents recurring intervals shorter than the send duration", () => {
    const campaign = { scheduleType: "CRON", cron: "* * * * *", timezone: "UTC" };
    expect(scheduleIssue(campaign, estimatedDurationMs(20, 5000))).toContain("more time");
    expect(scheduleIssue({ ...campaign, cron: "*/5 * * * *" }, 100000)).toBeNull();
  });
  it("interprets one-time local dates in the schedule timezone", () => {
    expect(zonedDateTimeToIso("2026-10-26T09:00", "Africa/Nairobi")).toBe("2026-10-26T06:00:00.000Z");
    expect(dateTimeInZone("2026-10-26T06:00:00Z", "Africa/Nairobi")).toBe("2026-10-26T09:00");
    expect(zonedDateTimeToIso("2026-10-26T09:00", "Asia/Kolkata")).toBe("2026-10-26T03:30:00.000Z");
  });
  it("rejects a nonexistent DST time and chooses the earlier repeated time", () => {
    expect(() => zonedDateTimeToIso("2026-03-08T02:30", "America/New_York")).toThrow("does not exist");
    expect(zonedDateTimeToIso("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });
});
