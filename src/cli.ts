#!/usr/bin/env node

import { run } from './cli/index.js';
import { disposeParsers } from './domain/parser.js';
import { CodegraphError, toErrorMessage } from './shared/errors.js';

/**
 * After the CLI command finishes, tear down any cached WASM parsers and the
 * worker thread pool. The WASM parse worker (see `domain/wasm-worker-pool.ts`)
 * keeps the event loop alive until `worker.terminate()` is called, so without
 * this teardown short-lived commands like `codegraph build` would hang for
 * minutes before Node gives up — surfacing in CI as `spawnSync ETIMEDOUT`
 * even though the command's work is already complete.
 *
 * `disposeParsers` is safe to call when the pool was never instantiated
 * (e.g. native engine, or commands that never parse): it no-ops cleanly.
 */
async function shutdown(): Promise<void> {
  try {
    await disposeParsers();
  } catch {
    /* don't mask the real exit status over a teardown failure */
  }
}

run()
  .then(shutdown)
  .catch(async (err: unknown) => {
    if (err instanceof CodegraphError) {
      console.error(`codegraph [${err.code}]: ${err.message}`);
      if (err.file) console.error(`  file: ${err.file}`);
    } else {
      console.error(`codegraph: fatal error — ${toErrorMessage(err)}`);
    }
    await shutdown();
    process.exit(1);
  });
