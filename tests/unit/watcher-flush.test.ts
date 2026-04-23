/**
 * Regression test for PR #1001 Greptile P1:
 *   Deleted files journaled as "changed" in SIGINT flush.
 *
 * `ctx.pending` in the watcher is a plain `Set<string>` that carries no
 * event-type metadata. The SIGINT flush must detect deletions via existence
 * check — otherwise a file removed during a watch session is journaled as a
 * changed path, and the next incremental build tries to re-parse a file that
 * no longer exists instead of removing it from the graph.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFlushEntriesFromPending } from '../../src/domain/graph/watcher.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-flush-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRoot(): string {
  return fs.mkdtempSync(path.join(tmpDir, 'root-'));
}

describe('buildFlushEntriesFromPending', () => {
  it('flags entries whose file no longer exists as deleted', () => {
    const root = makeRoot();
    const existing = path.join(root, 'src', 'kept.ts');
    const removed = path.join(root, 'src', 'gone.ts');
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, 'export const x = 1;\n');
    // Note: `removed` is intentionally not created — simulates a file
    // deleted during the watch session that is still in `ctx.pending`.

    const entries = buildFlushEntriesFromPending(root, [existing, removed]);

    const byName = new Map(entries.map((e) => [e.file, e.deleted]));
    expect(byName.get('src/kept.ts')).toBe(false);
    expect(byName.get('src/gone.ts')).toBe(true);
  });

  it('produces relative, normalized paths (forward slashes) regardless of platform', () => {
    const root = makeRoot();
    const nested = path.join(root, 'a', 'b', 'c.ts');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, '');

    const [entry] = buildFlushEntriesFromPending(root, [nested]);
    expect(entry!.file).toBe('a/b/c.ts');
    expect(entry!.deleted).toBe(false);
  });

  it('handles an empty pending set without throwing', () => {
    const root = makeRoot();
    expect(buildFlushEntriesFromPending(root, [])).toEqual([]);
  });
});
