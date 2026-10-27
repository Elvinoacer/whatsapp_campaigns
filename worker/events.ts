import { db } from "../lib/db";
import { isOptOut } from "../lib/campaign";

export async function recordOptOut(sessionId: string, from: string, body: string) {
  if (!from.endsWith("@c.us") || !isOptOut(body)) return false;
  const data = { consent: "OPTED_OUT" as const, consentNote: "Inbound STOP/unsubscribe", consentAt: null };
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    // The sender may not have discovered this contact. Keep the suppression anyway.
    await tx.contact.upsert({ where: { sessionId_whatsappId: { sessionId, whatsappId: from } },
      create: { sessionId, whatsappId: from, phone: from.split("@")[0], ...data }, update: data });
    await tx.contact.updateMany({ where: { whatsappId: from }, data });
  });
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

// Quoted responses are exact matches. Unquoted responses are attributed to the
// latest campaign message to that destination from this account within 30 days.
export async function recordReply(input: {
  sessionId: string; from: string; messageId: string; body: string;
  quotedMessageId?: string; receivedAt?: Date; author?: string;
}) {
  if (!input.messageId || !input.body.trim() || !/(@c\.us|@g\.us)$/.test(input.from)) return null;
  const receivedAt = input.receivedAt || new Date();
  const group = input.from.endsWith("@g.us")
    ? await db.waGroup.findUnique({ where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId: input.from } } }) : null;
  const recipientKey = group ? "group:" + group.id : "contact:" + input.from;
  const scope = { run: { OR: [{ sessionIdSnapshot: input.sessionId }, { sessionIdSnapshot: null, campaign: { sessionId: input.sessionId } }] }, recipientKey };
  const quoted = input.quotedMessageId ? await db.delivery.findFirst({
    where: { ...scope, messageId: input.quotedMessageId },
  }) : null;
  // A quote of some unrelated message must never be counted as a campaign reply.
  const delivery = input.quotedMessageId ? quoted : await db.delivery.findFirst({
    where: { ...scope, sentAt: { lte: receivedAt, gte: new Date(receivedAt.getTime() - 30 * 86400000) } },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
  if (!delivery) return null;
  return db.campaignReply.upsert({ where: { messageId: input.messageId }, update: {}, create: {
    messageId: input.messageId, deliveryId: delivery.id, body: input.body.slice(0, 8000), receivedAt,
    attribution: quoted ? "QUOTED" : "LATEST_SEND", author: input.author, isOptOut: isOptOut(input.body),
  } });
}
