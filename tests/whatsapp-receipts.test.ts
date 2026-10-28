import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";

const state = vi.hoisted(() => ({ deliveries: [] as Record<string, unknown>[], attempts: [] as Record<string, unknown>[] }));
vi.mock("../lib/db", () => {
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === "OR") return (value as Record<string, unknown>[]).some(part => matches(row, part));
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return (value.in as unknown[]).includes(row[key]);
        if ("not" in value) return row[key] !== value.not;
        if ("startsWith" in value && !(typeof row[key] === "string" && (row[key] as string).startsWith(String(value.startsWith)))) return false;
        if ("endsWith" in value) return typeof row[key] === "string" && (row[key] as string).endsWith(String(value.endsWith));
        if ("contains" in value) return typeof row[key] === "string" && (row[key] as string).includes(String(value.contains));
        return !!row[key] && matches(row[key] as Record<string, unknown>, value as Record<string, unknown>);
      }
      return row[key] === value;
    });
  }
  const model = (rows: Record<string, unknown>[]) => ({
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter(row => matches(row, where))),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const selected = rows.filter(row => matches(row, where));
      for (const row of selected) Object.assign(row, data);
      return { count: selected.length };
    }),
    findFirst: vi.fn(async () => null),
  });
  return { db: { delivery: model(state.deliveries), sendAttempt: model(state.attempts),
    $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    campaignReply: { upsert: vi.fn(async ({ create }: { create: unknown }) => create) },
    contact: { findMany: vi.fn(async () => []) },
    waGroup: { findUnique: vi.fn(async () => null) },
  } };
});
vi.mock("../lib/sending-safety", () => ({ evaluateSendingQuality: vi.fn(), accountKey: vi.fn() }));

import { db } from "../lib/db";
import { recordAcknowledgement, recordReply } from "../worker/events";
import { lookupReceipt, persistSendResult, prepareReceipt, reconcileSessionReceipts, type ReceiptClient } from "../worker/receipts";
import { sendResult } from "../worker/send-result";

