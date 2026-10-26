import { Queue } from "bullmq";
import IORedis from "ioredis";
import { randomUUID } from "node:crypto";

export const queueName = process.env.QUEUE_NAME || "campaign-operations";
export const campaignQueueName = queueName + "-delivery";
export function redisConnection(worker = false) {
  const client = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:56379", {
    maxRetriesPerRequest: worker ? null : 1,
    connectTimeout: 5000,
    ...(worker ? {} : { commandTimeout: 5000 }),
  });
  client.on("error", error => console.error("Redis connection error:", error.message));
  return client;
}
const globalQueues = globalThis as unknown as { operations?: Queue; campaigns?: Queue };
function queue(name: string) {
  const url = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:56379");
  const instance = new Queue(name, {
    connection: { host: url.hostname, port: Number(url.port || 6379), db: Number(url.pathname.slice(1) || 0),
      username: url.username ? decodeURIComponent(url.username) : undefined, password: url.password ? decodeURIComponent(url.password) : undefined,
      ...(url.protocol === "rediss:" ? { tls: {} } : {}), maxRetriesPerRequest: 1, connectTimeout: 5000, commandTimeout: 5000 },
    defaultJobOptions: { removeOnComplete: 300, removeOnFail: 300, attempts: 1 },
  });
  instance.on("error", error => console.error("Queue error:", error.message));
  return instance;
}
export const operations = globalQueues.operations ??= queue(queueName);
export const campaigns = globalQueues.campaigns ??= queue(campaignQueueName);
export async function command(name: string, data: Record<string, unknown>) {
  return operations.add(name, data);
}
export async function scheduleCampaign(campaign: { id: string; scheduleType: string; scheduledAt: Date | null; cron: string | null; timezone: string; updatedAt: Date }) {
  const data = { campaignId: campaign.id, revision: campaign.updatedAt.toISOString() };
  if (campaign.scheduleType === "CRON" && campaign.cron) {
    await campaigns.upsertJobScheduler("campaign:" + campaign.id,
      { pattern: campaign.cron, tz: campaign.timezone },
      { name: "run-campaign", data, opts: { attempts: 1 } });
  } else {
    const delay = campaign.scheduleType === "ONCE" && campaign.scheduledAt
      ? Math.max(0, campaign.scheduledAt.getTime() - Date.now()) : 0;
    const job = await campaigns.add("run-campaign", data, { delay, jobId: "campaign-" + campaign.id + "-" + randomUUID() });
    const redis = await campaigns.client;
    await redis.set(queueName + ":campaign-job:" + campaign.id, job.id!);
  }
}
export async function removeSchedule(id: string) {
  await campaigns.removeJobScheduler("campaign:" + id);
  const redis = await campaigns.client;
  const jobId = await redis.get(queueName + ":campaign-job:" + id);
  const oneOff = jobId ? await campaigns.getJob(jobId) : null;
  if (oneOff) {
    try { await oneOff.remove(); } catch { /* active job checks campaign state before sending */ }
  }
  await redis.del(queueName + ":campaign-job:" + id);
  // Remove schedules created by older versions of this application too.
  await operations.removeJobScheduler("campaign:" + id);
  const legacy = await operations.getJob("campaign-" + id);
  if (legacy) { try { await legacy.remove(); } catch { /* active jobs recheck campaign state */ } }
}
