#!/usr/bin/env node
/**
 * Copy the PR-built `.node` artifact (produced by the `native-host-build` CI
 * job and downloaded into `crates/codegraph-core/`) over the published
 * platform binary installed in `node_modules`.
 *
 * Used by the CI `test` and `parity` jobs so they exercise the native engine
 * built from the PR's Rust source rather than the last-published binary,
 * which lags behind PR changes and causes false parity failures.
 *
 * Also rewrites the platform package's `package.json` `version` field to
 * match the just-built binary's `CARGO_PKG_VERSION`. Without this step the
 * JS-side `getNativePackageVersion()` returns the published version while
 * the binary reports the bumped version, and the Rust orchestrator's
 * check_version_mismatch then forces every incremental rebuild back through
 * the full pipeline (~2s floor in #1066).
 *
 * The version is read from `NATIVE_BUILD_VERSION` if set (use this when the
 * artifact was built from a workflow that bumped Cargo.toml — e.g.
 * publish.yml's build-native job sets it from compute-version output),
 * falling back to `crates/codegraph-core/Cargo.toml` for flows that build
 * locally without a version bump.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLATFORM_PACKAGES = {
  'linux-x64-gnu': '@optave/codegraph-linux-x64-gnu',
  'linux-x64-musl': '@optave/codegraph-linux-x64-musl',
  'linux-arm64-gnu': '@optave/codegraph-linux-arm64-gnu',
  'linux-arm64-musl': '@optave/codegraph-linux-arm64-musl',
  'darwin-arm64': '@optave/codegraph-darwin-arm64',
  'darwin-x64': '@optave/codegraph-darwin-x64',
  'win32-x64': '@optave/codegraph-win32-x64-msvc',
};

function detectLibc() {
  if (os.platform() !== 'linux') return '';
  try {
    const files = fs.readdirSync('/lib');
    return files.some((f) => f.startsWith('ld-musl-') && f.endsWith('.so.1')) ? 'musl' : 'gnu';
  } catch {
    return 'gnu';
  }
}

function resolvePackage() {
  const plat = os.platform();
  const arch = os.arch();
  const libc = detectLibc();
  const key = libc ? `${plat}-${arch}-${libc}` : `${plat}-${arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) throw new Error(`No native package mapped for ${key}`);
  return pkg;
}

const crateDir = path.join('crates', 'codegraph-core');

const built = fs
  .readdirSync(crateDir)
  .filter((f) => f.endsWith('.node'))
  .map((f) => path.join(crateDir, f));

if (built.length === 0) {
  throw new Error(`No .node artifact found in ${crateDir}`);
}
if (built.length > 1) {
  console.warn(`[ci-install-native] multiple .node artifacts found, using ${built[0]}`);
}

const src = built[0];
const pkg = resolvePackage();
const destDir = path.join('node_modules', pkg);
const dest = path.join(destDir, 'codegraph-core.node');

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[ci-install-native] copied ${src} -> ${dest}`);

// Resolve the binary's CARGO_PKG_VERSION. We can't read it from the .node
// directly, so we accept it via env var (preferred) or fall back to the
// Cargo.toml on disk — which is correct for flows that build the artifact
// in the same checkout (no version bump between Cargo read and build).
function resolveBinaryVersion() {
  const envVersion = process.env.NATIVE_BUILD_VERSION?.trim();
  if (envVersion) return envVersion;
  const cargoPath = path.join('crates', 'codegraph-core', 'Cargo.toml');
  try {
    const cargoToml = fs.readFileSync(cargoPath, 'utf8');
    // Match the first `version = "X.Y.Z"` after the [package] header so we
    // don't accidentally pick up a dependency's version pin.
    const pkgSection = cargoToml.split(/^\[/m)[1] ?? cargoToml;
    const m = pkgSection.match(/version\s*=\s*"([^"]+)"/);
    return m?.[1] ?? null;
  } catch (e) {
    console.warn(`[ci-install-native] failed to read ${cargoPath}: ${e.message}`);
    return null;
  }
}

const binaryVersion = resolveBinaryVersion();
const pkgJsonPath = path.join(destDir, 'package.json');
if (binaryVersion && fs.existsSync(pkgJsonPath)) {
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const prev = pkgJson.version;
  if (prev !== binaryVersion) {
    pkgJson.version = binaryVersion;
    fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
    console.log(
      `[ci-install-native] updated ${pkgJsonPath} version: ${prev} -> ${binaryVersion}`,
    );
  } else {
    console.log(
      `[ci-install-native] ${pkgJsonPath} version already ${binaryVersion} — no rewrite needed`,
    );
  }
} else if (!binaryVersion) {
  console.warn(
    '[ci-install-native] could not resolve binary version (NATIVE_BUILD_VERSION unset and Cargo.toml unreadable) — leaving platform package.json untouched',
  );
}
