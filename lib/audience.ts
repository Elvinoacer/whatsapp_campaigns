import { db } from "./db";
import { isEligible } from "./campaign";

export type Recipient = {
  key: string;
  chatId: string;
  label: string;
  name?: string | null;
  phone?: string | null;
};
export async function resolveRecipients(campaignId: string): Promise<Recipient[]> {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { contacts: true, segments: true, groups: true },
  });
  if (!campaign) throw new Error("Campaign not found");
  if (campaign.audienceType === "GROUPS") {
    const groups = await db.waGroup.findMany({
      where: { id: { in: campaign.groups.map(x => x.groupId) }, sessionId: campaign.sessionId, allowPosting: true },
    });
    return groups.map(group => ({
      key: "group:" + group.id,
      chatId: group.whatsappId,
      label: group.name,
    }));
  }
  const contacts = await db.contact.findMany({
    where: {
      sessionId: campaign.sessionId,
      OR: [
        { id: { in: campaign.contacts.map(x => x.contactId) } },
        { segments: { some: { segmentId: { in: campaign.segments.map(x => x.segmentId) } } } },
      ],
    },
  });
  const seen = new Set<string>();
  return contacts.filter(contact => {
    if (!isEligible(contact.consent, contact.whatsappId, contact.sessionId, campaign.sessionId)) return false;
    if (seen.has(contact.whatsappId)) return false;
    seen.add(contact.whatsappId);
    return true;
  }).map(contact => ({
    key: "contact:" + contact.id,
    chatId: contact.whatsappId,
    label: contact.name || contact.phone || contact.whatsappId,
    name: contact.name,
    phone: contact.phone,
  }));
}
