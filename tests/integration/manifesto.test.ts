/**
 * Integration tests for manifesto rule engine.
 *
 * Creates a temp DB with fixture data, then verifies manifestoData()
 * returns correct pass/fail verdicts and violation details.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { manifestoData, RULE_DEFS } from '../../src/features/manifesto.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine = null) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

function insertComplexity(db, nodeId, cognitive, cyclomatic, maxNesting) {
  db.prepare(
    'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting) VALUES (?, ?, ?, ?)',
  ).run(nodeId, cognitive, cyclomatic, maxNesting);
}

function insertFileMetrics(db, nodeId, opts = {}) {
  db.prepare(
    'INSERT INTO node_metrics (node_id, line_count, symbol_count, import_count, export_count, fan_in, fan_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    nodeId,
    opts.lineCount ?? 100,
    opts.symbolCount ?? 5,
    opts.importCount ?? 3,
    opts.exportCount ?? 2,
    opts.fanIn ?? 1,
    opts.fanOut ?? 2,
  );
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence) VALUES (?, ?, ?, ?)').run(
    sourceId,
    targetId,
    kind,
    confidence,
  );
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Function nodes with varying complexity
  const fn1 = insertNode(db, 'simpleAdd', 'function', 'src/math.js', 1, 3);
  const fn2 = insertNode(db, 'processItems', 'function', 'src/processor.js', 5, 40);
  const fn3 = insertNode(db, 'validateInput', 'function', 'src/validator.js', 1, 20);
  const fn4 = insertNode(db, 'handleRequest', 'method', 'src/handler.js', 10, 50);
  const fn5 = insertNode(db, 'testHelper', 'function', 'tests/helper.test.js', 1, 10);

  insertComplexity(db, fn1, 0, 1, 0); // trivial
  insertComplexity(db, fn2, 18, 8, 4); // above cognitive warn (15), at maxNesting warn (4)
  insertComplexity(db, fn3, 12, 11, 3); // above cyclomatic warn (10)
  insertComplexity(db, fn4, 25, 15, 5); // above all thresholds
  insertComplexity(db, fn5, 5, 3, 2); // test file

  // File nodes with metrics
  const file1 = insertNode(db, 'src/math.js', 'file', 'src/math.js', 1);
  const file2 = insertNode(db, 'src/processor.js', 'file', 'src/processor.js', 1);
  const file3 = insertNode(db, 'src/handler.js', 'file', 'src/handler.js', 1);
  const testFile = insertNode(db, 'tests/helper.test.js', 'file', 'tests/helper.test.js', 1);

  insertFileMetrics(db, file1, {
    importCount: 2,
    exportCount: 1,
    lineCount: 50,
    fanIn: 3,
    fanOut: 1,
  });
  insertFileMetrics(db, file2, {
    importCount: 5,
    exportCount: 3,
    lineCount: 200,
    fanIn: 2,
    fanOut: 4,
  });
  insertFileMetrics(db, file3, {
    importCount: 8,
    exportCount: 2,
    lineCount: 300,
    fanIn: 1,
    fanOut: 6,
  });
  insertFileMetrics(db, testFile, {
    importCount: 3,
    exportCount: 0,
    lineCount: 80,
    fanIn: 0,
    fanOut: 2,
  });

  // Create a file-level cycle: math.js → processor.js → math.js
  insertEdge(db, file1, file2, 'imports');
  insertEdge(db, file2, file1, 'imports');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('manifestoData', () => {
  test('returns all rules with default thresholds', () => {
    const data = manifestoData(dbPath);
    expect(data.rules).toBeDefined();
    expect(data.rules.length).toBe(RULE_DEFS.length);

    const names = data.rules.map((r) => r.name);
    for (const def of RULE_DEFS) {
      expect(names).toContain(def.name);
    }
  });

  test('default thresholds: cognitive/cyclomatic/maxNesting active, file rules disabled', () => {
    const data = manifestoData(dbPath);

    // Function rules should have defaults
    const cognitive = data.rules.find((r) => r.name === 'cognitive');
    expect(cognitive.thresholds.warn).toBe(15);

    const cyclomatic = data.rules.find((r) => r.name === 'cyclomatic');
    expect(cyclomatic.thresholds.warn).toBe(10);

    const maxNesting = data.rules.find((r) => r.name === 'maxNesting');
    expect(maxNesting.thresholds.warn).toBe(4);

    // File rules should be disabled (null thresholds)
    const importCount = data.rules.find((r) => r.name === 'importCount');
    expect(importCount.thresholds.warn).toBeNull();
    expect(importCount.thresholds.fail).toBeNull();
    expect(importCount.status).toBe('pass');
    expect(importCount.violationCount).toBe(0);
  });

  test('detects function-level warn violations (cognitive > 15)', () => {
    const data = manifestoData(dbPath);
    const cogWarn = data.violations.filter((v) => v.rule === 'cognitive' && v.level === 'warn');
    // processItems (18) and handleRequest (25) exceed cognitive warn=15
    expect(cogWarn.length).toBeGreaterThanOrEqual(2);
    const names = cogWarn.map((v) => v.name);
    expect(names).toContain('processItems');
    expect(names).toContain('handleRequest');
  });

  test('detects function-level warn violations (cyclomatic > 10)', () => {
    const data = manifestoData(dbPath);
    const cycWarn = data.violations.filter((v) => v.rule === 'cyclomatic' && v.level === 'warn');
    // validateInput (11) and handleRequest (15) exceed cyclomatic warn=10
    expect(cycWarn.length).toBeGreaterThanOrEqual(2);
    const names = cycWarn.map((v) => v.name);
    expect(names).toContain('validateInput');
    expect(names).toContain('handleRequest');
  });

  test('file-level rules disabled by default produce zero violations', () => {
    const data = manifestoData(dbPath);
    const fileRules = data.rules.filter((r) => r.level === 'file');
    for (const rule of fileRules) {
      expect(rule.status).toBe('pass');
      expect(rule.violationCount).toBe(0);
    }
  });

  test('noTests filter excludes test files from violations', () => {
    const data = manifestoData(dbPath, { noTests: true });
    for (const v of data.violations) {
      if (v.file) {
        expect(v.file).not.toMatch(/\.test\./);
      }
    }
  });

  test('file filter scopes to matching files', () => {
    const data = manifestoData(dbPath, { file: 'handler' });
    // Only handleRequest should appear
    const funcViolations = data.violations.filter((v) => v.rule !== 'noCycles' && v.file);
    for (const v of funcViolations) {
      expect(v.file).toContain('handler');
    }
  });

  test('kind filter scopes to matching symbol kinds', () => {
    const data = manifestoData(dbPath, { kind: 'method' });
    const funcViolations = data.violations.filter(
      (v) => v.rule === 'cognitive' || v.rule === 'cyclomatic' || v.rule === 'maxNesting',
    );
    // Only handleRequest is a method
    for (const v of funcViolations) {
      expect(v.name).toBe('handleRequest');
    }
  });

  test('summary counts are accurate', () => {
    const data = manifestoData(dbPath);
    const s = data.summary;
    expect(s.total).toBe(RULE_DEFS.length);
    expect(s.passed + s.warned + s.failed).toBe(s.total);
    expect(s.violationCount).toBe(data.violations.length);
  });

  test('passed is true when no fail-level violations', () => {
    // Default config has no fail thresholds, so passed should be true
    const data = manifestoData(dbPath);
    expect(data.passed).toBe(true);
    expect(data.violations.every((v) => v.level === 'warn')).toBe(true);
  });

  test('empty DB — graceful handling, all rules pass', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-empty-'));
    fs.mkdirSync(path.join(emptyDir, '.codegraph'));
    const emptyDbPath = path.join(emptyDir, '.codegraph', 'graph.db');

    const db = new Database(emptyDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();

    try {
      const data = manifestoData(emptyDbPath);
      expect(data.passed).toBe(true);
      expect(data.violations.length).toBe(0);
      for (const rule of data.rules) {
        expect(rule.status).toBe('pass');
      }
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('noCycles rule detects cycles when enabled via config', () => {
    // Create a temp config that enables noCycles
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-cycles-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const cycleDbPath = path.join(configDir, '.codegraph', 'graph.db');

    // Copy the fixture DB
    fs.copyFileSync(dbPath, cycleDbPath);

    // Write a config that enables noCycles with warn
    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          rules: {
            noCycles: { warn: true, fail: null },
          },
        },
      }),
    );

    // Temporarily change cwd so loadConfig picks up the config
    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(cycleDbPath);
      const noCyclesRule = data.rules.find((r) => r.name === 'noCycles');
      expect(noCyclesRule.status).toBe('warn');
      expect(noCyclesRule.violationCount).toBeGreaterThan(0);

      const cycleViolations = data.violations.filter((v) => v.rule === 'noCycles');
      expect(cycleViolations.length).toBeGreaterThan(0);
      expect(cycleViolations[0].level).toBe('warn');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('reportOnly complexity rules ignore user-configured fail thresholds', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-reportonly-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const roDbPath = path.join(configDir, '.codegraph', 'graph.db');

    fs.copyFileSync(dbPath, roDbPath);

    // User attempts to set fail thresholds on complexity rules
    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          rules: {
            cognitive: { warn: 15, fail: 5 },
            cyclomatic: { warn: 10, fail: 3 },
            maxNesting: { warn: 4, fail: 2 },
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(roDbPath);

      // fail thresholds should be forced to null (reportOnly)
      for (const name of ['cognitive', 'cyclomatic', 'maxNesting']) {
        const rule = data.rules.find((r) => r.name === name);
        expect(rule.thresholds.fail).toBeNull();
      }

      // All violations should be warn-only, never fail
      const complexityViolations = data.violations.filter(
        (v) => v.rule === 'cognitive' || v.rule === 'cyclomatic' || v.rule === 'maxNesting',
      );
      for (const v of complexityViolations) {
        expect(v.level).toBe('warn');
      }

      // Overall result should pass (no fail-level violations)
      expect(data.passed).toBe(true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('boundaries rule passes when no boundary config exists', () => {
    const data = manifestoData(dbPath);
    const boundariesRule = data.rules.find((r) => r.name === 'boundaries');
    expect(boundariesRule).toBeDefined();
    expect(boundariesRule.status).toBe('pass');
    expect(boundariesRule.violationCount).toBe(0);
  });

  test('boundaries rule detects violations with warn threshold', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-boundaries-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const bDbPath = path.join(configDir, '.codegraph', 'graph.db');

    // Create a DB with cross-module imports
    const bDb = new Database(bDbPath);
    bDb.pragma('journal_mode = WAL');
    initSchema(bDb);

    const ctrl1 = insertNode(bDb, 'src/controllers/a.js', 'file', 'src/controllers/a.js', 1);
    const ctrl2 = insertNode(bDb, 'src/controllers/b.js', 'file', 'src/controllers/b.js', 1);
    const svc1 = insertNode(bDb, 'src/services/x.js', 'file', 'src/services/x.js', 1);
    insertEdge(bDb, ctrl1, ctrl2, 'imports'); // controller -> controller violation
    insertEdge(bDb, ctrl1, svc1, 'imports'); // controller -> service (allowed)
    bDb.close();

    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          boundaries: {
            modules: {
              controllers: 'src/controllers/**',
              services: 'src/services/**',
            },
            rules: [{ from: 'controllers', notTo: ['controllers'] }],
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(bDbPath);
      const boundariesRule = data.rules.find((r) => r.name === 'boundaries');
      expect(boundariesRule.status).toBe('warn');
      expect(boundariesRule.violationCount).toBe(1);

      const bViolations = data.violations.filter((v) => v.rule === 'boundaries');
      expect(bViolations.length).toBe(1);
      expect(bViolations[0].level).toBe('warn');
      expect(bViolations[0].name).toBe('controllers -> controllers');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('boundaries rule with fail threshold sets passed=false', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-bfail-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const bDbPath = path.join(configDir, '.codegraph', 'graph.db');

    const bDb = new Database(bDbPath);
    bDb.pragma('journal_mode = WAL');
    initSchema(bDb);

    const ctrl1 = insertNode(bDb, 'src/controllers/a.js', 'file', 'src/controllers/a.js', 1);
    const ctrl2 = insertNode(bDb, 'src/controllers/b.js', 'file', 'src/controllers/b.js', 1);
    insertEdge(bDb, ctrl1, ctrl2, 'imports');
    bDb.close();

    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          rules: { boundaries: { warn: null, fail: true } },
          boundaries: {
            modules: {
              controllers: 'src/controllers/**',
            },
            rules: [{ from: 'controllers', notTo: ['controllers'] }],
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(bDbPath);
      expect(data.passed).toBe(false);

      const boundariesRule = data.rules.find((r) => r.name === 'boundaries');
      expect(boundariesRule.status).toBe('fail');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('boundaries auto-enables at warn when boundary config exists without threshold', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-bauto-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const bDbPath = path.join(configDir, '.codegraph', 'graph.db');

    const bDb = new Database(bDbPath);
    bDb.pragma('journal_mode = WAL');
    initSchema(bDb);

    const ctrl1 = insertNode(bDb, 'src/controllers/a.js', 'file', 'src/controllers/a.js', 1);
    const ctrl2 = insertNode(bDb, 'src/controllers/b.js', 'file', 'src/controllers/b.js', 1);
    insertEdge(bDb, ctrl1, ctrl2, 'imports');
    bDb.close();

    // No explicit boundaries threshold — should auto-enable at warn
    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          boundaries: {
            modules: { controllers: 'src/controllers/**' },
            rules: [{ from: 'controllers', notTo: ['controllers'] }],
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(bDbPath);
      const boundariesRule = data.rules.find((r) => r.name === 'boundaries');
      expect(boundariesRule.status).toBe('warn');
      expect(boundariesRule.violationCount).toBe(1);
      // Auto-enabled should still pass (warn only)
      expect(data.passed).toBe(true);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('boundaries with preset evaluates layer rules', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-bpreset-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const bDbPath = path.join(configDir, '.codegraph', 'graph.db');

    const bDb = new Database(bDbPath);
    bDb.pragma('journal_mode = WAL');
    initSchema(bDb);

    // domain imports from adapters — violation in hexagonal
    const domFile = insertNode(bDb, 'src/domain/user.js', 'file', 'src/domain/user.js', 1);
    const adapterFile = insertNode(bDb, 'src/api/handler.js', 'file', 'src/api/handler.js', 1);
    insertEdge(bDb, domFile, adapterFile, 'imports');
    bDb.close();

    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          boundaries: {
            modules: {
              domain: { match: 'src/domain/**', layer: 'domain' },
              api: { match: 'src/api/**', layer: 'adapters' },
            },
            preset: 'hexagonal',
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(bDbPath);
      const boundariesRule = data.rules.find((r) => r.name === 'boundaries');
      expect(boundariesRule.violationCount).toBeGreaterThan(0);
      expect(boundariesRule.status).toBe('warn');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('noCycles rule with fail threshold sets passed=false', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manifesto-fail-'));
    fs.mkdirSync(path.join(configDir, '.codegraph'));
    const failDbPath = path.join(configDir, '.codegraph', 'graph.db');

    fs.copyFileSync(dbPath, failDbPath);

    fs.writeFileSync(
      path.join(configDir, '.codegraphrc.json'),
      JSON.stringify({
        manifesto: {
          rules: {
            noCycles: { warn: null, fail: true },
          },
        },
      }),
    );

    const origCwd = process.cwd();
    try {
      process.chdir(configDir);
      const data = manifestoData(failDbPath);
      expect(data.passed).toBe(false);

      const noCyclesRule = data.rules.find((r) => r.name === 'noCycles');
      expect(noCyclesRule.status).toBe('fail');
    } finally {
      process.chdir(origCwd);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
