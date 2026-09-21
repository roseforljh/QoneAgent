export type EventListener<E> = (event: E) => void;

/** Small synchronous typed bus used inside the sidecar. */
export class EventBus<E extends { type: string }> {
  private listeners = new Set<EventListener<E>>();

  subscribe(listener: EventListener<E>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: E): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** Bounded ordered journal used to resume event streams after reconnect. */
export class SequencedEventJournal<E extends { sequence: number; sessionId?: string }> {
  private events: E[] = [];
  private nextSequence: number;

  constructor(startSequence = 0, private capacity = 2000) {
    this.nextSequence = startSequence;
  }

  record(factory: (sequence: number) => E): E {
    const event = factory(this.nextSequence++);
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return event;
  }

  replay(afterSequence = -1, sessionId?: string): E[] {
    return this.events.filter((event) => event.sequence > afterSequence && (!sessionId || event.sessionId === sessionId));
  }

  get next(): number {
    return this.nextSequence;
  }

  restore(events: readonly E[]): void {
    this.events = [...events].sort((a, b) => a.sequence - b.sequence).slice(-this.capacity);
    const highest = this.events.at(-1)?.sequence;
    if (highest !== undefined) this.nextSequence = Math.max(this.nextSequence, highest + 1);
  }
}
