import type { IWorker } from './IWorker.js';

export class ConcreteWorker implements IWorker {
  doWork(): string {
    this.prepare();
    return 'done';
  }

  prepare(): void {}
}
