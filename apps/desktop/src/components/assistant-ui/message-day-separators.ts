import type { PairableMessage } from "./message-pairing";

export interface DatedPairableMessage extends PairableMessage {
  createdAt: Date;
}

function localDay(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Dates follow the last visible row of each past day; a paired turn starts on its user's date. */
export function messageDaySeparators(
  messages: readonly DatedPairableMessage[],
  pairedUserIdByAssistant: ReadonlyMap<string, string>,
  today = new Date(),
) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const pairedUserIds = new Set(pairedUserIdByAssistant.values());
  const separators = new Map<string, Date>();
  const todayDay = localDay(today);
  let previous: { id: string; date: Date; day: string } | undefined;

  for (const message of messages) {
    if (message.role === "user" && pairedUserIds.has(message.id)) continue;
    const pairedUser = byId.get(pairedUserIdByAssistant.get(message.id) ?? "");
    const date = pairedUser?.createdAt ?? message.createdAt;
    const day = localDay(date);
    if (previous && day !== previous.day && previous.day !== todayDay) {
      separators.set(previous.id, previous.date);
    }
    previous = { id: message.id, date, day };
  }
  if (previous && previous.day !== todayDay) separators.set(previous.id, previous.date);

  return separators;
}
