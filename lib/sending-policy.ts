import { z } from "zod";

const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

// Local workload and operating-hour controls. Configurable live in Settings -> Sending Rules.
const input = z.object({
  CAMPAIGN_MIN_INTERVAL_MS: z.coerce.number().int().min(1500).max(3600000).default(15000),
  CAMPAIGN_JITTER_MS: z.coerce.number().int().min(0).max(120000).default(3000),
  CAMPAIGN_MAX_PER_15_MINUTES: z.coerce.number().int().min(1).max(100000).default(10),
  CAMPAIGN_MAX_PER_HOUR: z.coerce.number().int().min(1).max(100000).default(35),
  CAMPAIGN_MAX_PER_DAY: z.coerce.number().int().min(1).max(100000).default(250),
  CAMPAIGN_CONTACT_COOLDOWN_HOURS: z.coerce.number().min(0).max(8760).default(0),
  CAMPAIGN_ALWAYS_OPEN: z.enum(["true", "false"]).optional(),
  CAMPAIGN_START_HOUR: z.coerce.number().int().min(0).max(23).default(0),
  CAMPAIGN_END_HOUR: z.coerce.number().int().min(1).max(24).default(24),
  CAMPAIGN_ACTIVE_DAYS: z.string().optional(),
  CAMPAIGN_TIMEZONE: z.string().default("Africa/Nairobi").refine(validTimezone, "Choose a valid sending timezone"),
  CAMPAIGN_BUSINESS_NAME: z.string().trim().max(80).default(""),
  CAMPAIGN_AUTO_HOLD_ON_QUALITY: z.enum(["true", "false"]).default("false"),
}).refine(value => value.CAMPAIGN_START_HOUR !== value.CAMPAIGN_END_HOUR, "Sending start and end hour cannot be identical");

export const sendingSettingsInput = z.object({
  alwaysOpen: z.boolean().default(true),
  startHour: z.number().int().min(0).max(23).default(0),
  endHour: z.number().int().min(1).max(24).default(24),
  activeDays: z.array(z.number().int().min(0).max(6)).min(1, "Select at least one active day").max(7).default([0, 1, 2, 3, 4, 5, 6]),
  timezone: z.string().trim().min(1).max(80).default("Africa/Nairobi").refine(validTimezone, "Choose a valid sending timezone"),
  minimumIntervalMs: z.number().int().min(1500).max(3600000).default(15000),
  jitterMs: z.number().int().min(0).max(120000).default(3000),
  maxPer15Minutes: z.number().int().min(1).max(100000).default(10),
  maxPerHour: z.number().int().min(1).max(100000).default(35),
  maxPerDay: z.number().int().min(1).max(100000).default(250),
  contactCooldownHours: z.number().min(0).max(8760).default(0),
  autoHoldOnQuality: z.boolean().default(false),
  businessName: z.preprocess(
    val => (typeof val === "string" ? val.trim() : ""),
    z.string().max(80)
  ).default(""),
}).refine(value => value.alwaysOpen || value.startHour !== value.endHour, {
  message: "Start hour and end hour cannot be identical when custom operating hours are enabled",
  path: ["endHour"],
});
export type SendingSettingsUpdate = z.infer<typeof sendingSettingsInput>;

export type SendingPolicy = {
  minimumIntervalMs: number;
  jitterMs: number;
  maxPer15Minutes: number;
  maxPerHour: number;
  maxPerDay: number;
  contactCooldownMs: number;
  alwaysOpen: boolean;
  startHour: number;
  endHour: number;
  activeDays: number[];
  timezone: string;
  businessName: string;
  autoHoldOnQuality: boolean;
};

export function sendingPolicy(env: Record<string, string | undefined> = process.env): SendingPolicy {
  const value = input.parse(env);
  const parsedDays = value.CAMPAIGN_ACTIVE_DAYS
    ? [...new Set(
        value.CAMPAIGN_ACTIVE_DAYS
          .split(",")
          .map(part => Number(part.trim()))
          .filter(day => Number.isInteger(day) && day >= 0 && day <= 6),
      )].sort((a, b) => a - b)
    : [0, 1, 2, 3, 4, 5, 6];
  const activeDays = parsedDays.length ? parsedDays : [0, 1, 2, 3, 4, 5, 6];
  const alwaysOpen = value.CAMPAIGN_ALWAYS_OPEN
    ? value.CAMPAIGN_ALWAYS_OPEN === "true"
    : value.CAMPAIGN_START_HOUR === 0 && value.CAMPAIGN_END_HOUR === 24 && activeDays.length === 7;
  return {
    minimumIntervalMs: value.CAMPAIGN_MIN_INTERVAL_MS,
    jitterMs: value.CAMPAIGN_JITTER_MS,
    maxPer15Minutes: value.CAMPAIGN_MAX_PER_15_MINUTES,
    maxPerHour: value.CAMPAIGN_MAX_PER_HOUR,
    maxPerDay: value.CAMPAIGN_MAX_PER_DAY,
    contactCooldownMs: value.CAMPAIGN_CONTACT_COOLDOWN_HOURS * 3600000,
    alwaysOpen,
    startHour: value.CAMPAIGN_START_HOUR,
    endHour: value.CAMPAIGN_END_HOUR,
    activeDays,
    timezone: value.CAMPAIGN_TIMEZONE,
    businessName: value.CAMPAIGN_BUSINESS_NAME,
    autoHoldOnQuality: value.CAMPAIGN_AUTO_HOLD_ON_QUALITY === "true",
  };
}

