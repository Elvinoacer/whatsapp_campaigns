export type DeliveryRecord = { status: string; _count?: { replies: number }; replies?: unknown[] };
export type DeliveryTotals = ReturnType<typeof deliveryTotals>;
export const unconfirmedSend = "WhatsApp did not return a message receipt. The message may have been sent; it will not be retried automatically to avoid duplicates.";

export function deliveryFeedback(delivery: { status: string; error?: string | null }) {
  if (delivery.status === "UNKNOWN" && /Cannot read properties of (?:undefined|null).*ack/i.test(delivery.error || ""))
    return unconfirmedSend;
  return delivery.error;
}
export function deliveryTotals(deliveries: DeliveryRecord[]) {
  const totals = { total: deliveries.length, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, uncertain: 0, skipped: 0, replies: 0, replied: 0 };
  for (const delivery of deliveries) {
    if (["QUEUED", "SENDING"].includes(delivery.status)) totals.pending++;
    if (["SENT", "DELIVERED", "READ"].includes(delivery.status)) totals.sent++;
    if (["DELIVERED", "READ"].includes(delivery.status)) totals.delivered++;
    if (delivery.status === "READ") totals.read++;
    if (delivery.status === "FAILED") totals.failed++;
    if (delivery.status === "UNKNOWN") totals.uncertain++;
    if (delivery.status === "SKIPPED") totals.skipped++;
    const replies = delivery._count?.replies ?? delivery.replies?.length ?? 0;
    totals.replies += replies;
    if (replies) totals.replied++;
  }
  return totals;
}
