/**
 * Regression test for #1738: `codegraph structure --depth 2 --json` reported
 * stale fileCount/symbolCount/fanIn/cohesion/density for a directory after an
 * INCREMENTAL rebuild added or removed a file in it. A full rebuild
 * (`--no-incremental`) always produced the correct numbers.
 *
 * Root cause: the small-incremental fast path (`updateChangedFileMetrics` in
 * `domain/graph/builder/stages/build-structure.ts`, mirrored by
 * `update_changed_file_metrics` in `crates/codegraph-core/src/features/
 * structure.rs`) only ever updated per-FILE `node_metrics` rows. It never
 * touched directories at all — no directory-metrics recompute, no `contains`
 * edge for the new file, and no directory node for a brand-new directory.
 * This path triggers whenever an incremental build touches at most
 * `smallFilesThreshold` (5) files and the repo already has more than 20
 * files — i.e. almost every normal edit-and-rebuild cycle on a non-trivial
 * repo, including a pure-removal build (0 parsed files, which trivially
 * satisfies the "<=5" gate).
 *
 * Fixed by `refreshAffectedDirectoryMetrics` /
 * `refresh_affected_directory_metrics`, which recomputes metrics (and wires
 * up any missing directory nodes/contains edges) for the ancestor
 * directories of the files touched by the incremental build, PLUS any
 * directory reachable from them via a live cross-directory import edge (a
 * changed file gaining/losing an import into a sibling package shifts that
 * package's fan-in/fan-out too, even though none of its own files changed)
 * — cheap because it's bounded by (changed files x path depth) rather than
 * the size of the repo. See #1839 for a narrower residual gap this does not
 * cover: a directory whose only link to the touched set was an edge to/from
 * a file that was itself just removed (that edge's evidence is gone by the
 * time the refresh runs).
 *
 * Strategy: build a fixture with >20 files (crossing the fast-path's
 * `existingFileCount > 20` gate), mutate it incrementally, then diff the
 * resulting directory metrics against a from-scratch full build of the exact
 * same final file set — the full build is what the issue itself uses as
 * "ground truth" (full rebuild fixes it).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { structureData } from '../../src/features/structure.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Small-incremental fast path requires existingFileCount > 20 — keep a
// healthy margin above that boundary.
const BASE_FILE_COUNT = 24;
const DIR = 'src/pkg';

function fileContent(i: number): string {
  return `export function fn${i}() { return ${i}; }\n`;
}

/** Write `count` standalone (no cross-imports) files into `<root>/src/pkg`. */
function writeBaseFixture(root: string, count: number, skip: Set<number> = new Set()): void {
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  for (let i = 0; i < count; i++) {
    if (skip.has(i)) continue;
    fs.writeFileSync(path.join(root, DIR, `file${i}.js`), fileContent(i));
  }
}

interface DirSnapshot {
  fileCount: number;
  symbolCount: number;
  fanIn: number;
  fanOut: number;
  cohesion: number | null;
  fileNames: string[];
}

function snapshotDir(dbPath: string, dirName: string): DirSnapshot {
  const data = structureData(dbPath, { directory: dirName, full: true });
  const entry = data.directories.find((d) => d.directory === dirName);
  expect(entry, `${dirName} directory missing from structureData output`).toBeDefined();
  return {
    fileCount: entry!.fileCount,
    symbolCount: entry!.symbolCount,
    fanIn: entry!.fanIn,
    fanOut: entry!.fanOut,
    cohesion: entry!.cohesion,
    fileNames: entry!.files.map((f) => f.file).sort(),
  };
}

