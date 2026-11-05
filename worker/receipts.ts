import type wwebjs from "whatsapp-web.js";
import { isOptOut } from "../lib/campaign";
import { db } from "../lib/db";
import { isDirectWhatsAppId, isDirectWhatsAppId as directId } from "../lib/whatsapp-id";
import { contactIds, type IdentityClient } from "./identity";
import {
  isSystemWhatsAppMessage,
  outgoingStanza,
  preparedReceiptId,
  preparedStanza,
  serializedMessageId,
} from "./receipt-identity";
import { recordAcknowledgement, recordReply, recordOptOut } from "./events";
import { matchHistoricalMessages, reconstructHistoricalText, type HistoryMessage } from "./history-match";
import { sendResult, type SentMessage, type SendResult } from "./send-result";

type Client = InstanceType<typeof wwebjs.Client>;
export type ReceiptClient = Partial<Pick<Client, "pupPage" | "getMessageById">> & IdentityClient;

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
    const actual = serializedMessageId(receipt?.id);
    return actual && (actual === messageId || (outgoingStanza(messageId) && outgoingStanza(messageId) === outgoingStanza(actual)))
      ? { ...receipt, id: { _serialized: actual } }
      : null;
  }
  if (!client.pupPage) return null;
  return client.pupPage.evaluate(async (stanza, addresses) => {
    type RawKey = {
      fromMe?: boolean;
      id?: string;
      _serialized?: string;
      $1?: string;
      remote?: string | { _serialized?: string; toString?: () => string };
      toString?: () => string;
    };
    type Model = { id?: RawKey; ack?: number; t?: number };
    type Collection = { getModelsArray: () => Model[]; getMessagesById: (ids: string[]) => Promise<{ messages?: Model[] }> };
    const page = window as unknown as { require: (name: string) => { Msg: Collection } };
    const messages = page.require("WAWebCollections").Msg;
    let message = messages.getModelsArray().find(item => item.id?.fromMe === true && item.id.id === stanza);
    if (!message && addresses.length) {
      const loaded = await messages.getMessagesById(addresses.map(address => `true_${address}_${stanza}`));
      message = loaded.messages?.find(item => item.id?.fromMe === true && item.id.id === stanza)
        || messages.getModelsArray().find(item => item.id?.fromMe === true && item.id.id === stanza);
    }
    const key = message?.id;
    const remote = typeof key?.remote === "string"
      ? key.remote
      : key?.remote?._serialized || (typeof key?.remote?.toString === "function" ? key.remote.toString() : "");
    const serialized = (typeof key?._serialized === "string" && key._serialized)
      || (typeof key?.$1 === "string" && key.$1)
      || (typeof key?.toString === "function" && key.toString !== Object.prototype.toString ? key.toString() : "")
      || (typeof key?.fromMe === "boolean" && remote && key?.id ? `${key.fromMe}_${remote}_${key.id}` : "");
    return serialized && !serialized.startsWith("[object ")
      ? { id: { _serialized: serialized }, ack: message?.ack, timestamp: message?.t }
      : null;
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
  const attempts = await db.sendAttempt.findMany({
    where: {
      sessionId,
      messageId: { not: null },
      outcome: { in: ["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED"] },
    },
    orderBy: { attemptedAt: "desc" },
    take: 1500,
  });
  let reconciled = 0;
  for (const attempt of attempts) {
    try {
      const baseAddresses = attempt.recipientKeys.map(key => key.replace(/^(contact|group):/, ""));
      const expanded = client.getContactLidAndPhone
        ? (await Promise.all(baseAddresses.map(id => contactIds(client, id)))).flat()
        : baseAddresses;
      const message = await lookupReceipt(client, attempt.messageId!, [...new Set(expanded)]);
      const actualId = serializedMessageId(message?.id);
      if (!message || !actualId) continue;
      await persistSendResult(attempt.deliveryId, sendResult({ ...message, id: { _serialized: actualId } }, preparedStanza(attempt.messageId) ? attempt.messageId : undefined));
      await recordAcknowledgement(actualId, Number(message.ack), { sessionId, receivedAt: message.timestamp ? new Date(message.timestamp * 1000) : undefined });
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
  const recent = await db.sendAttempt.findMany({
    where: { sessionId, attemptedAt: { gte: since } },
    take: 1500,
    orderBy: { attemptedAt: "desc" },
  });
  const deliveries = await db.delivery.findMany({
    where: {
      id: { in: recent.map(item => item.deliveryId) },
      ...(opts.campaignId ? { run: { campaignId: opts.campaignId } } : {}),
    },
    include: { run: { include: { campaign: { select: { audienceType: true, message: true, includeFooter: true } } } } },
  });
  const byDelivery = new Map(deliveries.map(item => [item.id, item]));
  const ids = [...new Set(recent.flatMap(item => item.recipientKeys.filter(key => key.startsWith("contact:")).map(key => key.slice(8))))];
  const contacts = await db.contact.findMany({
    where: { OR: [{ whatsappId: { in: ids } }, { id: { in: ids } }] },
    select: { id: true, whatsappId: true, name: true, phone: true },
  });
  const byContact = new Map(contacts.flatMap(item => [[item.id, item], [item.whatsappId, item]] as const));
  const groups = new Map<string, typeof recent>();
  const skipped = { count: 0 };
  for (const attempt of recent) {
    const delivery = byDelivery.get(attempt.deliveryId);
    if (!delivery) continue;
    // Group chats are deliberately not inferred from a similarly worded post.
    // Exact message-ID reconciliation above still supports group receipts.
    if (delivery.run.campaign.audienceType === "GROUPS" || !attempt.recipientKeys.some(key => key.startsWith("contact:"))) {
      skipped.count++;
      continue;
    }
    const rawIds = attempt.recipientKeys.map(key => key.startsWith("contact:") ? key.slice(8) : "").filter(Boolean);
    const chatId = rawIds.find(id => directId(id))
      || rawIds.map(id => byContact.get(id)?.whatsappId || "").find(id => directId(id));
    if (!chatId) { skipped.count++; continue; }
    const list = groups.get(chatId) || [];
    list.push(attempt);
    groups.set(chatId, list);
  }
  const entries = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map(v => v.attemptedAt.getTime())) - Math.max(...a[1].map(v => v.attemptedAt.getTime())));
  const maxChats = Math.min(200, Math.max(1, opts.maxChats || 100));
  const result: HistoryReconciliation = {
    scannedChats: 0, confirmed: 0, replies: 0, unresolved: 0,
    skipped: skipped.count, errors: 0, limited: entries.length > maxChats || recent.length === 1500,
  };
  const offset = entries.length ? (opts.chatOffset || 0) % entries.length : 0;
  const batch = [...entries.slice(offset), ...entries.slice(0, offset)].slice(0, maxChats);
  for (const [chatId, attempts] of batch) {
    try {
      const rawContactIds = attempts.flatMap(item => item.recipientKeys.filter(k => k.startsWith("contact:")).map(k => k.slice(8)));
      const contactAliases = rawContactIds.flatMap(id => {
        const record = byContact.get(id);
        return [
          ...(directId(id) ? [id] : []),
          ...(record?.whatsappId && directId(record.whatsappId) ? [record.whatsappId] : []),
          ...(record?.phone && /^\d{8,15}$/.test(record.phone) ? [`${record.phone}@c.us`] : []),
        ];
      });
      const baseChatIds = [...new Set([chatId, ...contactAliases])];
      const mappedChatIds = client.getContactLidAndPhone
        ? [...new Set((await Promise.all(baseChatIds.map(id => contactIds(client, id)))).flat())]
        : baseChatIds;

      const byMsgId = new Map<string, HistoryMessage & { _chatId: string }>();
      let anyChatOpened = false;
      for (const candidateChatId of mappedChatIds) {
        let chat: Awaited<ReturnType<NonNullable<typeof client.getChatById>>> | undefined;
        try {
          chat = await client.getChatById(candidateChatId);
        } catch (chatError) {
          const msg = chatError instanceof Error ? chatError.message : String(chatError);
          if (/not found|cannot find|invalid (?:wid|jid|chat)|no chat/i.test(msg)) {
            chat = undefined;
          } else {
            throw chatError;
          }
        }
        if (!chat) continue;
        anyChatOpened = true;
        const messages = await chat.fetchMessages({ limit: 100 });
        for (const message of messages) {
          const serialized = serializedMessageId(message.id);
          if (!serialized || !Number.isFinite(message.timestamp)) continue;
          if (!byMsgId.has(serialized)) {
            byMsgId.set(serialized, { ...message, id: { ...message.id, _serialized: serialized }, _chatId: candidateChatId });
          }
        }
      }
      if (!anyChatOpened) {
        result.scannedChats++;
        continue;
      }
      const valid = [...byMsgId.values()];
      const candidates = attempts.filter(item => {
        const delivery = byDelivery.get(item.deliveryId);
        // Administrator-confirmed or falsely failed historical sends still need their real
        // receipt recovered so later delivered/read acknowledgements and replies can link.
        return delivery && (["UNKNOWN", "SENDING", "FAILED"].includes(delivery.status)
          || ["SENT", "DELIVERED", "READ"].includes(delivery.status) && (!delivery.messageId || !!preparedStanza(delivery.messageId)));
      }).map(item => {
        const delivery = byDelivery.get(item.deliveryId)!;
        const original = item.recipientKeys.map(key => byContact.get(key.replace(/^contact:/, ""))).find(Boolean);
        const snapshot = delivery.run.messageSnapshot
          || (!delivery.run.campaign.includeFooter ? delivery.run.campaign.message : null);
        return {
          id: item.deliveryId,
          attemptedAt: item.attemptedAt,
          expectedText: reconstructHistoricalText(snapshot, { name: original?.name || null, phone: original?.phone || null }),
        };
      });
      // Never misassign one old message to two campaign attempts, and never
      // reuse WhatsApp IDs that were already attached to another delivery.
      const reservedIds = new Set(
        attempts
          .filter(item => !["UNKNOWN", "SENDING", "FAILED"].includes(item.outcome))
          .map(item => item.messageId)
          .filter((id): id is string => !!id && !preparedStanza(id)),
      );
      const matches = matchHistoricalMessages(candidates, valid, reservedIds);
      for (const [deliveryId, message] of matches) {
        const actual = serializedMessageId(message.id);
        if (!actual) continue;
        const other = await db.sendAttempt.findFirst({ where: { messageId: actual, deliveryId: { not: deliveryId } }, select: { id: true } });
        if (other) continue;
        await persistSendResult(deliveryId, sendResult({ id: { _serialized: actual }, ack: message.ack, timestamp: message.timestamp }));
        await recordAcknowledgement(actual, Number(message.ack), { sessionId, receivedAt: new Date(message.timestamp! * 1000) });
        result.confirmed++;
      }
      // Recover missed inbound messages only for a chat with an independently
      // confirmed outgoing campaign send. Unquoted replies are bounded to 72h.
      const known = await db.delivery.findMany({
        where: {
          id: { in: attempts.map(item => item.deliveryId) },
          status: { in: ["SENT", "DELIVERED", "READ"] },
          sentAt: { not: null },
        },
        select: { id: true, sentAt: true },
      });
      if (known.length) {
        const earliest = Math.floor(Math.min(...known.map(item => item.sentAt!.getTime())) / 1000) * 1000;
        const latestSent = Math.max(...known.map(item => item.sentAt!.getTime()));
        const replyContactIds = [...new Set([...mappedChatIds, ...rawContactIds])];
        for (const message of valid) {
          const replyId = serializedMessageId(message.id);
          const replyFrom = message.from && directId(message.from) ? message.from : message._chatId;
          if (message.fromMe || !replyId || isSystemWhatsAppMessage(message, replyFrom)) continue;
          const time = message.timestamp! * 1000;
          if (time < earliest || (!message.hasQuotedMsg && time > latestSent + 72 * 3600000)) continue;
          if (isOptOut(message.body || "")) await recordOptOut(sessionId, replyFrom, message.body || "", replyContactIds, new Date(time));
          const recorded = await db.campaignReply.findUnique?.({ where: { messageId: replyId }, select: { id: true } });
          if (recorded) continue;
          let quotedMessageId: string | undefined;
          if (message.hasQuotedMsg) {
            try { quotedMessageId = serializedMessageId((await message.getQuotedMessage?.())?.id) || undefined; }
            catch { continue; }
            if (!quotedMessageId) continue;
          }
          const reply = await recordReply({
            sessionId,
            from: replyFrom,
            messageId: replyId,
            body: message.body || "",
            hasMedia: !!message.hasMedia,
            quotedMessageId,
            receivedAt: new Date(time),
            contactIds: replyContactIds,
          });
          if (reply) result.replies++;
        }
      }
    } catch { result.errors++; }
    result.scannedChats++;
    if (opts.progress && (result.scannedChats % 5 === 0 || result.scannedChats === entries.length))
      await opts.progress(result);
  }
  result.unresolved = await db.sendAttempt.count({
    where: {
      sessionId,
      attemptedAt: { gte: since },
      outcome: { in: ["UNKNOWN", "SENDING"] },
      deliveryId: { in: deliveries.map(item => item.id) },
    },
  });
  await opts.progress?.(result);
  return result;
}
