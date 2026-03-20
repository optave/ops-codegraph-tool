import { resolve } from '../domain/resolver.js';
import { DEFAULT_NAME } from '../shared/index.js';

export function formatOutput(input) {
  const resolved = resolve(input);
  return resolved === DEFAULT_NAME ? 'default' : resolved;
}
