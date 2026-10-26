import type { Client } from "whatsapp-web.js";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown WhatsApp browser error";
}
export function isNavigationError(error: unknown): boolean {
  return /execution context|context.*destroyed|cannot find context|frame.*detached/i.test(errorMessage(error));
}

/** Read operations may restart after navigation. Never use this for sends. */
export async function readWhatsApp<T>(client: Pick<Client, "pupPage">, read: () => Promise<T>, current = () => true): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!current() || !client.pupPage || client.pupPage.isClosed())
      throw new Error("The WhatsApp session closed. Reconnect it before syncing.");
    try {
      await client.pupPage.waitForFunction(
        "typeof window.WWebJS !== 'undefined' && window.require('WAWebSocketModel').Socket.state === 'CONNECTED'",
        { timeout: 45000 },
      );
      const result = await read();
      if (!current()) throw new Error("The WhatsApp session changed during sync. Please sync again.");
      return result;
    } catch (error) {
      if (attempt >= 2 || !isNavigationError(error)) throw error;
    }
  }
}
