/**
 * Unit tests for `computeWasmOnlyStaleFiles` (#1073).
 *
 * The Rust orchestrator's `detect_removed_files` filter (#1070) skips files
 * outside its supported extensions, so deletions of WASM-only languages don't
 * reach the native purge path. The JS-side backfill only inserts rows, so
 * without this helper a deleted WASM-only file would leak `nodes`/`file_hashes`
 * rows until the next full rebuild.
 *
 * These tests pass the extension sets as parameters so they remain meaningful
 * even when every currently-registered language is natively supported
 * (i.e. `installedExts == nativeSupported`). The bug surface re-opens any time
 * a new WASM-only language enters the registry before its Rust extractor.
 */
import { describe, expect, it } from 'vitest';
import { computeWasmOnlyStaleFiles } from '../../src/domain/graph/builder/pipeline.js';

const NATIVE = new Set(['.ts', '.js', '.r']);
const INSTALLED = new Set(['.ts', '.js', '.r', '.gleam', '.foo']);

describe('computeWasmOnlyStaleFiles', () => {
  it('returns WASM-only files present in DB but missing from disk', () => {
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/a.gleam', 'src/b.ts']),
      existingHashes: new Set(['src/a.gleam', 'src/b.ts']),
      expected: new Set(['src/b.ts']),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual(['src/a.gleam']);
  });

  it('skips natively-supported extensions — Rust owns their deletion path', () => {
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/old.ts', 'src/old.r']),
      existingHashes: new Set(['src/old.ts', 'src/old.r']),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual([]);
  });

  it('skips extensions with no installed WASM grammar', () => {
    // .bar is not in installedExts — neither engine can parse it, so DB rows
    // for it can't have been written by this codepath. Leave them alone.
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/x.bar']),
      existingHashes: new Set(['src/x.bar']),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual([]);
  });

  it('catches files that exist only in file_hashes (nodes missing)', () => {
    // Legacy DB shape where file_hashes was written but `nodes` was not — the
    // backfill should still recognise the file_hashes row as stale.
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(),
      existingHashes: new Set(['src/leftover.gleam']),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual(['src/leftover.gleam']);
  });

  it('catches files that exist only in nodes (file_hashes missing)', () => {
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/leftover.gleam']),
      existingHashes: new Set(),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual(['src/leftover.gleam']);
  });

  it('deduplicates files appearing in both nodes and file_hashes', () => {
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/dup.gleam']),
      existingHashes: new Set(['src/dup.gleam']),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual(['src/dup.gleam']);
  });

  it('lowercases extensions to match registry/Rust normalisation', () => {
    // R is conventionally written `.R` on disk. The registry and the Rust
    // `LanguageKind::from_extension` accept both cases; `installedExts` and
    // `nativeSupported` carry the lowercase canonical form.
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/Plot.R']),
      existingHashes: new Set(['src/Plot.R']),
      expected: new Set(),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    // .R lowercases to .r which IS native-supported, so it should be skipped.
    expect(stale).toEqual([]);
  });

  it('returns empty when DB and disk agree', () => {
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src/a.gleam', 'src/b.ts']),
      existingHashes: new Set(['src/a.gleam', 'src/b.ts']),
      expected: new Set(['src/a.gleam', 'src/b.ts']),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual([]);
  });

  it('normalises DB paths with back-slashes against forward-slash expected set', () => {
    // Defends against false-positive purges on Windows where a stale DB row
    // (written by older code) could carry back-slashes while `expected` is
    // always normalised. Without `normalizePath` inside `consider`, the file
    // would look stale and be purged even though it exists on disk.
    const stale = computeWasmOnlyStaleFiles({
      existingNodes: new Set(['src\\live.gleam']),
      existingHashes: new Set(['src\\live.gleam']),
      expected: new Set(['src/live.gleam']),
      installedExts: INSTALLED,
      nativeSupported: NATIVE,
    });
    expect(stale).toEqual([]);
  });
});
