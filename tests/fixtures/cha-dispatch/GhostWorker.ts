import type { IWorker } from './IWorker.js';

// Never instantiated — RTA should exclude this from CHA dispatch targets.
export class GhostWorker implements IWorker {
  doWork(): string {
    return 'ghost';
  }
}
