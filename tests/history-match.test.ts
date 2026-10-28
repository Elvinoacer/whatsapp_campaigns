import { describe, expect, it } from "vitest";
import { matchHistoricalMessages, reconstructHistoricalText } from "../worker/history-match";

const base = new Date("2026-10-28T10:00:00Z");
const sent = (id: string, body = "Hello Ada\n\nMoi Mashinani Team\nReply STOP to unsubscribe.", offset = 20) => ({
  id: { _serialized: id }, fromMe: true, body, timestamp: Math.floor(base.getTime() / 1000) + offset, ack: 2,
});
describe("evidence-based historical WhatsApp matching", () => {
  const expectedText = "Hello Ada\n\nMoi Mashinani Team\nReply STOP to unsubscribe.";
  it("reconstructs personalized messages without treating unresolved templates as evidence", () => {
    expect(reconstructHistoricalText("Hello {{first_name}}\n\nMoi Mashinani Team\nReply STOP to unsubscribe.", { name: "Ada Test" })).toBe(expectedText);
    expect(reconstructHistoricalText("Hello {{unknown}}", { name: "Ada" })).toBeNull();
    expect(reconstructHistoricalText(null, { name: "Ada" })).toBeNull();
  });
  it("matches only unique sent outgoing messages in the same chat and bounded time window", () => {
    const matches = matchHistoricalMessages([{ id: "delivery-1", attemptedAt: base, expectedText }],
      [sent("true_254700000001@c.us_abc"), { ...sent("incoming"), fromMe: false }, sent("too-old", expectedText, -500)]);
    expect(matches.get("delivery-1")?.id?._serialized).toBe("true_254700000001@c.us_abc");
    expect(matches.size).toBe(1);
  });
  it("rejects identical messages close together, multiple reserved attempts, and unsent local drafts", () => {
    const reservation = { id: "one", attemptedAt: base, expectedText };
    expect(matchHistoricalMessages([reservation], [sent("one"), sent("two")]).size).toBe(0);
    expect(matchHistoricalMessages([reservation, { ...reservation, id: "two" }], [sent("one")]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [{ ...sent("one"), ack: 0 }]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [sent("one")], new Set(["one"])).size).toBe(0);
  });
  it("never promotes an incoming message, altered footer, old history or missing receipt", () => {
    const reservation = { id: "one", attemptedAt: base, expectedText };
    expect(matchHistoricalMessages([reservation], [{ ...sent("one"), fromMe: false }]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [sent("one", "Hello Ada")]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [sent("one", expectedText, 4000)]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [{ ...sent("one"), id: undefined }]).size).toBe(0);
    expect(matchHistoricalMessages([reservation], [sent("one", expectedText, 20), { ...sent("two"), ack: -1 }]).size).toBe(1);
  });
});
