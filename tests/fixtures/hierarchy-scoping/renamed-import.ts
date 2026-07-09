import { Repository as BaseRepo } from './moduleA/Base.js';

// #1812 Greptile follow-up: `Repository` is imported under the local alias
// `BaseRepo`. moduleA/Base.ts exports the symbol as `Repository`, not
// `BaseRepo` — the resolver must look up the *original* exported name in the
// imported file, not the local alias, or the edge is silently dropped.
export class RenamedConsumer extends BaseRepo {}
