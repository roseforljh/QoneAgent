import { AsyncLocalStorage } from "node:async_hooks";

export type MediaPhase = "started" | "completed";
type Reporter = (phase: MediaPhase) => void;

const reporters = new AsyncLocalStorage<Reporter>();

export function withMediaPhaseReporter<T>(reporter: Reporter, work: () => T): T {
  return reporters.run(reporter, work);
}

export function reportMediaPhase(phase: MediaPhase): void {
  reporters.getStore()?.(phase);
}
