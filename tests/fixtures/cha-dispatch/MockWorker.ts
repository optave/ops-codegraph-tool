import type { IWorker } from './IWorker.js';

export class MockWorker implements IWorker {
  doWork(): string {
    return 'mock';
  }
}
