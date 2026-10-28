import type wwebjs from "whatsapp-web.js";
import { db } from "../lib/db";
import { isDirectWhatsAppId } from "../lib/whatsapp-id";
import { outgoingStanza, preparedReceiptId, preparedStanza } from "./receipt-identity";
import { recordAcknowledgement } from "./events";
import { sendResult, type SentMessage } from "./send-result";

type Client = InstanceType<typeof wwebjs.Client>;
export type ReceiptClient = Partial<Pick<Client, "pupPage" | "getMessageById">>;

// Generate with the same WhatsApp API the SDK uses. The worker persists this
// identifier before calling sendMessage; the SDK patch consumes the extra option.
export async function prepareReceipt(client: ReceiptClient) {
  if (!client.pupPage) return null; // Lightweight non-browser integration clients.
  const stanza = await client.pupPage.evaluate(async () => {
    const page = window as unknown as { require: (name: string) => { newId: () => Promise<string> } };
    return page.require("WAWebMsgKey").newId();
  });
  if (!stanza || !/^[a-z0-9]+$/i.test(stanza)) throw new Error("WhatsApp could not prepare a message identifier");
  return { stanza, messageId: preparedReceiptId(stanza) };
}

export async function lookupReceipt(client: ReceiptClient, messageId: string, recipientIds: string[] = []): Promise<SentMessage | null> {
  const stanza = preparedStanza(messageId);
  if (!stanza) {
    const receipt = await client.getMessageById?.(messageId);
    const actual = receipt?.id?._serialized;
    return actual === messageId || (outgoingStanza(messageId) && outgoingStanza(messageId) === outgoingStanza(actual)) ? receipt! : null;
  }
  if (!client.pupPage) return null;
  return client.pupPage.evaluate(async (stanza, addresses) => {
    type Model = { id?: { fromMe?: boolean; id?: string; _serialized?: string }; ack?: number; t?: number };
    type Collection = { getModelsArray: () => Model[]; getMessagesById: (ids: string[]) => Promise<{ messages?: Model[] }> };
    const page = window as unknown as { require: (name: string) => { Msg: Collection } };
    const messages = page.require("WAWebCollections").Msg;
    let message = messages.getModelsArray().find(message => message.id?.fromMe === true && message.id.id === stanza);
    if (!message && addresses.length) {
      const loaded = await messages.getMessagesById(addresses.map(address => `true_${address}_${stanza}`));
      message = loaded.messages?.find(message => message.id?.fromMe === true && message.id.id === stanza)
        || messages.getModelsArray().find(message => message.id?.fromMe === true && message.id.id === stanza);
    }
    return message?.id?._serialized ? { id: { _serialized: message.id._serialized }, ack: message.ack, timestamp: message.t } : null;
  }, stanza, recipientIds.filter(id => isDirectWhatsAppId(id) || id.endsWith("@g.us")));
}

export async function persistSendResult(deliveryId: string, result: ReturnType<typeof sendResult>) {
  // Each write is conditional: a send promise settling after an acknowledgement
  // must never replace READ/DELIVERED with SENT or UNKNOWN.
  const prior = result.status === "UNKNOWN" || result.status === "SENDING" ? ["SENDING", "UNKNOWN"] as const
    : result.status === "FAILED" ? ["SENDING", "UNKNOWN", "FAILED"] as const
    : result.status === "SENT" ? ["SENDING", "UNKNOWN", "FAILED", "SENT"] as const
    : result.status === "DELIVERED" ? ["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED"] as const
    : ["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED", "READ"] as const;
  await db.$transaction([
    db.delivery.updateMany({ where: { id: deliveryId, status: { in: [...prior] } }, data: result }),
    db.sendAttempt.updateMany({ where: { deliveryId, outcome: { in: [...prior] } }, data: { outcome: result.status, messageId: result.messageId } }),
  ]);
}

// Read exact identifiers only. Never search by message text or dispatch again.
// Legacy attempts may retain a receipt even when their delivery row lost it.
export async function reconcileSessionReceipts(sessionId: string, client: ReceiptClient) {
  const attempts = await db.sendAttempt.findMany({ where: { sessionId, messageId: { not: null },
    outcome: { in: ["SENDING", "UNKNOWN", "SENT", "DELIVERED"] } }, orderBy: { attemptedAt: "desc" } });
  let reconciled = 0;
  for (const attempt of attempts) {
    try {
      const message = await lookupReceipt(client, attempt.messageId!, attempt.recipientKeys.map(key => key.replace(/^(contact|group):/, "")));
      if (!message?.id?._serialized) continue;
      await persistSendResult(attempt.deliveryId, sendResult(message, preparedStanza(attempt.messageId) ? attempt.messageId : undefined));
      await recordAcknowledgement(message.id._serialized, Number(message.ack), { sessionId, receivedAt: message.timestamp ? new Date(message.timestamp * 1000) : undefined });
      reconciled++;
    } catch { /* Unavailable history stays uncertain; another ready event can retry. */ }
  }
  return reconciled;
}
