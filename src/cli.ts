#!/usr/bin/env node

import { run } from './cli/index.js';
import { CodegraphError } from './shared/errors.js';

run().catch((err: unknown) => {
  if (err instanceof CodegraphError) {
    console.error(`codegraph [${err.code}]: ${err.message}`);
    if (err.file) console.error(`  file: ${err.file}`);
  } else {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`codegraph: fatal error — ${message}`);
  }
  process.exit(1);
});
