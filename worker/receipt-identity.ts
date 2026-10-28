// A locally prepared stanza identifies one send even if WhatsApp replaces the
// phone-addressed remote ID with a private LID. This is never a delivery receipt.
const prefix = "campaign-stanza:";
export const preparedReceiptId = (stanza: string) => prefix + stanza;
export const preparedStanza = (messageId?: string | null) => messageId?.startsWith(prefix) ? messageId.slice(prefix.length) : null;
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
