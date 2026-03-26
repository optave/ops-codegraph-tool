#!/usr/bin/env node

import { run } from './cli/index.js';
import { CodegraphError, toErrorMessage } from './shared/errors.js';

run().catch((err: unknown) => {
  if (err instanceof CodegraphError) {
    console.error(`codegraph [${err.code}]: ${err.message}`);
    if (err.file) console.error(`  file: ${err.file}`);
  } else {
    console.error(`codegraph: fatal error — ${toErrorMessage(err)}`);
  }
  process.exit(1);
});
