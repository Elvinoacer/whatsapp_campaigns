export type DeliveryRecord = { status: string; _count?: { replies: number } };
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
    totals.replies += delivery._count?.replies || 0;
    if (delivery._count?.replies) totals.replied++;
  }
  return totals;
}