function runScenario(engine: 'wasm' | 'native'): void {
  describe(`directory structure metrics after incremental rebuild (#1738) — ${engine}`, () => {
    let incrDir: string;
    const tmpDirs: string[] = [];
    const incrDbPath = () => path.join(incrDir, '.codegraph', 'graph.db');

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    }

    beforeAll(async () => {
      incrDir = mkTmp(`cg-1738-incr-${engine}-`);
      writeBaseFixture(incrDir, BASE_FILE_COUNT);
      await buildGraph(incrDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('baseline full build reports the expected file/symbol counts', () => {
      const snap = snapshotDir(incrDbPath(), DIR);
      expect(snap.fileCount).toBe(BASE_FILE_COUNT);
      expect(snap.symbolCount).toBe(BASE_FILE_COUNT);
    });

    it('reflects a newly added file after an incremental rebuild (matches a full rebuild of the same file set)', async () => {
      // Mutate the incremental repo: add one new file to the existing directory.
      // A single added file stays within smallFilesThreshold (5), so this
      // exercises the fast path.
      fs.writeFileSync(
        path.join(incrDir, DIR, 'new-file.js'),
        "export function brandNew() { return 'new'; }\n",
      );
      await buildGraph(incrDir, { engine, skipRegistry: true }); // incremental (default)
      const incremental = snapshotDir(incrDbPath(), DIR);

      // Ground truth: an independent repo built in one full pass with the
      // identical final file set (BASE_FILE_COUNT existing files + new-file.js).
      const refDir = mkTmp(`cg-1738-ref-add-${engine}-`);
      writeBaseFixture(refDir, BASE_FILE_COUNT);
      fs.writeFileSync(
        path.join(refDir, DIR, 'new-file.js'),
        "export function brandNew() { return 'new'; }\n",
      );
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
      const reference = snapshotDir(path.join(refDir, '.codegraph', 'graph.db'), DIR);

      expect(
        incremental.fileCount,
        'directory fileCount is stale after incremental rebuild added a file (#1738)',
      ).toBe(reference.fileCount);
      expect(incremental.symbolCount).toBe(reference.symbolCount);
      expect(incremental.fanIn).toBe(reference.fanIn);
      expect(incremental.fanOut).toBe(reference.fanOut);
      expect(incremental.cohesion).toBe(reference.cohesion);
      expect(
        incremental.fileNames,
        'new file is missing a contains edge from its parent directory (#1738)',
      ).toEqual(reference.fileNames);
      expect(incremental.fileNames).toContain(`${DIR}/new-file.js`);
    }, 60_000);

    it('reflects a removed file after an incremental rebuild (matches a full rebuild of the same file set)', async () => {
      // Mutate the incremental repo further: remove one pre-existing file.
      // Zero re-parsed files also stays within smallFilesThreshold, so this
      // exercises the fast path's pure-removal case.
      fs.rmSync(path.join(incrDir, DIR, 'file0.js'));
      await buildGraph(incrDir, { engine, skipRegistry: true });
      const incremental = snapshotDir(incrDbPath(), DIR);

      // Ground truth: BASE_FILE_COUNT files minus file0, plus new-file.js
      // (added by the previous test), built from scratch in one full pass.
      const refDir = mkTmp(`cg-1738-ref-remove-${engine}-`);
      writeBaseFixture(refDir, BASE_FILE_COUNT, new Set([0]));
      fs.writeFileSync(
        path.join(refDir, DIR, 'new-file.js'),
        "export function brandNew() { return 'new'; }\n",
      );
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
      const reference = snapshotDir(path.join(refDir, '.codegraph', 'graph.db'), DIR);

      expect(
        incremental.fileCount,
        'directory fileCount is stale after incremental rebuild removed a file (#1738)',
      ).toBe(reference.fileCount);
      expect(incremental.symbolCount).toBe(reference.symbolCount);
      expect(incremental.fileNames).toEqual(reference.fileNames);
      expect(incremental.fileNames).not.toContain(`${DIR}/file0.js`);
    }, 60_000);

    it('creates a directory node and metrics for a file added under a brand-new nested directory', async () => {
      // A file under a directory that has never existed before must get a
      // directory node (and ancestor contains edges) created for it, not
      // just a metrics update to a pre-existing row.
      fs.mkdirSync(path.join(incrDir, DIR, 'newdir', 'nested'), { recursive: true });
      fs.writeFileSync(
        path.join(incrDir, DIR, 'newdir', 'nested', 'deep.js'),
        'export function deepFn() { return 1; }\n',
      );
      await buildGraph(incrDir, { engine, skipRegistry: true });

      const nestedSnap = snapshotDir(incrDbPath(), `${DIR}/newdir/nested`);
      expect(nestedSnap.fileCount).toBe(1);
      expect(nestedSnap.symbolCount).toBe(1);
      expect(nestedSnap.fileNames).toEqual([`${DIR}/newdir/nested/deep.js`]);

      // The ancestor's transitive fileCount must include the nested file too.
      const parentSnap = snapshotDir(incrDbPath(), DIR);
      expect(parentSnap.fileCount).toBeGreaterThanOrEqual(
        BASE_FILE_COUNT /* original */ -
          1 /* file0 removed */ +
          1 /* new-file.js */ +
          1 /* deep.js */,
      );
    }, 60_000);

    it("reflects a cross-directory import gained by a changed file on the OTHER (untouched) directory's fan-in/fan-out", async () => {
      // A neighbor directory can have zero files of its own added, removed,
      // or modified and still need its fan-in/fan-out/cohesion refreshed,
      // because a changed file elsewhere gained or lost a cross-directory
      // import edge touching it.
      const crossDir = mkTmp(`cg-1738-cross-${engine}-`);
      fs.mkdirSync(path.join(crossDir, 'src', 'pkgA'), { recursive: true });
      fs.mkdirSync(path.join(crossDir, 'src', 'pkgB'), { recursive: true });
      writeBaseFixture(crossDir, BASE_FILE_COUNT); // padding to cross the fast-path gate
      fs.writeFileSync(
        path.join(crossDir, 'src', 'pkgA', 'a1.js'),
        "import { a2 } from './a2.js';\nexport function a1() { return a2(); }\n",
      );
      fs.writeFileSync(
        path.join(crossDir, 'src', 'pkgA', 'a2.js'),
        'export function a2() { return 2; }\n',
      );
      fs.writeFileSync(
        path.join(crossDir, 'src', 'pkgB', 'b1.js'),
        'export function b1() { return 1; }\n',
      );
      await buildGraph(crossDir, { engine, incremental: false, skipRegistry: true });

      const crossDbPath = () => path.join(crossDir, '.codegraph', 'graph.db');
      const baseline = snapshotDir(crossDbPath(), 'src/pkgB');
      expect(baseline.fanIn).toBe(0);

      // pkgA/a1.js (already-existing, gets modified) now ALSO imports
      // pkgB/b1.js — pkgB itself has no file of its own touched.
      fs.writeFileSync(
        path.join(crossDir, 'src', 'pkgA', 'a1.js'),
        "import { a2 } from './a2.js';\nimport { b1 } from '../pkgB/b1.js';\nexport function a1() { return a2() + b1(); }\n",
      );
      await buildGraph(crossDir, { engine, skipRegistry: true });
      const incremental = snapshotDir(crossDbPath(), 'src/pkgB');

      // Ground truth: an independent from-scratch full build of the same
      // final source.
      const refDir = mkTmp(`cg-1738-cross-ref-${engine}-`);
      fs.mkdirSync(path.join(refDir, 'src', 'pkgA'), { recursive: true });
      fs.mkdirSync(path.join(refDir, 'src', 'pkgB'), { recursive: true });
      writeBaseFixture(refDir, BASE_FILE_COUNT);
      fs.writeFileSync(
        path.join(refDir, 'src', 'pkgA', 'a1.js'),
        "import { a2 } from './a2.js';\nimport { b1 } from '../pkgB/b1.js';\nexport function a1() { return a2() + b1(); }\n",
      );
      fs.writeFileSync(
        path.join(refDir, 'src', 'pkgA', 'a2.js'),
        'export function a2() { return 2; }\n',
      );
      fs.writeFileSync(
        path.join(refDir, 'src', 'pkgB', 'b1.js'),
        'export function b1() { return 1; }\n',
      );
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
      const reference = snapshotDir(path.join(refDir, '.codegraph', 'graph.db'), 'src/pkgB');

      expect(
        incremental.fanIn,
        "pkgB's fanIn is stale — a cross-directory import gained by pkgA was not reflected on its neighbor (#1738)",
      ).toBe(reference.fanIn);
      expect(incremental.fanIn).toBe(1);
      expect(incremental.cohesion).toBe(reference.cohesion);
    }, 60_000);
  });
}

runScenario('wasm');

describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
