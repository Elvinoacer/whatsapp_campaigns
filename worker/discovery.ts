// Runs inside WhatsApp Web. Read only the fields the directory needs; the
// SDK's full serializers also fetch business profiles, messages and media.
type Wid = { _serialized: string };
type Collection<T> = { getModelsArray(): T[]; get?(id: string): T | undefined };
type ContactModel = { id: Wid; phoneNumber?: Wid; name?: string; pushname?: string; isMyContact?: boolean };
type Participant = { id: Wid };
type Metadata = { participants: Collection<Participant>; subject?: string };
type ChatModel = { id: Wid; name?: string; formattedTitle?: string; groupMetadata?: Metadata };
type Store = {
  Contact: Collection<ContactModel>;
  Chat: Collection<ChatModel>;
  GroupMetadata?: { update(id: Wid): Promise<unknown>; get?(id: string): Metadata | undefined };
  WAWebGroupMetadataCollection?: Store["GroupMetadata"];
};
type BrowserModules = {
  require(name: "WAWebCollections"): Store;
  require(name: "WAWebFrontendContactGetters"): { getIsMyContact(contact: ContactModel): boolean };
  require(name: "WAWebLidMigrationUtils"): { toPn(id: Wid): Wid | undefined };
};
export type DiscoveredContact = { whatsappId: string; name: string | null; isMyContact: boolean; aliases?: string[] };
export type DiscoveredGroup = { whatsappId: string; name: string; participantCount: number | null };
export type Discovery = { contacts: DiscoveredContact[]; groups: DiscoveredGroup[]; warnings: number; participants: DiscoveredContact[] | null };

export async function discoverWhatsApp(groupId?: string): Promise<Discovery> {
  const modules = window as unknown as BrowserModules;
  const store = modules.require("WAWebCollections");
  if (!store.Contact?.getModelsArray || !store.Chat?.getModelsArray)
    throw new Error("WhatsApp's contact store is not ready. Wait for the session to finish connecting, then sync again.");
  let warnings = 0;
  // This function is serialized into the browser, so keep validation local.
  const directIdPattern = /^(?:\d{8,15}@c\.us|\d{1,30}@lid)$/;
  let contactGetters: { getIsMyContact(contact: ContactModel): boolean } | undefined;
  let toPn: ((id: Wid) => Wid | undefined) | undefined;
  try { contactGetters = modules.require("WAWebFrontendContactGetters"); } catch { warnings++; }
  try { toPn = modules.require("WAWebLidMigrationUtils").toPn; } catch { /* Preserve unresolved LIDs. */ }
  const contacts = new Map<string, DiscoveredContact>();
  const bySourceId = new Map<string, DiscoveredContact>();
  for (const item of store.Contact.getModelsArray()) {
    if (!directIdPattern.test(item.id?._serialized || "")) continue;
    let whatsappId = item.id._serialized;
    if (whatsappId.endsWith("@lid")) {
      const phone = item.phoneNumber?._serialized;
      if (phone && directIdPattern.test(phone) && phone.endsWith("@c.us")) whatsappId = phone;
      else { try { const mapped = toPn?.(item.id)?._serialized; if (mapped && directIdPattern.test(mapped) && mapped.endsWith("@c.us")) whatsappId = mapped; } catch { /* Keep the private ID. */ } }
    }
    let isMyContact = item.isMyContact === true;
    try {
      if (contactGetters && "getIsMyContact" in contactGetters) isMyContact = contactGetters.getIsMyContact(item);
    } catch { warnings++; }
    const contact = { whatsappId, name: item.name || item.pushname || null, isMyContact,
      aliases: [...new Set([item.id._serialized, whatsappId])] };
    bySourceId.set(item.id._serialized, contact);
    const previous = contacts.get(contact.whatsappId);
    contacts.set(contact.whatsappId, { ...contact, name: previous?.name || contact.name, isMyContact: contact.isMyContact || previous?.isMyContact || false,
      aliases: [...new Set([...(previous?.aliases || []), ...contact.aliases])] });
  }
  const chats = store.Chat.getModelsArray();
  if (groupId) {
    const chat = chats.find(item => item.id?._serialized === groupId);
    if (!chat || !groupId.endsWith("@g.us")) throw new Error("Selected group is no longer available to this account.");
    const metadataStore = store.GroupMetadata || store.WAWebGroupMetadataCollection;
    if (!metadataStore) throw new Error("WhatsApp did not expose the group metadata store. Reconnect and try again.");
    await metadataStore.update(chat.id);
    const metadata = chat.groupMetadata || metadataStore.get?.(groupId);
    if (!metadata?.participants?.getModelsArray) throw new Error("WhatsApp did not expose the participant list. Existing members were kept.");
    const members = new Map<string, DiscoveredContact>();
    for (const participant of metadata.participants.getModelsArray()) {
      if (!directIdPattern.test(participant.id?._serialized || "")) continue;
      let whatsappId = participant.id._serialized;
      if (whatsappId.endsWith("@lid")) {
        try { const mapped = toPn?.(participant.id)?._serialized; if (mapped && directIdPattern.test(mapped) && mapped.endsWith("@c.us")) whatsappId = mapped; } catch { /* Keep the private ID. */ }
      }
      const member = bySourceId.get(participant.id._serialized) || { whatsappId, name: null, isMyContact: false,
        aliases: [...new Set([participant.id._serialized, whatsappId])] };
      const previous = members.get(member.whatsappId);
      members.set(member.whatsappId, { ...member, aliases: [...new Set([...(previous?.aliases || []), ...(member.aliases || [])])] });
    }
    return { contacts: [], groups: [], warnings, participants: [...members.values()] };
  }
  const groups: DiscoveredGroup[] = [];
  for (const chat of chats) {
    const whatsappId = chat.id?._serialized;
    if (whatsappId && directIdPattern.test(whatsappId)) {
      let destination = whatsappId;
      if (destination.endsWith("@lid")) {
        try { const mapped = toPn?.(chat.id)?._serialized; if (mapped && directIdPattern.test(mapped) && mapped.endsWith("@c.us")) destination = mapped; } catch { /* Keep the private ID. */ }
      }
      const previous = contacts.get(destination) || bySourceId.get(whatsappId);
      contacts.set(previous?.whatsappId || destination, { whatsappId: previous?.whatsappId || destination,
        name: previous?.name || chat.name || chat.formattedTitle || null, isMyContact: previous?.isMyContact || false,
        aliases: [...new Set([...(previous?.aliases || []), whatsappId, destination])] });
      continue;
    }
    if (!whatsappId?.endsWith("@g.us")) continue;
    groups.push({ whatsappId, name: chat.name || chat.formattedTitle || chat.groupMetadata?.subject || whatsappId,
      participantCount: chat.groupMetadata?.participants?.getModelsArray?.().length ?? null });
  }
  return { contacts: [...contacts.values()], groups, warnings, participants: null };
}
