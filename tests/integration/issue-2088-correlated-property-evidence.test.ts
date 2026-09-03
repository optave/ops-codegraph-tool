/**
 * Integration tests for #2088: receiver-correlated invoked-property evidence.
 *
 * A property `{ resolve: neverCalled }` must not stay live merely because
 * some unrelated `x.resolve(...)` exists. When the owning object literal is
 * proven local-closed, only a member call on a receiver that points at THAT
 * literal counts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import { createIncrementalStmts } from '../helpers/incremental-stmts.js';

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

const FIXTURES: Record<string, Record<string, string>> = {
  decoy: {
    'table.js': `
function neverCalled(x) { return x + 1; }
function isCalled(x) { return x + 2; }
const HANDLERS = {
  resolve: neverCalled,
  reject: isCalled,
};
export function run(x) { return HANDLERS.reject(x); }
`,
    'decoy.js': `
export function decoy(p) { return p.resolve(1); }
`,
  },
  handlers: {
    'handlers.js': `
function isFoo(x) { return x === 1; }
function doFoo(x) { return x; }
const RESOLVERS = [{ matches: isFoo, resolve: doFoo }];
export function pick(x) {
  for (const r of RESOLVERS) if (r.matches(x)) return r.resolve(x);
}
`,
  },
  alias: {
    'alias.js': `
function fnA() { return 1; }
function fnB() { return 2; }
const T = { alpha: fnA, beta: fnB };
const u = T;
export function go() { return u.alpha(); }
`,
  },
  twoFile: {
    'a.js': `
function fnA() { return 1; }
function unusedA() { return 2; }
const T = { alpha: fnA, unused: unusedA };
export function runA() { return T.alpha(); }
`,
    'b.js': `
function fnB() { return 3; }
function unusedB() { return 4; }
const T = { alpha: fnB, unused: unusedB };
export function runB() { return T.alpha(); }
`,
  },
  wrappers: {
    'wrappers.ts': `
function fnParen() { return 1; }
function fnConst(): number { return 2; }
function fnSat(): number { return 3; }
function fnNN(): number { return 4; }
interface Table { alpha(): number }
const T1 = ({ alpha: fnParen });
const T2 = { alpha: fnConst } as const;
const T3 = { alpha: fnSat } satisfies Table;
const T4 = ({ alpha: fnNN })!;
export function run() {
  return T1.alpha() + T2.alpha() + T3.alpha() + T4.alpha();
}
`,
  },
  localFunc: {
    'local.js': `
function fnI() { return 1; }
function makeLocal() {
  const L = { iota: fnI };
  return L.iota();
}
export function go() { return makeLocal(); }
`,
  },
  blockScope: {
    'block.js': `
function fnJ() { return 2; }
function maybeRun(cond) {
  if (cond) {
    const M = { kappa: fnJ };
    M.kappa();
  }
}
export function go() { maybeRun(true); }
`,
  },
  mixedData: {
    'mixed.js': `
function isBaz() { return 3; }
const N = { priority: 1, label: 'default', tags: ['x', 'y'], resolve: isBaz };
export function go() { return N.resolve(); }
`,
  },
  classMethod: {
    'class-method.ts': `
function isFoo33(x: number) { return x === 1; }
function doFoo33(x: number) { return x; }
const RESOLVERS33 = [{ matches: isFoo33, resolve: doFoo33 }];
export class C33 {
  run33(x: number) { for (const r of RESOLVERS33) { if (r.matches(x)) return r.resolve(x); } }
}
`,
  },
  classField: {
    'class-field.js': `
function isFoo34(x) { return x === 1; }
function doFoo34(x) { return x; }
const RESOLVERS34 = [{ matches: isFoo34, resolve: doFoo34 }];
export class C34 {
  run34 = (x) => { for (const r of RESOLVERS34) { if (r.matches(x)) return r.resolve(x); } };
}
`,
  },
  objArrow: {
    'obj-arrow.js': `
function isFoo35(x) { return x === 1; }
function doFoo35(x) { return x; }
const RESOLVERS35 = [{ matches: isFoo35, resolve: doFoo35 }];
export const obj35 = {
  run35: (x) => { for (const r of RESOLVERS35) { if (r.matches(x)) return r.resolve(x); } },
};
`,
  },
  collision: {
    'collision.ts': `
function matchesD36(x: number) { return x === 1; }
function resolveD36(x: number) { return x; }
function matchesE36(x: number) { return x === 2; }
function resolveE36(x: number) { return x + 1; }
const ARR_D36 = [{ matches: matchesD36, resolve: resolveD36 }];
const ARR_E36 = [{ matches: matchesE36, resolve: resolveE36 }];
export class D36 {
  run36(x: number) { for (const r of ARR_D36) { if (r.matches(x)) return r.resolve(x); } }
}
export class E36 {
  run36(x: number) { for (const r of ARR_E36) { if (r.matches(x)) return true; } }
}
`,
  },
};

function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

function readNodes(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind, role FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
      role: string | null;
    }>;
  } finally {
    db.close();
  }
}

function isDead(dbPath: string, name: string): boolean {
  const nodes = readNodes(dbPath);
  const n = nodes.find((row) => row.name === name && row.kind === 'function');
  expect(n, `${name} node not found`).toBeDefined();
  return DEAD_ROLES.has(n!.role ?? '');
}

function countCallsTo(dbPath: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND t.name = ?`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

function siteEscapes(dbPath: string, file: string): number | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare('SELECT escapes FROM object_literal_sites WHERE file = ? LIMIT 1')
      .get(file) as { escapes: number } | undefined;
    return row?.escapes ?? null;
  } finally {
    db.close();
  }
}

async function buildFixture(name: string, engine: 'wasm' | 'native'): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2088-${name}-${engine}-`));
  writeFixture(tmpDir, FIXTURES[name]!);
  await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
  return tmpDir;
}

function runSuite(engine: 'wasm' | 'native') {
  describe(`#2088 correlated property evidence — ${engine}`, () => {
    let decoyDir: string;
    let handlersDir: string;
    let aliasDir: string;
    let twoFileDir: string;
    let wrappersDir: string;
    let localFuncDir: string;
    let blockScopeDir: string;
    let mixedDataDir: string;
    let classMethodDir: string;
    let classFieldDir: string;
    let objArrowDir: string;
    let collisionDir: string;
    let configOffDir: string;
    let incrementalDir: string;

    beforeAll(async () => {
      decoyDir = await buildFixture('decoy', engine);
      handlersDir = await buildFixture('handlers', engine);
      aliasDir = await buildFixture('alias', engine);
      twoFileDir = await buildFixture('twoFile', engine);
      wrappersDir = await buildFixture('wrappers', engine);
      localFuncDir = await buildFixture('localFunc', engine);
      blockScopeDir = await buildFixture('blockScope', engine);
      mixedDataDir = await buildFixture('mixedData', engine);
      classMethodDir = await buildFixture('classMethod', engine);
      classFieldDir = await buildFixture('classField', engine);
      objArrowDir = await buildFixture('objArrow', engine);
      collisionDir = await buildFixture('collision', engine);

      configOffDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2088-configOff-${engine}-`));
      writeFixture(configOffDir, FIXTURES.decoy!);
      fs.writeFileSync(
        path.join(configOffDir, '.codegraphrc.json'),
        JSON.stringify({ analysis: { correlatedPropertyEvidence: false } }),
      );
      await buildGraph(configOffDir, { engine, incremental: false, skipRegistry: true });

      incrementalDir = await buildFixture('decoy', engine);
      const producer = path.join(incrementalDir, 'table.js');
      fs.appendFileSync(producer, '\n// touch for incremental rebuild\n');
      const db = openDb(path.join(incrementalDir, '.codegraph', 'graph.db'));
      initSchema(db);
      await rebuildFile(db, incrementalDir, producer, createIncrementalStmts(db), { engine }, null);
      db.close();
    }, 120_000);

    afterAll(() => {
      for (const dir of [
        decoyDir,
        handlersDir,
        aliasDir,
        twoFileDir,
        wrappersDir,
        localFuncDir,
        blockScopeDir,
        mixedDataDir,
        classMethodDir,
        classFieldDir,
        objArrowDir,
        collisionDir,
        configOffDir,
        incrementalDir,
      ]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('persists invoked_property_sites after a full build, before any rebuildFile', () => {
      // WU-8: native orchestrator (engine=native) and JS orchestrator +
      // native-call-edges (engine=wasm with the addon loaded) must both
      // write the table on the full-build path. decoyDir is never passed
      // through rebuildFile, so a COUNT>0 here cannot be a watch-path write.
      const dbPath = path.join(decoyDir, '.codegraph', 'graph.db');
      const db = new Database(dbPath, { readonly: true });
      try {
        const sites = db.prepare('SELECT COUNT(*) AS c FROM object_literal_sites').get() as {
          c: number;
        };
        const invoked = db.prepare('SELECT COUNT(*) AS c FROM invoked_property_sites').get() as {
          c: number;
        };
        expect(sites.c).toBeGreaterThan(0);
        expect(invoked.c).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });

    it('does not credit an unrelated x.resolve() as evidence for a local-closed table', () => {
      const dbPath = path.join(decoyDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'neverCalled')).toBe(true);
      expect(isDead(dbPath, 'isCalled')).toBe(false);
      expect(countCallsTo(dbPath, 'neverCalled')).toBe(0);
      expect(countCallsTo(dbPath, 'isCalled')).toBeGreaterThan(0);
      expect(siteEscapes(dbPath, 'table.js')).toBe(0);
    });

    it('correlates handler-array for-of receivers to the array-element site', () => {
      const dbPath = path.join(handlersDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'isFoo')).toBe(false);
      expect(isDead(dbPath, 'doFoo')).toBe(false);
      expect(siteEscapes(dbPath, 'handlers.js')).toBe(0);
    });

    it('follows a local alias (const u = T) for T1 evidence', () => {
      const dbPath = path.join(aliasDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'fnA')).toBe(false);
      expect(isDead(dbPath, 'fnB')).toBe(true);
      expect(siteEscapes(dbPath, 'alias.js')).toBe(0);
    });

    it('does not mix same-named tables across files', () => {
      const dbPath = path.join(twoFileDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'fnA')).toBe(false);
      expect(isDead(dbPath, 'fnB')).toBe(false);
      expect(isDead(dbPath, 'unusedA')).toBe(true);
      expect(isDead(dbPath, 'unusedB')).toBe(true);
    });

    it('builds pts maps for parenthesised / as-const / satisfies / non-null wrappers', () => {
      const dbPath = path.join(wrappersDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'fnParen')).toBe(false);
      expect(isDead(dbPath, 'fnConst')).toBe(false);
      expect(isDead(dbPath, 'fnSat')).toBe(false);
      expect(isDead(dbPath, 'fnNN')).toBe(false);
    });

    it('correlates a function-scoped table used only through a tracked position', () => {
      const dbPath = path.join(localFuncDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'fnI')).toBe(false);
      expect(siteEscapes(dbPath, 'local.js')).toBe(0);
    });

    it('correlates a block-scoped table inside an if body', () => {
      const dbPath = path.join(blockScopeDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'fnJ')).toBe(false);
      expect(siteEscapes(dbPath, 'block.js')).toBe(0);
    });

    it('does not over-escape a mixed data/handler table', () => {
      const dbPath = path.join(mixedDataDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'isBaz')).toBe(false);
      expect(siteEscapes(dbPath, 'mixed.js')).toBe(0);
    });

    it('correlates a handler array invoked from a TS class method (#2647)', () => {
      const dbPath = path.join(classMethodDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'isFoo33')).toBe(false);
      expect(isDead(dbPath, 'doFoo33')).toBe(false);
      expect(siteEscapes(dbPath, 'class-method.ts')).toBe(0);
    });

    it('correlates a handler array invoked from a class-field arrow (#2647)', () => {
      const dbPath = path.join(classFieldDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'isFoo34')).toBe(false);
      expect(isDead(dbPath, 'doFoo34')).toBe(false);
      expect(siteEscapes(dbPath, 'class-field.js')).toBe(0);
    });

    it('correlates a handler array invoked from an object-literal arrow prop (#2647)', () => {
      const dbPath = path.join(objArrowDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'isFoo35')).toBe(false);
      expect(isDead(dbPath, 'doFoo35')).toBe(false);
      expect(siteEscapes(dbPath, 'obj-arrow.js')).toBe(0);
    });

    it('keeps colliding same-named class-method arrays live (accepted T2-bounded cost)', () => {
      const dbPath = path.join(collisionDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'matchesD36')).toBe(false);
      expect(isDead(dbPath, 'resolveD36')).toBe(false);
      expect(isDead(dbPath, 'matchesE36')).toBe(false);
      expect(isDead(dbPath, 'resolveE36')).toBe(false);
    });

    it('restores pre-#2088 T2 when analysis.correlatedPropertyEvidence is false', () => {
      const dbPath = path.join(configOffDir, '.codegraph', 'graph.db');
      expect(isDead(dbPath, 'neverCalled')).toBe(false);
      expect(isDead(dbPath, 'isCalled')).toBe(false);
    });

    it('a producer-only watch rebuild keeps the same T1 decision as the full build', () => {
      const dbPath = path.join(incrementalDir, '.codegraph', 'graph.db');
      // rebuildFile reinserts nodes before roles run, so liveness is the
      // calls-edge decision, not nodes.role.
      expect(countCallsTo(dbPath, 'neverCalled')).toBe(0);
      expect(countCallsTo(dbPath, 'isCalled')).toBeGreaterThan(0);
      expect(siteEscapes(dbPath, 'table.js')).toBe(0);
      const db = new Database(dbPath, { readonly: true });
      try {
        const sites = db.prepare('SELECT COUNT(*) AS c FROM object_literal_sites').get() as {
          c: number;
        };
        const invoked = db.prepare('SELECT COUNT(*) AS c FROM invoked_property_sites').get() as {
          c: number;
        };
        expect(sites.c).toBeGreaterThan(0);
        expect(invoked.c).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });
}

runSuite('wasm');
describe.skipIf(!isNativeAvailable())('#2088 native engine', () => {
  runSuite('native');
});
