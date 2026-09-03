/**
 * Soundness gate for #2088: escaping sites keep today's T2 bare-name
 * predicate. A live property must never be reported dead solely because
 * T1 correlation is incomplete.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

const FIXTURES: Record<string, Record<string, string>> = {
  exported: {
    'a.js': `
export function fnA() { return 1; }
export const T = { alpha: fnA };
export function run() { return T.alpha(); }
`,
  },
  paramFlow: {
    'b.js': `
export function register(t) { return t.alpha(); }
`,
    'a.js': `
import { register } from './b.js';
function fnA() { return 1; }
function install() {
  const T = { alpha: fnA };
  register(T);
}
export function go() { install(); }
`,
  },
  thisMethod: {
    'this.js': `
function fnA() { return 1; }
const T = { alpha: fnA, run() { return this.alpha(); } };
export function go() { return T.run(); }
`,
  },
  spread: {
    'spread.js': `
function fnA() { return 1; }
const mixin = { run() { return this.alpha(); } };
const T = { alpha: fnA, ...mixin };
export function go() { return T.run(); }
`,
  },
  forEach: {
    'foreach.js': `
function isFoo(x) { return x === 1; }
function doFoo(x) { return x; }
const RESOLVERS = [{ matches: isFoo, resolve: doFoo }];
export function pick(x) {
  RESOLVERS.forEach((r) => { if (r.matches(x)) r.resolve(x); });
}
`,
  },
  factoryReturn: {
    'factory.js': `
function fnA() { return 1; }
export function make() {
  const T = { alpha: fnA };
  return T;
}
`,
    'consumer.js': `
import { make } from './factory.js';
export function go() { return make().alpha(); }
`,
  },
  globalThisRead: {
    // WU-10 (bh) / B5 / #2640: classic script, no "use strict", no
    // "type": "module". A globalThis-qualified read must mark the site
    // escaping — otherwise T1 exclusive-misses liveFn as dead.
    'globalthis-read.js': `
function liveFn() { return 1; }
var T = { resolve: liveFn };
function sink() { return globalThis.T.resolve(); }
function take(x) { return x.resolve(); }
sink();
take(globalThis.T);
export function go() { return sink(); }
`,
  },
};

function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

function isDead(dbPath: string, name: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const n = db.prepare("SELECT role FROM nodes WHERE name = ? AND kind = 'function'").get(name) as
      | { role: string | null }
      | undefined;
    expect(n, `${name} node not found`).toBeDefined();
    return DEAD_ROLES.has(n!.role ?? '');
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-2088-esc-${name}-${engine}-`));
  writeFixture(tmpDir, FIXTURES[name]!);
  await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
  return tmpDir;
}

function runSuite(engine: 'wasm' | 'native') {
  describe(`#2088 escape fallback — ${engine}`, () => {
    let exportedDir: string;
    let paramDir: string;
    let thisDir: string;
    let spreadDir: string;
    let forEachDir: string;
    let factoryDir: string;
    let globalThisDir: string;

    beforeAll(async () => {
      exportedDir = await buildFixture('exported', engine);
      paramDir = await buildFixture('paramFlow', engine);
      thisDir = await buildFixture('thisMethod', engine);
      spreadDir = await buildFixture('spread', engine);
      forEachDir = await buildFixture('forEach', engine);
      factoryDir = await buildFixture('factoryReturn', engine);
      globalThisDir = await buildFixture('globalThisRead', engine);
    });

    afterAll(() => {
      for (const dir of [
        exportedDir,
        paramDir,
        thisDir,
        spreadDir,
        forEachDir,
        factoryDir,
        globalThisDir,
      ]) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exported tables escape and keep T2 (fnA stays live via T.alpha())', () => {
      const dbPath = path.join(exportedDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'a.js')).toBe(1);
      expect(isDead(dbPath, 'fnA')).toBe(false);
    });

    it('parameter-flow sites escape (register(T)) and keep T2', () => {
      const dbPath = path.join(paramDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'a.js')).toBe(1);
      expect(isDead(dbPath, 'fnA')).toBe(false);
    });

    it('a same-literal this.k() method marks the site escaping', () => {
      const dbPath = path.join(thisDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'this.js')).toBe(1);
      expect(isDead(dbPath, 'fnA')).toBe(false);
    });

    it('object-spread sites escape rather than silently voting safe', () => {
      const dbPath = path.join(spreadDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'spread.js')).toBe(1);
      expect(isDead(dbPath, 'fnA')).toBe(false);
    });

    it('array-container forEach is an escape (no T1 for callback params)', () => {
      const dbPath = path.join(forEachDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'foreach.js')).toBe(1);
      expect(isDead(dbPath, 'isFoo')).toBe(false);
      expect(isDead(dbPath, 'doFoo')).toBe(false);
    });

    it('a returned factory table escapes and keeps T2 via the consumer call', () => {
      const dbPath = path.join(factoryDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'factory.js')).toBe(1);
      expect(isDead(dbPath, 'fnA')).toBe(false);
    });

    it('a globalThis-qualified read of a script-scope var escapes (B5 / #2640 case bh)', () => {
      const dbPath = path.join(globalThisDir, '.codegraph', 'graph.db');
      expect(siteEscapes(dbPath, 'globalthis-read.js')).toBe(1);
      expect(isDead(dbPath, 'liveFn')).toBe(false);
    });
  });
}

runSuite('wasm');
describe.skipIf(!isNativeAvailable())('#2088 escape fallback — native', () => {
  runSuite('native');
});
