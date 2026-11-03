import { Prisma } from "@prisma/client";
import { db } from "./db";
import { deliveryRates, deliveryTotals, type DeliveryTotals } from "./reporting";

export type EnrichedDeliverySummary = DeliveryTotals & {
  queued: number;
  sending: number;
  uniqueRecipients: number;
  groupDispatches: number;
  directDispatches: number;
};

async function deliverySummaries(ids: string[] | undefined, byRun: boolean) {
  if (ids && !ids.length) return new Map<string, DeliveryTotals>();
  const scope = byRun ? Prisma.sql`r.id` : Prisma.sql`r."campaignId"`;
  const rows = await db.$queryRaw<({ scopeId: string } & Record<keyof DeliveryTotals, bigint>)[]>(Prisma.sql`
    SELECT ${scope} AS "scopeId",
      count(*) AS total,
      count(*) FILTER (WHERE d.status IN ('QUEUED', 'SENDING')) AS pending,
      count(*) FILTER (WHERE d.status IN ('SENT', 'DELIVERED', 'READ')) AS sent,
      count(*) FILTER (WHERE d.status IN ('DELIVERED', 'READ')) AS delivered,
      count(*) FILTER (WHERE d.status = 'READ') AS read,
      count(*) FILTER (WHERE d.status = 'FAILED') AS failed,
      count(*) FILTER (WHERE d.status = 'UNKNOWN') AS uncertain,
      count(*) FILTER (WHERE d.status = 'SKIPPED') AS skipped,
      coalesce(sum(replies.n), 0)::bigint AS replies,
      count(*) FILTER (WHERE replies.n > 0) AS replied,
      count(*) FILTER (WHERE replies.optouts > 0 OR attempt."optedOutAt" IS NOT NULL) AS "optedOut"
    FROM "Delivery" d
    JOIN "CampaignRun" r ON r.id = d."runId"
    LEFT JOIN "SendAttempt" attempt ON attempt."deliveryId" = d.id
    LEFT JOIN (
      SELECT "deliveryId", count(*) AS n, count(*) FILTER (WHERE "isOptOut") AS optouts
      FROM "CampaignReply"
      GROUP BY "deliveryId"
    ) replies ON replies."deliveryId" = d.id
    ${ids ? Prisma.sql`WHERE ${scope} IN (${Prisma.join(ids)})` : Prisma.empty}
    GROUP BY ${scope}
  `);
  return new Map(
    rows.map(row => [
      row.scopeId,
      Object.fromEntries(
        Object.keys(deliveryTotals([])).map(key => [key, Number(row[key as keyof DeliveryTotals])]),
      ) as DeliveryTotals,
    ]),
  );
}

export const campaignDeliverySummaries = (campaignIds?: string[]) => deliverySummaries(campaignIds, false);
export const runDeliverySummaries = (runIds: string[]) => deliverySummaries(runIds, true);

export function combineDeliverySummaries(summaries: Iterable<DeliveryTotals>) {
  const total = deliveryTotals([]);
  for (const summary of summaries) {
    for (const key of Object.keys(total) as (keyof DeliveryTotals)[]) {
      total[key] += summary[key];
    }
  }
  return total;
}

