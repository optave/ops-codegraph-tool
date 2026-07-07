// Mixed statement: inline `type` modifier applied to individual specifiers
// (Repository, Widget) alongside plain value specifiers (openRepo,
// computeSize) in one import — the real-world pattern from this repo's own
// `db/index.ts` consumers (#1813). Ordering of the modifier within a
// specifier list is covered separately at the extractor unit-test level
// (tests/parsers/javascript.test.ts).
import { computeSize, openRepo, type Repository, type Widget } from './types.js';

export function useRepo(): Repository {
  return openRepo();
}

export function useWidget(): Widget {
  return { size: computeSize() };
}
