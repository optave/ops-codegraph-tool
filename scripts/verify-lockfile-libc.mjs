#!/usr/bin/env node
// Verifies that @optave/codegraph-linux-* entries in package-lock.json declare
// the `libc` discriminator. npm 11 silently strips this field when generating
// the lockfile on non-Linux hosts (and sometimes on Linux too), even though the
// published packages declare it. Without it, npm cannot disambiguate
// linux-x64-gnu vs linux-x64-musl when resolving from the lockfile and may
// install (or load) the wrong native binary on Alpine/musl hosts.
//
// Run via `npm run lint` (or directly) in CI to catch silent regressions from
// Dependabot bumps and contributor `npm install` runs.
import { readFileSync } from 'node:fs';

const EXPECTED_LIBC = {
  '@optave/codegraph-linux-arm64-gnu': 'glibc',
  '@optave/codegraph-linux-x64-gnu': 'glibc',
  '@optave/codegraph-linux-x64-musl': 'musl',
};

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const failures = [];

for (const [pkgName, expectedLibc] of Object.entries(EXPECTED_LIBC)) {
  const entry = lock.packages?.[`node_modules/${pkgName}`];
  if (!entry) {
    failures.push(`${pkgName}: missing from package-lock.json`);
    continue;
  }
  const libc = entry.libc;
  if (!Array.isArray(libc) || !libc.includes(expectedLibc)) {
    failures.push(
      `${pkgName}: expected libc=["${expectedLibc}"], got ${JSON.stringify(libc)}`,
    );
  }
}

if (failures.length > 0) {
  console.error('package-lock.json libc discriminator check failed:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nnpm install may have stripped the libc field. Restore it by editing\n' +
      'package-lock.json so each @optave/codegraph-linux-* entry includes\n' +
      'its libc field (see expected values above). Tracked in #1160.',
  );
  process.exit(1);
}

console.log('package-lock.json libc discriminators OK');
