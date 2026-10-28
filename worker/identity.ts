import { isDirectWhatsAppId } from "../lib/whatsapp-id";
import { hasConsentEvidence } from "../lib/campaign";

export type IdentityClient = {
  getContactLidAndPhone?: (ids: string[]) => Promise<{ lid?: string; pn?: string }[]>;
};

// Use only mappings WhatsApp supplies. A missing/hidden phone never makes a
// private destination invalid, and a mapping lookup must never resend a message.
export async function contactIds(client: IdentityClient, id: string): Promise<string[]> {
  if (!isDirectWhatsAppId(id)) return [id];
  try {
    const mappings = await client.getContactLidAndPhone?.([id]);
    const mapping = mappings?.find(item => item.lid === id || item.pn === id);
    return [...new Set([id, ...[mapping?.lid, mapping?.pn].filter((value): value is string => !!value && isDirectWhatsAppId(value))])];
  } catch { return [id]; }
}

type ExistingIdentity = { whatsappId: string; consent: string; consentAt?: Date | string | null; consentNote?: string | null };

// A newly revealed phone mapping must not strand consent and segment links on
// an existing private-ID record. Only aliases supplied by WhatsApp are compared.
export function stableContactIdentity<T extends ExistingIdentity>(ids: string[], existing: T[]) {
  const matches = existing.filter(contact => ids.includes(contact.whatsappId));
  return matches.find(contact => contact.consent === "OPTED_OUT")
    || matches.find(contact => contact.consent === "OPTED_IN" && hasConsentEvidence(contact))
    || matches.find(contact => contact.whatsappId === ids[0])
    || matches[0];
}
