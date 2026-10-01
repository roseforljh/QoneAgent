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
  private oldest = 0;
  private nextSequence: number;

  constructor(startSequence = 0, private capacity = 2000) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new RangeError("Journal capacity must be a non-negative integer");
    this.nextSequence = startSequence;
  }

  record(factory: (sequence: number) => E): E {
    const event = factory(this.nextSequence++);
    if (this.events.length < this.capacity) this.events.push(event);
    else if (this.capacity > 0) {
      this.events[this.oldest] = event;
      this.oldest = (this.oldest + 1) % this.capacity;
    }
    return event;
  }

  replay(afterSequence = -1, sessionId?: string): E[] {
    const matches: E[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[(this.oldest + i) % this.events.length]!;
      if (event.sequence > afterSequence && (!sessionId || event.sessionId === sessionId)) matches.push(event);
    }
    return matches;
  }

  get next(): number {
    return this.nextSequence;
  }

  restore(events: readonly E[]): void {
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    this.events = this.capacity > 0 ? ordered.slice(-this.capacity) : [];
    this.oldest = 0;
    const highest = ordered.at(-1)?.sequence;
    if (highest !== undefined) this.nextSequence = Math.max(this.nextSequence, highest + 1);
  }
}
