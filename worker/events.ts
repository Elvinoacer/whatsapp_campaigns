import { db } from "../lib/db";
import { isOptOut } from "../lib/campaign";
import { isDirectWhatsAppId } from "../lib/whatsapp-id";
import { accountKey, evaluateSendingQuality } from "../lib/sending-safety";
import { DAY } from "../lib/sending-policy";
import { receiptMatch } from "./receipt-identity";

export async function recordOptOut(sessionId: string, from: string, body: string, aliases: string[] = [], receivedAt?: Date) {
  if (!isDirectWhatsAppId(from) || !isOptOut(body)) return false;
  const baseIds = [...new Set([from, ...aliases.filter(isDirectWhatsAppId)])];
  const phones = baseIds.filter(id => id.endsWith("@c.us")).map(id => id.split("@")[0]);
  const linkedByPhone = phones.length
    ? (await db.contact?.findMany({ where: { phone: { in: phones } }, select: { whatsappId: true } }).catch(() => [])) ?? []
    : [];
  const ids = [...new Set([...baseIds, ...linkedByPhone.map(item => item.whatsappId).filter(isDirectWhatsAppId)])];
  const data = { consent: "OPTED_OUT" as const, consentNote: "Inbound STOP/unsubscribe", consentAt: null };
  let suppressed = false;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    // A recovered old STOP must not override a later renewed opt-in on any account.
    if (
      receivedAt &&
      (await tx.contact.findFirst({
        where: { whatsappId: { in: ids }, consent: "OPTED_IN", consentAt: { gt: receivedAt } },
        select: { id: true },
      }))
    ) {
      return;
    }
    suppressed = true;
    for (const id of ids) {
      await tx.contact.upsert({
        where: { sessionId_whatsappId: { sessionId, whatsappId: id } },
        create: { sessionId, whatsappId: id, phone: id.endsWith("@c.us") ? id.split("@")[0] : null, ...data },
        update: data,
      });
    }
    await tx.contact.updateMany({ where: { whatsappId: { in: ids } }, data });
  });
  if (!suppressed) return true;
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (session) {
    const key = accountKey(session);
    const eventTime = receivedAt || new Date();
    // Allow 60s upper tolerance for WhatsApp whole-second timestamp flooring,
    // and attribute opt-outs up to 30 days after the campaign send.
    const latest = await db.sendAttempt.findFirst({
      where: {
        accountKey: key,
        recipientKeys: { hasSome: ids.map(id => "contact:" + id) },
        attemptedAt: {
          gte: new Date(eventTime.getTime() - 30 * DAY),
          lte: new Date(eventTime.getTime() + 60_000),
        },
      },
      orderBy: { attemptedAt: "desc" },
    });
    if (latest) {
      await db.sendAttempt.update({ where: { id: latest.id }, data: { optedOutAt: eventTime } });
    }
    await evaluateSendingQuality(key);
  }
  return true;
}

export async function recordAcknowledgement(
  messageId: string,
  ack: number,
  context: { sessionId?: string; receivedAt?: Date } = {},
) {
  const status = ack >= 3
    ? "READ"
    : ack >= 2
      ? "DELIVERED"
      : ack >= 1
        ? "SENT"
        : ack === -1
          ? "FAILED"
          : ack === 0
            ? "SENDING"
            : null;
  if (!status) return;
  const matches = receiptMatch(messageId, !!context.sessionId);
  const attempts = await db.sendAttempt.findMany({
    where: { OR: matches, ...(context.sessionId ? { sessionId: context.sessionId } : {}) },
    select: { deliveryId: true, accountKey: true },
  });
  const where = {
    OR: [...matches, { id: { in: attempts.map(item => item.deliveryId) } }],
    ...(context.sessionId
      ? {
        run: {
          OR: [
            { sessionIdSnapshot: context.sessionId },
            { sessionIdSnapshot: null, campaign: { sessionId: context.sessionId } },
          ],
        },
      }
      : {}),
  };
  const prior = status === "SENDING"
    ? (["SENDING", "UNKNOWN"] as const)
    : status === "FAILED"
      ? (["SENDING", "UNKNOWN", "FAILED"] as const)
      : status === "SENT"
        ? (["SENDING", "UNKNOWN", "FAILED", "SENT"] as const)
        : status === "DELIVERED"
          ? (["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED"] as const)
          : (["SENDING", "UNKNOWN", "FAILED", "SENT", "DELIVERED", "READ"] as const);
  await db.delivery.updateMany({
    where: { ...where, status: { in: [...prior] } },
    data: { status, messageId, error: status === "FAILED" ? "WhatsApp reported a send failure." : null },
  });
  if (!["FAILED", "SENDING"].includes(status)) {
    await db.delivery.updateMany({
      where: { ...where, status, sentAt: null },
      data: { sentAt: context.receivedAt || new Date() },
    });
  }
  await db.sendAttempt.updateMany({
    where: { OR: matches, ...(context.sessionId ? { sessionId: context.sessionId } : {}), outcome: { in: [...prior] } },
    data: { outcome: status, messageId },
  });
  if (status === "FAILED") {
    for (const key of new Set(attempts.map(item => item.accountKey))) {
      await evaluateSendingQuality(key);
    }
  }
}

