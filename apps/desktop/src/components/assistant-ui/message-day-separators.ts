import type { PairableMessage } from "./message-pairing";

export interface DatedPairableMessage extends PairableMessage {
  createdAt: Date;
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Dates belong to rendered rows; a paired turn starts on its user's date. */
export function messageDaySeparators(
  messages: readonly DatedPairableMessage[],
  pairedUserIdByAssistant: ReadonlyMap<string, string>,
) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const pairedUserIds = new Set(pairedUserIdByAssistant.values());
  const separators = new Map<string, Date>();
  let previousDay: string | undefined;

  for (const message of messages) {
    if (message.role === "user" && pairedUserIds.has(message.id)) continue;
    const pairedUser = byId.get(pairedUserIdByAssistant.get(message.id) ?? "");
    const date = pairedUser?.createdAt ?? message.createdAt;
    const day = localDay(date);
    if (day !== previousDay) separators.set(message.id, date);
    previousDay = day;
  }

  return separators;
}
