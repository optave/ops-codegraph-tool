import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyNativeDrops,
  formatDropExtensionSummary,
  NATIVE_SUPPORTED_EXTENSIONS,
} from '../../src/domain/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('classifyNativeDrops', () => {
  it('groups WASM-only languages under unsupported-by-native', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.fs',
      'src/b.gleam',
      'src/c.clj',
      'src/d.jl',
      'src/e.R',
      'src/g.sol',
      'src/h.cu',
      'src/i.groovy',
      'src/j.v',
      'src/k.m',
    ]);
    expect(totals['unsupported-by-native']).toBe(10);
    expect(totals['native-extractor-failure']).toBe(0);
    expect(byReason['unsupported-by-native'].get('.fs')).toEqual(['src/a.fs']);
    expect(byReason['unsupported-by-native'].get('.gleam')).toEqual(['src/b.gleam']);
    expect(byReason['unsupported-by-native'].get('.r')).toEqual(['src/e.R']);
  });

  it('flags natively-supported extensions as native-extractor-failure', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.ts',
      'src/b.py',
      'src/c.go',
      'src/d.rs',
    ]);
    expect(totals['native-extractor-failure']).toBe(4);
    expect(totals['unsupported-by-native']).toBe(0);
    expect(byReason['native-extractor-failure'].get('.ts')).toEqual(['src/a.ts']);
    expect(byReason['native-extractor-failure'].get('.py')).toEqual(['src/b.py']);
  });

  it('handles a mix of supported and unsupported extensions', () => {
    const { byReason, totals } = classifyNativeDrops([
      'src/a.ts',
      'src/b.fs',
      'src/c.fs',
      'src/d.gleam',
    ]);
    expect(totals['native-extractor-failure']).toBe(1);
    expect(totals['unsupported-by-native']).toBe(3);
    expect(byReason['unsupported-by-native'].get('.fs')).toEqual(['src/b.fs', 'src/c.fs']);
    expect(byReason['unsupported-by-native'].get('.gleam')).toEqual(['src/d.gleam']);
  });

  it('lowercases extensions so .R and .r share a bucket', () => {
    const { byReason, totals } = classifyNativeDrops(['scripts/a.R', 'scripts/b.r']);
    expect(totals['unsupported-by-native']).toBe(2);
    expect(byReason['unsupported-by-native'].get('.r')).toEqual(['scripts/a.R', 'scripts/b.r']);
  });

  it('returns empty buckets when no files are passed', () => {
    const { byReason, totals } = classifyNativeDrops([]);
    expect(totals['native-extractor-failure']).toBe(0);
    expect(totals['unsupported-by-native']).toBe(0);
    expect(byReason['native-extractor-failure'].size).toBe(0);
    expect(byReason['unsupported-by-native'].size).toBe(0);
  });

  it('exposes the native-supported extension set for callers', () => {
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.ts')).toBe(true);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.py')).toBe(true);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.fs')).toBe(false);
    expect(NATIVE_SUPPORTED_EXTENSIONS.has('.gleam')).toBe(false);
  });
});

