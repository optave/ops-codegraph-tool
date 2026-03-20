import { parseItems } from '../domain/index.js';
import { clamp } from '../shared/constants.js';
import { paginate } from '../shared/helpers.js';

export function runQuery(raw, page) {
  const items = parseItems(raw);
  const safePage = clamp(page, 0, 100);
  return paginate(items, safePage, 10);
}
