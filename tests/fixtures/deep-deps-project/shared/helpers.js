import { clamp, MAX_ITEMS } from './constants.js';

export function paginate(items, page, size) {
  const safeSize = clamp(size, 1, MAX_ITEMS);
  const start = page * safeSize;
  return items.slice(start, start + safeSize);
}

export function formatName(name) {
  return name.trim().toLowerCase();
}
