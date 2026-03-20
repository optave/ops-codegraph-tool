// The deeply-imported leaf file
export const MAX_ITEMS = 100;
export const DEFAULT_NAME = 'codegraph';

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
