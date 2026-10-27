import { db } from "./db";
import { contactExclusionReason, hasConsentEvidence } from "./campaign";

export type AudienceExclusions = {
  missingConsent: number;
  optedOut: number;
  unusablePhone: number;
  unauthorizedGroups: number;
};
const emptyExclusions = (): AudienceExclusions => ({
  missingConsent: 0, optedOut: 0, unusablePhone: 0, unauthorizedGroups: 0,
});

export type Recipient = {
  key: string;
  chatId: string;
  label: string;
  contactId?: string;
  name?: string | null;
  phone?: string | null;
  sources?: string[];
};
type Audience = { audienceType: string; sessionId: string; contactIds: string[]; segmentIds: string[]; groupIds: string[] };

export async function resolveAudience(audience: Audience) {
  if (audience.audienceType === "GROUPS") {
    const groups = await db.waGroup.findMany({ where: { id: { in: audience.groupIds }, sessionId: audience.sessionId } });
    const recipients: Recipient[] = groups.filter(g => g.allowPosting).map(group => ({ key: "group:" + group.id, chatId: group.whatsappId, label: group.name }));
    const excluded = groups.length - recipients.length;
    return { recipients, total: groups.length, duplicates: 0, excluded,
      exclusions: { ...emptyExclusions(), unauthorizedGroups: excluded } };
  }
  const contacts = await db.contact.findMany({
    where: { OR: [
      { id: { in: audience.contactIds } },
      { segments: { some: { segmentId: { in: audience.segmentIds } } } },
      { members: { some: { groupId: { in: audience.groupIds } } } },
    ] },
    include: {
      segments: { where: { segmentId: { in: audience.segmentIds } }, include: { segment: { select: { name: true } } } },
      members: { where: { groupId: { in: audience.groupIds } }, include: { group: { select: { name: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const suppressed = new Set((await db.contact.findMany({
    where: { whatsappId: { in: contacts.map(c => c.whatsappId) }, consent: "OPTED_OUT" }, select: { whatsappId: true },
  })).map(c => c.whatsappId));
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  let duplicates = 0;
  let excluded = 0;
  const exclusions = emptyExclusions();
  for (const contact of contacts) {
    const reason = contactExclusionReason(contact.consent, contact.whatsappId, suppressed.has(contact.whatsappId))
      || (!hasConsentEvidence(contact) ? "NO_OPT_IN" : null);
    if (reason) {
      excluded++;
      if (reason === "NO_OPT_IN") exclusions.missingConsent++;
      else if (reason === "OPTED_OUT") exclusions.optedOut++;
      else exclusions.unusablePhone++;
      continue;
    }
    if (seen.has(contact.whatsappId)) { duplicates++; continue; }
    seen.add(contact.whatsappId);
    recipients.push({
      key: "contact:" + contact.whatsappId, contactId: contact.id, chatId: contact.whatsappId,
      label: contact.name || contact.phone || contact.whatsappId, name: contact.name, phone: contact.phone,
      sources: [...(audience.contactIds.includes(contact.id) ? ["Individually selected"] : []), ...contact.segments.map(item => item.segment.name), ...contact.members.map(item => "Group: " + item.group.name)],
    });
  }
  return { recipients, total: contacts.length, duplicates, excluded, exclusions };
}

export async function getCampaignAudience(campaignId: string) {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { contacts: true, segments: true, groups: true } });
  if (!campaign) throw new Error("Campaign not found");
  return resolveAudience({ ...campaign,
    contactIds: campaign.contacts.map(c => c.contactId), segmentIds: campaign.segments.map(s => s.segmentId), groupIds: campaign.groups.map(g => g.groupId),
  });
}

export async function resolveRecipients(campaignId: string): Promise<Recipient[]> {
  return (await getCampaignAudience(campaignId)).recipients;
}

export function explainAudienceBlocker(audience: Awaited<ReturnType<typeof resolveAudience>>) {
  const { missingConsent, optedOut, unusablePhone, unauthorizedGroups } = audience.exclusions;
  const reasons = [
    missingConsent && `${missingConsent} awaiting verified opt-in`,
    unusablePhone && `${unusablePhone} without valid WhatsApp destinations`,
    optedOut && `${optedOut} opted out or suppressed`,
    unauthorizedGroups && `${unauthorizedGroups} groups without posting authorization`,
  ].filter(Boolean);
  return reasons.length
    ? `No eligible recipients: ${reasons.join("; ")}. Review the selected segment in Contacts; group membership alone is not opt-in.`
    : "No eligible recipients. Check that the selected contacts or segments contain permitted recipients.";
}
