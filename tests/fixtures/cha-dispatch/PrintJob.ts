import { AbstractJob } from './AbstractJob.js';

export class PrintJob extends AbstractJob {
  run(): string {
    return 'print';
  }
}
