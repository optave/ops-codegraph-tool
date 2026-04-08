/**
 * Dynamic call-tracing driver for the TSX resolution fixture.
 *
 * The loader-hook.mjs load() hook instruments ALL function bodies at the
 * source level (not just exports), so intra-module calls are captured.
 *
 * Run via: tsx --import ../tracer/loader-hook.mjs driver.mjs
 */

import { App } from './App.tsx';
import { createUser, getUser, listUsers, removeUser } from './service.tsx';
import { formatErrors, validateUser } from './validators.tsx';

try {
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Exercise App()
  App();

  // Direct validator calls
  validateUser('Test', 'test@example.com');
  formatErrors({ valid: false, errors: ['test'] });

  // Direct service calls
  const user = createUser('Direct', 'direct@example.com');
  getUser(user.id);
  listUsers();
  removeUser(user.id);

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
