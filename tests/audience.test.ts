import { describe, expect, it } from "vitest";
import { campaignInput } from "../lib/campaign";

describe("campaign schedule validation", () => {
  const base = { name: "Announcement", message: "Hello", sessionId: "s", audienceType: "GROUPS", groupIds: ["g"] };
  it("accepts an immediate group campaign", () => {
    expect(campaignInput.safeParse(base).success).toBe(true);
  });
  it("rejects invalid cron and missing date", () => {
    expect(campaignInput.safeParse({ ...base, scheduleType: "CRON", cron: "broken" }).success).toBe(false);
    expect(campaignInput.safeParse({ ...base, scheduleType: "ONCE" }).success).toBe(false);
  });
  it("accepts Nairobi cron", () => {
    expect(campaignInput.safeParse({ ...base, scheduleType: "CRON", cron: "0 9 * * 1", timezone: "Africa/Nairobi" }).success).toBe(true);
  });
});
