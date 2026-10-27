import { isDirectWhatsAppId } from "../lib/whatsapp-id";

export type IdentityClient = {
  getContactLidAndPhone?: (ids: string[]) => Promise<{ lid: string; pn: string }[]>;
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
