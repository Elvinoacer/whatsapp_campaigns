import { z } from "zod";
import { db } from "./db";
import { segmentInput } from "./campaign";
import { contactSelectionInput, selectionWhere } from "./contact-selection";
import { HttpError } from "./http";

export const bulkSegmentInput = z.object({
  selection: contactSelectionInput,
  action: z.enum(["add", "move", "remove"]).default("add"),
  segmentIds: z.array(z.string().min(1)).max(100).default([]),
  sourceSegmentId: z.string().min(1).optional(),
  newSegment: segmentInput.optional(),
}).superRefine((value, ctx) => {
  if (!value.segmentIds.length && !value.newSegment) ctx.addIssue({ code: "custom", message: "Choose at least one segment", path: ["segmentIds"] });
  if (value.action === "remove" && value.newSegment) ctx.addIssue({ code: "custom", message: "Cannot remove from a new segment", path: ["newSegment"] });
  if (value.action === "move" && value.sourceSegmentId && value.segmentIds.includes(value.sourceSegmentId)) ctx.addIssue({ code: "custom", message: "Choose a different destination segment", path: ["segmentIds"] });
});

export async function organizeContacts(input: z.infer<typeof bulkSegmentInput>) {
  return db.$transaction(async tx => {
    // Serialize membership edits, including concurrent moves from different browser tabs.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    const requested = [...new Set([...input.segmentIds, ...(input.sourceSegmentId ? [input.sourceSegmentId] : [])])];
    if (await tx.segment.count({ where: { id: { in: requested } } }) !== requested.length) throw new HttpError(400, "One or more segments no longer exist");
    const contacts = await tx.contact.findMany({ where: selectionWhere(input.selection), select: { id: true } });
    if (input.selection.contactIds && contacts.length !== new Set(input.selection.contactIds).size) throw new HttpError(400, "One or more contacts no longer exist");
    if (!contacts.length) throw new HttpError(400, "No contacts match this selection");
    const created = input.newSegment ? await tx.segment.create({ data: input.newSegment }) : null;
    const destinations = [...new Set([...input.segmentIds, ...(created ? [created.id] : [])])];
    const ids = contacts.map(c => c.id);
    if (input.action === "move" && input.sourceSegmentId) {
      let count = 0;
      for (let start = 0; start < ids.length; start += 1000) {
        count += await tx.segmentMember.count({ where: { segmentId: input.sourceSegmentId, contactId: { in: ids.slice(start, start + 1000) } } });
      }
      if (count !== ids.length) throw new HttpError(409, "Some contacts left the source segment. Refresh the selection and try again.");
    }
    let added = 0;
    if (input.action !== "remove") {
      // Keep inserts bounded for large filtered selections and multiple destinations.
      for (const segmentId of destinations) {
        for (let start = 0; start < ids.length; start += 1000) {
          added += (await tx.segmentMember.createMany({ data: ids.slice(start, start + 1000).map(contactId => ({ segmentId, contactId })), skipDuplicates: true })).count;
        }
      }
    }
    let removed = 0;
    if (input.action !== "add") {
      for (let start = 0; start < ids.length; start += 1000) {
        removed += (await tx.segmentMember.deleteMany({ where: {
          contactId: { in: ids.slice(start, start + 1000) },
          segmentId: input.action === "remove" ? { in: destinations }
            : input.sourceSegmentId ? input.sourceSegmentId : { notIn: destinations },
        } })).count;
      }
    }
    await tx.auditLog.create({ data: { action: "segments.contacts_" + input.action, details: { contacts: ids.length, segmentIds: destinations, sourceSegmentId: input.sourceSegmentId, added, removed } } });
    return { count: ids.length, added, removed, segment: created };
  }, { timeout: 60000 });
}
