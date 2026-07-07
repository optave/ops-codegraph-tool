/**
 * Regression test for #1839: a directory's fan-in/fan-out stayed stale after
 * an incremental rebuild removed the ONLY file connecting it to a neighbor
 * directory via a cross-directory import.
 *
 * Follow-up to #1738. `refreshAffectedDirectoryMetrics` /
 * `refresh_affected_directory_metrics` (the small-incremental fast path's
 * directory-metrics refresh) discovers cross-directory neighbors by querying
 * LIVE import edges from the affected directories — this works when a file is
 * added or modified (its edges are rebuilt and still present), but not when
 * the file is removed: `purgeFilesFromGraph`/`purgeFilesData` deletes both
 * directions of its edges before the structure stage runs, so there is no
 * live evidence left to discover the neighbor directory from.
 *
 * Root cause: `detectChanges` didn't capture a removed file's cross-directory
 * import neighbors before purging it. Fixed by `captureRemovedFileNeighbors`
 * (WASM) / `capture_removed_file_neighbors` (native), which reads that
 * forward+reverse neighbor-file set BEFORE the purge runs and threads it
 * through to `refreshAffectedDirectoryMetrics`/`refresh_affected_directory_metrics`
 * so the neighbor directory's ancestor chain is still folded into the
 * affected-directory set.
 *
 * Strategy: mirrors the #1738 test — build a fixture with >20 files (crossing
 * the fast path's `existingFileCount > 20` gate), remove the sole
 * cross-directory-import file, then diff the resulting directory metrics
 * against a from-scratch full build of the exact same final file set.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { structureData } from '../../src/features/structure.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Small-incremental fast path requires existingFileCount > 20 — keep a
// healthy margin above that boundary.
const BASE_FILE_COUNT = 24;

function fileContent(i: number): string {
  return `export function fn${i}() { return ${i}; }\n`;
}

/** Write `count` standalone (no cross-imports) padding files into `<root>/src/pad`. */
function writePaddingFixture(root: string, count: number): void {
  fs.mkdirSync(path.join(root, 'src', 'pad'), { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(root, 'src', 'pad', `file${i}.js`), fileContent(i));
  }
}

interface DirSnapshot {
  fileCount: number;
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
    fanIn: entry!.fanIn,
    fanOut: entry!.fanOut,
    cohesion: entry!.cohesion,
    fileNames: entry!.files.map((f) => f.file).sort(),
  };
}

/** Writes the pkgA/pkgB fixture: a1.js is the ONLY file in pkgA importing pkgB. */
function writeCrossDirFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'pkgA'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'pkgB'), { recursive: true });
  writePaddingFixture(root, BASE_FILE_COUNT);
  fs.writeFileSync(
    path.join(root, 'src', 'pkgA', 'a1.js'),
    "import { b1 } from '../pkgB/b1.js';\nexport function a1() { return b1(); }\n",
  );
  fs.writeFileSync(path.join(root, 'src', 'pkgA', 'a2.js'), 'export function a2() { return 2; }\n');
  fs.writeFileSync(path.join(root, 'src', 'pkgB', 'b1.js'), 'export function b1() { return 1; }\n');
}

function runScenario(engine: 'wasm' | 'native'): void {
  describe(`directory fan-in/fan-out after removing the only connecting file (#1839) — ${engine}`, () => {
    const tmpDirs: string[] = [];

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    }

    afterAll(() => {
      for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("clears the neighbor directory's fanIn once the only connecting file is removed via the incremental fast path", async () => {
      const crossDir = mkTmp(`cg-1839-${engine}-`);
      writeCrossDirFixture(crossDir);
      await buildGraph(crossDir, { engine, incremental: false, skipRegistry: true });

      const crossDbPath = () => path.join(crossDir, '.codegraph', 'graph.db');
      const baseline = snapshotDir(crossDbPath(), 'src/pkgB');
      expect(baseline.fanIn).toBe(1);

      // Remove pkgA/a1.js — the ONLY file connecting pkgA to pkgB. This is a
      // pure-removal incremental build (0 parsed files), which trivially
      // stays within smallFilesThreshold, so it exercises the fast path.
      fs.rmSync(path.join(crossDir, 'src', 'pkgA', 'a1.js'));
      await buildGraph(crossDir, { engine, skipRegistry: true }); // incremental (default)
      const incremental = snapshotDir(crossDbPath(), 'src/pkgB');

      // Ground truth: an independent from-scratch full build of the same
      // final source (a1.js gone, everything else unchanged).
      const refDir = mkTmp(`cg-1839-ref-${engine}-`);
      fs.mkdirSync(path.join(refDir, 'src', 'pkgA'), { recursive: true });
      fs.mkdirSync(path.join(refDir, 'src', 'pkgB'), { recursive: true });
      writePaddingFixture(refDir, BASE_FILE_COUNT);
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
        "pkgB's fanIn is stale after removing pkgA's only file importing it (#1839)",
      ).toBe(reference.fanIn);
      expect(incremental.fanIn).toBe(0);
      expect(incremental.cohesion).toBe(reference.cohesion);

      // pkgA itself must also have lost the fanOut it had via a1.js.
      const pkgAIncremental = snapshotDir(crossDbPath(), 'src/pkgA');
      const pkgAReference = snapshotDir(path.join(refDir, '.codegraph', 'graph.db'), 'src/pkgA');
      expect(pkgAIncremental.fanOut).toBe(pkgAReference.fanOut);
      expect(pkgAIncremental.fanOut).toBe(0);
    }, 60_000);
  });
}

runScenario('wasm');

describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
