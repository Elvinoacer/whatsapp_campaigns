export function personalize(message: string, contact: { name?: string | null; phone?: string | null }) {
  return message.replace(/\{\{\s*(first_name|name|phone)\s*\}\}/g, (_, key: string) => {
    if (key === "phone") return contact.phone || "";
    const name = contact.name?.trim() || "there";
    return key === "first_name" ? name.split(/\s+/)[0] : name;
  });
}

/** An internal session label is never a customer-facing business identity. */
export function publicSenderName(session: { publicSenderName?: string | null }, workspaceName?: string | null) {
  return session.publicSenderName?.trim() || workspaceName?.trim() || "";
}

export const MISSING_SENDER_NAME = "Set a public sender name in WhatsApp sessions → Edit account before sending direct messages.";

export function campaignMessage(message: string, senderName: string, individual = true) {
  if (!individual) return message;
  const identity = senderName.trim();
  if (!identity) throw new Error(MISSING_SENDER_NAME);
  return `${message.trim()}\n\n${identity}\nReply STOP to unsubscribe.`;
}
