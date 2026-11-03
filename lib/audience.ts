import { audienceContactWhere } from "./contact-selection";
import { db } from "./db";
import { contactExclusionReason } from "./campaign";

export type AudienceExclusions = {
  missingConsent: number;
  optedOut: number;
  unusablePhone: number;
  unauthorizedGroups: number;
};

const emptyExclusions = (): AudienceExclusions => ({
  missingConsent: 0,
  optedOut: 0,
  unusablePhone: 0,
  unauthorizedGroups: 0,
});

export type Recipient = {
  key: string;
  chatId: string;
  label: string;
  contactId?: string;
  groupId?: string;
  groupName?: string | null;
  name?: string | null;
  phone?: string | null;
  sources?: string[];
};

type Audience = {
  audienceType: string;
  sessionId: string;
  contactIds: string[];
  segmentIds: string[];
  groupIds: string[];
};

export async function resolveAudience(audience: Audience) {
  const exclusions = emptyExclusions();
  const recipients: Recipient[] = [];
  let total = 0;
  let duplicates = 0;
  let excluded = 0;

  if (audience.audienceType === "GROUPS" || audience.audienceType === "BOTH") {
    const groups = await db.waGroup.findMany({
      where: { id: { in: audience.groupIds }, sessionId: audience.sessionId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    total += groups.length;
    for (const group of groups) {
      if (!group.allowPosting) {
        excluded++;
        exclusions.unauthorizedGroups++;
        continue;
      }
      recipients.push({
        key: "group:" + group.id,
        groupId: group.id,
        groupName: group.name,
        chatId: group.whatsappId,
        label: group.name,
        sources: ["WhatsApp group"],
      });
    }
    if (audience.audienceType === "GROUPS") {
      return { recipients, total, duplicates, excluded, exclusions };
    }
  }

  const contactScope = {
    contactIds: audience.contactIds,
    segmentIds: audience.segmentIds,
    // In BOTH mode, groupIds designate group chats to post into; in CONTACTS mode,
    // groupIds select saved members of those groups as DM recipients.
    groupIds: audience.audienceType === "CONTACTS" ? audience.groupIds : [],
  };
  const contacts = await db.contact.findMany({
    where: audienceContactWhere(contactScope),
    include: {
      segments: { where: { segmentId: { in: contactScope.segmentIds } }, include: { segment: { select: { name: true } } } },
      members: { where: { groupId: { in: contactScope.groupIds } }, include: { group: { select: { name: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  total += contacts.length;
  const suppressed = new Set(
    (
      await db.contact.findMany({
        where: { whatsappId: { in: contacts.map(c => c.whatsappId) }, consent: "OPTED_OUT" },
        select: { whatsappId: true },
      })
    ).map(c => c.whatsappId),
  );
  const seen = new Set<string>();
  for (const contact of contacts) {
    const reason = contactExclusionReason(contact.consent, contact.whatsappId, suppressed.has(contact.whatsappId));
    if (reason) {
      excluded++;
      if (reason === "NO_OPT_IN") exclusions.missingConsent++;
      else if (reason === "OPTED_OUT") exclusions.optedOut++;
      else exclusions.unusablePhone++;
      continue;
    }
    if (seen.has(contact.whatsappId)) {
      duplicates++;
      continue;
    }
    seen.add(contact.whatsappId);
    const directPhone = contact.phone && /^\d{8,15}$/.test(contact.phone) ? `${contact.phone}@c.us` : null;
    const destination = directPhone || contact.whatsappId;
    recipients.push({
      key: "contact:" + contact.whatsappId,
      contactId: contact.id,
      chatId: destination,
      label: contact.name || contact.phone || contact.whatsappId,
      name: contact.name,
      phone: contact.phone,
      groupName: contact.members[0]?.group.name || null,
      sources: [
        ...(audience.contactIds.includes(contact.id) ? ["Individually selected"] : []),
        ...contact.segments.map(item => "Segment: " + item.segment.name),
        ...contact.members.map(item => "Group: " + item.group.name),
      ],
    });
  }
  return { recipients, total, duplicates, excluded, exclusions };
}

export async function getCampaignAudience(campaignId: string) {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { contacts: true, segments: true, groups: true },
  });
  if (!campaign) throw new Error("Campaign not found");
  return resolveAudience({
    ...campaign,
    contactIds: campaign.contacts.map(c => c.contactId),
    segmentIds: campaign.segments.map(s => s.segmentId),
    groupIds: campaign.groups.map(g => g.groupId),
  });
}

export async function resolveRecipients(campaignId: string): Promise<Recipient[]> {
  return (await getCampaignAudience(campaignId)).recipients;
}

export function explainAudienceBlocker(audience: Awaited<ReturnType<typeof resolveAudience>>) {
  const { optedOut, unusablePhone, unauthorizedGroups } = audience.exclusions;
  const reasons = [
    unusablePhone && `${unusablePhone} without valid WhatsApp destinations`,
    optedOut && `${optedOut} opted out or suppressed`,
    unauthorizedGroups && `${unauthorizedGroups} groups with posting paused`,
  ].filter(Boolean);
  return reasons.length
    ? `No eligible recipients: ${reasons.join("; ")}.`
    : "No eligible recipients. Add contacts to the selected segment or choose an active group.";
}
