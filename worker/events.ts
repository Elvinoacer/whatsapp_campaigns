import { db } from "../lib/db";
import { isOptOut } from "../lib/campaign";

export async function recordOptOut(sessionId: string, from: string, body: string) {
  if (!from.endsWith("@c.us") || !isOptOut(body)) return false;
  await db.contact.updateMany({ where: { sessionId, whatsappId: from },
    data: { consent: "OPTED_OUT", consentNote: "Inbound STOP/unsubscribe", consentAt: null } });
  return true;
}

export async function recordAcknowledgement(messageId: string, ack: number) {
  const status = ack >= 3 ? "READ" : ack >= 2 ? "DELIVERED" : ack >= 1 ? "SENT" : null;
  if (!status) return;
  // Update conditionally so a delayed acknowledgement cannot downgrade a read receipt.
  const prior = status === "SENT" ? ["SENDING", "UNKNOWN", "SENT"] as const
    : status === "DELIVERED" ? ["SENDING", "UNKNOWN", "SENT", "DELIVERED"] as const
    : ["SENDING", "UNKNOWN", "SENT", "DELIVERED", "READ"] as const;
  await db.delivery.updateMany({ where: { messageId, status: { in: [...prior] } }, data: { status } });
}
