import { unconfirmedSend } from "../lib/reporting";

type SentMessage = { id?: { _serialized?: string }; ack?: number };

export function sendResult(message?: SentMessage | null) {
  const messageId = message?.id?._serialized || null;
  if (!messageId) return { status: "UNKNOWN" as const, messageId, error: unconfirmedSend, sentAt: null };
  const ack = Number(message?.ack);
  if (ack === -1) return { status: "FAILED" as const, messageId, error: "WhatsApp reported a send failure.", sentAt: null };
  return { status: ack >= 3 ? "READ" as const : ack >= 2 ? "DELIVERED" as const : "SENT" as const,
    messageId, error: null, sentAt: new Date() };
}
