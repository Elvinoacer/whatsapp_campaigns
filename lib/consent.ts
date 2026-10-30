import { z } from "zod";
import { db } from "./db";
import { HttpError } from "./http";
import { contactSelectionInput, selectionWhere } from "./contact-selection";

const consentStatus = z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]);
const method = z.enum(["WHATSAPP_REPLY", "WEB_FORM", "IN_PERSON", "OTHER"]);

export const bulkConsentInput = z.object({
  selection: contactSelectionInput,
  consent: consentStatus,
  consentMethod: method.optional(),
  consentNote: z.string().trim().max(400).default(""),
  confirmed: z.boolean().default(false),
  includeOptedOut: z.boolean().default(false),
  reoptInConfirmed: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.includeOptedOut && (value.consent !== "OPTED_IN" || !value.reoptInConfirmed))
    ctx.addIssue({ code: "custom", path: ["reoptInConfirmed"], message: "Explicitly confirm renewed opt-in for previously opted-out contacts" });
  if (value.consent === "OPTED_IN") {
    if (!value.consentMethod) ctx.addIssue({ code: "custom", path: ["consentMethod"], message: "Choose how the selected people opted in" });
    if (value.consentMethod !== "OTHER" && value.consentNote.length < 10) ctx.addIssue({ code: "custom", path: ["consentNote"], message: "Record when and how each recipient consented" });
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
    });
    if (!contacts.length) throw new HttpError(400, "No contacts match the selection. Refresh the directory.");
    if (input.selection.contactIds && contacts.length !== new Set(input.selection.contactIds).size)
      throw new HttpError(409, "Some selected contacts no longer exist. Refresh the directory.");

    // Consent is an administrator decision; a missing destination must not
    // prevent updating the rest of a large selection. Delivery validates IDs.
    let ids = [...new Set(contacts.map(c => c.whatsappId))];
    const suppressed = new Set<string>();
    if (input.consent === "OPTED_IN" && !input.includeOptedOut) {
      for (let start = 0; start < ids.length; start += 500) {
        const records = await tx.contact.findMany({ where: { whatsappId: { in: ids.slice(start, start + 500) }, consent: "OPTED_OUT" }, select: { whatsappId: true } });
        for (const record of records) suppressed.add(record.whatsappId);
      }
      ids = ids.filter(id => !suppressed.has(id));
    }

    let affectedRecords = 0;
    const evidence = input.consent === "OPTED_IN" ? `[${input.consentMethod}] ${input.consentNote || "Opt-in confirmed by workspace administrator"}`
      : input.consent === "OPTED_OUT" ? input.consentNote || "Manually suppressed by workspace administrator" : "";
    for (let start = 0; start < ids.length; start += 500) {
      const updated = await tx.contact.updateMany({
        where: {
          whatsappId: { in: ids.slice(start, start + 500) },
          // Resetting to UNKNOWN must never erase an existing STOP/opt-out.
          ...(input.consent !== "OPTED_OUT" && !input.includeOptedOut ? { consent: { not: "OPTED_OUT" } } : {}),
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
      renewedOptIn: input.includeOptedOut, skippedOptedOut: suppressed.size,
      mode: input.selection.audience ? "campaign_audience" : input.selection.filter ? "all_matching" : "selected_ids",
    } } });
    return { selected: contacts.length, uniqueDestinations: ids.length, affectedRecords, skippedOptedOut: suppressed.size };
  }, { timeout: 60000 });
}

// Keep the original name available to callers while the endpoint uses the general update API.
export const recordBulkOptIn = updateBulkContactConsent;
