import { db } from "../lib/db";
import { isOptOut } from "../lib/campaign";
import { isDirectWhatsAppId } from "../lib/whatsapp-id";
import { accountKey, evaluateSendingQuality } from "../lib/sending-safety";
import { DAY } from "../lib/sending-policy";

export async function recordOptOut(sessionId: string, from: string, body: string, aliases: string[] = []) {
  if (!isDirectWhatsAppId(from) || !isOptOut(body)) return false;
  const ids = [...new Set([from, ...aliases.filter(isDirectWhatsAppId)])];
  const data = { consent: "OPTED_OUT" as const, consentNote: "Inbound STOP/unsubscribe", consentAt: null };
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    // The sender may not have discovered this contact. Keep the suppression anyway.
    for (const id of ids) await tx.contact.upsert({ where: { sessionId_whatsappId: { sessionId, whatsappId: id } },
      create: { sessionId, whatsappId: id, phone: id.endsWith("@c.us") ? id.split("@")[0] : null, ...data }, update: data });
    await tx.contact.updateMany({ where: { whatsappId: { in: ids } }, data });
  });
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (session) {
    const key = accountKey(session);
    const latest = await db.sendAttempt.findFirst({ where: { accountKey: key, recipientKeys: { hasSome: ids.map(id => "contact:" + id) },
      attemptedAt: { gte: new Date(Date.now() - DAY) } }, orderBy: { attemptedAt: "desc" } });
    if (latest) await db.sendAttempt.update({ where: { id: latest.id }, data: { optedOutAt: new Date() } });
    await evaluateSendingQuality(key);
  }
  return true;
}

export async function recordAcknowledgement(messageId: string, ack: number) {
  const status = ack >= 3 ? "READ" : ack >= 2 ? "DELIVERED" : ack >= 1 ? "SENT" : ack === -1 ? "FAILED" : null;
  if (!status) return;
  // Update conditionally so a delayed acknowledgement cannot downgrade a read receipt.
  const prior = status === "SENT" || status === "FAILED" ? ["SENDING", "UNKNOWN", "FAILED", "SENT"] as const
    : status === "DELIVERED" ? ["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED"] as const
    : ["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED", "READ"] as const;
  await db.delivery.updateMany({ where: { messageId, status: { in: [...prior] } },
    data: { status, error: status === "FAILED" ? "WhatsApp reported a send failure." : null } });
  if (status !== "FAILED") await db.delivery.updateMany({ where: { messageId, status, sentAt: null }, data: { sentAt: new Date() } });
  await db.sendAttempt.updateMany({ where: { messageId, outcome: { in: [...prior] } }, data: { outcome: status } });
  if (status === "FAILED") {
    const attempts = await db.sendAttempt.findMany({ where: { messageId }, select: { accountKey: true }, distinct: ["accountKey"] });
    for (const item of attempts) await evaluateSendingQuality(item.accountKey);
  }
}

// Quoted responses are exact matches. Unquoted responses are attributed to the
// latest campaign message to that destination from this account within 30 days.
export async function recordReply(input: {
  sessionId: string; from: string; messageId: string; body: string;
  quotedMessageId?: string; receivedAt?: Date; author?: string; contactIds?: string[];
}) {
  if (!input.messageId || !input.body.trim() || !(isDirectWhatsAppId(input.from) || input.from.endsWith("@g.us"))) return null;
  const receivedAt = input.receivedAt || new Date();
  const group = input.from.endsWith("@g.us")
    ? await db.waGroup.findUnique({ where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId: input.from } } }) : null;
  const recipientKey = group ? "group:" + group.id : { in: [...new Set([input.from, ...(input.contactIds || []).filter(isDirectWhatsAppId)])].map(id => "contact:" + id) };
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
