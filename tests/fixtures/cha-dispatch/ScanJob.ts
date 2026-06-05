import { AbstractJob } from './AbstractJob.js';

export class ScanJob extends AbstractJob {
  run(): string {
    return 'scan';
  }
}
