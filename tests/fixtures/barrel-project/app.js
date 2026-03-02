import { add, multiply } from './src/index.js';

export function compute(x, y) {
  return add(x, multiply(x, y));
}
