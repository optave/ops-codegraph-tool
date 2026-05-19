#!/usr/bin/env node
// Verifies that @optave/codegraph-linux-* entries in package-lock.json declare
// the `libc` discriminator. npm 11 silently strips this field when generating
// the lockfile on non-Linux hosts (and sometimes on Linux too), even though the
// published packages declare it. Without it, npm cannot disambiguate
// linux-x64-gnu vs linux-x64-musl when resolving from the lockfile and may
// install (or load) the wrong native binary on Alpine/musl hosts.
//
// The set of packages to check is derived from `optionalDependencies` in
// package.json, so adding a new linux-* platform there automatically extends
// this guard with no script change required. The expected libc value is
// inferred from the package name's `-gnu`/`-musl` suffix (the napi-rs naming
// convention).
//
// Run via `npm run lint` (or directly) in CI to catch silent regressions from
// Dependabot bumps and contributor `npm install` runs.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBC_BY_SUFFIX = {
  gnu: 'glibc',
  musl: 'musl',
};
const LINUX_PKG_PATTERN = /^@optave\/codegraph-linux-[^-]+-(gnu|musl)$/;

// Resolve relative to this script's location so it works regardless of CWD
// (e.g. running `node scripts/verify-lockfile-libc.mjs` from the `scripts/`
// subdirectory still finds the repo-root manifests).
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'));

const optionalDeps = pkg.optionalDependencies ?? {};
const linuxPackages = Object.keys(optionalDeps).filter((name) =>
  name.startsWith('@optave/codegraph-linux-'),
);

if (linuxPackages.length === 0) {
  console.log('package-lock.json libc check: no @optave/codegraph-linux-* packages declared, skipping');
  process.exit(0);
}

const failures = [];
const unknownSuffixes = [];

for (const pkgName of linuxPackages) {
  const match = LINUX_PKG_PATTERN.exec(pkgName);
  if (!match) {
    unknownSuffixes.push(pkgName);
    continue;
  }
  const expectedLibc = LIBC_BY_SUFFIX[match[1]];
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

if (unknownSuffixes.length > 0) {
  console.error(
    'package-lock.json libc discriminator check cannot infer expected libc for:\n',
  );
  for (const name of unknownSuffixes) console.error(`  - ${name}`);
  console.error(
    `\nExtend LIBC_BY_SUFFIX in ${import.meta.url.replace('file://', '')}\n` +
      'to cover the new suffix (current rule: -gnu → glibc, -musl → musl).',
  );
  process.exit(1);
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

console.log(
  `package-lock.json libc discriminators OK (${linuxPackages.length} linux package(s) checked)`,
);
