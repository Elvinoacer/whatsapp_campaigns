import { z } from "zod";
import { db } from "./db";
import { HttpError } from "./http";
import { isEligible } from "./campaign";
import { contactSelectionInput, selectionWhere } from "./contact-selection";

const consentStatus = z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]);
const method = z.enum(["WHATSAPP_REPLY", "WEB_FORM", "IN_PERSON", "OTHER"]);

export const bulkConsentInput = z.object({
  selection: contactSelectionInput,
  consent: consentStatus,
  consentMethod: method.optional(),
  consentNote: z.string().trim().max(400).default(""),
  confirmed: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.consent === "OPTED_IN") {
    if (!value.consentMethod) ctx.addIssue({ code: "custom", path: ["consentMethod"], message: "Choose how the selected people opted in" });
    if (value.consentNote.length < 10) ctx.addIssue({ code: "custom", path: ["consentNote"], message: "Record when and how each recipient consented" });
    if (!value.confirmed) ctx.addIssue({ code: "custom", path: ["confirmed"], message: "Confirm that every selected recipient opted in" });
  }
});

export async function updateBulkContactConsent(input: z.infer<typeof bulkConsentInput>) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    // The selection is evaluated on the server, not limited to the current UI page.
    const contacts = await tx.contact.findMany({
      where: selectionWhere(input.selection),
      select: { id: true, whatsappId: true, consent: true },
      take: 5001,
    });
    if (!contacts.length) throw new HttpError(400, "No contacts match the selection. Refresh the directory.");
    if (contacts.length > 5000) throw new HttpError(400, "Bulk updates are limited to 5,000 records. Narrow the filters and retry.");
    if (input.selection.contactIds && contacts.length !== new Set(input.selection.contactIds).size)
      throw new HttpError(409, "Some selected contacts no longer exist. Refresh the directory.");

    if (input.consent === "OPTED_IN") {
      if (contacts.some(c => !isEligible("OPTED_IN", c.whatsappId)))
        throw new HttpError(400, "Some selected contacts have invalid WhatsApp destinations. Sync those contacts before recording opt-in. Private WhatsApp IDs do not require a phone number.");
      if (contacts.some(c => c.consent === "OPTED_OUT"))
        throw new HttpError(409, "The selection includes opted-out contacts. Filter them out; suppression cannot be silently overridden.");
    }

    const ids = [...new Set(contacts.map(c => c.whatsappId))];
    if (input.consent === "OPTED_IN") {
      for (let start = 0; start < ids.length; start += 500) {
        if (await tx.contact.count({ where: { whatsappId: { in: ids.slice(start, start + 500) }, consent: "OPTED_OUT" } }))
          throw new HttpError(409, "One or more selected WhatsApp contacts opted out on another session. Exclude those contacts.");
      }
    }

    let affectedRecords = 0;
    const evidence = input.consent === "OPTED_IN" ? `[${input.consentMethod}] ${input.consentNote}`
      : input.consent === "OPTED_OUT" ? input.consentNote || "Manually suppressed by workspace administrator" : "";
    for (let start = 0; start < ids.length; start += 500) {
      const updated = await tx.contact.updateMany({
        where: {
          whatsappId: { in: ids.slice(start, start + 500) },
          // Resetting to UNKNOWN must never erase an existing STOP/opt-out.
          ...(input.consent !== "OPTED_OUT" ? { consent: { not: "OPTED_OUT" } } : {}),
        },
        data: {
          consent: input.consent,
          consentNote: evidence,
          consentAt: input.consent === "OPTED_IN" ? new Date() : null,
        },
      });
      affectedRecords += updated.count;
    }
    await tx.auditLog.create({ data: { action: "contacts.bulk_consent_changed", details: {
      selected: contacts.length, uniqueDestinations: ids.length, affectedRecords,
      consent: input.consent, method: input.consentMethod || null,
      evidence: input.consent === "OPTED_IN" ? evidence : undefined,
      mode: input.selection.filter ? "all_matching" : "selected_ids",
    } } });
    return { selected: contacts.length, uniqueDestinations: ids.length, affectedRecords };
  }, { timeout: 60000 });
}

// Keep the original name available to callers while the endpoint uses the general update API.
export const recordBulkOptIn = updateBulkContactConsent;
