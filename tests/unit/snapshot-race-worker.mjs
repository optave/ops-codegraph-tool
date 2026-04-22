// Worker entry used by snapshot.test.ts to create genuine concurrency
// between two snapshotSave calls. better-sqlite3 is synchronous, so
// Promise-based concurrency cannot exercise the TOCTOU race — only
// separate threads can.
//
// This file is .mjs so Node loads it directly without a TypeScript loader;
// it imports the compiled dist build when available, falling back to the
// TS source via the project's ts-resolve-hooks when running under vitest
// (which propagates the strip-types flag to workers via NODE_OPTIONS).

import { parentPort, workerData } from 'node:worker_threads';

const { dbPath, name, force } = workerData;

try {
  const mod = await import('../../src/features/snapshot.ts');
  mod.snapshotSave(name, { dbPath, force });
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
}
