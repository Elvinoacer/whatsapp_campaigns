import type { Client as WhatsAppClient } from "whatsapp-web.js";
import type { Prisma } from "@prisma/client";
import type Redis from "ioredis";
import { groupSyncStateKey, syncStateKey, type SyncState } from "../lib/sync-state";
import { errorMessage } from "./browser";
import { db } from "../lib/db";
import { readWhatsApp } from "./browser";
import { discoverWhatsApp, type DiscoveredContact } from "./discovery";
import { stableContactIdentity } from "./identity";
import { isDirectWhatsAppId } from "../lib/whatsapp-id";

function phoneFromId(id: string): string | null {
  if (!id.endsWith("@c.us")) return null;
  const phone = id.split("@")[0];
  return /^\d{8,15}$/.test(phone) ? phone : null;
}

export async function saveDiscoveredContacts(tx: Pick<Prisma.TransactionClient, "contact">, sessionId: string, contacts: DiscoveredContact[]) {
  const identities = contacts.map(contact => [...new Set([contact.whatsappId, ...(contact.aliases || [])])].filter(isDirectWhatsAppId));
  const allIds = [...new Set(identities.flat())];
  const existing = await tx.contact.findMany({ where: { whatsappId: { in: allIds }, OR: [{ sessionId }, { consent: "OPTED_OUT" }] },
    select: { id: true, sessionId: true, whatsappId: true, consent: true, consentAt: true, consentNote: true } });
  const byId = new Map(existing.filter(contact => contact.sessionId === sessionId).map(contact => [contact.whatsappId, contact]));
  const suppressed = new Set(existing.filter(contact => contact.consent === "OPTED_OUT").map(contact => contact.whatsappId));
  // Preserve STOP across a verified phone/private-ID mapping, including a
  // suppression received on another connected account.
  let changed = true;
  while (changed) {
    changed = false;
    for (const ids of identities) if (ids.some(id => suppressed.has(id))) for (const id of ids) {
      if (!suppressed.has(id)) { suppressed.add(id); changed = true; }
    }
  }
  const suppression = { consent: "OPTED_OUT" as const, consentAt: null, consentNote: "Opt-out preserved for linked WhatsApp identities" };
  const suppressedIds = [...suppressed];
  for (let start = 0; start < suppressedIds.length; start += 500) await tx.contact.updateMany({
    where: { whatsappId: { in: suppressedIds.slice(start, start + 500) }, consent: { not: "OPTED_OUT" } }, data: suppression,
  });
  const savedIds = new Set<string>();
  for (const [index, item] of contacts.entries()) {
    const ids = identities[index];
    if (!ids.length) continue;
    const old = stableContactIdentity(ids, ids.flatMap(id => byId.get(id) ? [byId.get(id)!] : []));
    const whatsappId = old?.whatsappId || ids[0];
    const phone = ids.map(phoneFromId).find(value => value !== null) || null;
    const contact = await tx.contact.upsert({
      where: { sessionId_whatsappId: { sessionId, whatsappId } },
      create: { sessionId, whatsappId, phone, name: item.name, isMyContact: item.isMyContact,
        ...(suppressed.has(whatsappId) ? suppression : {}) },
      update: { phone, name: item.name || undefined, isMyContact: item.isMyContact, lastSyncedAt: new Date(),
        ...(suppressed.has(whatsappId) && old?.consent !== "OPTED_OUT" ? suppression : {}) },
    });
    savedIds.add(contact.id);
  }
  return [...savedIds];
}

export async function sync(sessionId: string, client: WhatsAppClient | undefined, current: () => boolean) {
  const session = await db.waSession.findUnique({ where: { id: sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the WhatsApp session first");
  const { contacts, groups, warnings } = await readWhatsApp(client,
    () => client.pupPage!.evaluate(discoverWhatsApp), current);
  const savedContacts = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    return saveDiscoveredContacts(tx, sessionId, contacts);
  }, { timeout: 60000 });
  const importedContacts = savedContacts.length;
  let importedGroups = 0;
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
export async function syncGroupMembers(groupId: string, getClient: (id: string) => WhatsAppClient | undefined, segmentIds: string[] = []) {
  const group = await db.waGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new Error("Group does not exist");
  const client = getClient(group.sessionId);
  const session = await db.waSession.findUnique({ where: { id: group.sessionId } });
  if (!client || session?.status !== "CONNECTED") throw new Error("Connect the group WhatsApp session first");
  const { participants } = await readWhatsApp(client,
    () => client.pupPage!.evaluate(discoverWhatsApp, group.whatsappId), () => getClient(group.sessionId) === client);
  if (!participants) throw new Error("WhatsApp Web did not expose the participant list for this group");
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342101)`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7342102)`;
    if (await tx.segment.count({ where: { id: { in: [...new Set(segmentIds)] } } }) !== new Set(segmentIds).size) throw new Error("A selected segment was deleted. Choose the segments again.");
    const memberIds = await saveDiscoveredContacts(tx, group.sessionId, participants);
    await tx.groupMember.deleteMany({ where: { groupId } });
    if (memberIds.length)
      await tx.groupMember.createMany({ data: memberIds.map(contactId => ({ groupId, contactId })), skipDuplicates: true });
    for (const segmentId of new Set(segmentIds)) {
      for (let start = 0; start < memberIds.length; start += 1000) {
        await tx.segmentMember.createMany({ data: memberIds.slice(start, start + 1000).map(contactId => ({ segmentId, contactId })), skipDuplicates: true });
      }
    }
    await tx.waGroup.update({ where: { id: groupId }, data: { participantCount: participants.length, lastSyncedAt: new Date() } });
    await tx.auditLog.create({ data: { action: "group.members_synced", details: { groupId, count: memberIds.length } } });
  }, { timeout: 60000 });
  return `Saved ${participants.length} group ${participants.length === 1 ? "contact" : "contacts"} to Contacts.${segmentIds.length ? ` Added to ${new Set(segmentIds).size} segments.` : ""}`;
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
