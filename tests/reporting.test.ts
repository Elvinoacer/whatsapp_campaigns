import { describe, it, expect } from "vitest";
import { deliveryRates, deliveryTotals, ratePercent } from "../lib/reporting";
import { campaignInput } from "../lib/campaign";

describe("delivery reporting & conversion rates", () => {
  it("counts a retained opt-out event without inventing a missing reply or counting it twice", () => {
    const result = deliveryTotals([
      { status: "SENT", optedOutAt: new Date(), replies: [] },
      { status: "READ", optedOutAt: new Date(), replies: [{ isOptOut: true }] },
    ]);
    expect(result.optedOut).toBe(2);
    expect(result.replied).toBe(1);
    expect(result.replies).toBe(1);
  });

  it("counts one opt-out per delivery even when the recipient sends several STOP replies", () => {
    const result = deliveryTotals([
      { status: "READ", _count: { replies: 4 }, replies: [{ isOptOut: true }, { isOptOut: true }] },
      { status: "SENT", replies: [{ isOptOut: false }] },
    ]);
    expect(result.optedOut).toBe(1);
    expect(result.replies).toBe(5);
    expect(result.replied).toBe(2);
  });

  it("counts sent, delivered and read cumulatively, and computes accurate percentage rates", () => {
    const result = deliveryTotals([
      { status: "SENT", _count: { replies: 2 } },
      { status: "DELIVERED" },
      { status: "READ", _count: { replies: 1 } },
      { status: "QUEUED" },
      { status: "SENDING" },
      { status: "FAILED" },
      { status: "UNKNOWN" },
      { status: "SKIPPED" },
    ]);
    expect(result).toEqual({
      total: 8,
      sent: 3,
      delivered: 2,
      read: 1,
      replies: 3,
      replied: 2,
      pending: 2,
      failed: 1,
      uncertain: 1,
      skipped: 1,
      optedOut: 0,
    });
    const rates = deliveryRates(result);
    expect(rates).toEqual({
      deliveryRate: 66.7,
      readRate: 33.3,
      replyRate: 66.7,
      optOutRate: 0,
    });
    expect(ratePercent(0, 0)).toBe(0);
  });

  it("accepts up to 50,000 individual DM recipients in a campaign", () => {
    const base = { name: "Large campaign", message: "Hello", sessionId: "sender", audienceType: "CONTACTS" };
    expect(campaignInput.safeParse({ ...base, contactIds: Array.from({ length: 5000 }, (_, i) => String(i)) }).success).toBe(true);
    expect(campaignInput.safeParse({ ...base, contactIds: Array.from({ length: 50001 }, (_, i) => String(i)) }).success).toBe(false);
  });

  it("counts fetched replies when a count projection is not included", () => {
    const result = deliveryTotals([{ status: "SENT", replies: [{ isOptOut: false }, { isOptOut: false }] }, { status: "READ", replies: [] }]);
    expect(result.replies).toBe(2);
    expect(result.replied).toBe(1);
  });

  it("excludes lifecycle stop/pause/continuation placeholders from skipped and total while keeping genuine rule skips", () => {
    const result = deliveryTotals([
      { status: "DELIVERED" },
      { status: "SKIPPED", error: "Run stopped before this recipient was sent. Resume continues eligible unattempted recipients." },
      { status: "SKIPPED", error: "Run ended before this recipient was sent" },
      { status: "SKIPPED", error: "Campaign paused while waiting for its sending window" },
      { status: "SKIPPED", error: "Already attempted in a previous run; manual reconciliation required" },
      { status: "SKIPPED", error: "Contact opted out or unavailable" },
      { status: "SKIPPED", error: "Recipient cooldown active until 2026-11-05T00:00:00.000Z" },
    ]);
    expect(result.sent).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(3);
  });
});
