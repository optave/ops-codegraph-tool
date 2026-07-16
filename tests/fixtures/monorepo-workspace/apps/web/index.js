import { add, multiply } from '@myorg/lib';

export function calculate(a, b) {
  return add(a, b) + multiply(a, b);
}
