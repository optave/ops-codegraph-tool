/**
 * Regression test for #1752: `codegraph check --staged --blast-radius` (and
 * `codegraph fn-impact`) reported a DIFFERENT transitive-caller count for a
 * function after an INCREMENTAL rebuild than after a from-scratch full
 * rebuild of the identical final source — even though the function's own
 * source text and call relationships never changed. A full rebuild always
 * produced the correct, stable number.
 *
 * Root cause: `reconnectReverseDepEdges` (`build-edges.ts`, WASM/JS engine)
 * and its native mirror `reconnect_reverse_dep_edges`
 * (`crates/codegraph-core/.../detect_changes.rs`) re-attach a reverse-dep
 * caller's edge to its purged-and-reinserted target using only
 * `(name, kind, file)` plus "nearest to the old line" as a tiebreak. When a
 * file contains MULTIPLE distinct symbols sharing the same name and kind —
 * e.g. several object-literal `close() {}` methods returned from different
 * functions in the same file, a common pattern for resource-handle wrappers
 * (confirmed in this repo's own `src/db/connection.ts`, which has four such
 * `close` methods, each destructured out by callers exactly like
 * `const { repo, close } = openRepo(...)`) — nearest-line is not a reliable
 * way to tell them apart: once unrelated code inserted elsewhere in the file
 * shifts the whole same-named group, an old reference line can end up
 * numerically closer to a DIFFERENT sibling's new line than to its own,
 * silently re-attaching the edge to the wrong symbol (and, when several
 * saved edges collide on the same wrong candidate, collapsing two distinct
 * edges into one via INSERT OR IGNORE while another candidate is left with
 * no edge at all). A full rebuild is immune because it re-resolves every
 * call from scratch using real call-site information, not line proximity.
 *
 * Root-caused by replaying this repo's own last 35 real commits as a
 * sequence of incremental builds and diffing the result against a full
 * rebuild of the identical final source: node tables were byte-identical,
 * but 5 reverse-dep callers ended up wired to `close@line 433` instead of
 * the correct `close@line 580`. Reproduced in miniature here: a caller that
 * destructures `close` off four candidate `open*()` functions used to
 * resolve (via the global by-name fallback, confidence-gated by directory
 * proximity — `resolveByGlobal` in `resolver/strategy.ts`) to all four
 * same-named `close` siblings at once, exactly mirroring the real edge shape
 * found in this repo's own graph.db.
 *
 * Fixed by recording each target's 1-based ordinal rank (by line) among its
 * same-(name,kind) siblings at save time, and using that ordinal — not line
 * proximity — to re-select the correct candidate after purge+reinsert,
 * falling back to nearest-line only when the sibling count itself changed
 * (a genuinely ambiguous case, e.g. a sibling added/removed since save).
 *
 * #1863 follow-up: `resolveByGlobal`'s exact-name lookup no longer fans out
 * to every same-named candidate — a genuine top-confidence tie (as here, since
 * all four `close` siblings live in the same file and therefore score
 * identical directory-proximity confidence against the caller) now resolves
 * to NO edge rather than betting on all four. That eliminates this fixture's
 * false edges at the root, so the reverse-dep reconnect logic below has
 * nothing to reconnect for this exact shape — the tests instead assert the
 * (now empty) edge set stays IDENTICAL across a full vs. incremental rebuild,
 * preserving #1752's real invariant: whatever `resolveByGlobal` produces,
 * incremental rebuilds must never disagree with a from-scratch rebuild of the
 * same source. The ordinal-based reconnect mechanism itself remains directly
 * covered by the Rust unit tests below (unaffected by the #1863 change, since
 * they operate on synthetic pre-resolved edge fixtures).
 *
 * WASM engine only: the native mirror fix in `reconnect_reverse_dep_edges`
 * (Rust) requires rebuilding the native addon to take effect. Covered
 * instead by dedicated Rust unit/integration tests in `detect_changes.rs`
 * (`pick_reconnect_target_*`, `compute_ordinals_*`,
 * `reconnect_survives_uniform_shift_of_same_named_siblings`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const REL_CONN_FILE = 'src/db/conn.ts';
// Same directory DEPTH as the caller matters: call-target resolution for this
// fixture's unqualified `close()` call falls back to a directory-proximity-
// scored global name match (see module doc comment), which requires the
// caller and target to share a common grandparent directory — mirroring this
// repo's real `src/features/*.ts` -> `src/db/connection.ts` shape.
const REL_CALLER_FILE = 'src/features/caller.ts';

/**
 * Four distinct functions, each returning an object with its OWN `close()`
 * method — same name ("close") and kind ("method") repeated four times in
 * one file, exactly the ambiguous shape that broke reverse-dep reconnection
 * in #1752 (mirrors `src/db/connection.ts`'s four real `close` methods).
 */
