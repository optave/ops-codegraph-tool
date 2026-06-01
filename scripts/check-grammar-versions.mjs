#!/usr/bin/env node
// Verifies that tree-sitter grammar versions in package.json devDependencies
// stay in major-version sync with their Cargo crate counterparts in
// crates/codegraph-core/Cargo.toml. A major-version divergence means the two
// engines ship grammars at incompatible API levels, which can produce
// parse-tree differences that are hard to diagnose.
//
// Minor-version drifts between npm and Cargo are allowed — they are caught at
// build time by the Rust `all_grammars_have_compatible_abi` test when the ABI
// actually diverges. Git/tarball npm references with no embeddable semver are
// skipped with a notice.
//
// Run via CI or locally: node scripts/check-grammar-versions.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
const cargoToml = readFileSync(
  resolve(repoRoot, 'crates/codegraph-core/Cargo.toml'),
  'utf8',
);

// When a grammar's npm package name differs from its Cargo crate name, map it here.
// All other grammar packages use the same name on both registries.
const NPM_TO_CARGO = {
  '@eagleoutice/tree-sitter-r': 'tree-sitter-r',
  '@tree-sitter-grammars/tree-sitter-hcl': 'tree-sitter-hcl',
  '@tree-sitter-grammars/tree-sitter-lua': 'tree-sitter-lua',
  '@tree-sitter-grammars/tree-sitter-zig': 'tree-sitter-zig',
  'tree-sitter-kotlin': 'tree-sitter-kotlin-sg',
  'tree-sitter-clojure': 'tree-sitter-clojure-orchard',
};

// Grammars where a major-version mismatch exists but cannot be fixed yet
// (e.g. the Cargo crate hasn't published its v1.x release). Each entry must
// document why the exception exists; remove it once the crate is updated.
const KNOWN_EXCEPTIONS = {
  // npm tree-sitter-dart@^1.0.0, but tree-sitter-dart on crates.io tops out
  // at 0.2.0 — v1.x has not been published to the Rust registry yet.
  // Remove once https://crates.io/crates/tree-sitter-dart reaches v1.
  'tree-sitter-dart': 'tree-sitter-dart v1.x not yet published to crates.io (latest: 0.2.0)',
};

// Full set of grammar npm packages that have a paired Cargo crate.
// Adding a new grammar here is the only edit needed to extend the check.
const GRAMMAR_NPM_PACKAGES = [
  '@eagleoutice/tree-sitter-r',
  '@tree-sitter-grammars/tree-sitter-hcl',
  '@tree-sitter-grammars/tree-sitter-lua',
  '@tree-sitter-grammars/tree-sitter-zig',
  'tree-sitter-bash',
  'tree-sitter-c',
  'tree-sitter-c-sharp',
  'tree-sitter-clojure',
  'tree-sitter-cpp',
  'tree-sitter-cuda',
  'tree-sitter-dart',
  'tree-sitter-elixir',
  'tree-sitter-erlang',
  'tree-sitter-fsharp',
  'tree-sitter-gleam',
  'tree-sitter-go',
  'tree-sitter-groovy',
  'tree-sitter-haskell',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-julia',
  'tree-sitter-kotlin',
  'tree-sitter-objc',
  'tree-sitter-ocaml',
  'tree-sitter-php',
  'tree-sitter-python',
  'tree-sitter-ruby',
  'tree-sitter-rust',
  'tree-sitter-scala',
  'tree-sitter-solidity',
  'tree-sitter-swift',
  'tree-sitter-typescript',
  'tree-sitter-verilog',
];

// Strip range prefixes and return the raw version string, or null for
// unresolvable specifiers (github:, git+, bare tarball without a version tag).
function extractNpmVersion(specifier) {
  if (specifier.startsWith('github:') || specifier.startsWith('git+')) return null;
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
    // Tarball URLs sometimes embed the version in the filename, e.g.
    // ".../tree-sitter-fsharp/archive/refs/tags/0.3.0.tar.gz"
    const match = /\/(\d+\.\d+(?:\.\d+)*)(?:\.tar\.gz)?(?:\?.*)?$/.exec(specifier);
    return match ? match[1] : null;
  }
  return specifier; // "^X.Y.Z", "X.Y.Z", "X", etc.
}

// Return the major version number (X in X.Y.Z), or null on parse failure.
function parseMajor(spec) {
  const cleaned = spec.replace(/^[^0-9]*/, ''); // strip ^, ~, >=, …
  const match = /^(\d+)/.exec(cleaned);
  return match ? parseInt(match[1], 10) : null;
}

// Build a Map<crate_name, version_string> from Cargo.toml text.
// Handles: `crate = "ver"` and `crate = { version = "ver", … }`.
function parseCargoVersions(toml) {
  const map = new Map();
  for (const line of toml.split('\n')) {
    const simple = /^(tree-sitter-[a-z0-9-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (simple) { map.set(simple[1], simple[2]); continue; }
    const inline =
      /^(tree-sitter-[a-z0-9-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/.exec(line);
    if (inline) map.set(inline[1], inline[2]);
  }
  return map;
}

const devDeps = pkg.devDependencies ?? {};
const cargoVersions = parseCargoVersions(cargoToml);

const failures = [];
const skipped = [];
let checked = 0;

for (const npmName of GRAMMAR_NPM_PACKAGES) {
  const npmSpec = devDeps[npmName];
  if (!npmSpec) {
    failures.push(
      `${npmName}: listed in check but absent from package.json devDependencies`,
    );
    continue;
  }

  const cargoName = NPM_TO_CARGO[npmName] ?? npmName;
  const cargoSpec = cargoVersions.get(cargoName);
  if (!cargoSpec) {
    failures.push(`${npmName} → ${cargoName}: crate absent from Cargo.toml`);
    continue;
  }

  const npmVersion = extractNpmVersion(npmSpec);
  if (npmVersion === null) {
    skipped.push(`${npmName}: npm ref "${npmSpec}" has no semver version — skipped`);
    continue;
  }

  const npmMajor = parseMajor(npmVersion);
  const cargoMajor = parseMajor(cargoSpec);
  if (npmMajor === null || cargoMajor === null) {
    skipped.push(
      `${npmName}: could not parse versions (npm="${npmSpec}", cargo="${cargoSpec}") — skipped`,
    );
    continue;
  }

  if (npmMajor !== cargoMajor) {
    const exceptionReason = KNOWN_EXCEPTIONS[npmName];
    if (exceptionReason) {
      skipped.push(
        `${npmName}: major-version mismatch excused — ${exceptionReason}`,
      );
    } else {
      failures.push(
        `${npmName} (cargo: ${cargoName}): major-version mismatch — ` +
        `npm ${npmMajor}.x ("${npmSpec}") vs Cargo ${cargoMajor}.x ("${cargoSpec}")`,
      );
    }
  } else {
    checked++;
  }
}

if (skipped.length > 0) {
  console.log('Grammar version parity: notices (skipped entries):');
  for (const s of skipped) console.log(`  ${s}`);
}

if (failures.length > 0) {
  console.error(`\nGrammar version parity check FAILED (${failures.length} issue(s)):\n`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  console.error(
    '\nBump the mismatched grammar to the same major version in BOTH ' +
    'package.json devDependencies and\ncrates/codegraph-core/Cargo.toml, ' +
    'then run `npm install` and `cargo update` to regenerate lockfiles.',
  );
  process.exit(1);
}

console.log(
  `Grammar version parity OK — ${checked} grammar(s) checked, ${skipped.length} skipped.`,
);
