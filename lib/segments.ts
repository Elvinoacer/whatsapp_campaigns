import { z } from "zod";
import { db } from "./db";
import { segmentInput } from "./campaign";
import { contactSelectionInput, selectionWhere } from "./contact-selection";
import { HttpError } from "./http";

export const bulkSegmentInput = z.object({
  selection: contactSelectionInput,
  action: z.enum(["add", "move", "remove"]).default("add"),
  segmentIds: z.array(z.string().min(1)).max(500).default([]),
  sourceSegmentId: z.string().min(1).optional(),
  newSegment: segmentInput.optional(),
}).superRefine((value, ctx) => {
  if (!value.segmentIds.length && !value.newSegment) ctx.addIssue({ code: "custom", message: "Choose at least one segment", path: ["segmentIds"] });
  if (value.action === "remove" && value.newSegment) ctx.addIssue({ code: "custom", message: "Cannot remove from a new segment", path: ["newSegment"] });
  if (value.action === "move" && value.sourceSegmentId && value.segmentIds.includes(value.sourceSegmentId)) {
    ctx.addIssue({ code: "custom", message: "Choose a different destination segment", path: ["segmentIds"] });
  }
});

export const groupExportInput = z.object({
  groupIds: z.array(z.string().min(1)).min(1, "Select at least one group").max(500),
  segmentIds: z.array(z.string().min(1)).max(500).default([]),
  newSegment: segmentInput.optional(),
  syncLive: z.boolean().default(true),
}).refine(value => value.segmentIds.length > 0 || Boolean(value.newSegment), {
  message: "Choose an existing segment or enter a new segment name",
  path: ["segmentIds"],
});

export async function organizeContacts(input: z.infer<typeof bulkSegmentInput>) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    const requested = [...new Set([...input.segmentIds, ...(input.sourceSegmentId ? [input.sourceSegmentId] : [])])];
    if (await tx.segment.count({ where: { id: { in: requested } } }) !== requested.length) {
      throw new HttpError(400, "One or more segments no longer exist");
    }
    const contacts = await tx.contact.findMany({ where: selectionWhere(input.selection), select: { id: true } });
    if (input.selection.contactIds && contacts.length !== new Set(input.selection.contactIds).size) {
      throw new HttpError(400, "One or more contacts no longer exist");
    }
    if (!contacts.length) throw new HttpError(400, "No contacts match this selection");
    const created = input.newSegment ? await tx.segment.create({ data: input.newSegment }) : null;
    const destinations = [...new Set([...input.segmentIds, ...(created ? [created.id] : [])])];
    const ids = contacts.map(c => c.id);
    if (input.action === "move" && input.sourceSegmentId) {
      let count = 0;
      for (let start = 0; start < ids.length; start += 1000) {
        count += await tx.segmentMember.count({
          where: { segmentId: input.sourceSegmentId, contactId: { in: ids.slice(start, start + 1000) } },
        });
      }
      if (count !== ids.length) {
        throw new HttpError(409, "Some contacts left the source segment. Refresh the selection and try again.");
      }
    }
    let added = 0;
    if (input.action !== "remove") {
      for (const segmentId of destinations) {
        for (let start = 0; start < ids.length; start += 1000) {
          added += (
            await tx.segmentMember.createMany({
              data: ids.slice(start, start + 1000).map(contactId => ({ segmentId, contactId })),
              skipDuplicates: true,
            })
          ).count;
        }
      }
    }
    let removed = 0;
    if (input.action !== "add") {
      for (let start = 0; start < ids.length; start += 1000) {
        removed += (
          await tx.segmentMember.deleteMany({
            where: {
              contactId: { in: ids.slice(start, start + 1000) },
              segmentId: input.action === "remove"
                ? { in: destinations }
                : input.sourceSegmentId
                  ? input.sourceSegmentId
                  : { notIn: destinations },
            },
          })
        ).count;
      }
    }
    await tx.auditLog.create({
      data: {
        action: "segments.contacts_" + input.action,
        details: { contacts: ids.length, segmentIds: destinations, sourceSegmentId: input.sourceSegmentId, added, removed },
      },
    });
    return { count: ids.length, added, removed, segment: created };
  }, { timeout: 60000 });
}

export async function exportGroupsToSegments(input: z.infer<typeof groupExportInput>) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    const groupIds = [...new Set(input.groupIds)];
    const groups = await tx.waGroup.findMany({
      where: { id: { in: groupIds } },
      include: { session: { select: { id: true, status: true } } },
    });
    if (groups.length !== groupIds.length) throw new HttpError(400, "One or more selected groups no longer exist");
    const requestedSegments = [...new Set(input.segmentIds)];
    if (await tx.segment.count({ where: { id: { in: requestedSegments } } }) !== requestedSegments.length) {
      throw new HttpError(400, "One or more destination segments no longer exist");
    }
    if (input.newSegment && await tx.segment.findUnique({ where: { name: input.newSegment.name } })) {
      throw new HttpError(409, "A segment with that name already exists. Choose it from the list or use another name.");
    }
    const created = input.newSegment ? await tx.segment.create({ data: input.newSegment }) : null;
    const destinationIds = [...new Set([...requestedSegments, ...(created ? [created.id] : [])])];
    const memberships = await tx.groupMember.findMany({
      where: { groupId: { in: groupIds } },
      select: { contactId: true, contact: { select: { whatsappId: true } } },
    });
    const contactIds = [...new Set(memberships.map(m => m.contactId))];
    const uniquePeople = new Set(memberships.map(m => m.contact.whatsappId)).size;
    let added = 0;
    for (const segmentId of destinationIds) {
      for (let start = 0; start < contactIds.length; start += 1000) {
        added += (
          await tx.segmentMember.createMany({
            data: contactIds.slice(start, start + 1000).map(contactId => ({ segmentId, contactId })),
            skipDuplicates: true,
          })
        ).count;
      }
    }
    await tx.auditLog.create({
      data: {
        action: "groups.exported_to_segments",
        details: { groupIds, segmentIds: destinationIds, savedContactsExported: contactIds.length, uniquePeople, added },
      },
    });
    return {
      segment: created,
      destinationIds,
      savedContactsExported: contactIds.length,
      uniquePeople,
      added,
      connectedGroups: groups.filter(group => group.session.status === "CONNECTED"),
    };
  }, { timeout: 60000 });
}
