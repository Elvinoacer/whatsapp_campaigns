import { unconfirmedSend } from "../lib/reporting";
import { outgoingStanza, preparedStanza, serializedMessageId, type RawMessageKey } from "./receipt-identity";

export type SentMessage = { id?: RawMessageKey; ack?: number; timestamp?: number };

export type SendResult =
  | { status: "UNKNOWN"; messageId: string | null; error: string; sentAt: null }
  | { status: "FAILED"; messageId: string | null; error: string; sentAt: null }
  | { status: "SENDING"; messageId: string; error: null; sentAt: null }
  | { status: "SENT" | "DELIVERED" | "READ"; messageId: string; error: null; sentAt: Date };

export function sendResult(message?: SentMessage | null, preparedMessageId?: string | null): SendResult {
  const messageId = serializedMessageId(message?.id);
  const expected = preparedStanza(preparedMessageId);
  if (!messageId || (expected && outgoingStanza(messageId) !== expected)) return { status: "UNKNOWN" as const,
    messageId: preparedMessageId || null, error: unconfirmedSend, sentAt: null };
  const ack = Number(message?.ack);
  if (ack === -1) return { status: "FAILED" as const, messageId, error: "WhatsApp reported a send failure.", sentAt: null };
  if (!(ack >= 1)) return { status: "SENDING" as const, messageId, error: null, sentAt: null };
  return { status: ack >= 3 ? "READ" as const : ack >= 2 ? "DELIVERED" as const : "SENT" as const,
    messageId, error: null, sentAt: message?.timestamp ? new Date(message.timestamp * 1000) : new Date() };
}
