import { formatOutput } from './features/format.js';
import { runQuery } from './features/query.js';
import { MAX_ITEMS } from './shared/constants.js';

export function main(input, page) {
  const results = runQuery(input, page);
  const label = formatOutput(input);
  return { label, results, max: MAX_ITEMS };
}