export async function recordReply(input: {
  sessionId: string;
  from: string;
  messageId: string;
  body: string;
  hasMedia?: boolean;
  quotedMessageId?: string;
  receivedAt?: Date;
  author?: string;
  contactIds?: string[];
}) {
  if (
    !input.messageId ||
    (!input.body.trim() && !input.hasMedia) ||
    !(isDirectWhatsAppId(input.from) || input.from.endsWith("@g.us"))
  ) {
    return null;
  }
  const receivedAt = input.receivedAt || new Date();
  const group = input.from.endsWith("@g.us")
    ? await db.waGroup.findUnique({ where: { sessionId_whatsappId: { sessionId: input.sessionId, whatsappId: input.from } } })
    : null;
  if (input.from.endsWith("@g.us") && !group) return null;
  const rawAliases = [...new Set([input.from, ...(input.contactIds || []).filter(isDirectWhatsAppId)])];
  const phones = rawAliases.filter(id => id.endsWith("@c.us")).map(id => id.split("@")[0]);
  const legacyContacts = group
    ? []
    : await db.contact.findMany({
      where: {
        OR: [
          { whatsappId: { in: rawAliases } },
          { id: { in: rawAliases } },
          ...(phones.length ? [{ phone: { in: phones } }] : []),
        ],
      },
      select: { id: true, whatsappId: true, phone: true },
    });
  const extraPhones = [...new Set(legacyContacts.map(item => item.phone).filter((p): p is string => Boolean(p)))];
  const aliases = [
    ...new Set([
      ...rawAliases,
      ...legacyContacts.map(item => item.whatsappId).filter(isDirectWhatsAppId),
      ...extraPhones.map(phone => phone + "@c.us"),
    ]),
  ];
  const recipientKey = group
    ? "group:" + group.id
    : {
      in: [...new Set([...aliases.map(id => "contact:" + id), ...legacyContacts.map(item => "contact:" + item.id)])],
    };
  const scope = {
    run: {
      OR: [
        { sessionIdSnapshot: input.sessionId },
        { sessionIdSnapshot: null, campaign: { sessionId: input.sessionId } },
      ],
    },
    recipientKey,
  };
  const quoted = input.quotedMessageId
    ? await db.delivery.findFirst({
      where: { ...scope, OR: receiptMatch(input.quotedMessageId, true) },
    })
    : null;
  // Tolerance of +60s handles WhatsApp's whole-second timestamp flooring when a
  // recipient replies within the same second or while local clock milliseconds differ.
  const upperBound = new Date(receivedAt.getTime() + 60_000);
  const lowerBound = new Date(receivedAt.getTime() - 30 * 86400000);
  const delivery = input.quotedMessageId
    ? quoted
    : await db.delivery.findFirst({
      where: {
        ...scope,
        OR: [
          { sentAt: { lte: upperBound, gte: lowerBound } },
          {
            sentAt: null,
            status: { in: ["SENDING", "SENT", "DELIVERED", "READ", "UNKNOWN"] },
            updatedAt: { lte: upperBound, gte: lowerBound },
          },
        ],
      },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    });
  if (!delivery) return null;
  return db.campaignReply.upsert({
    where: { messageId: input.messageId },
    update: {},
    create: {
      messageId: input.messageId,
      deliveryId: delivery.id,
      body: input.body.slice(0, 8000),
      receivedAt,
      attribution: quoted ? "QUOTED" : "LATEST_SEND",
      author: input.author,
      isOptOut: isOptOut(input.body),
    },
  });
}
