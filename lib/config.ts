import { z } from "zod";
import { sendingPolicy } from "./sending-policy";

const settings = z.object({
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:/.test(value), "Use a PostgreSQL URL"),
  REDIS_URL: z.string().url().refine(value => /^rediss?:/.test(value), "Use a Redis URL"),
  AUTH_SECRET: z.string().min(32).refine(value => !/REPLACE|CHANGEME/i.test(value), "Run npm run setup to generate AUTH_SECRET"),
  MAX_CAMPAIGN_RECIPIENTS: z.coerce.number().int().min(1).max(100000).default(25000),
  SEND_INTERVAL_MS: z.coerce.number().int().min(1500).default(3000),
});
export function configuration() {
  sendingPolicy();
  const parsed = settings.safeParse(process.env);
  if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
  return parsed.data;
}
export function campaignLimit() { return configuration().MAX_CAMPAIGN_RECIPIENTS; }
