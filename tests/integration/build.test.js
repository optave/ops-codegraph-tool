/**
 * Integration tests for buildGraph — builds from the fixture project
 * and verifies the resulting database contents.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeDb, openDb, setBuildMeta } from '../../src/db/index.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { JOURNAL_FILENAME, writeJournalHeader } from '../../src/domain/graph/journal.js';

// ES-module versions of the sample-project fixture so the parser
// generates import edges (the originals use CommonJS require()).
const FIXTURE_FILES = {
  'math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
export function square(x) { return multiply(x, x); }
`.trimStart(),
  'utils.js': `
import { add, square } from './math.js';
export function sumOfSquares(a, b) { return add(square(a), square(b)); }
export class Calculator {
  compute(x, y) { return sumOfSquares(x, y); }
}
`.trimStart(),
  'index.js': `
import { sumOfSquares, Calculator } from './utils.js';
import { add } from './math.js';
export function main() {
  console.log(add(1, 2));
  console.log(sumOfSquares(3, 4));
  const calc = new Calculator();
  console.log(calc.compute(5, 6));
}
`.trimStart(),
};

let tmpDir, dbPath;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-build-'));
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }
  await buildGraph(tmpDir, { skipRegistry: true });
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildGraph', () => {
  test('creates DB file at .codegraph/graph.db', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test('nodes table contains expected file nodes', () => {
    const db = new Database(dbPath, { readonly: true });
    const files = db
      .prepare("SELECT file FROM nodes WHERE kind = 'file'")
      .all()
      .map((r) => r.file);
    db.close();
    expect(files).toContain('math.js');
    expect(files).toContain('utils.js');
    expect(files).toContain('index.js');
  });

  test('nodes table contains expected function/class nodes', () => {
    const db = new Database(dbPath, { readonly: true });
    const names = db
      .prepare("SELECT name FROM nodes WHERE kind IN ('function', 'class', 'method')")
      .all()
      .map((r) => r.name);
    db.close();
    expect(names).toContain('add');
    expect(names).toContain('multiply');
    expect(names).toContain('square');
    expect(names).toContain('sumOfSquares');
    expect(names).toContain('Calculator');
    expect(names).toContain('main');
  });

  test('edges table contains import edges', () => {
    const db = new Database(dbPath, { readonly: true });
    const edges = db
      .prepare(`
      SELECT s.file as src, t.file as tgt FROM edges e
      JOIN nodes s ON e.source_id = s.id
      JOIN nodes t ON e.target_id = t.id
      WHERE e.kind = 'imports' AND s.kind = 'file' AND t.kind = 'file'
    `)
      .all();
    db.close();
    const pairs = edges.map((e) => `${e.src}->${e.tgt}`);
    expect(pairs).toContain('utils.js->math.js');
    expect(pairs).toContain('index.js->utils.js');
    expect(pairs).toContain('index.js->math.js');
  });

  test('edges table contains call edges', () => {
    const db = new Database(dbPath, { readonly: true });
    const edges = db
      .prepare(`
      SELECT s.name as caller, t.name as callee FROM edges e
      JOIN nodes s ON e.source_id = s.id
      JOIN nodes t ON e.target_id = t.id
      WHERE e.kind = 'calls'
    `)
      .all();
    db.close();
    const pairs = edges.map((e) => `${e.caller}->${e.callee}`);
    expect(pairs).toContain('square->multiply');
    expect(pairs).toContain('sumOfSquares->add');
    expect(pairs).toContain('sumOfSquares->square');
  });

  test('file_hashes table populated for all files', () => {
    const db = new Database(dbPath, { readonly: true });
    const hashes = db
      .prepare('SELECT file FROM file_hashes')
      .all()
      .map((r) => r.file);
    db.close();
    expect(hashes).toHaveLength(3);
    expect(hashes).toContain('math.js');
    expect(hashes).toContain('utils.js');
    expect(hashes).toContain('index.js');
  });

  test('file_hashes stores real mtime and size', () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT file, mtime, size FROM file_hashes').all();
    db.close();
    for (const row of rows) {
      // mtime should be a reasonable epoch ms (not Date.now() from build time, but actual file mtime)
      expect(row.mtime).toBeGreaterThan(0);
      // size should be > 0 for our fixture files
      expect(row.size).toBeGreaterThan(0);
    }
  });

  test('journal header is written after build', () => {
    const journalPath = path.join(tmpDir, '.codegraph', JOURNAL_FILENAME);
    expect(fs.existsSync(journalPath)).toBe(true);
    const content = fs.readFileSync(journalPath, 'utf-8');
    expect(content).toMatch(/^# codegraph-journal v1 \d+/);
  });
});

describe('three-tier incremental builds', () => {
  let incrDir, incrDbPath;

  beforeAll(async () => {
    incrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tier-'));
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      fs.writeFileSync(path.join(incrDir, name), content);
    }
    // First full build — disable cfg/dataflow so the no-change rebuild
    // test doesn't trigger a pending analysis pass instead of "No changes detected"
    await buildGraph(incrDir, { skipRegistry: true, cfg: false, dataflow: false });
    incrDbPath = path.join(incrDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    if (incrDir) fs.rmSync(incrDir, { recursive: true, force: true });
  });

  test('rebuild with no changes detects nothing (Tier 1 mtime+size)', async () => {
    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(incrDir, { skipRegistry: true, cfg: false, dataflow: false });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');
    expect(output).toContain('No changes detected');
  });

  test('rebuild after modifying a file detects change (Tier 1 mtime miss → Tier 2 hash)', async () => {
    // Modify math.js
    const mathPath = path.join(incrDir, 'math.js');
    fs.writeFileSync(
      mathPath,
      `${FIXTURE_FILES['math.js']}\nexport function subtract(a, b) { return a - b; }\n`,
    );

    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(incrDir, { skipRegistry: true });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');
    expect(output).toContain('Incremental: 1 changed');

    // Verify the new function was added
    const db = new Database(incrDbPath, { readonly: true });
    const names = db
      .prepare("SELECT name FROM nodes WHERE kind = 'function'")
      .all()
      .map((r) => r.name);
    db.close();
    expect(names).toContain('subtract');
  });

  test('rebuild with valid journal uses Tier 0', async () => {
    // Reset math.js to original
    fs.writeFileSync(path.join(incrDir, 'math.js'), FIXTURE_FILES['math.js']);
    // Build to get clean state
    await buildGraph(incrDir, { skipRegistry: true });

    // Now simulate watcher: write journal with only utils.js changed
    const db = new Database(incrDbPath, { readonly: true });
    const latestMtime = db.prepare('SELECT MAX(mtime) as m FROM file_hashes').get().m;
    db.close();
    writeJournalHeader(incrDir, latestMtime);

    // Modify utils.js and record it in the journal
    const utilsPath = path.join(incrDir, 'utils.js');
    fs.writeFileSync(
      utilsPath,
      `${FIXTURE_FILES['utils.js']}\nexport function helper() { return 42; }\n`,
    );
    fs.appendFileSync(path.join(incrDir, '.codegraph', JOURNAL_FILENAME), 'utils.js\n');

    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(incrDir, { skipRegistry: true });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');
    expect(output).toContain('Incremental: 1 changed');

    // Verify the new function was added
    const db2 = new Database(incrDbPath, { readonly: true });
    const names = db2
      .prepare("SELECT name FROM nodes WHERE kind = 'function'")
      .all()
      .map((r) => r.name);
    db2.close();
    expect(names).toContain('helper');
  });

  test('incremental rebuild preserves edges from unchanged files (issue #116)', async () => {
    // Reset all files to original state and do a clean build
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      fs.writeFileSync(path.join(incrDir, name), content);
    }
    await buildGraph(incrDir, { skipRegistry: true, incremental: false });

    // Record baseline edges
    const db1 = new Database(incrDbPath, { readonly: true });
    const baselineImports = db1
      .prepare(`
        SELECT s.file as src, t.file as tgt FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'imports' AND s.kind = 'file' AND t.kind = 'file'
      `)
      .all()
      .map((e) => `${e.src}->${e.tgt}`)
      .sort();
    const baselineCalls = db1
      .prepare(`
        SELECT s.name as caller, t.name as callee FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'calls'
      `)
      .all()
      .map((e) => `${e.caller}->${e.callee}`)
      .sort();
    db1.close();

    // Touch math.js (append a comment — content changes but exports don't)
    const mathPath = path.join(incrDir, 'math.js');
    fs.writeFileSync(mathPath, `${FIXTURE_FILES['math.js']}// touched\n`);

    // Incremental rebuild
    await buildGraph(incrDir, { skipRegistry: true });

    // Assert import edges match baseline
    const db2 = new Database(incrDbPath, { readonly: true });
    const afterImports = db2
      .prepare(`
        SELECT s.file as src, t.file as tgt FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'imports' AND s.kind = 'file' AND t.kind = 'file'
      `)
      .all()
      .map((e) => `${e.src}->${e.tgt}`)
      .sort();
    const afterCalls = db2
      .prepare(`
        SELECT s.name as caller, t.name as callee FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'calls'
      `)
      .all()
      .map((e) => `${e.caller}->${e.callee}`)
      .sort();
    db2.close();

    // Key assertions: edges FROM unchanged files TO math.js must survive
    expect(afterImports).toContain('utils.js->math.js');
    expect(afterImports).toContain('index.js->math.js');
    expect(afterImports).toEqual(baselineImports);
    expect(afterCalls).toEqual(baselineCalls);
  });

  test('rebuild with corrupt journal falls back to Tier 1', async () => {
    // Reset utils.js
    fs.writeFileSync(path.join(incrDir, 'utils.js'), FIXTURE_FILES['utils.js']);
    await buildGraph(incrDir, { skipRegistry: true, cfg: false, dataflow: false });

    // Corrupt the journal
    fs.writeFileSync(
      path.join(incrDir, '.codegraph', JOURNAL_FILENAME),
      'garbage not a valid header\n',
    );

    // Rebuild with no actual changes — should still detect nothing via Tier 1
    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(incrDir, { skipRegistry: true, cfg: false, dataflow: false });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');
    expect(output).toContain('No changes detected');
  });
});

describe('nested function caller attribution', () => {
  let nestDir, nestDbPath;

  beforeAll(async () => {
    nestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nested-'));
    // File with an outer function containing a nested helper that is called
    fs.writeFileSync(
      path.join(nestDir, 'nested.js'),
      [
        'function outer() {',
        '  function inner() {',
        '    return 42;',
        '  }',
        '  return inner();',
        '}',
        '',
      ].join('\n'),
    );
    await buildGraph(nestDir, { skipRegistry: true });
    nestDbPath = path.join(nestDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    if (nestDir) fs.rmSync(nestDir, { recursive: true, force: true });
  });

  test('enclosing function is the caller of a nested function, not a self-call', () => {
    const db = new Database(nestDbPath, { readonly: true });
    const edges = db
      .prepare(`
        SELECT s.name as caller, t.name as callee FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'calls'
      `)
      .all();
    db.close();
    const pairs = edges.map((e) => `${e.caller}->${e.callee}`);
    // outer() calls inner() — should produce outer->inner edge
    expect(pairs).toContain('outer->inner');
    // Should NOT have inner->inner self-call (the old bug)
    expect(pairs).not.toContain('inner->inner');
  });
});

describe('version/engine mismatch auto-promotes to full rebuild', () => {
  let promoDir, promoDbPath;

  beforeAll(async () => {
    promoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-promo-'));
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      fs.writeFileSync(path.join(promoDir, name), content);
    }
    await buildGraph(promoDir, { skipRegistry: true });
    promoDbPath = path.join(promoDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    if (promoDir) fs.rmSync(promoDir, { recursive: true, force: true });
  });

  test('version mismatch triggers full rebuild', async () => {
    // Tamper the stored schema version to simulate a schema upgrade
    const db = openDb(promoDbPath);
    setBuildMeta(db, { schema_version: '0' });
    closeDb(db);

    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(promoDir, { skipRegistry: true });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');

    // Should promote to full rebuild, not just warn
    expect(output).toContain('promoting to full rebuild');
    // Should NOT say "No changes detected" (that would mean incremental ran)
    expect(output).not.toContain('No changes detected');

    // Verify the stored schema version is now updated
    const db2 = new Database(promoDbPath, { readonly: true });
    const schemaVersion = db2
      .prepare("SELECT value FROM build_meta WHERE key = 'schema_version'")
      .get();
    db2.close();
    expect(schemaVersion.value).not.toBe('0');
  });

  test('engine mismatch triggers full rebuild', async () => {
    // Tamper the stored engine to simulate a switch
    const db = openDb(promoDbPath);
    setBuildMeta(db, { engine: 'fake-engine' });
    closeDb(db);

    const stderrSpy = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrSpy.push(String(chunk));
      return true;
    };
    try {
      await buildGraph(promoDir, { skipRegistry: true });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrSpy.join('');

    expect(output).toContain('Engine changed');
    expect(output).toContain('promoting to full rebuild');
    expect(output).not.toContain('No changes detected');
  });
});

describe('typed method call resolution', () => {
  let typedDir, typedDbPath;

  beforeAll(async () => {
    typedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-typed-'));
    fs.writeFileSync(
      path.join(typedDir, 'typed.ts'),
      [
        'class Router {',
        '  get(path: string) {}',
        '  post(path: string) {}',
        '}',
        'const app: Router = new Router();',
        'app.get("/users");',
        'app.post("/items");',
        '',
      ].join('\n'),
    );
    // Force WASM engine — native binary may not be present in all test environments
    await buildGraph(typedDir, { skipRegistry: true, engine: 'wasm' });
    typedDbPath = path.join(typedDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    if (typedDir) fs.rmSync(typedDir, { recursive: true, force: true });
  });

  test('typed variable call produces call edge to the declared type method', () => {
    const db = new Database(typedDbPath, { readonly: true });
    const edges = db
      .prepare(`
        SELECT s.name as caller, t.name as callee FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'calls'
      `)
      .all();
    db.close();
    const callees = edges.map((e) => e.callee);
    // The key assertion: typed receiver 'app' resolves to Router, producing
    // call edges to Router.get and Router.post
    expect(callees).toContain('Router.get');
    expect(callees).toContain('Router.post');
  });

  test('typed variable produces receiver edge to the class', () => {
    const db = new Database(typedDbPath, { readonly: true });
    const edges = db
      .prepare(`
        SELECT s.name as caller, t.name as target, e.confidence FROM edges e
        JOIN nodes s ON e.source_id = s.id
        JOIN nodes t ON e.target_id = t.id
        WHERE e.kind = 'receiver'
      `)
      .all();
    db.close();
    const receiverEdges = edges.filter((e) => e.target === 'Router');
    expect(receiverEdges.length).toBeGreaterThan(0);
    // Type-resolved receiver edges carry the type source confidence
    // (1.0 for constructor `new Router()`, 0.9 for annotation, 0.7 for factory)
    expect(receiverEdges[0].confidence).toBe(1.0);
  });
});
