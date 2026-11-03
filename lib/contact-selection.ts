import { z } from "zod";
import type { Prisma } from "@prisma/client";

// Shared by phonebook queries, CSV exports, and bulk actions so "all matching" means the exact same set.
export const contactFilterInput = z.object({
  search: z.string().trim().max(150).optional(),
  sessionId: z.string().min(1).optional(),
  groupId: z.string().min(1).optional(),
  groupIds: z.array(z.string().min(1)).max(500).optional(),
  segmentId: z.string().min(1).optional(),
  consent: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]).optional(),
  status: z.enum(["active", "opted_out"]).optional(),
  phoneAvailability: z.enum(["usable", "unavailable"]).optional(),
  destinationAvailability: z.enum(["phone", "private"]).optional(),
  source: z.enum(["mine", "groups", "other"]).optional(),
  unsegmented: z.boolean().optional(),
});
export type ContactFilter = z.infer<typeof contactFilterInput>;

export const contactSelectionInput = z.object({
  contactIds: z.array(z.string().min(1)).min(1).max(50000).optional(),
  filter: contactFilterInput.optional(),
  audience: z.object({
    contactIds: z.array(z.string().min(1)).max(50000).default([]),
    segmentIds: z.array(z.string().min(1)).max(500).default([]),
    groupIds: z.array(z.string().min(1)).max(500).default([]),
  }).refine(value => value.contactIds.length + value.segmentIds.length + value.groupIds.length > 0, "Choose an audience").optional(),
}).refine(value => [value.contactIds, value.filter, value.audience].filter(Boolean).length === 1, "Choose exactly one contact selection");
export type ContactSelection = z.infer<typeof contactSelectionInput>;

export function contactWhere(filter: ContactFilter): Prisma.ContactWhereInput {
  const members: Prisma.GroupMemberListRelationFilter = {
    ...(filter.groupIds?.length
      ? { some: { groupId: { in: filter.groupIds } } }
      : filter.groupId
        ? { some: { groupId: filter.groupId } }
        : filter.source === "groups"
          ? { some: {} }
          : {}),
    ...(filter.source === "other" && { none: {} }),
  };
  return {
    ...(filter.sessionId && { sessionId: filter.sessionId }),
    ...(Object.keys(members).length > 0 && { members }),
    ...(filter.status === "opted_out"
      ? { consent: "OPTED_OUT" }
      : filter.status === "active"
        ? { consent: { not: "OPTED_OUT" } }
        : filter.consent
          ? { consent: filter.consent }
          : {}),
    ...(filter.phoneAvailability === "usable" && { phone: { not: null } }),
    ...(filter.phoneAvailability === "unavailable" && { phone: null }),
    ...(filter.destinationAvailability && { whatsappId: { endsWith: filter.destinationAvailability === "private" ? "@lid" : "@c.us" } }),
    ...(filter.source === "mine" && { isMyContact: true }),
    ...(filter.source === "other" && { isMyContact: false }),
    ...(filter.unsegmented ? { segments: { none: {} } } : filter.segmentId ? { segments: { some: { segmentId: filter.segmentId } } } : {}),
    ...(filter.search && {
      OR: [
        { name: { contains: filter.search, mode: "insensitive" } },
        { phone: { contains: filter.search } },
        { whatsappId: { contains: filter.search } },
      ],
    }),
  };
}

export function selectionWhere(selection: ContactSelection): Prisma.ContactWhereInput {
  if (selection.audience) return audienceContactWhere(selection.audience);
  return selection.contactIds ? { id: { in: selection.contactIds } } : contactWhere(selection.filter!);
}

// Campaign selection is independent from directory filters and segment labels.
export function audienceContactWhere(audience: { contactIds: string[]; segmentIds: string[]; groupIds: string[] }): Prisma.ContactWhereInput {
  const clauses: Prisma.ContactWhereInput[] = [];
  if (audience.contactIds.length) clauses.push({ id: { in: audience.contactIds } });
  if (audience.segmentIds.length) clauses.push({ segments: { some: { segmentId: { in: audience.segmentIds } } } });
  if (audience.groupIds.length) clauses.push({ members: { some: { groupId: { in: audience.groupIds } } } });
  return clauses.length ? { OR: clauses } : { id: { in: [] } };
}
