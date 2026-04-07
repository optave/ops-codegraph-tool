/**
 * Dynamic call-tracing driver for the TSX resolution fixture.
 *
 * Imports all modules via __tracer.instrumentExports(), exercises every
 * exported function/method, then dumps captured call edges to stdout.
 *
 * Run via: tsx --import ../tracer/loader-hook.mjs driver.mjs
 */

import * as _app from './App.tsx';
import * as _service from './service.tsx';
import * as _validators from './validators.tsx';

const app = globalThis.__tracer.instrumentExports(_app, 'App.tsx');
const service = globalThis.__tracer.instrumentExports(_service, 'service.tsx');
const validators = globalThis.__tracer.instrumentExports(_validators, 'validators.tsx');

try {
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Exercise App()
  app.App();

  // Direct validator calls
  validators.validateUser('Test', 'test@example.com');
  validators.formatErrors({ valid: false, errors: ['test'] });

  // Direct service calls
  const user = service.createUser('Direct', 'direct@example.com');
  service.getUser(user.id);
  service.listUsers();
  service.removeUser(user.id);

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
