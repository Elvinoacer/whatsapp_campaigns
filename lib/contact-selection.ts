import { z } from "zod";
import type { Prisma } from "@prisma/client";

// Shared by directory queries and bulk actions so “all matching” means the same thing.
export const contactFilterInput = z.object({
  search: z.string().trim().max(150).optional(),
  sessionId: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  segmentId: z.string().min(1).optional(),
  consent: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]).optional(),
  phoneAvailability: z.enum(["usable", "unavailable"]).optional(),
  // Identity type and phone visibility are separate. A private WhatsApp ID can
  // receive a campaign even when its phone field is empty.
  destinationAvailability: z.enum(["phone", "private"]).optional(),
  source: z.enum(["mine", "groups", "other"]).optional(),
  unsegmented: z.boolean().optional(),
});
export type ContactFilter = z.infer<typeof contactFilterInput>;
export const contactSelectionInput = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
  filter: contactFilterInput.optional(),
}).refine(value => !!value.contactIds !== !!value.filter, "Select contact IDs or all contacts matching a filter");
export type ContactSelection = z.infer<typeof contactSelectionInput>;

export function contactWhere(filter: ContactFilter): Prisma.ContactWhereInput {
  const members: Prisma.GroupMemberListRelationFilter = {
    ...(filter.groupId ? { some: { groupId: filter.groupId } } : filter.source === "groups" ? { some: {} } : {}),
    ...(filter.source === "other" && { none: {} }),
  };
  return {
    ...(filter.sessionId && { sessionId: filter.sessionId }),
    ...(Object.keys(members).length > 0 && { members }),
    ...(filter.consent && { consent: filter.consent }),
    ...(filter.phoneAvailability === "usable" && { phone: { not: null } }),
    ...(filter.phoneAvailability === "unavailable" && { phone: null }),
    ...(filter.destinationAvailability && { whatsappId: { endsWith: filter.destinationAvailability === "private" ? "@lid" : "@c.us" } }),
    ...(filter.source === "mine" && { isMyContact: true }),
    ...(filter.source === "other" && { isMyContact: false }),
    ...(filter.unsegmented ? { segments: { none: {} } } : filter.segmentId ? { segments: { some: { segmentId: filter.segmentId } } } : {}),
    ...(filter.search && { OR: [{ name: { contains: filter.search, mode: "insensitive" } }, { phone: { contains: filter.search } }, { whatsappId: { contains: filter.search } }] }),
  };
}

export function selectionWhere(selection: ContactSelection): Prisma.ContactWhereInput {
  return selection.contactIds ? { id: { in: selection.contactIds } } : contactWhere(selection.filter!);
}
