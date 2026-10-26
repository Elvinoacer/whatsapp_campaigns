import { z } from "zod";
import { db } from "./db";
import { HttpError } from "./http";
import { isEligible } from "./campaign";

export const bulkConsentInput = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(200),
  consentMethod: z.enum(["WHATSAPP_REPLY", "WEB_FORM", "IN_PERSON", "OTHER"]),
  consentNote: z.string().trim().min(10).max(400),
  confirmed: z.literal(true),
});

export async function recordBulkOptIn(input: z.infer<typeof bulkConsentInput>) {
  const contactIds = [...new Set(input.contactIds)];
  return db.$transaction(async tx => {
    // Serialize bulk consent reviews. This only records permissions already granted.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    const contacts = await tx.contact.findMany({
      where: { id: { in: contactIds } },
      select: { id: true, whatsappId: true, consent: true },
    });
    if (contacts.length !== contactIds.length)
      throw new HttpError(400, "Some selected contacts no longer exist. Refresh and select them again.");
    if (contacts.some(contact => !isEligible("OPTED_IN", contact.whatsappId)))
      throw new HttpError(400, "Some selected contacts have no usable WhatsApp phone number. Review unresolved IDs separately.");
    if (contacts.some(contact => contact.consent === "OPTED_OUT"))
      throw new HttpError(409, "At least one selected contact opted out. Do not bulk-enroll opted-out contacts.");

    const whatsappIds = [...new Set(contacts.map(contact => contact.whatsappId))];
    if (await tx.contact.count({ where: { whatsappId: { in: whatsappIds }, consent: "OPTED_OUT" } }))
      throw new HttpError(409, "One or more phone numbers are suppressed in another session. Review their consent individually.");

    const evidence = `[${input.consentMethod}] ${input.consentNote}`;
    const updated = await tx.contact.updateMany({
      where: { whatsappId: { in: whatsappIds }, consent: { not: "OPTED_OUT" } },
      data: { consent: "OPTED_IN", consentAt: new Date(), consentNote: evidence },
    });
    await tx.auditLog.create({ data: { action: "contacts.bulk_consent_recorded", details: {
      count: contactIds.length, uniquePhones: whatsappIds.length,
      affectedRecords: updated.count, consentMethod: input.consentMethod, evidence,
    } } });
    return { selected: contactIds.length, uniquePhones: whatsappIds.length, affectedRecords: updated.count };
  }, { timeout: 60000 });
}
