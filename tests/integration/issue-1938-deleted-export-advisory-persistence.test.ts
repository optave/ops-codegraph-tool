/**
 * Regression test for #1938: `checkNoDeletedExportsInUse` (#1806) missed a
 * deleted file's exported-symbol violation once a *separate* `codegraph
 * build` invocation had already purged that file's `nodes`/`edges` rows —
 * which `detectChanges` does unconditionally for any file no longer found
 * on disk, regardless of whether `codegraph check` has run yet.
 *
 * Root cause: the predicate only ever queried the *current* DB state, with
 * no durable record of what a deleted file's exports/consumers looked like
 * before the purge. Fixed by capturing a snapshot into
 * `deleted_export_advisories` at the exact point `detectChanges` computes
 * the removed-file set — BEFORE purging — so `checkNoDeletedExportsInUse`
 * can fall back to it once the live rows are gone. Both the WASM/JS
 * pipeline (`db/repository/deleted-export-advisories.ts`, wired into
 * `detect-changes.ts`) and the native Rust orchestrator fast path
 * (`record_deleted_export_advisories`/`clear_deleted_export_advisories` in
 * `detect_changes.rs`, wired into `pipeline.rs`'s `save_and_purge_changed`)
 * must produce the same result, since the native path bypasses the JS
 * `detectChanges` stage entirely for a plain incremental build.
 *
 * Strategy: build a real two-file project, delete the file with the
 * external consumer, run a real incremental `buildGraph` (which purges the
 * deleted file's rows via whichever engine's purge path), THEN run
 * `checkData` against the staged deletion and confirm the violation is
 * still reported — proving detection survives purge ordering, not just the
 * "check before any rebuild" case #1806 already covered.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { checkData } from '../../src/features/check.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function runScenario(engine: 'wasm' | 'native'): void {
  describe(`deleted-export advisory survives a purge via the ${engine} engine (#1938)`, () => {
    const tmpDirs: string[] = [];

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    }

    afterAll(() => {
      for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flags the violation from the persisted advisory after an intervening rebuild purges the deleted file', async () => {
      const projectDir = mkTmp(`cg-1938-${engine}-`);
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-1938', version: '1.0.0', type: 'module' }),
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'shared.js'),
        'export function sharedHelper() {\n  return 1;\n}\n',
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'consumer.js'),
        "import { sharedHelper } from './shared.js';\nexport function useShared() {\n  return sharedHelper();\n}\n",
      );

      git(projectDir, ['init']);
      git(projectDir, ['config', 'user.email', 'test@test.com']);
      git(projectDir, ['config', 'user.name', 'Test']);
      git(projectDir, ['add', '.']);
      git(projectDir, ['commit', '-m', 'init']);

      // Initial full build so the graph reflects the committed state.
      await buildGraph(projectDir, { engine, incremental: false, skipRegistry: true });

      // Stage the deletion of shared.js — consumer.js is left untouched,
      // still importing/calling it.
      git(projectDir, ['rm', 'src/shared.js']);

      const dbPath = path.join(projectDir, '.codegraph', 'graph.db');

      // THE KEY STEP: rebuild the graph now (incremental — the default),
      // separately from the `checkData` call below. This is what #1806
      // could not survive: detectChanges purges shared.js's nodes/edges
      // unconditionally, before check ever runs.
      await buildGraph(projectDir, { engine, skipRegistry: true });

      // Sanity check: the purge actually happened — shared.js's exported
      // node must be gone from the live DB by now. If this fails, the test
      // isn't exercising the purged-state path at all.
      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const liveRows = verifyDb.prepare("SELECT * FROM nodes WHERE file = 'src/shared.js'").all();
        expect(liveRows).toEqual([]);
      } finally {
        verifyDb.close();
      }

      const data = checkData(dbPath, {
        staged: true,
        signatures: true,
        cycles: false,
        boundaries: false,
      });

      expect(data.error).toBeUndefined();
      expect(data.passed).toBe(false);
      const sigPred = data.predicates.find((p) => p.name === 'signatures');
      expect(sigPred).toBeDefined();
      expect(sigPred.passed).toBe(false);
      const violation = sigPred.violations.find((v) => v.name === 'sharedHelper');
      expect(violation).toBeDefined();
      expect(violation.reason).toBe('file-deleted');
      expect(violation.consumers.map((c) => c.file)).toContain('src/consumer.js');
    }, 60_000);

    it('clears the advisory once the deleted file reappears, so a later unrelated deletion at the same path is not misattributed', async () => {
      const projectDir = mkTmp(`cg-1938-revert-${engine}-`);
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-1938-revert', version: '1.0.0', type: 'module' }),
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'shared.js'),
        'export function sharedHelper() {\n  return 1;\n}\n',
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'consumer.js'),
        "import { sharedHelper } from './shared.js';\nexport function useShared() {\n  return sharedHelper();\n}\n",
      );

      // No git repo needed here — this test only checks the build
      // pipeline's own advisory bookkeeping, not `checkData`'s git-diff path.
      await buildGraph(projectDir, { engine, incremental: false, skipRegistry: true });

      // Delete shared.js, rebuild (purges + captures the advisory), then
      // bring it back with NO exports at all before the next rebuild.
      fs.rmSync(path.join(projectDir, 'src', 'shared.js'));
      await buildGraph(projectDir, { engine, skipRegistry: true });

      fs.writeFileSync(path.join(projectDir, 'src', 'shared.js'), '// no exports here\n');
      await buildGraph(projectDir, { engine, skipRegistry: true });

      const dbPath = path.join(projectDir, '.codegraph', 'graph.db');
      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const advisoryRows = verifyDb
          .prepare("SELECT * FROM deleted_export_advisories WHERE file = 'src/shared.js'")
          .all();
        expect(advisoryRows).toEqual([]);
      } finally {
        verifyDb.close();
      }
    }, 60_000);

    it('survives a second, unrelated incremental build after the deletion (repeat-build erasure regression)', async () => {
      const projectDir = mkTmp(`cg-1938-repeat-${engine}-`);
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'test-1938-repeat', version: '1.0.0', type: 'module' }),
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'shared.js'),
        'export function sharedHelper() {\n  return 1;\n}\n',
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'consumer.js'),
        "import { sharedHelper } from './shared.js';\nexport function useShared() {\n  return sharedHelper();\n}\n",
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'unrelated.js'),
        'export function unrelatedHelper() {\n  return 2;\n}\n',
      );

      git(projectDir, ['init']);
      git(projectDir, ['config', 'user.email', 'test@test.com']);
      git(projectDir, ['config', 'user.name', 'Test']);
      git(projectDir, ['add', '.']);
      git(projectDir, ['commit', '-m', 'init']);

      await buildGraph(projectDir, { engine, incremental: false, skipRegistry: true });

      // Stage the deletion of shared.js — consumer.js is left untouched.
      git(projectDir, ['rm', 'src/shared.js']);

      const dbPath = path.join(projectDir, '.codegraph', 'graph.db');

      // First rebuild: purges shared.js's nodes/edges and captures the
      // advisory snapshot from the still-live pre-purge state.
      await buildGraph(projectDir, { engine, skipRegistry: true });

      let verifyDb = new Database(dbPath, { readonly: true });
      try {
        const rows = verifyDb
          .prepare("SELECT * FROM deleted_export_advisories WHERE file = 'src/shared.js'")
          .all();
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        verifyDb.close();
      }

      // Second, later incremental build touching a completely unrelated
      // file. `shared.js`'s `file_hashes` row is intentionally never purged,
      // so detectChanges keeps re-classifying it as "removed" on every
      // subsequent build — this must not wipe the already-captured advisory
      // just because its nodes are no longer live to re-derive it from
      // (#1938 repeat-build erasure).
      fs.writeFileSync(
        path.join(projectDir, 'src', 'unrelated.js'),
        'export function unrelatedHelper() {\n  return 3;\n}\n',
      );
      await buildGraph(projectDir, { engine, skipRegistry: true });

      verifyDb = new Database(dbPath, { readonly: true });
      try {
        const rows = verifyDb
          .prepare("SELECT * FROM deleted_export_advisories WHERE file = 'src/shared.js'")
          .all();
        expect(rows.length).toBeGreaterThan(0);
      } finally {
        verifyDb.close();
      }

      const data = checkData(dbPath, {
        staged: true,
        signatures: true,
        cycles: false,
        boundaries: false,
      });

      expect(data.error).toBeUndefined();
      expect(data.passed).toBe(false);
      const sigPred = data.predicates.find((p) => p.name === 'signatures');
      expect(sigPred).toBeDefined();
      expect(sigPred.passed).toBe(false);
      const violation = sigPred.violations.find((v) => v.name === 'sharedHelper');
      expect(violation).toBeDefined();
      expect(violation.reason).toBe('file-deleted');
      expect(violation.consumers.map((c) => c.file)).toContain('src/consumer.js');
    }, 60_000);
  });
}

runScenario('wasm');

describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
