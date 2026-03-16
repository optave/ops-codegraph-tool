#!/usr/bin/env node

import { run } from './cli/index.js';
import { CodegraphError } from './shared/errors.js';

run().catch((err) => {
  if (err instanceof CodegraphError) {
    console.error(`codegraph [${err.code}]: ${err.message}`);
    if (err.file) console.error(`  file: ${err.file}`);
  } else {
    console.error(`codegraph: fatal error — ${err.message || err}`);
  }
  process.exit(1);
});
