import type wwebjs from "whatsapp-web.js";
import { isOptOut } from "../lib/campaign";
import { db } from "../lib/db";
import { isDirectWhatsAppId, isDirectWhatsAppId as directId } from "../lib/whatsapp-id";
import { outgoingStanza, preparedReceiptId, preparedStanza } from "./receipt-identity";
import { recordAcknowledgement, recordReply, recordOptOut } from "./events";
import { matchHistoricalMessages, reconstructHistoricalText, type HistoryMessage } from "./history-match";
import { sendResult, type SentMessage, type SendResult } from "./send-result";

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

export async function persistSendResult(deliveryId: string, result: SendResult) {
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
    outcome: { in: ["SENDING", "UNKNOWN", "SENT", "DELIVERED"] } }, orderBy: { attemptedAt: "desc" }, take: 1500 });
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

/** Read-only WhatsApp history scan for old attempts with missing or lost receipts.
 * Never dispatches a message or requeues an uncertain send. Recovered STOP replies preserve opt-outs.
 * Limited to a bounded set of recent, reserved attempts per user request.
 */
export type HistoryClient = ReceiptClient & {
  getChatById?: (chatId: string) => Promise<{ fetchMessages: (options: { limit: number }) => Promise<HistoryMessage[]> }>;
};
export type HistoryReconciliation = {
  scannedChats: number; confirmed: number; replies: number; unresolved: number;
  skipped: number; errors: number; limited: boolean;
};
export async function reconcileSessionHistory(sessionId: string, client: HistoryClient, opts: {
  campaignId?: string; maxChats?: number; chatOffset?: number; progress?: (result: HistoryReconciliation) => Promise<void>;
} = {}): Promise<HistoryReconciliation> {
  if (!client.getChatById) throw new Error("WhatsApp history is not available on this session.");
  const since = new Date(Date.now() - 30 * 86400000);
  await reconcileSessionReceipts(sessionId, client); // Exact ID evidence always wins.
  const recent = await db.sendAttempt.findMany({ where: { sessionId, attemptedAt: { gte: since } },
    take: 1500, orderBy: { attemptedAt: "desc" } });
  const deliveries = await db.delivery.findMany({ where: {
    id: { in: recent.map(item => item.deliveryId) },
    ...(opts.campaignId ? { run: { campaignId: opts.campaignId } } : {}),
  }, include: { run: { include: { campaign: { select: { audienceType: true } } } } } });
  const byDelivery = new Map(deliveries.map(item => [item.id, item]));
  const ids = [...new Set(recent.flatMap(item => item.recipientKeys.filter(key => key.startsWith("contact:")).map(key => key.slice(8))))];
  const contacts = await db.contact.findMany({ where: { OR: [
    { whatsappId: { in: ids } }, { id: { in: ids } },
  ] }, select: { id: true, whatsappId: true, name: true, phone: true } });
  const byContact = new Map(contacts.flatMap(item => [[item.id, item], [item.whatsappId, item]] as const));
  const groups = new Map<string, typeof recent>();
  const skipped = { count: 0 };
  for (const attempt of recent) {
    const delivery = byDelivery.get(attempt.deliveryId);
    if (!delivery) continue;
    // Group chats are deliberately not inferred from a similarly worded post.
    // Exact message-ID reconciliation above still supports group receipts.
    if (delivery.run.campaign.audienceType === "GROUPS" || !attempt.recipientKeys.some(key => key.startsWith("contact:"))) { skipped.count++; continue; }
    const chatId = attempt.recipientKeys.map(key => key.startsWith("contact:") ? key.slice(8) : "")
      .find(id => directId(id));
    if (!chatId) { skipped.count++; continue; }
    const list = groups.get(chatId) || [];
    list.push(attempt);
    groups.set(chatId, list);
  }
  const entries = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map(v => v.attemptedAt.getTime())) - Math.max(...a[1].map(v => v.attemptedAt.getTime())));
  const maxChats = Math.min(200, Math.max(1, opts.maxChats || 100));
  const result: HistoryReconciliation = { scannedChats: 0, confirmed: 0, replies: 0, unresolved: 0,
    skipped: skipped.count, errors: 0, limited: entries.length > maxChats || recent.length === 1500 };
  const offset = entries.length ? (opts.chatOffset || 0) % entries.length : 0;
  const batch = [...entries.slice(offset), ...entries.slice(0, offset)].slice(0, maxChats);
  for (const [chatId, attempts] of batch) {
    try {
      const chat = await client.getChatById(chatId);
      if (!chat) {
        for (const attempt of attempts) {
          const delivery = byDelivery.get(attempt.deliveryId);
          if (delivery && delivery.status === "UNKNOWN") {
            await persistSendResult(delivery.id, {
              status: "FAILED",
              messageId: attempt.messageId,
              error: "Recipient chat not found or cannot be opened in WhatsApp.",
              sentAt: null,
            });
          }
        }
        result.scannedChats++;
        continue;
      }
      const messages = await chat.fetchMessages({ limit: 100 });
      const valid = messages.filter(message => message.id?._serialized && Number.isFinite(message.timestamp));
      const candidates = attempts.filter(item => {
        const delivery = byDelivery.get(item.deliveryId);
        // Administrator-confirmed historical sends still need their real
        // receipt recovered so later delivered/read and quoted replies can link.
        return delivery && (["UNKNOWN", "SENDING"].includes(delivery.status)
          || delivery.status === "SENT" && (!delivery.messageId || !!preparedStanza(delivery.messageId)));
      }).map(item => {
        const delivery = byDelivery.get(item.deliveryId)!;
        const original = item.recipientKeys.map(key => byContact.get(key.replace(/^contact:/, ""))).find(Boolean);
        return { id: item.deliveryId, attemptedAt: item.attemptedAt,
          expectedText: reconstructHistoricalText(delivery.run.messageSnapshot,
            { name: original?.name || null, phone: original?.phone || null }) };
      });
      // Never misassign one old message to two campaign attempts, and never
      // reuse WhatsApp IDs that were already attached to another delivery.
      const reservedIds = new Set(attempts.filter(item => !["UNKNOWN", "SENDING"].includes(item.outcome))
        .map(item => item.messageId).filter((id): id is string => !!id));
      const matches = matchHistoricalMessages(candidates, valid, reservedIds);
      for (const [deliveryId, message] of matches) {
        const actual = message.id?._serialized;
        if (!actual) continue;
        const other = await db.sendAttempt.findFirst({ where: { messageId: actual, deliveryId: { not: deliveryId } }, select: { id: true } });
        if (other) continue;
        await persistSendResult(deliveryId, sendResult({ id: { _serialized: actual },
          ack: message.ack, timestamp: message.timestamp }));
        await recordAcknowledgement(actual, Number(message.ack), { sessionId, receivedAt: new Date(message.timestamp! * 1000) });
        result.confirmed++;
      }
      // Recover missed inbound messages only for a chat with an independently
      // confirmed outgoing campaign send. Unquoted replies are bounded to 72h.
      const known = await db.delivery.findMany({ where: { id: { in: attempts.map(item => item.deliveryId) },
        status: { in: ["SENT", "DELIVERED", "READ"] }, sentAt: { not: null } },
        select: { id: true, sentAt: true } });
      if (known.length) {
        const earliest = Math.min(...known.map(item => item.sentAt!.getTime()));
        for (const message of valid) {
          if (message.fromMe || !message.id?._serialized) continue;
          const time = message.timestamp! * 1000;
          if (time < earliest || (!message.hasQuotedMsg && time > Math.max(...known.map(item => item.sentAt!.getTime())) + 72 * 3600000)) continue;
          if (isOptOut(message.body || "")) await recordOptOut(sessionId, chatId, message.body || "", [], new Date(time));
          const recorded = await db.campaignReply.findUnique({ where: { messageId: message.id._serialized }, select: { id: true } });
          if (recorded) continue;
          let quotedMessageId: string | undefined;
          if (message.hasQuotedMsg) {
            try { quotedMessageId = (await message.getQuotedMessage?.())?.id?._serialized; }
            catch { continue; }
            if (!quotedMessageId) continue;
          }
          const reply = await recordReply({ sessionId, from: chatId,
            messageId: message.id._serialized, body: message.body || "", hasMedia: !!message.hasMedia,
            quotedMessageId, receivedAt: new Date(time),
            contactIds: attempts.flatMap(item => item.recipientKeys.map(key => key.replace(/^contact:/, ""))) });
          if (reply) result.replies++;
        }
      }
    } catch { result.errors++; }
    result.scannedChats++;
    if (opts.progress && (result.scannedChats % 5 === 0 || result.scannedChats === entries.length))
      await opts.progress(result);
  }
  result.unresolved = await db.sendAttempt.count({ where: { sessionId, attemptedAt: { gte: since },
    outcome: { in: ["UNKNOWN", "SENDING"] }, deliveryId: { in: deliveries.map(item => item.id) } } });
  await opts.progress?.(result);
  return result;
}
