import { db } from "./db";
import { isEligible } from "./campaign";

export type Recipient = {
  key: string;
  chatId: string;
  label: string;
  contactId?: string;
  name?: string | null;
  phone?: string | null;
};
type Audience = { audienceType: string; sessionId: string; contactIds: string[]; segmentIds: string[]; groupIds: string[] };

export async function resolveAudience(audience: Audience) {
  if (audience.audienceType === "GROUPS") {
    const groups = await db.waGroup.findMany({ where: { id: { in: audience.groupIds }, sessionId: audience.sessionId } });
    const recipients: Recipient[] = groups.filter(g => g.allowPosting).map(group => ({ key: "group:" + group.id, chatId: group.whatsappId, label: group.name }));
    return { recipients, total: groups.length, duplicates: 0, excluded: groups.length - recipients.length };
  }
  const contacts = await db.contact.findMany({
    where: { OR: [
      { id: { in: audience.contactIds } },
      { segments: { some: { segmentId: { in: audience.segmentIds } } } },
    ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const suppressed = new Set((await db.contact.findMany({
    where: { whatsappId: { in: contacts.map(c => c.whatsappId) }, consent: "OPTED_OUT" }, select: { whatsappId: true },
  })).map(c => c.whatsappId));
  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  let duplicates = 0;
  let excluded = 0;
  for (const contact of contacts) {
    if (!isEligible(contact.consent, contact.whatsappId) || suppressed.has(contact.whatsappId)) { excluded++; continue; }
    if (seen.has(contact.whatsappId)) { duplicates++; continue; }
    seen.add(contact.whatsappId);
    recipients.push({
      key: "contact:" + contact.whatsappId, contactId: contact.id, chatId: contact.whatsappId,
      label: contact.name || contact.phone || contact.whatsappId, name: contact.name, phone: contact.phone,
    });
  }
  return { recipients, total: contacts.length, duplicates, excluded };
}

export async function resolveRecipients(campaignId: string): Promise<Recipient[]> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, include: { contacts: true, segments: true, groups: true } });
  if (!campaign) throw new Error("Campaign not found");
  return (await resolveAudience({ ...campaign,
    contactIds: campaign.contacts.map(c => c.contactId), segmentIds: campaign.segments.map(s => s.segmentId), groupIds: campaign.groups.map(g => g.groupId),
  })).recipients;
}
