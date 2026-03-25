#!/usr/bin/env node
/**
 * Syncs @optave/codegraph-* optionalDependencies versions to match the root version.
 * Runs automatically via the npm "version" lifecycle hook.
 *
 * Flags:
 *   --strip   Remove platform @optave/codegraph-* entries from optionalDependencies
 *             (used by publish-dev to avoid npm resolution failures for dev versions)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const strip = process.argv.includes('--strip');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const v = pkg.version;

for (const key of Object.keys(pkg.optionalDependencies)) {
  if (key.startsWith('@optave/codegraph-')) {
    if (strip) {
      delete pkg.optionalDependencies[key];
    } else {
      pkg.optionalDependencies[key] = v;
    }
  }
}

writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// Also sync Cargo.toml version (used by the native engine's engine_version())
if (!strip) {
  const cargoPath = 'crates/codegraph-core/Cargo.toml';
  try {
    let cargo = readFileSync(cargoPath, 'utf8');
    cargo = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${v}"`);
    writeFileSync(cargoPath, cargo);
  } catch {
    /* skip if Cargo.toml doesn't exist */
  }
}
