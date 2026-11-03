import { z } from "zod";
import { parseExpression } from "cron-parser";
import { isDirectWhatsAppId } from "./whatsapp-id";

export const sessionInput = z.object({
  label: z.string().trim().min(2).max(80),
  publicSenderName: z.string().trim().max(80).refine(
    name => !name || (name.length >= 2 && !/[\r\n]/.test(name)),
    "Use a recognizable, single-line sender name (at least 2 characters)",
  ).optional(),
});

export const contactInput = z.object({
  consent: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]),
  consentNote: z.string().trim().max(500).optional(),
  reoptIn: z.boolean().optional(),
});

export const segmentInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(250).optional(),
});

const mediaFields = {
  mediaKey: z.string().regex(/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/).nullable().optional(),
  mediaMime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]).nullable().optional(),
  mediaName: z.string().max(140).nullable().optional(),
};

function validateMedia(value: { mediaKey?: string | null; mediaMime?: string | null }, ctx: z.RefinementCtx) {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  };
  if (
    Boolean(value.mediaKey) !== Boolean(value.mediaMime) ||
    (value.mediaKey && value.mediaMime && !value.mediaKey.endsWith("." + extensions[value.mediaMime]))
  ) {
    ctx.addIssue({ code: "custom", message: "Attachment type and file must match", path: ["mediaMime"] });
  }
}

export const templateInput = z.object({
  name: z.string().trim().min(2).max(80),
  category: z.string().trim().min(1).max(50).default("General"),
  audienceMode: z.enum(["ALL", "CONTACTS", "GROUPS"]).default("ALL"),
  body: z.string().trim().min(1).max(4096),
  includeFooter: z.boolean().default(false),
  ...mediaFields,
}).superRefine((value, ctx) => {
  validateMedia(value, ctx);
});

export const campaignInput = z.object({
  name: z.string().trim().min(2).max(100),
  message: z.string().trim().min(1).max(4096),
  ...mediaFields,
  sessionId: z.string().min(1),
  audienceType: z.enum(["CONTACTS", "GROUPS", "BOTH"]),
  contactIds: z.array(z.string()).max(50000).default([]),
  segmentIds: z.array(z.string()).max(500).default([]),
  groupIds: z.array(z.string()).max(500).default([]),
  scheduleType: z.enum(["NOW", "ONCE", "CRON"]).default("NOW"),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  cron: z.string().trim().max(100).nullable().optional(),
  intervalHours: z.number().int().min(1).max(720).nullable().optional(),
  runImmediately: z.boolean().default(true),
  repeatPolicy: z.enum(["ALLOW_REPEAT", "COOLDOWN", "NO_REPEAT"]).default("ALLOW_REPEAT"),
  repeatCooldownHours: z.number().min(0).max(8760).default(0),
  includeFooter: z.boolean().default(false),
  templateId: z.string().min(1).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default("Africa/Nairobi"),
  sendIntervalMs: z.number().int().min(1500).max(3600000).default(5000),
}).superRefine((value, ctx) => {
  if (value.audienceType === "CONTACTS" && !value.contactIds.length && !value.segmentIds.length && !value.groupIds.length) {
    ctx.addIssue({ code: "custom", message: "Select segments, contacts, or saved groups", path: ["contactIds"] });
  }
  if (value.audienceType === "GROUPS" && !value.groupIds.length) {
    ctx.addIssue({ code: "custom", message: "Select at least one group", path: ["groupIds"] });
  }
  if (value.audienceType === "BOTH" && (!value.groupIds.length || (!value.contactIds.length && !value.segmentIds.length))) {
    ctx.addIssue({
      code: "custom",
      message: "Combined mode requires at least one group and at least one segment or contact",
      path: ["groupIds"],
    });
  }
  if (value.scheduleType === "ONCE" && (!value.scheduledAt || Date.parse(value.scheduledAt) <= Date.now())) {
    ctx.addIssue({ code: "custom", message: "Choose a future date/time", path: ["scheduledAt"] });
  }
  if (value.scheduleType === "CRON") {
    if (!value.intervalHours && !value.cron) {
      ctx.addIssue({ code: "custom", message: "Choose an hourly interval or a cron schedule", path: ["cron"] });
    } else if (value.cron && !value.intervalHours) {
      try {
        const parts = value.cron.split(/\s+/);
        if (![5, 6].includes(parts.length)) throw new Error("Invalid cron");
        if (parts.length === 6 && parts[0] !== "0") throw new Error("Use minute precision");
        parseExpression(value.cron, { tz: value.timezone }).next();
      } catch {
        ctx.addIssue({ code: "custom", message: "Use a valid five-field cron (or six fields with seconds set to 0)", path: ["cron"] });
      }
    }
  }
  validateMedia(value, ctx);
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid timezone", path: ["timezone"] });
  }
});

