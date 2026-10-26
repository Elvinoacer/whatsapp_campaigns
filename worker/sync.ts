import type { Client as WhatsAppClient } from "whatsapp-web.js";
import type Redis from "ioredis";
import { groupSyncStateKey, syncStateKey, type SyncState } from "../lib/sync-state";
import { errorMessage } from "./browser";
import { db } from "../lib/db";
import { readWhatsApp } from "./browser";
import { discoverWhatsApp } from "./discovery";

function phoneFromId(id: string): string | null {
  if (!id.endsWith("@c.us")) return null;
  const phone = id.split("@")[0];
  return /^\d{8,15}$/.test(phone) ? phone : null;
}
export async function sync(sessionId: string, client: WhatsAppClient | undefined, current: () => boolean) {
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the WhatsApp session first");
  const { contacts, groups, warnings } = await readWhatsApp(client,
    () => client.pupPage!.evaluate(discoverWhatsApp), current);
  let importedContacts = 0;
  let importedGroups = 0;
  for (const item of contacts) {
    const whatsappId = item.whatsappId;
    await db.contact.upsert({
      where: { sessionId_whatsappId: { sessionId, whatsappId } },
      create: { sessionId, whatsappId, phone: phoneFromId(whatsappId),
        name: item.name, isMyContact: item.isMyContact },
      update: { phone: phoneFromId(whatsappId),
        name: item.name || undefined, isMyContact: item.isMyContact, lastSyncedAt: new Date() },
    });
    importedContacts++;
  }
  for (const chat of groups) {
    const whatsappId = chat.whatsappId;
    const count = chat.participantCount;
    await db.waGroup.upsert({
      where: { sessionId_whatsappId: { sessionId, whatsappId } },
      create: { sessionId, whatsappId, name: chat.name, participantCount: count ?? 0 },
      update: { name: chat.name, ...(count === null ? {} : { participantCount: count }), lastSyncedAt: new Date() },
    });
    importedGroups++;
  }
  await db.auditLog.create({ data: { action: "session.synced", details: { sessionId, importedContacts, importedGroups, warnings } } });
  return `Synced ${importedContacts} contacts and ${importedGroups} groups.${warnings ? ` ${warnings} optional fields were unavailable.` : ""}`;
}
export async function syncGroupMembers(groupId: string, getClient: (id: string) => WhatsAppClient | undefined) {
  const group = await db.waGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new Error("Group does not exist");
  const client = getClient(group.sessionId);
  const session = await db.waSession.findUnique({ where: { id: group.sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the group WhatsApp session first");
  const { participants } = await readWhatsApp(client,
    () => client.pupPage!.evaluate(discoverWhatsApp, group.whatsappId), () => getClient(group.sessionId) === client);
  if (!participants) throw new Error("WhatsApp Web did not expose the participant list for this group");
  await db.$transaction(async tx => {
    const memberIds: string[] = [];
    for (const participant of participants) {
      const whatsappId = participant.whatsappId;
      const contact = await tx.contact.upsert({
        where: { sessionId_whatsappId: { sessionId: group.sessionId, whatsappId } },
        create: { sessionId: group.sessionId, whatsappId, phone: phoneFromId(whatsappId), name: participant.name, isMyContact: participant.isMyContact },
        update: { ...(participant.name ? { name: participant.name } : {}), lastSyncedAt: new Date() },
      });
      memberIds.push(contact.id);
    }
    await tx.groupMember.deleteMany({ where: { groupId } });
    if (memberIds.length)
      await tx.groupMember.createMany({ data: memberIds.map(contactId => ({ groupId, contactId })), skipDuplicates: true });
    await tx.waGroup.update({ where: { id: groupId }, data: { participantCount: participants.length, lastSyncedAt: new Date() } });
    await tx.auditLog.create({ data: { action: "group.members_synced", details: { groupId, count: memberIds.length } } });
  }, { timeout: 60000 });
  return `Saved ${participants.length} group ${participants.length === 1 ? "contact" : "contacts"} to Contacts.`;
}

export async function trackedSync(sessionId: string, kind: SyncState["kind"], run: () => Promise<string>, redis: Redis, queueName: string, groupId?: string) {
  const keys = [syncStateKey(queueName, sessionId), ...(groupId ? [groupSyncStateKey(queueName, groupId)] : [])];
  const save = (phase: SyncState["phase"], message: string) => Promise.all(keys.map(key => redis.set(key,
    JSON.stringify({ phase, kind, message, updatedAt: new Date().toISOString() } satisfies SyncState), "EX", 86400)));
  await save("RUNNING", kind === "directory" ? "Syncing contacts and groups…" : "Saving group members to Contacts…");
  try {
    const message = await run();
    await db.waSession.updateMany({ where: { id: sessionId, status: "CONNECTED" }, data: { error: null } });
    await save("COMPLETED", message);
  } catch (error) {
    const message = `Sync failed: ${errorMessage(error)}. Reconnect the account and try again.`;
    try {
      await db.waSession.updateMany({ where: { id: sessionId, status: "CONNECTED" }, data: { error: message.slice(0, 400) } });
      await db.auditLog.create({ data: { action: "session.sync_failed", details: { sessionId, kind, message } } });
    } catch (statusError) { console.error("Could not record sync failure", errorMessage(statusError)); }
    await save("FAILED", message);
    throw error;
  } finally { await redis.del(...keys.map(key => key + ":queued")); }
}
