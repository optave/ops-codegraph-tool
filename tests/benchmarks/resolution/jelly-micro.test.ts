/**
 * Jelly Micro-Test Benchmark (imported from github.com/cs-au-dk/jelly/tests/micro)
 *
 * Runs codegraph on each of Jelly's 64 micro-test programs
 * (imported from github.com/cs-au-dk/jelly/tests/micro) and measures how many
 * of Jelly's ground-truth call edges codegraph resolves.
 *
 * Only "named" edges are scored — edges where both caller and callee have a
 * real name (not <anon@…> or <root>). Anonymous-function edges require
 * dataflow-level analysis that codegraph doesn't yet perform.
 *
 * To regenerate fixtures:
 *   node scripts/import-jelly-micro.mjs --src /tmp/jelly-micro-raw
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openReadonlyOrFail } from '../../../src/db/index.js';
import { buildGraph } from '../../../src/domain/graph/builder.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures/jelly-micro');

interface Edge {
  source_name: string;
  source_file: string;
  target_name: string;
  target_file: string;
}

interface ExpectedEdge {
  source: { name: string; file: string };
  target: { name: string; file: string };
}

function edgeKey(src: string, srcFile: string, tgt: string, tgtFile: string) {
  return `${src}@${path.basename(srcFile)} -> ${tgt}@${path.basename(tgtFile)}`;
}

function isNamed(name: string) {
  return !name.startsWith('<anon') && !name.startsWith('<root>');
}

/** All subdirectories that have a .js file and expected-edges.json */
function discoverTests(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((d) => {
      const dir = path.join(FIXTURES_DIR, d);
      return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'expected-edges.json'));
    })
    .sort();
}

/**
 * Per-fixture minimum recall floors based on the baseline measured on origin/main
 * (commit 784951d, June 2026).  Fixtures not listed here default to 0 — they
 * produce 0% recall and can only improve, never regress below zero.
 *
 * Format: fixture-name → minimum recall fraction in [0, 1].
 * Exact fractions shown in comments; stored as the corresponding percentage
 * value so a single lost TP triggers a failure.
 *
 * Note: more1 was moved to the pts-javascript fixture set in #1383 and is
 * no longer part of jelly-micro.
 */
const RECALL_FLOORS: Record<string, number> = {
  accessors3: 1.0, // 1/1
  arguments: 1.0, // 1/1
  classes: 0.2, // 6/30
  defineProperty: 0.5, // 3/6
  fun: 1.0, // 4/4
  generators: 1.0, // 9/9
  'receiver-callee-mixup': 1.0, // 1/1
  rest: 1.0, // 1/1
  spread: 1.0, // 4/4
  super: 0.38, // 5/13
  super2: 0.4, // 2/5
  super3: 1.0, // 3/3
  this: 1.0, // 1/1
};

const tests = discoverTests();

// Sanity-check: every RECALL_FLOORS key must match a discovered fixture name.
// A mismatch means either a fixture was renamed or the key was mistyped, and
// the regression floor would silently degrade to 0 without this guard.
// Only enforce when the fixture directory is present (CI skips the whole suite
// when fixtures are absent).
if (tests.length > 0) {
  const testSet = new Set(tests);
  for (const key of Object.keys(RECALL_FLOORS)) {
    if (!testSet.has(key)) {
      throw new Error(
        `RECALL_FLOORS key "${key}" does not match any discovered fixture in ${FIXTURES_DIR}. ` +
          'Update the key or remove the stale entry.',
      );
    }
  }
}

// Per-test results collected for summary
const allResults: Record<
  string,
  { tp: number; fp: number; fn: number; total: number; named: number }
> = {};

