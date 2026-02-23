/**
 * Integration tests for buildGraph — builds from the fixture project
 * and verifies the resulting database contents.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildGraph } from '../../src/builder.js';

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
});
