import { Queue } from "bullmq";
import IORedis from "ioredis";

export const queueName = "campaign-operations";
export function redisConnection() {
  return new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });
}
const globalQueues = globalThis as unknown as { operations?: Queue };
export const operations = globalQueues.operations ?? new Queue(queueName, {
  connection: redisConnection(),
  defaultJobOptions: { removeOnComplete: 300, removeOnFail: 300, attempts: 1 },
});
if (process.env.NODE_ENV !== "production") globalQueues.operations = operations;
export async function command(name: string, data: Record<string, string>) {
  return operations.add(name, data);
}
export async function scheduleCampaign(campaign: { id: string; scheduleType: string; scheduledAt: Date | null; cron: string | null; timezone: string }) {
  if (campaign.scheduleType === "CRON" && campaign.cron) {
    await operations.upsertJobScheduler("campaign:" + campaign.id,
      { pattern: campaign.cron, tz: campaign.timezone },
      { name: "run-campaign", data: { campaignId: campaign.id }, opts: { attempts: 1 } });
  } else {
    const delay = campaign.scheduleType === "ONCE" && campaign.scheduledAt
      ? Math.max(0, campaign.scheduledAt.getTime() - Date.now()) : 0;
    await operations.add("run-campaign", { campaignId: campaign.id }, { delay, jobId: "campaign:" + campaign.id });
  }
}
export async function removeSchedule(id: string) {
  await operations.removeJobScheduler("campaign:" + id);
  const oneOff = await operations.getJob("campaign:" + id);
  if (oneOff) {
    try { await oneOff.remove(); } catch { /* active job checks campaign state before sending */ }
  }
}
