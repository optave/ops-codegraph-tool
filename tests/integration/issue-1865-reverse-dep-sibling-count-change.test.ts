/**
 * Regression test for #1865: `reconnectReverseDepEdges` (`build-edges.ts`,
 * WASM/JS engine) correctly reconnects reverse-dep call edges across an
 * incremental rebuild that shifts a group of same-(name, kind) sibling
 * declarations (#1752) — but ONLY as long as the sibling count itself stays
 * the same. When a same-named/same-kind sibling is ALSO added or removed in
 * the SAME edit that shifts the group, the #1752 fix fell back to its
 * pre-#1752 nearest-line heuristic — exactly the heuristic #1752 proved
 * unreliable once a same-named group shifts far enough.
 *
 * Fixed by replacing the ordinal/nearest-line two-tier heuristic with a
 * single alignment: match old-to-new siblings by rank when the sibling
 * count is unchanged (subsumes #1752's fix), or by the single dominant
 * line-shift that best explains the surviving (untouched) siblings when the
 * count changed — since unrelated code shifts them all by the exact same
 * delta, regardless of how far the group has moved (see `alignSiblingLines`
 * in `build-edges.ts`; mirrored in Rust as `align_sibling_lines` in
 * `detect_changes.rs`, covered by dedicated Rust unit tests there —
 * `pick_reconnect_target_drops_edge_when_its_own_sibling_was_removed`,
 * `pick_reconnect_target_survives_added_sibling_plus_shift`,
 * `reconnect_survives_shift_plus_sibling_removed_in_same_edit`).
 *
 * As of #1863, name-only resolution of an ambiguous same-file/same-name/
 * same-kind call (the mechanism the original #1752 fixture used to produce
 * its saved reverse-dep edges) now resolves to NO edge instead of fanning
 * out — so a real source fixture can no longer *naturally* produce a saved
 * edge targeting one specific sibling among several sharing a raw (name,
 * kind, file) triple (typed/receiver-qualified dispatch avoids the
 * ambiguity by qualifying the node's own name, e.g. `OpenA.close`, which no
 * longer collides with its siblings at all). This test instead seeds the
 * exact DB topology `addReverseDeps`/`reconnectReverseDepEdges` operate on
 * directly — four real `close()` method nodes (produced by a real parse)
 * plus four synthetic reverse-dep `calls` edges, one per method — then
 * exercises the REAL incremental `buildGraph()` pipeline end-to-end,
 * mirroring the direct-DB-fixture strategy the original #1752 Rust unit
 * tests use for the same reason.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const REL_CONN_FILE = 'src/db/conn.ts';

/**
 * Four distinct functions, each returning an object with its OWN `close()`
 * method — same name ("close") and kind ("method") repeated four times in
 * one file, exactly the ambiguous shape #1752 fixed reconnection for
 * (mirrors `src/db/connection.ts`'s four real `close` methods).
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
 * Same fixture, but: (1) an unrelated helper function is inserted above ALL
 * FOUR functions, shifting every `close()` sibling down by a fixed amount
 * without touching any of their own source text, AND (2) `openB`'s `close`
 * is renamed to `shutdown` — changing the sibling count for
 * `(name="close", kind="method")` in this file from 4 to 3 in the SAME edit.
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

export function openA() {
  return {
    close() {
      return 'A';
    },
  };
}

export function openB() {
  return {
    shutdown() {
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
 * One trivial caller function per sibling, in its own untouched file. Each
 * imports its corresponding `open*` function so `findReverseDependencies`
 * genuinely classifies this file as a reverse-dep of `conn.ts` — the actual
 * `close()` reverse-dep call edge is seeded separately (see module doc
 * comment), independent of whatever this import is used for.
 */
function callerSource(name: string, openFn: string): string {
  return `import { ${openFn} } from '../db/conn.js';

export function ${name}(): void {
  ${openFn}();
}
`;
}

