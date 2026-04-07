/**
 * Dynamic call-tracing driver for the TypeScript resolution fixture.
 *
 * Imports all modules via __tracer.instrumentExports(), exercises every
 * exported function/method, then dumps captured call edges to stdout.
 *
 * Run via: tsx --import ../tracer/loader-hook.mjs driver.mjs
 */

import * as _index from './index.ts';
import * as _repository from './repository.ts';
import * as _serializer from './serializer.ts';
import * as _service from './service.ts';

const index = globalThis.__tracer.instrumentExports(_index, 'index.ts');
const repository = globalThis.__tracer.instrumentExports(_repository, 'repository.ts');
const serializer = globalThis.__tracer.instrumentExports(_serializer, 'serializer.ts');
const service = globalThis.__tracer.instrumentExports(_service, 'service.ts');

try {
  globalThis.__tracer.pushCall('__driver__', 'driver.mjs');

  // Exercise main()
  index.main();

  // Exercise withExplicitType()
  index.withExplicitType();

  // Direct service calls
  const svc = service.createService();
  svc.addUser('{"id":"99","name":"Test","email":"t@t.com"}');
  svc.getUser('99');
  svc.removeUser('99');

  // Direct serializer calls
  const ser = new serializer.JsonSerializer();
  ser.serialize({ id: '1', name: 'A', email: 'a@b.com' });
  ser.deserialize('{"id":"1","name":"A","email":"a@b.com"}');

  // Direct repository calls
  const repo = repository.createRepository();
  repo.save({ id: '1', name: 'A', email: 'a@b.com' });
  repo.findById('1');
  repo.delete('1');

  globalThis.__tracer.popCall();
} catch {
  // Swallow errors — we only care about call edges
}

const edges = globalThis.__tracer.dump();
console.log(JSON.stringify({ edges }, null, 2));
