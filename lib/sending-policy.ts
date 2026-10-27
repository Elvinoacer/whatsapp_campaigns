import { z } from "zod";

// These are local workload controls, not published WhatsApp allowances or
// thresholds at which an unofficial transport becomes safe from enforcement.
const input = z.object({
  CAMPAIGN_MIN_INTERVAL_MS: z.coerce.number().int().min(1500).max(3600000).default(30000),
  CAMPAIGN_MAX_PER_15_MINUTES: z.coerce.number().int().min(1).max(100000).default(10),
  CAMPAIGN_MAX_PER_HOUR: z.coerce.number().int().min(1).max(100000).default(30),
  CAMPAIGN_MAX_PER_DAY: z.coerce.number().int().min(1).max(100000).default(100),
  CAMPAIGN_CONTACT_COOLDOWN_HOURS: z.coerce.number().min(0).max(8760).default(168),
  CAMPAIGN_START_HOUR: z.coerce.number().int().min(0).max(23).default(9),
  CAMPAIGN_END_HOUR: z.coerce.number().int().min(1).max(24).default(18),
  CAMPAIGN_TIMEZONE: z.string().default("Africa/Nairobi").refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Choose a valid sending timezone"),
  CAMPAIGN_BUSINESS_NAME: z.string().trim().max(80).default(""),
}).refine(value => value.CAMPAIGN_START_HOUR < value.CAMPAIGN_END_HOUR, "Sending hours must start before they end");

export function sendingPolicy(env: Record<string, string | undefined> = process.env) {
  const value = input.parse(env);
  return {
    minimumIntervalMs: value.CAMPAIGN_MIN_INTERVAL_MS,
    maxPer15Minutes: value.CAMPAIGN_MAX_PER_15_MINUTES,
    maxPerHour: value.CAMPAIGN_MAX_PER_HOUR,
    maxPerDay: value.CAMPAIGN_MAX_PER_DAY,
    contactCooldownMs: value.CAMPAIGN_CONTACT_COOLDOWN_HOURS * 3600000,
    startHour: value.CAMPAIGN_START_HOUR, endHour: value.CAMPAIGN_END_HOUR,
    timezone: value.CAMPAIGN_TIMEZONE, businessName: value.CAMPAIGN_BUSINESS_NAME,
  };
}
export type SendingPolicy = ReturnType<typeof sendingPolicy>;
export const HOUR = 3600000;
export const DAY = 24 * HOUR;

export function nextSendingWindow(now: Date, policy: SendingPolicy) {
  const format = new Intl.DateTimeFormat("en", { timeZone: policy.timezone, hour: "numeric", hourCycle: "h23" });
  const open = (date: Date) => { const hour = Number(format.format(date)); return hour >= policy.startHour && hour < policy.endHour; };
  if (open(now)) return now;
  // Minute-by-minute instants handle DST gaps/overlaps without inventing a
  // local time or relying on the machine's timezone.
  for (let time = Math.ceil(now.getTime() / 60000) * 60000; time <= now.getTime() + 2 * DAY; time += 60000) {
    const candidate = new Date(time);
    if (open(candidate)) return candidate;
  }
  throw new Error("Could not resolve the next permitted sending window");
}

export function nextBudgetSlot(attemptedAt: Date[], now: Date, policy: SendingPolicy, intervalMs = policy.minimumIntervalMs) {
  const times = attemptedAt.map(date => date.getTime()).sort((a, b) => b - a);
  let next = now.getTime();
  if (times.length) next = Math.max(next, times[0] + Math.max(intervalMs, policy.minimumIntervalMs));
  for (const [window, limit] of [[15 * 60000, policy.maxPer15Minutes], [HOUR, policy.maxPerHour], [DAY, policy.maxPerDay]]) {
    const recent = times.filter(time => time > now.getTime() - window);
    if (recent.length >= limit) next = Math.max(next, recent[limit - 1] + window);
  }
  return nextSendingWindow(new Date(next), policy);
}

export function minimumCampaignDuration(count: number, intervalMs: number, policy: SendingPolicy) {
  if (!count) return 0;
  return Math.max(count * Math.max(intervalMs, policy.minimumIntervalMs),
    Math.floor((count - 1) / policy.maxPer15Minutes) * 15 * 60000 + intervalMs,
    Math.floor((count - 1) / policy.maxPerHour) * HOUR + intervalMs,
    Math.floor((count - 1) / policy.maxPerDay) * DAY + intervalMs);
}

export function restrictionSignal(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:\b(?:SMB_)?TOS_BLOCK\b|\bTEMP(?:ORARY)?_BAN\b|\b(?:restricted|restriction|banned|spam|rate.?limit|too many requests)\b|\b429\b)/i.test(text);
}

export function qualityIssue(attempts: { outcome: string; optedOutAt: Date | null }[]) {
  const bad = (status: string) => ["FAILED", "UNKNOWN"].includes(status);
  if (attempts.length >= 3 && attempts.slice(0, 3).every(item => bad(item.outcome)))
    return "Three consecutive sends failed or have no confirmed receipt. Review the account and transport before continuing.";
  const sample = attempts.slice(0, 20);
  if (sample.length >= 10 && sample.filter(item => bad(item.outcome)).length / sample.length >= 0.2)
    return "At least 20% of the latest send attempts failed or remain unconfirmed. Review delivery problems before continuing.";
  const optOuts = attempts.filter(item => item.optedOutAt).length;
  if (optOuts >= 3 && optOuts / attempts.length >= 0.05)
    return "Recent recipients are opting out (at least three and 5% of attempts). Review permission, relevance and frequency before continuing.";
  return null;
}
