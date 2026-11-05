// A locally prepared stanza identifies one send even if WhatsApp replaces the
// phone-addressed remote ID with a private LID. This is never a delivery receipt.
const prefix = "campaign-stanza:";
export const preparedReceiptId = (stanza: string) => prefix + stanza;
export const preparedStanza = (messageId?: string | null) => messageId?.startsWith(prefix) ? messageId.slice(prefix.length) : null;

export type RawMessageKey = {
  _serialized?: string;
  $1?: string;
  fromMe?: boolean;
  id?: string;
  remote?: string | { _serialized?: string; toString?: () => string };
  toString?: () => string;
};

export function serializedMessageId(key?: RawMessageKey | string | null): string | null {
  if (!key) return null;
  if (typeof key === "string") return key || null;
  if (typeof key._serialized === "string" && key._serialized) return key._serialized;
  if (typeof key.$1 === "string" && key.$1) return key.$1;
  if (typeof key.toString === "function" && key.toString !== Object.prototype.toString) {
    const str = key.toString();
    if (typeof str === "string" && str && !str.startsWith("[object ")) return str;
  }
  const remote = typeof key.remote === "string"
    ? key.remote
    : key.remote?._serialized || (typeof key.remote?.toString === "function" && key.remote.toString !== Object.prototype.toString ? key.remote.toString() : "");
  if (typeof key.fromMe === "boolean" && remote && key.id) {
    return `${key.fromMe}_${remote}_${key.id}`;
  }
  return null;
}

const NON_USER_MESSAGE_TYPES = new Set([
  "e2e_notification",
  "notification",
  "notification_template",
  "gp2",
  "ciphertext",
  "protocol",
  "revoked",
  "call_log",
]);

export function isSystemWhatsAppMessage(
  message: { from?: string; type?: string; isNotification?: boolean },
  chatId?: string,
) {
  const sender = message.from || chatId || "";
  if (/^0@(?:c\.us|lid)$/i.test(sender) || sender === "status@broadcast") return true;
  if (message.isNotification) return true;
  if (message.type && NON_USER_MESSAGE_TYPES.has(message.type)) return true;
  return false;
}

export function outgoingStanza(messageId?: string | null) {
  if (!messageId?.startsWith("true_")) return null;
  const parts = messageId.split("_");
  return parts.length >= 3 ? parts[2] : null;
}
export function receiptIds(messageId: string, includePrepared = false) {
  const stanza = outgoingStanza(messageId);
  return [messageId, ...(includePrepared && stanza ? [preparedReceiptId(stanza)] : [])];
}
export function receiptMatch(messageId: string, includePrepared = false) {
  const stanza = outgoingStanza(messageId);
  return [{ messageId: { in: receiptIds(messageId, includePrepared) } },
    ...(includePrepared && stanza && /^[a-z0-9]+$/i.test(stanza) ? [
      { messageId: { startsWith: "true_", endsWith: "_" + stanza } },
      { messageId: { startsWith: "true_", contains: "_" + stanza + "_" } },
    ] : [])];
}
