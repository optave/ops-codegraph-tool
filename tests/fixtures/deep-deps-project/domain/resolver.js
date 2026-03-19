import { DEFAULT_NAME } from '../shared/constants.js';
import { formatName } from '../shared/helpers.js';

export function resolve(input) {
  const name = input || DEFAULT_NAME;
  return formatName(name);
}
