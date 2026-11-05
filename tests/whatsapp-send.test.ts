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
  it.each([[undefined, "SENDING"], [0, "SENDING"], [1, "SENT"], [2, "DELIVERED"], [3, "READ"], [4, "READ"], [-1, "FAILED"]])(
    "records ack %s as %s when WhatsApp returns an actual message ID", (ack, status) => {
      const result = sendResult({ id: { _serialized: "true_200@lid_unique" }, ack: ack as number | undefined });
      expect(result.status).toBe(status);
      expect(result.messageId).toBe("true_200@lid_unique");
    });
  it("explains old ack errors without changing their uncertain delivery status", () => {
    expect(deliveryFeedback({ status: "UNKNOWN", error: "Cannot read properties of undefined (reading 'ack')" })).toBe(unconfirmedSend);
    expect(deliveryFeedback({ status: "FAILED", error: "Disconnected" })).toBe("Disconnected");
  });
  it("retains a prepared exact identifier for missing results and rejects another message's receipt", () => {
    expect(sendResult(undefined, "campaign-stanza:unique").messageId).toBe("campaign-stanza:unique");
    expect(sendResult({ id: { _serialized: "true_200@lid_other" }, ack: 3 }, "campaign-stanza:unique"))
      .toMatchObject({ status: "UNKNOWN", messageId: "campaign-stanza:unique", sentAt: null });
  });
});

describe("patched SDK message lookup", () => {
  function fixture(mode: "direct" | "promise" | "lid" | "missing") {
    const id = { id: "unique", fromMe: true, _serialized: "true_200@lid_unique" };
    const actual = { id, serialize: () => ({ id, ack: 2 }) };
    const unrelated = { id: { id: "older", fromMe: true }, body: "same text" };
    const send = vi.fn<(_chat: unknown, _message: unknown) => [Promise<unknown>, Promise<void>]>(() => [Promise.resolve(mode === "promise" ? actual : undefined), Promise.resolve()]);
    const generatedId = vi.fn(async () => "unique");
    class MsgKey {
      static newId = generatedId;
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
    return { page, actual, send, generatedId };
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
  it("uses the persisted stanza exactly once and keeps its local option out of WhatsApp metadata", async () => {
    const { page, actual, send, generatedId } = fixture("direct");
    expect(await page.WWebJS.sendMessage({ id: { isLid: () => false } }, "same text", {
      extraOptions: { campaignStanzaId: "unique" },
    })).toBe(actual);
    expect(send).toHaveBeenCalledOnce();
    expect(generatedId).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty("campaignStanzaId");
    expect(send.mock.calls[0]?.[1]).not.toHaveProperty("extraOptions");
  });
  it("rejects an invalid prepared identifier before dispatch", async () => {
    const { page, send } = fixture("direct");
    await expect(page.WWebJS.sendMessage({ id: { isLid: () => false } }, "same text", {
      extraOptions: { campaignStanzaId: "invalid_id" },
    })).rejects.toThrow("Invalid prepared campaign stanza ID");
    expect(send).not.toHaveBeenCalled();
  });
  it("populates _serialized in getMessageModel and avoids crashing getChatModel when WAWebMsgKey omits _serialized", async () => {
    class ModernMsgKey {
      $1: string;
      id: string;
      fromMe: boolean;
      remote: { _serialized: string };
      constructor(fromMe: boolean, remote: string, id: string) {
        this.fromMe = fromMe;
        this.remote = { _serialized: remote };
        this.id = id;
        this.$1 = `${fromMe}_${remote}_${id}`;
      }
      toString() { return this.$1; }
    }
    const lastKey = new ModernMsgKey(true, "200@lid", "STANZA99");
    const rawMsg = {
      id: lastKey,
      body: "Hello",
      ack: 2,
      serialize: () => ({ id: { fromMe: true, id: "STANZA99", remote: { _serialized: "200@lid" }, $1: "true_200@lid_STANZA99" }, body: "Hello", ack: 2 }),
    };
    const getMessagesById = vi.fn(async (ids: unknown[]) => {
      if (ids.some(id => !id)) throw new Error("No key or key range specified");
      return { messages: [rawMsg] };
    });
    const page = {
      require: (name: string) => {
        if (name === "WAWebMsgKey") return ModernMsgKey;
        if (name === "WALinkify") return { findLinks: () => [] };
        if (name === "WAWebCollections") return { Msg: { get: () => undefined, getMessagesById } };
        return {};
      },
      WWebJS: {} as {
        getMessageModel: (msg: unknown) => { id: { _serialized?: string; remote?: string } };
        getChatModel: (chat: unknown) => Promise<{ lastMessage?: { id?: { _serialized?: string } } }>;
      },
    };
    vi.stubGlobal("window", page);
    LoadUtils();
    expect((lastKey as unknown as { _serialized?: string })._serialized).toBe("true_200@lid_STANZA99");
    const serializedModel = page.WWebJS.getMessageModel(rawMsg);
    expect(serializedModel.id._serialized).toBe("true_200@lid_STANZA99");
    expect(serializedModel.id.remote).toBe("200@lid");
    const chatModel = await page.WWebJS.getChatModel({
      id: { _serialized: "200@lid" },
      formattedTitle: "Recipient",
      lastReceivedKey: lastKey,
      mute: { expiration: 0 },
      serialize: () => ({ id: { _serialized: "200@lid" }, msgs: [{}] }),
    });
    expect(getMessagesById).toHaveBeenCalledWith(["true_200@lid_STANZA99"]);
    expect(chatModel.lastMessage?.id?._serialized).toBe("true_200@lid_STANZA99");
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