export const HOUR = 3600000;
export const DAY = 24 * HOUR;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nextSendingWindow(now: Date, policy: Pick<SendingPolicy, "timezone" | "startHour" | "endHour"> & Partial<Pick<SendingPolicy, "alwaysOpen" | "activeDays">>) {
  const days = policy.activeDays?.length ? new Set(policy.activeDays) : new Set([0, 1, 2, 3, 4, 5, 6]);
  if (policy.alwaysOpen || (policy.startHour === 0 && policy.endHour === 24 && days.size === 7)) {
    return now;
  }
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: policy.timezone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const open = (date: Date) => {
    const parts = format.formatToParts(date);
    const weekday = WEEKDAYS[parts.find(part => part.type === "weekday")?.value || "Sun"] ?? 0;
    const hour = Number(parts.find(part => part.type === "hour")?.value || 0);
    if (policy.startHour < policy.endHour) {
      return days.has(weekday) && hour >= policy.startHour && hour < policy.endHour;
    }
    // Overnight window, e.g. 20:00 -> 06:00 across midnight.
    if (hour >= policy.startHour) return days.has(weekday);
    if (hour < policy.endHour) return days.has((weekday + 6) % 7);
    return false;
  };
  if (open(now)) return now;
  const startMinute = Math.ceil(now.getTime() / 60000) * 60000;
  const horizon = now.getTime() + 8 * DAY;
  // Coarse 15-minute scan followed by 1-minute refinement keeps multi-day
  // active-day windows sub-millisecond while preserving exact DST boundaries.
  for (let coarse = startMinute; coarse <= horizon; coarse += 15 * 60000) {
    if (open(new Date(coarse))) {
      const fineStart = Math.max(startMinute, coarse - 15 * 60000);
      for (let exact = fineStart; exact <= coarse; exact += 60000) {
        const candidate = new Date(exact);
        if (open(candidate)) return candidate;
      }
      return new Date(coarse);
    }
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
  return Math.max(
    count * Math.max(intervalMs, policy.minimumIntervalMs),
    Math.floor((count - 1) / policy.maxPer15Minutes) * 15 * 60000 + intervalMs,
    Math.floor((count - 1) / policy.maxPerHour) * HOUR + intervalMs,
    Math.floor((count - 1) / policy.maxPerDay) * DAY + intervalMs,
  );
}

export function restrictionSignal(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:\b(?:SMB_)?TOS_BLOCK\b|\bTEMP(?:ORARY)?_BAN\b|\b(?:restricted|restriction|banned|spam|rate.?limit|too many requests)\b|\b429\b)/i.test(text);
}

export type QualitySignal = { kind: "TRANSPORT" | "CONSENT"; reason: string };
export const TRANSPORT_RECOVERY_MS = 15 * 60_000;
export const MAX_TRANSPORT_RECOVERIES = 1;

export function qualitySignal(attempts: { outcome: string; optedOutAt: Date | null }[]): QualitySignal | null {
  const optOuts = attempts.filter(item => item.optedOutAt).length;
  if (optOuts >= 3 && optOuts / attempts.length >= 0.05)
    return { kind: "CONSENT", reason: "Recent recipients are opting out (at least three and 5% of attempts). Review permission, relevance and frequency before continuing." };
  const bad = (status: string) => ["FAILED", "UNKNOWN"].includes(status);
  if (attempts.length >= 3 && attempts.slice(0, 3).every(item => bad(item.outcome)))
    return { kind: "TRANSPORT", reason: "Three consecutive sends failed or have no confirmed receipt." };
  const sample = attempts.slice(0, 20);
  if (sample.length >= 10 && sample.filter(item => bad(item.outcome)).length / sample.length >= 0.2)
    return { kind: "TRANSPORT", reason: "At least 20% of the latest send attempts failed or remain unconfirmed." };
  return null;
}

export function qualityIssue(attempts: { outcome: string; optedOutAt: Date | null }[]) {
  return qualitySignal(attempts)?.reason || null;
}