// Skip the entire suite when fixtures aren't present (e.g. in CI where the
// jelly-micro directory is gitignored). Without this guard, vitest errors with
// "No test found in suite" when the for-loop generates no test() calls.
describe.skipIf(tests.length === 0)('Jelly Micro-Test Benchmark', () => {
  afterAll(() => {
    const rows = Object.entries(allResults).sort((a, b) => a[0].localeCompare(b[0]));
    const totNamed = rows.reduce((s, [, r]) => s + r.named, 0);
    const totTP = rows.reduce((s, [, r]) => s + r.tp, 0);
    const totFP = rows.reduce((s, [, r]) => s + r.fp, 0);
    const totFN = rows.reduce((s, [, r]) => s + r.fn, 0);
    const totEdges = rows.reduce((s, [, r]) => s + r.total, 0);
    const recall = totNamed > 0 ? totTP / totNamed : 0;
    const precision = totTP + totFP > 0 ? totTP / (totTP + totFP) : 0;

    const lines = [
      '\n╔══════════════════════════════════════════════════════════╗',
      '║  Jelly Micro-Test Benchmark Summary                      ║',
      '╚══════════════════════════════════════════════════════════╝',
      '',
      `  Tests run:    ${rows.length}`,
      `  Jelly edges:  ${totEdges} total · ${totNamed} named (scoreable)`,
      `  Codegraph:    precision=${(precision * 100).toFixed(1)}%  recall=${(recall * 100).toFixed(1)}%  TP=${totTP}  FP=${totFP}  FN=${totFN}`,
      '',
      '  ── Per-Test Recall (named edges only) ──',
      '  Test                           Named  TP   FN   Recall',
      '  ──────────────────────────────────────────────────────',
    ];

    for (const [name, r] of rows) {
      if (r.named === 0) continue; // skip tests with no named edges
      const rec = r.named > 0 ? ((r.tp / r.named) * 100).toFixed(0) : '–';
      lines.push(
        `  ${name.padEnd(30)} ${String(r.named).padStart(5)}  ${String(r.tp).padStart(3)}  ${String(r.fn).padStart(3)}   ${rec}%`,
      );
    }

    lines.push('');
    console.log(lines.join('\n'));
  });

  for (const testName of tests) {
    describe(testName, () => {
      const fixtureDir = path.join(FIXTURES_DIR, testName);
      let resolvedEdges: Edge[] = [];
      let expectedEdges: ExpectedEdge[] = [];
      let namedExpected: ExpectedEdge[] = [];

      beforeAll(async () => {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(fixtureDir, 'expected-edges.json'), 'utf8'),
        );
        expectedEdges = manifest.edges ?? [];
        namedExpected = expectedEdges.filter(
          (e) => isNamed(e.source.name) && isNamed(e.target.name),
        );

        if (namedExpected.length === 0) {
          allResults[testName] = { tp: 0, fp: 0, fn: 0, total: expectedEdges.length, named: 0 };
          return;
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-jelly-${testName}-`));
        try {
          await buildGraph(fixtureDir, {
            dbPath: path.join(tmpDir, '.codegraph', 'graph.db'),
            incremental: false,
            engine: 'wasm',
            dataflow: false,
            cfg: false,
            ast: false,
          });
          const db = openReadonlyOrFail(path.join(tmpDir, '.codegraph', 'graph.db'));
          try {
            resolvedEdges = db
              .prepare(
                `SELECT src.name AS source_name, src.file AS source_file,
                        tgt.name AS target_name, tgt.file AS target_file
                 FROM edges e
                 JOIN nodes src ON e.source_id = src.id
                 JOIN nodes tgt ON e.target_id = tgt.id
                 WHERE e.kind = 'calls' AND src.kind IN ('function','method')`,
              )
              .all() as Edge[];
          } finally {
            db.close();
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      });

      test('named-edge recall', () => {
        if (namedExpected.length === 0) {
          console.log(`  [${testName}] no named edges — skipped`);
          return;
        }

        const resolvedSet = new Set(
          resolvedEdges.map((e) =>
            edgeKey(e.source_name, e.source_file, e.target_name, e.target_file),
          ),
        );
        const expectedSet = new Set(
          namedExpected.map((e) =>
            edgeKey(e.source.name, e.source.file, e.target.name, e.target.file),
          ),
        );

        let tp = 0;
        const fn: string[] = [];
        for (const key of expectedSet) {
          if (resolvedSet.has(key)) tp++;
          else fn.push(key);
        }
        const fp = [...resolvedSet].filter((k) => !expectedSet.has(k)).length;

        allResults[testName] = {
          tp,
          fp,
          fn: fn.length,
          total: expectedEdges.length,
          named: expectedSet.size,
        };

        const recall = expectedSet.size > 0 ? tp / expectedSet.size : 0;
        console.log(
          `  [${testName}] recall=${(recall * 100).toFixed(0)}% TP=${tp} FN=${fn.length} FP=${fp} (named=${expectedSet.size})`,
        );
        if (fn.length > 0 && fn.length <= 5) {
          for (const e of fn) console.log(`    FN: ${e}`);
        }

        const floor = RECALL_FLOORS[testName] ?? 0;
        expect(recall).toBeGreaterThanOrEqual(floor);
      });
    });
  }
});
