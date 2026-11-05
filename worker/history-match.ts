import { personalize } from "../lib/message";
import { serializedMessageId, type RawMessageKey } from "./receipt-identity";

// Historical send recovery is deliberately conservative. A chat message is
// evidence only when its full text, direction, timestamp and identifier match
// exactly one database reservation. A message merely existing in WhatsApp is
// not proof that the campaign sent it.
export type HistoryMessage = {
  id?: RawMessageKey;
  from?: string;
  type?: string;
  isNotification?: boolean;
  fromMe?: boolean;
  body?: string;
  timestamp?: number;
  ack?: number;
  hasMedia?: boolean;
  hasQuotedMsg?: boolean;
  getQuotedMessage?: () => Promise<{ id?: RawMessageKey } | undefined>;
};
export type HistoryAttempt = {
  id: string;
  attemptedAt: Date;
  expectedText: string | null;
};
export const HISTORY_WINDOW_BEFORE_MS = 120_000;
export const HISTORY_WINDOW_AFTER_MS = 15 * 60_000;

export function reconstructHistoricalText(snapshot: string | null, recipient: { name?: string | null; phone?: string | null }) {
  if (!snapshot?.trim()) return null;
  const text = personalize(snapshot, recipient);
  // Unknown placeholders must not be treated as a definitive match.
  return /\{\{[^}]*\}\}/.test(text) ? null : text;
}

export function matchHistoricalMessages(attempts: HistoryAttempt[], messages: HistoryMessage[], reservedIds: ReadonlySet<string> = new Set()) {
  const edges = new Map<string, string[]>();
  const matches = new Map<string, HistoryMessage>();
  for (const attempt of attempts) {
    if (!attempt.expectedText) continue;
    const possible = messages.filter(message => {
      const id = serializedMessageId(message.id);
      if (!id || reservedIds.has(id) || !message.fromMe || !(Number(message.ack) >= 1)
          || !Number.isFinite(message.timestamp) || message.body !== attempt.expectedText) return false;
      const distance = message.timestamp! * 1000 - attempt.attemptedAt.getTime();
      return distance >= -HISTORY_WINDOW_BEFORE_MS && distance <= HISTORY_WINDOW_AFTER_MS;
    });
    const possibleIds = possible.map(item => serializedMessageId(item.id)!);
    edges.set(attempt.id, possibleIds);
    for (const item of possible) matches.set(serializedMessageId(item.id)!, item);
  }
  const usage = new Map<string, number>();
  for (const ids of edges.values()) for (const id of ids) usage.set(id, (usage.get(id) || 0) + 1);
  return new Map([...edges].flatMap(([attemptId, ids]) =>
    ids.length === 1 && usage.get(ids[0]) === 1 ? [[attemptId, matches.get(ids[0])!]] as const : []));
}