function connSource(): string {
  return `export function openA() {
  return {
    close() {
      return 'A';
    },
  };
}

export function openB() {
  return {
    close() {
      return 'B';
    },
  };
}

export function openC() {
  return {
    close() {
      return 'C';
    },
  };
}

export function openD() {
  return {
    close() {
      return 'D';
    },
  };
}
`;
}

/**
 * The same fixture after a new, unrelated function has been inserted above
 * ALL four `open*` functions — shifts every `close` sibling down by a fixed
 * amount without touching any of their own source text.
 */
function editedConnSource(): string {
  return `function helperPadding(x: number): number {
  // Several lines added here shift every function below down by a fixed
  // amount, without touching their own source text at all.
  console.log('padding line 1');
  console.log('padding line 2');
  console.log('padding line 3');
  console.log('padding line 4');
  console.log('padding line 5');
  return x + 1;
}

${connSource()}`;
}

/**
 * Reverse-dep file: never edited across the whole scenario. Destructures
 * `close` off `openC()`'s return value — the exact pattern this repo's own
 * `openRepo()` callers use (`const { repo, close } = openRepo(...)`).
 */
function callerSource(): string {
  return `import { openC } from '../db/conn.js';

export function useC(): void {
  const { close } = openC();
  close();
}
`;
}

function writeFixture(root: string, conn: string): void {
  fs.mkdirSync(path.join(root, 'src', 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
  fs.writeFileSync(path.join(root, REL_CONN_FILE), conn);
  fs.writeFileSync(path.join(root, REL_CALLER_FILE), callerSource());
}

/** Sorted list of target lines every `useC() -> close` edge currently points to. */
function findUseCCloseTargetLines(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT t.line AS line
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE s.name = 'useC' AND t.name = 'close' AND t.kind = 'method'
           AND e.kind = 'calls'
         ORDER BY t.line`,
      )
      .all() as Array<{ line: number }>;
    return rows.map((r) => r.line);
  } finally {
    db.close();
  }
}

describe('Issue #1752: reverse-dep call edges survive same-named-sibling line shifts (wasm)', () => {
  let projDir: string;
  const tmpDirs: string[] = [];
  const dbPath = () => path.join(projDir, '.codegraph', 'graph.db');

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    projDir = mkTmp('cg-1752-wasm-');
    writeFixture(projDir, connSource());
    await buildGraph(projDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('baseline: useC’s ambiguous close() call resolves to no edge (#1863)', () => {
    // All four `close` siblings live in the same file, so they score an
    // identical directory-proximity confidence against the caller — a
    // genuine tie with no receiver/type info to break it. Since #1863,
    // `resolveByGlobal` treats that as unresolved rather than fanning out
    // a false `calls` edge to every sibling.
    const lines = findUseCCloseTargetLines(dbPath());
    expect(lines).toEqual([]);
  });

  it('useC keeps the exact same (empty) set of close() target lines after an incremental rebuild ' +
    'that only inserts an unrelated function above all four open*/close() pairs ' +
    '(matches a from-scratch full rebuild)', async () => {
    // Edit conn.ts only — shifts every close() sibling's line number
    // without touching any of their own source text.
    fs.writeFileSync(path.join(projDir, REL_CONN_FILE), editedConnSource());
    await buildGraph(projDir, { engine: 'wasm', skipRegistry: true }); // incremental (default)
    const incrementalLines = findUseCCloseTargetLines(dbPath());

    // Ground truth: an independent repo built in one full pass with the
    // identical final file content (post-edit).
    const refDir = mkTmp('cg-1752-ref-wasm-');
    writeFixture(refDir, editedConnSource());
    await buildGraph(refDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    const refDbPath = path.join(refDir, '.codegraph', 'graph.db');
    const referenceLines = findUseCCloseTargetLines(refDbPath);

    // Post-#1863, the ambiguous tie resolves to no edge in a full rebuild too.
    expect(
      referenceLines,
      'reference full rebuild: useC -> close should resolve to no edge (#1863 ambiguity guard)',
    ).toEqual([]);

    expect(
      incrementalLines,
      'useC’s close() call edges must agree between an incremental rebuild and a ' +
        `from-scratch rebuild of identical source — incremental target lines=[${incrementalLines}], ` +
        `full-rebuild ground truth=[${referenceLines}]`,
    ).toEqual(referenceLines);

    // The old nearest-line heuristic didn't just pick a wrong candidate —
    // it could collapse two distinct saved edges onto the SAME new node
    // (via INSERT OR IGNORE) while leaving another candidate un-targeted.
    // Guard against that regression shape explicitly (trivially holds for
    // an empty set, but keeps this invariant checked if the fixture ever
    // gains an unambiguous edge again).
    expect(new Set(incrementalLines).size).toBe(incrementalLines.length);
  }, 60_000);
});
