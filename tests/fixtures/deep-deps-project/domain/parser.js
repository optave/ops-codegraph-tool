import { clamp, MAX_ITEMS } from '../shared/index.js';

export function parseItems(raw) {
  const items = raw.split(',').map((s) => s.trim());
  return items.slice(0, clamp(items.length, 0, MAX_ITEMS));
}