export { personalize } from "./message";

export function isOptOut(text: string) {
  const command = text.normalize("NFKC").trim().replace(/[.!?,;:]+$/g, "").trim();
  return /^(?:(?:please\s+)?(?:stop|unsubscribe|opt[\s-]*out)(?:\s+(?:please|me|messaging(?:\s+me)?|sending(?:\s+me)?(?:\s+messages)?))?|remove\s+me(?:\s+from\s+(?:your|the)\s+(?:list|mailing\s+list))?|(?:do\s+not|don't)\s+(?:message|contact|text)\s+me(?:\s+again)?)$/i.test(command);
}

export function hasConsentEvidence(contact: { consentNote?: string | null; consentAt?: Date | string | null }) {
  return !!contact.consentNote?.trim() && !!contact.consentAt;
}

export type ContactExclusionReason = "NO_OPT_IN" | "OPTED_OUT" | "INVALID_ID";

export function contactExclusionReason(consent: string, whatsappId: string, suppressed = false): ContactExclusionReason | null {
  if (suppressed || consent === "OPTED_OUT") return "OPTED_OUT";
  if (!isDirectWhatsAppId(whatsappId)) return "INVALID_ID";
  return null;
}

export function isEligible(consent: string, whatsappId: string) {
  return contactExclusionReason(consent, whatsappId) === null;
}

export function schedulePreview(
  campaign: {
    scheduleType: string;
    scheduledAt?: Date | string | null;
    cron?: string | null;
    intervalHours?: number | null;
    runImmediately?: boolean;
    timezone: string;
  },
  now = new Date(),
) {
  if (campaign.scheduleType === "NOW") return [now.toISOString()];
  if (campaign.scheduleType === "ONCE") return campaign.scheduledAt ? [new Date(campaign.scheduledAt).toISOString()] : [];
  if (campaign.intervalHours && campaign.intervalHours > 0) {
    const stepMs = campaign.intervalHours * 3600000;
    const startOffset = campaign.runImmediately === false ? 1 : 0;
    return Array.from({ length: 5 }, (_, index) => new Date(now.getTime() + (index + startOffset) * stepMs).toISOString());
  }
  if (!campaign.cron) return [];
  const iterator = parseExpression(campaign.cron, { tz: campaign.timezone, currentDate: now });
  return Array.from({ length: 5 }, () => iterator.next().toISOString());
}

export function estimatedDurationMs(count: number, intervalMs: number) {
  return count * intervalMs;
}

export function scheduleIssue(
  campaign: { scheduleType: string; cron?: string | null; intervalHours?: number | null; timezone: string },
  durationMs: number,
) {
  if (campaign.scheduleType !== "CRON") return null;
  if (campaign.intervalHours && campaign.intervalHours > 0) {
    if (campaign.intervalHours * 3600000 < durationMs) {
      return "This audience needs more time to send than the chosen hourly interval. Increase the interval or reduce the audience.";
    }
    return null;
  }
  if (!campaign.cron) return "Choose an hourly interval or a cron schedule.";
  const iterator = parseExpression(campaign.cron, { tz: campaign.timezone });
  let previous = iterator.next().getTime();
  for (let i = 0; i < 100; i++) {
    const next = iterator.next().getTime();
    if (next - previous < durationMs) {
      return "This audience needs more time to send. Increase the recurring interval or reduce the audience.";
    }
    previous = next;
  }
  return null;
}
