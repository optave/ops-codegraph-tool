/**
 * Tests for WASM worker crash-isolation (issue #965).
 *
 * When the WASM grammar triggers a V8 fatal (uncatchable from JS) the worker
 * exits with a non-zero code. The pool must:
 *   - detect the exit,
 *   - skip the in-flight file with a warn(),
 *   - respawn the worker,
 *   - and continue parsing the rest of the batch.
 *
 * We simulate the V8 fatal by having the worker `process.exit(1)` when the
 * source contains a magic test token (gated by CODEGRAPH_WASM_WORKER_TEST_CRASH).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeParsers, parseFileAuto, parseFilesAuto } from '../../src/domain/parser.js';

const CRASH_MAGIC = '__CODEGRAPH_WASM_WORKER_TEST_CRASH__';

describe('WASM worker crash isolation (issue #965)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    // Pool is a singleton — dispose so the next spawn picks up the env flag.
    await disposeParsers();
    process.env.CODEGRAPH_WASM_WORKER_TEST_CRASH = '1';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-wasm-crash-'));
  });

  afterEach(async () => {
    delete process.env.CODEGRAPH_WASM_WORKER_TEST_CRASH;
    stderrSpy.mockRestore();
    await disposeParsers();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns null and warns when a single-file parse crashes the worker', async () => {
    const filePath = path.join(tmpDir, 'boom.js');
    const code = `// ${CRASH_MAGIC}\nfunction hello() {}`;
    fs.writeFileSync(filePath, code);

    const symbols = await parseFileAuto(filePath, code, { engine: 'wasm' });
    expect(symbols).toBeNull();

    const warnings = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[codegraph WARN]'));
    expect(warnings.some((w) => w.includes('boom.js'))).toBe(true);
    expect(warnings.some((w) => /crashed|exit|skipping/i.test(w))).toBe(true);
  });

  it('skips the crashing file but continues parsing the rest of the batch', async () => {
    const good1 = path.join(tmpDir, 'math.js');
    const good2 = path.join(tmpDir, 'utils.js');
    const poisoned = path.join(tmpDir, 'boom.js');
    fs.writeFileSync(good1, 'export function add(a, b) { return a + b; }');
    fs.writeFileSync(good2, 'export function id(x) { return x; }');
    fs.writeFileSync(poisoned, `// ${CRASH_MAGIC}\nfunction hello() {}`);

    const result = await parseFilesAuto([good1, good2, poisoned], tmpDir, { engine: 'wasm' });

    expect(result).toBeInstanceOf(Map);
    expect(result.has('math.js')).toBe(true);
    expect(result.has('utils.js')).toBe(true);
    expect(result.has('boom.js')).toBe(false);

    const warnings = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[codegraph WARN]'));
    expect(warnings.some((w) => w.includes('boom.js'))).toBe(true);
  });

  it('re-crashes are tolerated: pool respawns worker and keeps going', async () => {
    const good = path.join(tmpDir, 'math.js');
    const poisoned1 = path.join(tmpDir, 'boom1.js');
    const poisoned2 = path.join(tmpDir, 'boom2.js');
    fs.writeFileSync(good, 'export function add(a, b) { return a + b; }');
    fs.writeFileSync(poisoned1, `// ${CRASH_MAGIC}\nfunction a() {}`);
    fs.writeFileSync(poisoned2, `// ${CRASH_MAGIC}\nfunction b() {}`);

    const result = await parseFilesAuto([poisoned1, good, poisoned2], tmpDir, { engine: 'wasm' });

    expect(result.has('math.js')).toBe(true);
    expect(result.has('boom1.js')).toBe(false);
    expect(result.has('boom2.js')).toBe(false);
  });
});