function writeFixture(root: string, conn: string): void {
  fs.mkdirSync(path.join(root, 'src', 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
  fs.writeFileSync(path.join(root, REL_CONN_FILE), conn);
  fs.writeFileSync(path.join(root, 'src/features/useA.ts'), callerSource('useA', 'openA'));
  fs.writeFileSync(path.join(root, 'src/features/useB.ts'), callerSource('useB', 'openB'));
  fs.writeFileSync(path.join(root, 'src/features/useC.ts'), callerSource('useC', 'openC'));
  fs.writeFileSync(path.join(root, 'src/features/useD.ts'), callerSource('useD', 'openD'));
}

/**
 * Seeds one synthetic `calls` edge from each `use*` caller to its
 * corresponding `close()` method node — simulating what a high-confidence
 * resolution technique would have produced, without depending on any
 * specific name-resolution behavior (see module doc comment for why a real
 * source pattern can no longer naturally produce this topology post-#1863).
 */
function seedReverseDepEdges(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const closeNodes = db
      .prepare(
        "SELECT id, line FROM nodes WHERE name = 'close' AND kind = 'method' AND file = ? ORDER BY line",
      )
      .all(REL_CONN_FILE) as Array<{ id: number; line: number }>;
    expect(closeNodes).toHaveLength(4);
    const callerIds: Record<string, number> = {};
    for (const name of ['useA', 'useB', 'useC', 'useD']) {
      const row = db
        .prepare("SELECT id FROM nodes WHERE name = ? AND kind = 'function'")
        .get(name) as { id: number } | undefined;
      expect(row, `caller node ${name} must exist`).toBeDefined();
      callerIds[name] = row!.id;
    }
    const insert = db.prepare(
      "INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, 'calls', 0.9, 0)",
    );
    insert.run(callerIds.useA, closeNodes[0]!.id);
    insert.run(callerIds.useB, closeNodes[1]!.id);
    insert.run(callerIds.useC, closeNodes[2]!.id);
    insert.run(callerIds.useD, closeNodes[3]!.id);
  } finally {
    db.close();
  }
}

/** Sorted list of target lines every `close()` reverse-dep edge points to, keyed by caller. */
function findCloseTargetLines(dbPath: string): Record<string, number | null> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result: Record<string, number | null> = {};
    for (const caller of ['useA', 'useB', 'useC', 'useD']) {
      const row = db
        .prepare(
          `SELECT t.line AS line
           FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE s.name = ? AND e.kind = 'calls' AND t.file = ? AND t.kind = 'method'`,
        )
        .get(caller, REL_CONN_FILE) as { line: number } | undefined;
      result[caller] = row?.line ?? null;
    }
    return result;
  } finally {
    db.close();
  }
}

describe('Issue #1865: reverse-dep edges survive a same-named-sibling line shift AND count change in the same edit (wasm)', () => {
  let projDir: string;
  const tmpDirs: string[] = [];
  const dbPath = () => path.join(projDir, '.codegraph', 'graph.db');

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    projDir = mkTmp('cg-1865-wasm-');
    writeFixture(projDir, connSource());
    await buildGraph(projDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    seedReverseDepEdges(dbPath());
  }, 60_000);

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('baseline: each seeded caller points to its own close() line', () => {
    expect(findCloseTargetLines(dbPath())).toEqual({ useA: 3, useB: 11, useC: 19, useD: 27 });
  });

  it('incremental rebuild that shifts the whole close() sibling group AND renames one ' +
    'sibling away (4 -> 3) in the same edit reconnects the untouched siblings correctly ' +
    'and drops the edge to the removed one', async () => {
    // Edit conn.ts only: shift + rename openB's close -> shutdown. None of
    // the use*.ts caller files are touched.
    fs.writeFileSync(path.join(projDir, REL_CONN_FILE), editedConnSource());
    await buildGraph(projDir, { engine: 'wasm', skipRegistry: true }); // incremental (default)

    const afterIncremental = findCloseTargetLines(dbPath());

    // Ground truth: shift the ORIGINAL (pre-edit) close() lines by hand —
    // this is exactly what a correct reconnection must produce. A's/C's/
    // D's own bodies never changed, only the padding above them, so each
    // survivor's new line is fully determined by the file's own new
    // content, independent of the reconnection algorithm under test.
    const newConnLines = fs
      .readFileSync(path.join(projDir, REL_CONN_FILE), 'utf8')
      .split('\n')
      .reduce<number[]>((acc, line, idx) => {
        if (line.trim() === 'close() {') acc.push(idx + 1);
        return acc;
      }, []);
    expect(newConnLines).toHaveLength(3); // A, C, D — B was renamed away

    expect(
      afterIncremental,
      `incremental reconnection result: ${JSON.stringify(afterIncremental)}`,
    ).toEqual({
      useA: newConnLines[0],
      useB: null, // openB's close() no longer exists — edge must be dropped, not mis-wired
      useC: newConnLines[1],
      useD: newConnLines[2],
    });
  }, 60_000);
});
