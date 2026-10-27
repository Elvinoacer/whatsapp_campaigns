// A private WhatsApp ID is a destination, not a phone number. Never turn a
// username/display name into a destination by appending a WhatsApp suffix.
export function isDirectWhatsAppId(id: string) {
  return /^(?:\d{8,15}@c\.us|\d{1,30}@lid)$/.test(id);
}
