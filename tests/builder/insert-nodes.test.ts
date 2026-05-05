/**
 * Unit tests for insertNodes helpers.
 *
 * Regression coverage for #1068: the file-hash builder must emit a row for
 * every collected file, even those whose parser produced zero symbols (empty
 * files, parser no-op, or optional-language grammar unavailable). Skipping
 * symbol-less files would leave the next no-op rebuild's fast-skip pre-flight
 * (#1054) rejecting on `collected file missing from file_hashes` and force
 * the full ~2s native pipeline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileHash } from '../../src/domain/graph/builder/helpers.js';
import { buildFileHashes } from '../../src/domain/graph/builder/stages/insert-nodes.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-insert-nodes-'));
  fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 1;');
  // Symbol-less file (e.g. registered extension whose grammar wasn't installed,
  // or a file the parser silently no-op'd on). Content is arbitrary — the
  // hash builder must not care whether parsing produced any symbols.
  fs.writeFileSync(path.join(tmpDir, 'b.clj'), '(comment "no symbols")');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildFileHashes', () => {
  it('emits a row for every collected file, including symbol-less ones (#1068)', () => {
    const filesToParse = [
      { file: path.join(tmpDir, 'a.js') },
      { file: path.join(tmpDir, 'b.clj') },
    ];
    const result = buildFileHashes(filesToParse, new Map(), [], tmpDir);

    const files = result.map((r) => r.file).sort();
    expect(files).toEqual(['a.js', 'b.clj']);
    for (const row of result) {
      expect(row.hash).toMatch(/^[0-9a-f]+$/);
      expect(row.size).toBeGreaterThan(0);
      expect(row.mtime).toBeGreaterThan(0);
    }
  });

  it('uses precomputed hash when present', () => {
    const aPath = path.join(tmpDir, 'a.js');
    const precomputedHash = 'deadbeef';
    const precomputed = new Map([
      [
        'a.js',
        {
          file: aPath,
          relPath: 'a.js',
          hash: precomputedHash,
          stat: { mtime: 12345, size: 99 },
        },
      ],
    ]);
    const result = buildFileHashes([{ file: aPath, relPath: 'a.js' }], precomputed, [], tmpDir);

    expect(result).toEqual([{ file: 'a.js', hash: precomputedHash, mtime: 12345, size: 99 }]);
  });

  it('skips files marked _reverseDepOnly (hash already correct)', () => {
    const aPath = path.join(tmpDir, 'a.js');
    const precomputed = new Map([
      [
        'a.js',
        {
          file: aPath,
          relPath: 'a.js',
          hash: 'unused',
          _reverseDepOnly: true,
        },
      ],
    ]);
    const result = buildFileHashes([{ file: aPath, relPath: 'a.js' }], precomputed, [], tmpDir);

    expect(result).toEqual([]);
  });

  it('falls back to reading file from disk when no precomputed data exists', () => {
    const aPath = path.join(tmpDir, 'a.js');
    const result = buildFileHashes([{ file: aPath }], new Map(), [], tmpDir);

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.file).toBe('a.js');
    expect(row.hash).toBe(fileHash(fs.readFileSync(aPath, 'utf-8')));
  });

  it('appends metadata-only updates after the file iteration', () => {
    const result = buildFileHashes(
      [],
      new Map(),
      [{ relPath: 'meta.js', hash: 'abc', stat: { mtime: 10, size: 20 } }],
      tmpDir,
    );

    expect(result).toEqual([{ file: 'meta.js', hash: 'abc', mtime: 10, size: 20 }]);
  });

  it('deduplicates when filesToParse contains the same relPath twice', () => {
    const aPath = path.join(tmpDir, 'a.js');
    const result = buildFileHashes(
      [
        { file: aPath, relPath: 'a.js' },
        { file: aPath, relPath: 'a.js' },
      ],
      new Map(),
      [],
      tmpDir,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.file).toBe('a.js');
  });
});
