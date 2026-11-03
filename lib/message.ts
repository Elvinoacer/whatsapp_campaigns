export function personalize(message: string, recipient: {
  name?: string | null;
  phone?: string | null;
  groupName?: string | null;
  label?: string | null;
  timezone?: string | null;
  now?: Date;
}) {
  return message.replace(/\{\{\s*(first_name|name|phone|group_name|date)\s*\}\}/g, (_, key: string) => {
    if (key === "phone") return recipient.phone || "";
    if (key === "group_name") return recipient.groupName?.trim() || recipient.label?.trim() || "";
    if (key === "date") {
      try {
        return new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          ...(recipient.timezone ? { timeZone: recipient.timezone } : {}),
        }).format(recipient.now || new Date());
      } catch {
        return (recipient.now || new Date()).toISOString().slice(0, 10);
      }
    }
    const name = recipient.name?.trim() || "there";
    return key === "first_name" ? name.split(/\s+/)[0] : name;
  });
}

/** An internal session label is never a customer-facing business identity. */
export function publicSenderName(session: { publicSenderName?: string | null }, workspaceName?: string | null) {
  return session.publicSenderName?.trim() || workspaceName?.trim() || "";
}

export const MISSING_SENDER_NAME = "Set a public sender name in WhatsApp sessions → Edit account before using a signed sender footer.";

export function campaignMessage(message: string, senderName: string, individual = true, includeFooter = true) {
  if (!individual || !includeFooter) return message.trim() ? message : message;
  const identity = senderName.trim();
  if (!identity) return `${message.trim()}\n\nReply STOP to unsubscribe.`;
  return `${message.trim()}\n\n${identity}\nReply STOP to unsubscribe.`;
}