describe('formatDropExtensionSummary', () => {
  it('returns an empty string when no buckets are present', () => {
    expect(formatDropExtensionSummary(new Map())).toBe('');
  });

  it('lists every extension when under the cap', () => {
    const buckets = new Map<string, string[]>([
      ['.ts', ['a.ts', 'b.ts']],
      ['.py', ['c.py']],
    ]);
    expect(formatDropExtensionSummary(buckets)).toBe('.ts (2: a.ts, b.ts); .py (1: c.py)');
  });

  it('caps samples per extension at 3 and renders +N more', () => {
    const buckets = new Map<string, string[]>([['.ts', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']]]);
    expect(formatDropExtensionSummary(buckets)).toBe('.ts (5: a.ts, b.ts, c.ts, +2 more)');
  });

  it('shows exactly MAX_SAMPLES samples without a +N suffix when count equals the cap', () => {
    const buckets = new Map<string, string[]>([['.ts', ['a.ts', 'b.ts', 'c.ts']]]);
    expect(formatDropExtensionSummary(buckets)).toBe('.ts (3: a.ts, b.ts, c.ts)');
  });

  it('caps extensions at 6 and renders +N more extension(s)', () => {
    // 8 extensions, all with 1 file — sorted by count is a stable tie so insertion
    // order wins, and the first 6 are shown.
    const buckets = new Map<string, string[]>([
      ['.a', ['1.a']],
      ['.b', ['1.b']],
      ['.c', ['1.c']],
      ['.d', ['1.d']],
      ['.e', ['1.e']],
      ['.f', ['1.f']],
      ['.g', ['1.g']],
      ['.h', ['1.h']],
    ]);
    const out = formatDropExtensionSummary(buckets);
    expect(out.endsWith('; +2 more extension(s)')).toBe(true);
    // First 6 extensions are present, the last 2 (.g, .h) are not.
    expect(out).toContain('.a (1: 1.a)');
    expect(out).toContain('.f (1: 1.f)');
    expect(out).not.toContain('.g (');
    expect(out).not.toContain('.h (');
  });

  it('sorts by descending file count so the loudest offender is first', () => {
    const buckets = new Map<string, string[]>([
      ['.small', ['x']],
      ['.huge', ['a', 'b', 'c', 'd']],
      ['.medium', ['m', 'n']],
    ]);
    const out = formatDropExtensionSummary(buckets);
    const positions = ['.huge', '.medium', '.small'].map((ext) => out.indexOf(ext));
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });
});

/**
 * Drift guard for `NATIVE_SUPPORTED_EXTENSIONS`.
 *
 * Greptile flagged that this set is keyed to one snapshot of
 * `LanguageKind::from_extension` in the Rust addon, and silent drift between
 * the JS and Rust sides would mis-classify drops (real native failures shown
 * as info, parser-limit gaps shown as warn). The native addon doesn't expose
 * its own metadata, so we parse the Rust source instead and assert the two
 * lists agree at build time. If `parser_registry.rs` is ever refactored, this
 * test fails loudly so the maintainer notices.
 */
describe('NATIVE_SUPPORTED_EXTENSIONS drift guard', () => {
  it('matches the extension set in crates/codegraph-core/src/parser_registry.rs', () => {
    const registryPath = path.join(
      REPO_ROOT,
      'crates',
      'codegraph-core',
      'src',
      'parser_registry.rs',
    );
    const src = fs.readFileSync(registryPath, 'utf8');
    const fromExtStart = src.indexOf('pub fn from_extension');
    expect(fromExtStart, 'from_extension not found in parser_registry.rs').toBeGreaterThan(-1);
    // Slice from `pub fn from_extension` to the next `pub fn` (boundary of
    // the next method) so we don't accidentally pick up extensions from
    // unrelated functions like `from_lang_id` (which contains lang_id
    // strings that look extension-like, e.g. "javascript", "python").
    const tail = src.slice(fromExtStart);
    const nextFnRel = tail.slice(1).search(/\n\s*\/\/\/|\n\s*pub fn /);
    const body = nextFnRel === -1 ? tail : tail.slice(0, nextFnRel + 1);
    const rustExts = new Set<string>();
    // Match string literals like "ts", "py", "tsx", "d.ts" etc.
    for (const m of body.matchAll(/"([A-Za-z0-9.]+)"/g)) {
      rustExts.add(m[1]);
    }
    // Normalize Rust forms to the JS `.ext` form. The function mixes:
    //   - prefix branches with leading dot: ".tsx", ".d.ts"
    //   - `match ext` arms without dot: "ts", "py", "rb", ...
    // `.d.ts` is a TypeScript declaration file alias mapped to TypeScript;
    // JS treats those files via `.ts` so the alias is not in the JS set.
    const normalized = new Set<string>();
    for (const e of rustExts) {
      // `.d.ts` declaration files are mapped to TypeScript via a special
      // prefix branch — JS handles those via the `.ts` entry, so skip the
      // alias in either matched form.
      if (e === 'd.ts' || e === '.d.ts') continue;
      const withDot = e.startsWith('.') ? e : `.${e}`;
      normalized.add(withDot.toLowerCase());
    }
    const jsExts = new Set(NATIVE_SUPPORTED_EXTENSIONS);
    const onlyInRust = [...normalized].filter((e) => !jsExts.has(e));
    const onlyInJs = [...jsExts].filter((e) => !normalized.has(e));
    expect(
      onlyInRust,
      `Extensions in parser_registry.rs but missing from NATIVE_SUPPORTED_EXTENSIONS: ${onlyInRust.join(', ')}`,
    ).toEqual([]);
    expect(
      onlyInJs,
      `Extensions in NATIVE_SUPPORTED_EXTENSIONS but missing from parser_registry.rs: ${onlyInJs.join(', ')}`,
    ).toEqual([]);
  });
});
