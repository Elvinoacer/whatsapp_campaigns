import { describe, it, expect } from "vitest";
import { deliveryTotals } from "../lib/reporting";
import { campaignInput } from "../lib/campaign";

describe("delivery reporting", () => {
  it("counts one opt-out per delivery even when the recipient sends several STOP replies", () => {
    const result = deliveryTotals([{ status: "READ", _count: { replies: 4 }, replies: [{ isOptOut: true }, { isOptOut: true }] }, { status: "SENT", replies: [{ isOptOut: false }] }]);
    expect(result.optedOut).toBe(1);
    expect(result.replies).toBe(5);
    expect(result.replied).toBe(2);
  });
  it("counts sent, delivered and read cumulatively, and distinguishes replies from recipients", () => {
    const result = deliveryTotals([
      { status: "SENT", _count: { replies: 2 } }, { status: "DELIVERED" }, { status: "READ", _count: { replies: 1 } },
      { status: "QUEUED" }, { status: "SENDING" }, { status: "FAILED" }, { status: "UNKNOWN" }, { status: "SKIPPED" },
    ]);
    expect(result).toEqual({ total: 8, sent: 3, delivered: 2, read: 1, replies: 3, replied: 2, pending: 2, failed: 1, uncertain: 1, skipped: 1, optedOut: 0 });
  });
  it("accepts 1,500 individual recipients and rejects more", () => {
    const base = { name: "Large campaign", message: "Hello", sessionId: "sender", audienceType: "CONTACTS" };
    expect(campaignInput.safeParse({ ...base, contactIds: Array.from({ length: 1500 }, (_, i) => String(i)) }).success).toBe(true);
    expect(campaignInput.safeParse({ ...base, contactIds: Array.from({ length: 1501 }, (_, i) => String(i)) }).success).toBe(false);
  });
  it("counts fetched replies when a count projection is not included", () => {
    const result = deliveryTotals([{ status: "SENT", replies: [{ isOptOut: false }, { isOptOut: false }] }, { status: "READ", replies: [] }]);
    expect(result.replies).toBe(2);
    expect(result.replied).toBe(1);
  });
});
