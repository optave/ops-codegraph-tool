import { parseItems } from '../domain/index.js';
import { paginate } from '../shared/helpers.js';
import { clamp } from '../shared/constants.js';

export function runQuery(raw, page) {
  const items = parseItems(raw);
  const safePage = clamp(page, 0, 100);
  return paginate(items, safePage, 10);
}
