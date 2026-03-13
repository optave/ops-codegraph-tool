#!/usr/bin/env node

import { run } from './cli/index.js';

run().catch((err) => {
  console.error(`codegraph: fatal error — ${err.message || err}`);
  process.exit(1);
});
