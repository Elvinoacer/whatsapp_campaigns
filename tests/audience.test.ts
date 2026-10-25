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
  it("accepts an uploaded PDF attachment key", () => {
    expect(campaignInput.safeParse({ ...base, mediaKey: "0e159421-c8de-44e7-a3f0-e43ba1bc82c0.pdf", mediaMime: "application/pdf", mediaName: "update.pdf" }).success).toBe(true);
  });
  it("accepts Nairobi cron", () => {
    expect(campaignInput.safeParse({ ...base, scheduleType: "CRON", cron: "0 9 * * 1", timezone: "Africa/Nairobi" }).success).toBe(true);
  });
});
