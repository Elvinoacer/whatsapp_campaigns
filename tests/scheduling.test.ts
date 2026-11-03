import { describe, expect, it } from "vitest";
import { campaignInput, estimatedDurationMs, scheduleIssue, schedulePreview } from "../lib/campaign";
import { dateTimeInZone, zonedDateTimeToIso } from "../lib/timezone";

const base = { name: "Shared segment campaign", message: "Hello", sessionId: "sender", audienceType: "CONTACTS", segmentIds: ["segment"] };
describe("campaign timing & fixed-hour interval crons", () => {
  it("accepts shared segment audiences with bounded pacing", () => {
    expect(campaignInput.parse(base).sendIntervalMs).toBe(5000);
    expect(campaignInput.safeParse({ ...base, sendIntervalMs: 500 }).success).toBe(false);
    expect(campaignInput.safeParse({ ...base, sendIntervalMs: 1500 }).success).toBe(true);
  });

  it("supports exact fixed-hour intervals (1h, 2h, 3h, 4h, 5h, 6h) for groups and DMs", () => {
    for (const hours of [1, 2, 3, 4, 5, 6, 12, 24]) {
      const parsed = campaignInput.safeParse({
        name: `Group ${hours}h Broadcast`,
        message: "Automated update",
        sessionId: "sender",
        audienceType: "GROUPS",
        groupIds: ["g1", "g2"],
        scheduleType: "CRON",
        intervalHours: hours,
        runImmediately: true,
      });
      expect(parsed.success).toBe(true);
    }
    const start = new Date("2026-10-26T00:00:00Z");
    const preview5h = schedulePreview({ scheduleType: "CRON", intervalHours: 5, runImmediately: false, timezone: "UTC" }, start);
    expect(preview5h[0]).toBe("2026-10-26T05:00:00.000Z");
    expect(preview5h[4]).toBe("2026-10-27T01:00:00.000Z"); // True 5h intervals across midnight without cron reset drift!
    expect(scheduleIssue({ scheduleType: "CRON", intervalHours: 1, timezone: "UTC" }, 2 * 3600_000)).toContain("more time");
    expect(scheduleIssue({ scheduleType: "CRON", intervalHours: 2, timezone: "UTC" }, 30 * 60_000)).toBeNull();
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

  it("interprets one-time local dates in the schedule timezone and handles DST", () => {
    expect(zonedDateTimeToIso("2026-10-26T09:00", "Africa/Nairobi")).toBe("2026-10-26T06:00:00.000Z");
    expect(dateTimeInZone("2026-10-26T06:00:00Z", "Africa/Nairobi")).toBe("2026-10-26T09:00");
    expect(zonedDateTimeToIso("2026-10-26T09:00", "Asia/Kolkata")).toBe("2026-10-26T03:30:00.000Z");
    expect(() => zonedDateTimeToIso("2026-03-08T02:30", "America/New_York")).toThrow("does not exist");
    expect(zonedDateTimeToIso("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });
});
