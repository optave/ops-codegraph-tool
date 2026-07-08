/**
 * Unit tests for scripts/lib/bench-config.ts's srcImport().
 *
 * Regression coverage for #1907: scripts/token-benchmark.ts's `--perf`
 * dynamic imports used flat paths (e.g. `src/builder.js`, `src/queries.js`,
 * `src/native.js`, `src/parser.js`) that never existed — the real modules
 * live nested (`src/domain/graph/builder.ts`, `src/domain/queries.ts`,
 * `src/infrastructure/native.ts`, `src/domain/parser.ts`), mirroring dist/'s
 * layout. This locks in that the exact nested subpaths token-benchmark.ts
 * now imports via srcImport() resolve to real, importable modules exporting
 * the symbols runPerfBenchmarks() needs.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { srcImport } from '../../scripts/lib/bench-config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = path.join(repoRoot, 'src');

describe('srcImport() against the module paths used by token-benchmark.ts --perf', () => {
  it('resolves domain/graph/builder.js to a module exporting buildGraph', async () => {
    const mod = await import(srcImport(srcDir, 'domain/graph/builder.js'));
    expect(typeof mod.buildGraph).toBe('function');
  });

  it('resolves domain/queries.js to a module exporting fnDepsData, fnImpactData, statsData', async () => {
    const mod = await import(srcImport(srcDir, 'domain/queries.js'));
    expect(typeof mod.fnDepsData).toBe('function');
    expect(typeof mod.fnImpactData).toBe('function');
    expect(typeof mod.statsData).toBe('function');
  });

  it('resolves infrastructure/native.js to a module exporting isNativeAvailable', async () => {
    const mod = await import(srcImport(srcDir, 'infrastructure/native.js'));
    expect(typeof mod.isNativeAvailable).toBe('function');
  });

  it('resolves domain/parser.js to a module exporting isWasmAvailable', async () => {
    const mod = await import(srcImport(srcDir, 'domain/parser.js'));
    expect(typeof mod.isWasmAvailable).toBe('function');
  });
});
