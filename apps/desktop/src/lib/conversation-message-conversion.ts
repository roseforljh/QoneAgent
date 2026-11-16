import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage } from "../store";
import type { MessageConversionContext } from "./runtime-message-converter";

type Convert = (message: ChatMessage, context: MessageConversionContext) => ThreadMessageLike;

export interface ConversionMemo {
  messages: readonly ChatMessage[];
  context: readonly unknown[];
  converted: ThreadMessageLike[];
}

/**
 * Streaming rewrites the tail row on every flush while the history in front of
 * it stays identical. Reuse the converted identities outside the changed rows
 * so a long conversation costs pointer compares, not a full dependency rebuild
 * per message.
 */
export function memoizeConvertedMessages(
  messages: readonly ChatMessage[],
  context: MessageConversionContext,
  dependencies: readonly unknown[],
  convert: Convert,
  memo: { current: ConversionMemo | undefined },
): ThreadMessageLike[] {
  const previous = memo.current;
  const reusable = previous
    && previous.context.length === dependencies.length
    && dependencies.every((value, index) => Object.is(value, previous.context[index]));
  if (reusable) {
    const previousLength = previous.messages.length;
    let head = 0;
    while (head < previousLength && head < messages.length && previous.messages[head] === messages[head]) head++;
    if (head === messages.length) {
      // The live row went away (message.completed): drop its converted tail.
      if (previousLength === messages.length) return previous.converted;
      const converted = previous.converted.slice(0, messages.length);
      memo.current = { messages, context: dependencies, converted };
      return converted;
    }
    // A pure append (message.completed) keeps every earlier row.
    const appended = head === previousLength && messages.length > previousLength;
    let tail = 0;
    if (!appended) {
      while (tail < previousLength - head
        && previous.messages[previousLength - 1 - tail] === messages[messages.length - 1 - tail]) tail++;
    }
    let converted = previous.converted.slice(0, head);
    for (let index = head; index < messages.length - tail; index++) {
      converted.push(convert(messages[index]!, context));
    }
    if (tail) converted = converted.concat(previous.converted.slice(previousLength - tail));
    memo.current = { messages, context: dependencies, converted };
    return converted;
  }
  const converted = messages.map((message) => convert(message, context));
  memo.current = { messages, context: dependencies, converted };
  return converted;
}
