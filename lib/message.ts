export function personalize(message: string, contact: { name?: string | null; phone?: string | null }) {
  return message.replace(/\{\{\s*(first_name|name|phone)\s*\}\}/g, (_, key: string) => {
    if (key === "phone") return contact.phone || "";
    const name = contact.name?.trim() || "there";
    return key === "first_name" ? name.split(/\s+/)[0] : name;
  });
}
