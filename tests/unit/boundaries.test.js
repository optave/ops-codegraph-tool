import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  evaluateBoundaries,
  globToRegex,
  PRESETS,
  resolveModules,
  validateBoundaryConfig,
} from '../../src/features/boundaries.js';

// ─── globToRegex ─────────────────────────────────────────────────────

describe('globToRegex', () => {
  test('** matches any path depth', () => {
    const re = globToRegex('src/**/*.js');
    expect(re.test('src/foo.js')).toBe(true);
    expect(re.test('src/a/b/c.js')).toBe(true);
    expect(re.test('lib/foo.js')).toBe(false);
  });

  test('* matches non-slash characters', () => {
    const re = globToRegex('src/*.js');
    expect(re.test('src/foo.js')).toBe(true);
    expect(re.test('src/a/foo.js')).toBe(false);
  });

  test('? matches single non-slash character', () => {
    const re = globToRegex('src/?.js');
    expect(re.test('src/a.js')).toBe(true);
    expect(re.test('src/ab.js')).toBe(false);
  });

  test('escapes special regex characters', () => {
    const re = globToRegex('src/file.name.js');
    expect(re.test('src/file.name.js')).toBe(true);
    expect(re.test('src/filexnamexjs')).toBe(false);
  });

  test('** at start matches any prefix', () => {
    const re = globToRegex('**/*.test.js');
    expect(re.test('src/foo.test.js')).toBe(true);
    expect(re.test('a/b/c.test.js')).toBe(true);
    expect(re.test('foo.test.js')).toBe(true);
  });

  test('exact path match', () => {
    const re = globToRegex('src/controllers/main.js');
    expect(re.test('src/controllers/main.js')).toBe(true);
    expect(re.test('src/controllers/other.js')).toBe(false);
  });
});

// ─── resolveModules ──────────────────────────────────────────────────

describe('resolveModules', () => {
  test('string shorthand form', () => {
    const modules = resolveModules({ modules: { controllers: 'src/controllers/**' } });
    expect(modules.size).toBe(1);
    expect(modules.get('controllers').pattern).toBe('src/controllers/**');
  });

  test('object form with match', () => {
    const modules = resolveModules({
      modules: { services: { match: 'src/services/**' } },
    });
    expect(modules.size).toBe(1);
    expect(modules.get('services').pattern).toBe('src/services/**');
  });

  test('object form with layer', () => {
    const modules = resolveModules({
      modules: { domain: { match: 'src/domain/**', layer: 'domain' } },
    });
    expect(modules.get('domain').layer).toBe('domain');
  });

  test('empty/null config returns empty map', () => {
    expect(resolveModules(null).size).toBe(0);
    expect(resolveModules({}).size).toBe(0);
    expect(resolveModules({ modules: null }).size).toBe(0);
  });
});

// ─── validateBoundaryConfig ──────────────────────────────────────────

