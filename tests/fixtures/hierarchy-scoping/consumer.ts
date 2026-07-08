import { type Readable, Repository } from './moduleA/Base.js';

// #1812: `Repository` is imported specifically from moduleA/Base.ts. The
// hierarchy resolver must link here, not to the unrelated moduleB/Base.ts or
// decoy/Repository.py declarations that happen to share the bare name.
export class UserRepository extends Repository implements Readable {
  read(): void {}
}
