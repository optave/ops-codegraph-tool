/**
 * Dynamic call-tracing driver for the TypeScript resolution fixture.
 *
 * The loader-hook.mjs load() hook instruments ALL function bodies at the
 * source level (not just exports), so intra-module calls like
 * JsonSerializer.serialize→formatJson are captured automatically.
 *
 * Run via: tsx --import ../tracer/loader-hook.mjs driver.mjs
 */

import { main, withExplicitType } from './index.ts';
import { createRepository } from './repository.ts';
import { JsonSerializer } from './serializer.ts';
import { createService } from './service.ts';

try {
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Exercise main()
  main();

  // Exercise withExplicitType()
  withExplicitType();

  // Direct service calls
  const svc = createService();
  svc.addUser('{"id":"99","name":"Test","email":"t@t.com"}');
  svc.getUser('99');
  svc.removeUser('99');

  // Direct serializer calls
  const ser = new JsonSerializer();
  ser.serialize({ id: '1', name: 'A', email: 'a@b.com' });
  ser.deserialize('{"id":"1","name":"A","email":"a@b.com"}');

  // Direct repository calls
  const repo = createRepository();
  repo.save({ id: '1', name: 'A', email: 'a@b.com' });
  repo.findById('1');
  repo.delete('1');

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