describe('validateBoundaryConfig', () => {
  test('valid config with notTo rules', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**', b: 'src/b/**' },
      rules: [{ from: 'a', notTo: ['b'] }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('valid config with onlyTo rules', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**', b: 'src/b/**' },
      rules: [{ from: 'a', onlyTo: ['b'] }],
    });
    expect(result.valid).toBe(true);
  });

  test('rejects null config', () => {
    const result = validateBoundaryConfig(null);
    expect(result.valid).toBe(false);
  });

  test('rejects empty modules', () => {
    const result = validateBoundaryConfig({ modules: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/non-empty/);
  });

  test('rejects both notTo and onlyTo on same rule', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**', b: 'src/b/**' },
      rules: [{ from: 'a', notTo: ['b'], onlyTo: ['b'] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('cannot have both'))).toBe(true);
  });

  test('rejects rule with neither notTo nor onlyTo', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**' },
      rules: [{ from: 'a' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must have either'))).toBe(true);
  });

  test('rejects unknown module in from', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**' },
      rules: [{ from: 'unknown', notTo: ['a'] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown module "unknown"'))).toBe(true);
  });

  test('rejects unknown module in notTo', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**' },
      rules: [{ from: 'a', notTo: ['unknown'] }],
    });
    expect(result.valid).toBe(false);
  });

  test('rejects invalid preset name', () => {
    const result = validateBoundaryConfig({
      modules: { a: 'src/a/**' },
      preset: 'invalid',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must be one of'))).toBe(true);
  });

  test('rejects layer not in preset', () => {
    const result = validateBoundaryConfig({
      modules: { a: { match: 'src/a/**', layer: 'nonexistent' } },
      preset: 'hexagonal',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not in preset'))).toBe(true);
  });

  test('valid preset with correct layers', () => {
    const result = validateBoundaryConfig({
      modules: {
        core: { match: 'src/core/**', layer: 'domain' },
        api: { match: 'src/api/**', layer: 'adapters' },
      },
      preset: 'hexagonal',
    });
    expect(result.valid).toBe(true);
  });
});

// ─── PRESETS ─────────────────────────────────────────────────────────

describe('PRESETS', () => {
  test('all four presets defined', () => {
    expect(PRESETS.hexagonal).toBeDefined();
    expect(PRESETS.layered).toBeDefined();
    expect(PRESETS.clean).toBeDefined();
    expect(PRESETS.onion).toBeDefined();
  });

  test('each preset has layers array', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(Array.isArray(preset.layers)).toBe(true);
      expect(preset.layers.length).toBeGreaterThan(1);
    }
  });
});

// ─── evaluateBoundaries ──────────────────────────────────────────────

describe('evaluateBoundaries', () => {
  let tmpDir, dbPath, db;

  function insertNode(database, name, kind, file, line) {
    return database
      .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
      .run(name, kind, file, line).lastInsertRowid;
  }

  function insertEdge(database, sourceId, targetId, kind) {
    database
      .prepare('INSERT INTO edges (source_id, target_id, kind, confidence) VALUES (?, ?, ?, 1.0)')
      .run(sourceId, targetId, kind);
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-boundaries-'));
    fs.mkdirSync(path.join(tmpDir, '.codegraph'));
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Create file nodes in different "modules"
    const ctrl1 = insertNode(
      db,
      'src/controllers/userCtrl.js',
      'file',
      'src/controllers/userCtrl.js',
      1,
    );
    const ctrl2 = insertNode(
      db,
      'src/controllers/orderCtrl.js',
      'file',
      'src/controllers/orderCtrl.js',
      1,
    );
    const svc1 = insertNode(db, 'src/services/userSvc.js', 'file', 'src/services/userSvc.js', 1);
    const svc2 = insertNode(db, 'src/services/orderSvc.js', 'file', 'src/services/orderSvc.js', 1);
    const dom1 = insertNode(db, 'src/domain/user.js', 'file', 'src/domain/user.js', 1);
    const testFile = insertNode(db, 'tests/ctrl.test.js', 'file', 'tests/ctrl.test.js', 1);

    // controller -> service (allowed)
    insertEdge(db, ctrl1, svc1, 'imports');
    // controller -> controller (violation for notTo rule)
    insertEdge(db, ctrl1, ctrl2, 'imports');
    // service -> domain (allowed)
    insertEdge(db, svc1, dom1, 'imports');
    // service -> controller (violation for preset rules)
    insertEdge(db, svc2, ctrl1, 'imports');
    // test -> controller (test file edge)
    insertEdge(db, testFile, ctrl1, 'imports');

    db.close();
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function openDb() {
    return new Database(dbPath, { readonly: true });
  }

  test('detects notTo violations', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, {
        modules: {
          controllers: 'src/controllers/**',
          services: 'src/services/**',
        },
        rules: [{ from: 'controllers', notTo: ['controllers'] }],
      });
      expect(result.violationCount).toBe(1);
      expect(result.violations[0].name).toBe('controllers -> controllers');
      expect(result.violations[0].file).toBe('src/controllers/userCtrl.js');
      expect(result.violations[0].targetFile).toBe('src/controllers/orderCtrl.js');
    } finally {
      database.close();
    }
  });

  test('detects onlyTo violations', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, {
        modules: {
          controllers: 'src/controllers/**',
          services: 'src/services/**',
          domain: 'src/domain/**',
        },
        rules: [{ from: 'controllers', onlyTo: ['services'] }],
      });
      // controller -> controller violates onlyTo (controllers not in allowed list)
      expect(result.violationCount).toBeGreaterThanOrEqual(1);
      const names = result.violations.map((v) => v.name);
      expect(names).toContain('controllers -> controllers');
    } finally {
      database.close();
    }
  });

  test('scopeFiles limits checked edges', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(
        database,
        {
          modules: {
            controllers: 'src/controllers/**',
            services: 'src/services/**',
          },
          rules: [
            { from: 'controllers', notTo: ['controllers'] },
            { from: 'services', notTo: ['controllers'] },
          ],
        },
        { scopeFiles: ['src/services/orderSvc.js'] },
      );
      // Only service -> controller violation (scoped to orderSvc.js)
      expect(result.violationCount).toBe(1);
      expect(result.violations[0].file).toBe('src/services/orderSvc.js');
    } finally {
      database.close();
    }
  });

  test('noTests excludes test files', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(
        database,
        {
          modules: {
            controllers: 'src/controllers/**',
            tests: 'tests/**',
          },
          rules: [{ from: 'tests', notTo: ['controllers'] }],
        },
        { noTests: true },
      );
      expect(result.violationCount).toBe(0);
    } finally {
      database.close();
    }
  });

  test('preset generates rules from layer assignments', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, {
        modules: {
          controllers: { match: 'src/controllers/**', layer: 'adapters' },
          services: { match: 'src/services/**', layer: 'application' },
          domain: { match: 'src/domain/**', layer: 'domain' },
        },
        preset: 'hexagonal',
      });
      // domain is innermost, cannot import from application/adapters
      // application cannot import from adapters
      // service -> controller = application -> adapters = violation
      const svcToCtrl = result.violations.filter((v) => v.file === 'src/services/orderSvc.js');
      expect(svcToCtrl.length).toBeGreaterThanOrEqual(1);
    } finally {
      database.close();
    }
  });

  test('returns empty on null config', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, null);
      expect(result.violations).toHaveLength(0);
      expect(result.violationCount).toBe(0);
    } finally {
      database.close();
    }
  });

  test('returns empty on invalid config', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, { modules: {} });
      expect(result.violations).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  test('files not in any module are skipped', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, {
        modules: {
          controllers: 'src/controllers/**',
          // services NOT defined as a module
        },
        rules: [{ from: 'controllers', notTo: ['controllers'] }],
      });
      // Only the controller -> controller edge should be a violation
      // controller -> service edges are skipped because services is not a module
      expect(result.violationCount).toBe(1);
    } finally {
      database.close();
    }
  });

  test('custom message appears in violation', () => {
    const database = openDb();
    try {
      const result = evaluateBoundaries(database, {
        modules: {
          controllers: 'src/controllers/**',
        },
        rules: [
          { from: 'controllers', notTo: ['controllers'], message: 'No cross-controller imports' },
        ],
      });
      expect(result.violations[0].message).toBe('No cross-controller imports');
    } finally {
      database.close();
    }
  });
});