function seed(messageId = "campaign-stanza:unique") {
  state.deliveries.push({ id: "delivery", messageId, status: "SENDING", sentAt: null,
    run: { sessionIdSnapshot: "sender", campaign: { sessionId: "sender" } } });
  state.attempts.push({ deliveryId: "delivery", messageId, sessionId: "sender", outcome: "SENDING", accountKey: "account",
    recipientKeys: ["contact:254700000001@c.us"] });
}
beforeEach(() => { state.deliveries.length = 0; state.attempts.length = 0; vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe("campaign receipt persistence", () => {
  it("links an early LID read receipt to the prepared stanza and never downgrades it", async () => {
    seed();
    const sentAt = new Date("2026-01-01T10:00:00Z");
    await recordAcknowledgement("true_200@lid_unique", 3, { sessionId: "sender", receivedAt: sentAt });
    await persistSendResult("delivery", sendResult(undefined, "campaign-stanza:unique"));
    await persistSendResult("delivery", sendResult({ id: { _serialized: "true_254700000001@c.us_unique" }, ack: 1 }));
    await recordAcknowledgement("true_200@lid_unique", 1, { sessionId: "sender" });
    expect(state.deliveries[0]).toMatchObject({ status: "READ", messageId: "true_200@lid_unique", sentAt, error: null });
    expect(state.attempts[0]).toMatchObject({ outcome: "READ", messageId: "true_200@lid_unique" });
  });
  it("requires the sending session to attach a prepared identifier", async () => {
    seed();
    await recordAcknowledgement("true_200@lid_unique", 3, { sessionId: "other-session" });
    expect(state.deliveries[0].status).toBe("SENDING");
    expect(state.attempts[0].outcome).toBe("SENDING");
  });
  it("keeps following the exact stanza when a late promise returns the older phone address", async () => {
    seed();
    await recordAcknowledgement("true_200@lid_unique", 1, { sessionId: "sender" });
    await persistSendResult("delivery", sendResult({ id: { _serialized: "true_254700000001@c.us_unique" }, ack: 1 }));
    await recordAcknowledgement("true_200@lid_unique", 2, { sessionId: "sender" });
    expect(state.deliveries[0]).toMatchObject({ status: "DELIVERED", messageId: "true_200@lid_unique" });
    expect(state.attempts[0]).toMatchObject({ outcome: "DELIVERED", messageId: "true_200@lid_unique" });
  });
  it("keeps a local pending model out of the sent count", async () => {
    seed();
    await recordAcknowledgement("true_200@lid_unique", 0, { sessionId: "sender" });
    expect(state.deliveries[0]).toMatchObject({ status: "SENDING", messageId: "true_200@lid_unique", sentAt: null });
    await recordAcknowledgement("true_200@lid_unique", 1, { sessionId: "sender" });
    expect(state.deliveries[0].status).toBe("SENT");
    await persistSendResult("delivery", sendResult({ id: { _serialized: "true_200@lid_unique" }, ack: -1 }));
    await recordAcknowledgement("true_200@lid_unique", -1, { sessionId: "sender" });
    expect(state.deliveries[0].status).toBe("SENT");
    expect(state.attempts[0].outcome).toBe("SENT");
  });
  it("recovers an exact historical receipt kept only in SendAttempt without sending", async () => {
    seed("true_254700000001@c.us_unique");
    Object.assign(state.deliveries[0], { status: "UNKNOWN", messageId: null });
    Object.assign(state.attempts[0], { outcome: "UNKNOWN" });
    const getMessageById = vi.fn(async () => ({ id: { _serialized: "true_200@lid_unique" }, ack: 2 }));
    expect(await reconcileSessionReceipts("sender", { getMessageById } as unknown as ReceiptClient)).toBe(1);
    expect(getMessageById).toHaveBeenCalledWith("true_254700000001@c.us_unique");
    expect(state.deliveries[0]).toMatchObject({ status: "DELIVERED", messageId: "true_200@lid_unique" });
    expect(state.attempts[0]).toMatchObject({ outcome: "DELIVERED" });
  });
  it("leaves history without identifiers unconfirmed", async () => {
    seed();
    Object.assign(state.deliveries[0], { status: "UNKNOWN", messageId: null });
    Object.assign(state.attempts[0], { outcome: "UNKNOWN", messageId: null });
    const getMessageById = vi.fn();
    expect(await reconcileSessionReceipts("sender", { getMessageById } as unknown as ReceiptClient)).toBe(0);
    expect(getMessageById).not.toHaveBeenCalled();
    expect(state.deliveries[0].status).toBe("UNKNOWN");
  });
});

describe("exact WhatsApp browser lookup", () => {
  it("runs the worker's actual tsx-serialized browser callbacks without module helpers", async () => {
    const sources = JSON.parse(execFileSync(process.execPath, ["--require", "tsx/cjs", "-e", `
      const { prepareReceipt, lookupReceipt } = require("./worker/receipts.ts");
      const sources = [];
      const client = { pupPage: { evaluate: async fn => { sources.push(fn.toString()); return "ABC123"; } } };
      Promise.all([prepareReceipt(client), lookupReceipt(client, "campaign-stanza:ABC123")]).then(() => {
        process.stdout.write(JSON.stringify(sources)); process.exit(0);
      });
    `], { cwd: new URL("..", import.meta.url), encoding: "utf8" })) as string[];
    const browserWindow = { require: (name: string) => name === "WAWebMsgKey" ? { newId: async () => "ABC123" } : {
      Msg: { getModelsArray: () => [{ id: { fromMe: true, id: "ABC123", _serialized: "true_200@lid_ABC123" }, ack: 2, t: 100 }] },
    } };
    expect(await runInNewContext(`(${sources[0]})()`, { window: browserWindow })).toBe("ABC123");
    expect(await runInNewContext(`(${sources[1]})("ABC123", [])`, { window: browserWindow }))
      .toEqual({ id: { _serialized: "true_200@lid_ABC123" }, ack: 2, timestamp: 100 });
  }, 15000);
  it("loads by the generated stanza, rejects unrelated and inbound models, and returns minimal receipt data", async () => {
    const actual = { id: { fromMe: true, id: "unique", _serialized: "true_200@lid_unique" }, ack: 3, t: 100 };
    const getMessagesById = vi.fn(async () => ({ messages: [
      { id: { fromMe: true, id: "older" }, ack: 3 }, { id: { fromMe: false, id: "unique" }, ack: 3 }, actual,
    ] }));
    vi.stubGlobal("window", { require: () => ({ Msg: { getModelsArray: () => [], getMessagesById } }) });
    const client = { pupPage: { evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args) } } as unknown as ReceiptClient;
    expect(await lookupReceipt(client, "campaign-stanza:unique", ["254700000001@c.us", "guessed-username"]))
      .toEqual({ id: { _serialized: "true_200@lid_unique" }, ack: 3, timestamp: 100 });
    expect(getMessagesById).toHaveBeenCalledWith(["true_254700000001@c.us_unique"]);
  });
  it("prepares with WhatsApp's generator before any dispatch", async () => {
    const newId = vi.fn(async () => "ABC123");
    vi.stubGlobal("window", { require: () => ({ newId }) });
    const client = { pupPage: { evaluate: async (fn: () => unknown) => fn() } } as unknown as ReceiptClient;
    expect(await prepareReceipt(client)).toEqual({ stanza: "ABC123", messageId: "campaign-stanza:ABC123" });
    expect(newId).toHaveBeenCalledOnce();
  });
});

describe("inbound campaign replies", () => {
  it("counts a media reply even without a caption and matches a quoted prepared stanza", async () => {
    vi.mocked(db.delivery.findFirst).mockResolvedValueOnce({ id: "delivery" } as never);
    const result = await recordReply({ sessionId: "sender", from: "200@lid", messageId: "incoming", body: "", hasMedia: true,
      quotedMessageId: "true_200@lid_unique", contactIds: ["254700000001@c.us"] });
    expect(result).toMatchObject({ deliveryId: "delivery", attribution: "QUOTED", body: "" });
    expect(db.delivery.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      OR: expect.arrayContaining([{ messageId: { in: ["true_200@lid_unique", "campaign-stanza:unique"] } }]),
      recipientKey: { in: ["contact:200@lid", "contact:254700000001@c.us"] },
    }) }));
  });
  it("never attributes an unknown group to an individual", async () => {
    expect(await recordReply({ sessionId: "sender", from: "100@g.us", messageId: "incoming", body: "hello" })).toBeNull();
    expect(db.delivery.findFirst).not.toHaveBeenCalled();
  });
});
