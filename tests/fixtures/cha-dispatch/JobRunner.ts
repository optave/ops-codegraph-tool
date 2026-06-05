import type { IJob } from './IJob.js';
import { PrintJob } from './PrintJob.js';
import { ScanJob } from './ScanJob.js';

// worker: IJob — 3-level hierarchy: IJob → AbstractJob → PrintJob / ScanJob.
// CHA transitive BFS must reach PrintJob and ScanJob even though AbstractJob
// sits in the middle and is never instantiated.
function runJob(job: IJob): string {
  return job.run();
}

export function processJobs(): string {
  const p = new PrintJob();
  const s = new ScanJob();
  return runJob(p) + runJob(s);
}
