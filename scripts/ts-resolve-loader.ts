/**
 * Registers the .js → .ts ESM resolve hook.
 *
 * Usage: node --experimental-strip-types --import ./scripts/ts-resolve-loader.ts src/cli.ts
 */

import { register } from 'node:module';

register(new URL('./ts-resolve-hooks.ts', import.meta.url));
