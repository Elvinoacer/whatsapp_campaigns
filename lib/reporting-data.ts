import { Prisma } from "@prisma/client";
import { db } from "./db";
import { deliveryTotals, type DeliveryTotals } from "./reporting";

// Aggregate in Postgres so polling does not load every historical delivery.
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
      count(*) FILTER (WHERE replies.optouts > 0) AS "optedOut"
    FROM "Delivery" d
    JOIN "CampaignRun" r ON r.id = d."runId"
    LEFT JOIN (SELECT "deliveryId", count(*) AS n, count(*) FILTER (WHERE "isOptOut") AS optouts FROM "CampaignReply" GROUP BY "deliveryId") replies
      ON replies."deliveryId" = d.id
    ${ids ? Prisma.sql`WHERE ${scope} IN (${Prisma.join(ids)})` : Prisma.empty}
    GROUP BY ${scope}
  `);
  return new Map(rows.map(row => [row.scopeId, Object.fromEntries(
    Object.keys(deliveryTotals([])).map(key => [key, Number(row[key as keyof DeliveryTotals])]),
  ) as DeliveryTotals]));
}

export const campaignDeliverySummaries = (campaignIds?: string[]) => deliverySummaries(campaignIds, false);
export const runDeliverySummaries = (runIds: string[]) => deliverySummaries(runIds, true);

export function combineDeliverySummaries(summaries: Iterable<DeliveryTotals>) {
  const total = deliveryTotals([]);
  for (const summary of summaries) for (const key of Object.keys(total) as (keyof DeliveryTotals)[]) total[key] += summary[key];
  return total;
}
