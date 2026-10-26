import { z } from "zod";
import { parseExpression } from "cron-parser";

export const sessionInput = z.object({ label: z.string().trim().min(2).max(80) });
export const contactInput = z.object({
  consent: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]),
  consentNote: z.string().trim().max(500).optional(),
}).refine(value => value.consent !== "OPTED_IN" || !!value.consentNote?.trim(), { message: "Provide evidence of opt-in consent", path: ["consentNote"] });
export const segmentInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(250).optional(),
});
export const campaignInput = z.object({
  name: z.string().trim().min(3).max(100),
  message: z.string().trim().min(1).max(4096),
  mediaKey: z.string().regex(/^[a-f0-9-]{36}\.(jpg|png|webp|pdf)$/).optional(),
  mediaMime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]).optional(),
  mediaName: z.string().max(140).optional(),
  sessionId: z.string().min(1),
  audienceType: z.enum(["CONTACTS", "GROUPS"]),
  contactIds: z.array(z.string()).max(500).default([]),
  segmentIds: z.array(z.string()).max(100).default([]),
  groupIds: z.array(z.string()).max(100).default([]),
  scheduleType: z.enum(["NOW", "ONCE", "CRON"]).default("NOW"),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  cron: z.string().trim().max(100).optional(),
  timezone: z.string().trim().min(1).max(80).default("Africa/Nairobi"),
}).superRefine((value, ctx) => {
  if (value.audienceType === "CONTACTS" && !value.contactIds.length && !value.segmentIds.length)
    ctx.addIssue({ code: "custom", message: "Select contacts or a contact list", path: ["contactIds"] });
  if (value.audienceType === "GROUPS" && !value.groupIds.length)
    ctx.addIssue({ code: "custom", message: "Select a group", path: ["groupIds"] });
  if (value.scheduleType === "ONCE" && (!value.scheduledAt || Date.parse(value.scheduledAt) <= Date.now()))
    ctx.addIssue({ code: "custom", message: "Choose a future date/time", path: ["scheduledAt"] });
  if (value.scheduleType === "CRON") {
    try {
      if (!value.cron || ![5, 6].includes(value.cron.split(/\s+/).length)) throw new Error("Invalid cron");
      parseExpression(value.cron, { tz: value.timezone }).next();
    } catch { ctx.addIssue({ code: "custom", message: "Provide a valid 5 or 6 field cron expression", path: ["cron"] }); }
  }
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
  if (!!value.mediaKey !== !!value.mediaMime || (value.mediaKey && value.mediaMime && !value.mediaKey.endsWith("." + extensions[value.mediaMime])))
    ctx.addIssue({ code: "custom", message: "Attachment type and file must match", path: ["mediaMime"] });
  try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid timezone", path: ["timezone"] }); }
});
export function personalize(message: string, contact: { name?: string | null; phone?: string | null }) {
  return message.replace(/\{\{\s*(first_name|name|phone)\s*\}\}/g, (_, key: string) => {
    if (key === "phone") return contact.phone || "";
    const name = contact.name?.trim() || "there";
    return key === "first_name" ? name.split(/\s+/)[0] : name;
  });
}
export function isOptOut(text: string) {
  return /^(stop|unsubscribe|opt\s*out)$/i.test(text.trim());
}
export function isEligible(consent: string, whatsappId: string, sessionId: string, targetSession: string) {
  return consent === "OPTED_IN" && whatsappId.endsWith("@c.us") && sessionId === targetSession;
}
