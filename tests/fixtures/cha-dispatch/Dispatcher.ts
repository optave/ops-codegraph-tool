import { ConcreteWorker } from './ConcreteWorker.js';
import type { IWorker } from './IWorker.js';
import { MockWorker } from './MockWorker.js';

// Typed parameter — typeMap will record worker: IWorker (confidence 0.9).
// CHA should expand worker.doWork() to all instantiated IWorker implementations.
function dispatch(worker: IWorker): string {
  return worker.doWork();
}

export function run(): string {
  const w1 = new ConcreteWorker();
  const w2 = new MockWorker();
  // GhostWorker is never instantiated — RTA excludes it from CHA targets.
  return dispatch(w1) + dispatch(w2);
}
