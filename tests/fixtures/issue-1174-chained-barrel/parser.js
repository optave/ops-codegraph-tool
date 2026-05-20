// Hybrid barrel: has one re-export AND many local definitions.
// Mirrors src/domain/parser.ts in the dogfooded reproduction of #1174:
// the file is flagged as a barrel candidate by the orchestrator (because
// it has ≥1 reexports edge in the DB) yet is *not* barrel-only because
// its local defs outnumber its reexports.
export { Token } from './types/index.js';

import { extractAlpha, extractBeta, extractDelta, extractGamma } from './extractors/index.js';

export function runParser(input) {
  const alpha = extractAlpha(input);
  const beta = extractBeta(input);
  const gamma = extractGamma(input);
  const delta = extractDelta(input);
  return combineResults(alpha, beta, gamma, delta);
}

export function combineResults(a, b, c, d) {
  return [a, b, c, d].join('|');
}

export function describeParser() {
  return 'chained-barrel parser';
}

export function resetParser() {
  return null;
}
