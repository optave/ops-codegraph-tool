import type { IJob } from './IJob.js';

// Abstract middle tier — never instantiated directly.
// CHA transitive expansion must pass through this class to reach subclasses.
export abstract class AbstractJob implements IJob {
  abstract run(): string;
}
