import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendResult } from "../worker/send-result";
import { contactIds } from "../worker/identity";
import { deliveryFeedback, unconfirmedSend } from "../lib/reporting";

const require = createRequire(import.meta.url);
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils.js");
afterEach(() => vi.unstubAllGlobals());

describe("WhatsApp send receipts", () => {
  it("handles a missing SDK result without inventing success or throwing an ack error", () => {
    for (const message of [undefined, null, { ack: 2 }])
      expect(sendResult(message)).toEqual({ status: "UNKNOWN", messageId: null, error: unconfirmedSend, sentAt: null });
  });
  it.each([[undefined, "SENT"], [0, "SENT"], [1, "SENT"], [2, "DELIVERED"], [3, "READ"], [4, "READ"], [-1, "FAILED"]])(
    "records ack %s as %s when WhatsApp returns an actual message ID", (ack, status) => {
      const result = sendResult({ id: { _serialized: "true_200@lid_unique" }, ack: ack as number | undefined });
      expect(result.status).toBe(status);
      expect(result.messageId).toBe("true_200@lid_unique");
    });
  it("explains old ack errors without changing their uncertain delivery status", () => {
    expect(deliveryFeedback({ status: "UNKNOWN", error: "Cannot read properties of undefined (reading 'ack')" })).toBe(unconfirmedSend);
    expect(deliveryFeedback({ status: "FAILED", error: "Disconnected" })).toBe("Disconnected");
  });
});

describe("patched SDK message lookup", () => {
  function fixture(mode: "direct" | "promise" | "lid" | "missing") {
    const id = { id: "unique", fromMe: true, _serialized: "true_200@lid_unique" };
    const actual = { id, serialize: () => ({ id, ack: 2 }) };
    const unrelated = { id: { id: "older", fromMe: true }, body: "same text" };
    const send = vi.fn(() => [Promise.resolve(mode === "promise" ? actual : undefined), Promise.resolve()]);
    class MsgKey {
      static newId = async () => "unique";
      id = "unique";
      _serialized = "true_254700000001@c.us_unique";
    }
    const modules: Record<string, unknown> = {
      WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
      WALinkify: {},
      WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => ({}), getMaybeMePnUser: () => ({}) },
      WAWebMsgKey: MsgKey,
      WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
      WAWebSendMsgChatAction: { addAndSendMsgToChat: send },
      WAWebCollections: { Msg: { get: () => mode === "direct" ? actual : undefined,
        getModelsArray: () => mode === "lid" ? [unrelated, actual] : [unrelated] } },
    };
    const page = { require: (name: string) => modules[name], WWebJS: {} as { sendMessage: (chat: unknown, content: string, options: object) => Promise<unknown> } };
    vi.stubGlobal("window", page);
    LoadUtils();
    return { page, actual, send };
  }
  it.each(["direct", "promise", "lid"] as const)("retrieves the actual sent model via %s, with exactly one send", async mode => {
    const { page, actual, send } = fixture(mode);
    expect(await page.WWebJS.sendMessage({ id: { isLid: () => false } }, "same text", { waitUntilMsgSent: true })).toBe(actual);
    expect(send).toHaveBeenCalledOnce();
  });
  it("never substitutes a different message or resends when the model is missing", async () => {
    const { page, send } = fixture("missing");
    expect(await page.WWebJS.sendMessage({ id: { isLid: () => false } }, "same text", {})).toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("private contact identity", () => {
  it("uses only an explicit WhatsApp mapping, preserving a hidden phone", async () => {
    expect(await contactIds({}, "200@lid")).toEqual(["200@lid"]);
    expect(await contactIds({ getContactLidAndPhone: async () => [{ lid: "200@lid", pn: "254700000001@c.us" }] }, "200@lid"))
      .toEqual(["200@lid", "254700000001@c.us"]);
    expect(await contactIds({ getContactLidAndPhone: async () => [{ lid: "300@lid", pn: "254700000002@c.us" }] }, "200@lid"))
      .toEqual(["200@lid"]);
    expect(await contactIds({ getContactLidAndPhone: async () => { throw new Error("Phone hidden"); } }, "200@lid"))
      .toEqual(["200@lid"]);
  });
});