export async function workspaceReportSummary() {
  const [deliveryRow, contactRow, campaignCounts] = await Promise.all([
    db.$queryRaw<{
      total: bigint;
      queued: bigint;
      sending: bigint;
      pending: bigint;
      sent: bigint;
      delivered: bigint;
      read: bigint;
      failed: bigint;
      uncertain: bigint;
      skipped: bigint;
      replies: bigint;
      replied: bigint;
      optedOut: bigint;
      uniqueRecipientsSent: bigint;
      uniqueContactsSent: bigint;
      uniqueGroupsSent: bigint;
    }[]>(Prisma.sql`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE d.status = 'QUEUED') AS queued,
        count(*) FILTER (WHERE d.status = 'SENDING') AS sending,
        count(*) FILTER (WHERE d.status IN ('QUEUED', 'SENDING')) AS pending,
        count(*) FILTER (WHERE d.status IN ('SENT', 'DELIVERED', 'READ')) AS sent,
        count(*) FILTER (WHERE d.status IN ('DELIVERED', 'READ')) AS delivered,
        count(*) FILTER (WHERE d.status = 'READ') AS read,
        count(*) FILTER (WHERE d.status = 'FAILED') AS failed,
        count(*) FILTER (WHERE d.status = 'UNKNOWN') AS uncertain,
        count(*) FILTER (WHERE d.status = 'SKIPPED') AS skipped,
        coalesce(sum(replies.n), 0)::bigint AS replies,
        count(*) FILTER (WHERE replies.n > 0) AS replied,
        count(*) FILTER (WHERE replies.optouts > 0 OR attempt."optedOutAt" IS NOT NULL) AS "optedOut",
        count(DISTINCT d."recipientKey") FILTER (WHERE d.status IN ('SENT', 'DELIVERED', 'READ')) AS "uniqueRecipientsSent",
        count(DISTINCT d."recipientKey") FILTER (WHERE d.status IN ('SENT', 'DELIVERED', 'READ') AND d."recipientKey" LIKE 'contact:%') AS "uniqueContactsSent",
        count(DISTINCT d."recipientKey") FILTER (WHERE d.status IN ('SENT', 'DELIVERED', 'READ') AND d."recipientKey" LIKE 'group:%') AS "uniqueGroupsSent"
      FROM "Delivery" d
      LEFT JOIN "SendAttempt" attempt ON attempt."deliveryId" = d.id
      LEFT JOIN (
        SELECT "deliveryId", count(*) AS n, count(*) FILTER (WHERE "isOptOut") AS optouts
        FROM "CampaignReply"
        GROUP BY "deliveryId"
      ) replies ON replies."deliveryId" = d.id
    `),
    db.$queryRaw<{
      uniquePeople: bigint;
      optedOutPeople: bigint;
    }[]>(Prisma.sql`
      SELECT
        count(DISTINCT "whatsappId") AS "uniquePeople",
        count(DISTINCT "whatsappId") FILTER (WHERE consent = 'OPTED_OUT') AS "optedOutPeople"
      FROM "Contact"
    `),
    db.campaign.groupBy({ by: ["status"], _count: true }),
  ]);
  const d = deliveryRow[0];
  const c = contactRow[0];
  const base: DeliveryTotals = {
    total: Number(d?.total ?? 0),
    pending: Number(d?.pending ?? 0),
    sent: Number(d?.sent ?? 0),
    delivered: Number(d?.delivered ?? 0),
    read: Number(d?.read ?? 0),
    failed: Number(d?.failed ?? 0),
    uncertain: Number(d?.uncertain ?? 0),
    skipped: Number(d?.skipped ?? 0),
    replies: Number(d?.replies ?? 0),
    replied: Number(d?.replied ?? 0),
    optedOut: Number(d?.optedOut ?? 0),
  };
  const uniquePeople = Number(c?.uniquePeople ?? 0);
  const directoryOptedOut = Number(c?.optedOutPeople ?? 0);
  const statusMap = Object.fromEntries(campaignCounts.map(item => [item.status, item._count]));
  return {
    ...base,
    queued: Number(d?.queued ?? 0),
    sending: Number(d?.sending ?? 0),
    uniqueRecipientsSent: Number(d?.uniqueRecipientsSent ?? 0),
    uniqueContactsSent: Number(d?.uniqueContactsSent ?? 0),
    uniqueGroupsSent: Number(d?.uniqueGroupsSent ?? 0),
    uniquePeople,
    activePeople: Math.max(0, uniquePeople - directoryOptedOut),
    directoryOptedOut,
    rates: deliveryRates(base),
    campaignsByStatus: {
      active: statusMap.ACTIVE ?? 0,
      scheduled: statusMap.SCHEDULED ?? 0,
      paused: statusMap.PAUSED ?? 0,
      draft: statusMap.DRAFT ?? 0,
      completed: statusMap.COMPLETED ?? 0,
    },
  };
}

export async function recordedOptOutsForRuns(runIds: string[]) {
  if (!runIds.length) return new Map<string, Date>();
  const rows = await db.$queryRaw<{ deliveryId: string; optedOutAt: Date }[]>(Prisma.sql`
    SELECT a."deliveryId", a."optedOutAt" FROM "SendAttempt" a
    JOIN "Delivery" d ON d.id = a."deliveryId"
    WHERE d."runId" IN (${Prisma.join(runIds)}) AND a."optedOutAt" IS NOT NULL
  `);
  return new Map(rows.map(row => [row.deliveryId, row.optedOutAt]));
}
