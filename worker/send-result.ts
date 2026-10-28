import { unconfirmedSend } from "../lib/reporting";
import { outgoingStanza, preparedStanza } from "./receipt-identity";

export type SentMessage = { id?: { _serialized?: string }; ack?: number; timestamp?: number };

export function sendResult(message?: SentMessage | null, preparedMessageId?: string | null) {
  const messageId = message?.id?._serialized || null;
  const expected = preparedStanza(preparedMessageId);
  if (!messageId || (expected && outgoingStanza(messageId) !== expected)) return { status: "UNKNOWN" as const,
    messageId: preparedMessageId || null, error: unconfirmedSend, sentAt: null };
  const ack = Number(message?.ack);
  if (ack === -1) return { status: "FAILED" as const, messageId, error: "WhatsApp reported a send failure.", sentAt: null };
  if (!(ack >= 1)) return { status: "SENDING" as const, messageId, error: null, sentAt: null };
  return { status: ack >= 3 ? "READ" as const : ack >= 2 ? "DELIVERED" as const : "SENT" as const,
    messageId, error: null, sentAt: message?.timestamp ? new Date(message.timestamp * 1000) : new Date() };
}
