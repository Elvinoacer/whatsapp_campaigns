import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), query: vi.fn() }));
vi.mock("../lib/db", () => ({ db: {
  $transaction: async (operation: (tx: unknown) => Promise<void>) => operation({
    $queryRaw: mocks.query,
    contact: { findFirst: mocks.findFirst, upsert: mocks.upsert, updateMany: mocks.updateMany },
  }),
  waSession: { findUnique: async () => null },
} }));
import { recordOptOut } from "../worker/events";

beforeEach(() => { vi.resetAllMocks(); mocks.findFirst.mockResolvedValue(null); });
describe("recovered opt-out decisions", () => {
  it("preserves a later renewed opt-in from another account without creating a new suppression", async () => {
    mocks.findFirst.mockResolvedValue({ id: "renewed-on-other-account" });
    const receivedAt = new Date("2026-10-25T10:00:00Z");
    await recordOptOut("sender", "200@lid", "STOP", ["254700000001@c.us"], receivedAt);
    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({
      whatsappId: { in: ["200@lid", "254700000001@c.us"] }, consent: "OPTED_IN", consentAt: { gt: receivedAt },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("suppresses historical STOP across verified identities when there is no newer opt-in", async () => {
    await recordOptOut("sender", "200@lid", "Please stop", ["254700000001@c.us"], new Date());
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany.mock.calls[0][0]).toMatchObject({
      where: { whatsappId: { in: ["200@lid", "254700000001@c.us"] } }, data: { consent: "OPTED_OUT" },
    });
  });
  it("continues to honor a fresh STOP regardless of earlier opt-in", async () => {
    mocks.findFirst.mockResolvedValue({ id: "previous-opt-in" });
    await recordOptOut("sender", "200@lid", "STOP");
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledOnce();
  });
});
