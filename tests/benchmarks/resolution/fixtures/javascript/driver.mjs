/**
 * Dynamic call-tracing driver for the JavaScript resolution fixture.
 *
 * The loader-hook.mjs load() hook instruments ALL function bodies at the
 * source level (not just exports), so intra-module calls like
 * validate→checkLength are captured automatically.
 *
 * This driver just exercises every code path so the tracer records edges.
 *
 * Run via: node --import ../tracer/loader-hook.mjs driver.mjs
 */

import { main, directInstantiation } from './index.js';
import { Logger } from './logger.js';
import { buildService } from './service.js';
import { validate, normalize } from './validators.js';

try {
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Call main() — exercises buildService, createUser, validate, deleteUser
  main();

  // Call directInstantiation() — exercises new UserService, createUser
  directInstantiation();

  // Direct validator calls — exercises checkLength, trimWhitespace
  validate({ name: 'test' });
  normalize({ name: '  test  ' });

  // Direct logger calls — exercises _write
  const log = new Logger('test');
  log.info('test message');
  log.warn('test warning');
  log.error('test error');

  // Direct service calls
  const svc = buildService();
  svc.createUser({ name: 'Direct' });
  svc.deleteUser(99);

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

// Output edges as JSON
const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
