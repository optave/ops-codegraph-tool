/**
 * Integration tests for the structure analysis module.
 * Builds a real graph from a multi-directory fixture and tests structure queries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { hotspotsData, moduleBoundariesData, structureData } from '../../src/features/structure.js';

// Multi-directory fixture with cross-directory imports
const FIXTURE_FILES = {
  'src/math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
`.trimStart(),
  'src/utils.js': `
import { add } from './math.js';
export function double(x) { return add(x, x); }
`.trimStart(),
  'lib/format.js': `
import { add } from '../src/math.js';
export function formatSum(a, b) { return String(add(a, b)); }
`.trimStart(),
  'lib/helpers.js': `
import { formatSum } from './format.js';
export function printSum(a, b) { console.log(formatSum(a, b)); }
`.trimStart(),
  'index.js': `
import { double } from './src/utils.js';
import { printSum } from './lib/helpers.js';
export function main() { printSum(1, double(2)); }
`.trimStart(),
};

let tmpDir, dbPath;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-structure-'));

  // Create directories first
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });

  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(tmpDir, relPath), content);
  }

  await buildGraph(tmpDir, { engine: 'wasm', skipRegistry: true });
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Structure integration', () => {
  test('build creates directory nodes', () => {
    const db = new Database(dbPath, { readonly: true });
    const dirs = db.prepare("SELECT name FROM nodes WHERE kind = 'directory' ORDER BY name").all();
    db.close();
    const dirNames = dirs.map((d) => d.name);
    expect(dirNames).toContain('src');
    expect(dirNames).toContain('lib');
  });

  test('build creates contains edges', () => {
    const db = new Database(dbPath, { readonly: true });
    const containsCount = db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'contains'")
      .get().c;
    db.close();
    expect(containsCount).toBeGreaterThan(0);
  });

  test('build creates node_metrics', () => {
    const db = new Database(dbPath, { readonly: true });
    const metricsCount = db.prepare('SELECT COUNT(*) as c FROM node_metrics').get().c;
    db.close();
    expect(metricsCount).toBeGreaterThan(0);
  });

  test('file metrics have line counts', () => {
    const db = new Database(dbPath, { readonly: true });
    const metrics = db
      .prepare(`
        SELECT n.name, nm.line_count FROM nodes n
        JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'file' AND nm.line_count > 0
      `)
      .all();
    db.close();
    expect(metrics.length).toBeGreaterThan(0);
  });
});

describe('structureData', () => {
  test('returns directories with metrics', () => {
    const data = structureData(dbPath);
    expect(data.directories.length).toBeGreaterThan(0);
    for (const d of data.directories) {
      expect(d).toHaveProperty('directory');
      expect(d).toHaveProperty('fileCount');
      expect(d).toHaveProperty('symbolCount');
      expect(d).toHaveProperty('fanIn');
      expect(d).toHaveProperty('fanOut');
      expect(d).toHaveProperty('files');
    }
  });

  test('filters by directory', () => {
    const data = structureData(dbPath, { directory: 'src' });
    for (const d of data.directories) {
      expect(d.directory).toMatch(/^src/);
    }
  });

  test('limits by depth', () => {
    const data = structureData(dbPath, { depth: 1 });
    for (const d of data.directories) {
      expect(d.directory.split('/').length).toBeLessThanOrEqual(1);
    }
  });

  test('supports JSON output format', () => {
    const data = structureData(dbPath);
    expect(data).toHaveProperty('count');
    expect(data).toHaveProperty('directories');
    expect(typeof data.count).toBe('number');
  });
});

describe('structureData file limit', () => {
  test('default fileLimit truncates files and includes warning when exceeded', () => {
    // Use a very low fileLimit to trigger truncation on the small fixture
    const data = structureData(dbPath, { fileLimit: 2 });
    const shownFiles = data.directories.reduce((sum, d) => sum + d.files.length, 0);
    expect(shownFiles).toBeLessThanOrEqual(2);
    expect(data.suppressed).toBeGreaterThan(0);
    expect(data.warning).toMatch(/files omitted/);
    expect(data.warning).toMatch(/--full/);
  });

  test('full: true returns all files without warning', () => {
    const data = structureData(dbPath, { full: true });
    const totalFiles = data.directories.reduce((sum, d) => sum + d.files.length, 0);
    expect(totalFiles).toBeGreaterThan(0);
    expect(data.suppressed).toBeUndefined();
    expect(data.warning).toBeUndefined();
  });

  test('no truncation when total files are within limit', () => {
    // fileLimit higher than total files should not add warning
    const data = structureData(dbPath, { fileLimit: 100 });
    expect(data.suppressed).toBeUndefined();
    expect(data.warning).toBeUndefined();
  });
});

describe('hotspotsData', () => {
  test('returns file hotspots ranked by fan-in', () => {
    const data = hotspotsData(dbPath, { metric: 'fan-in', level: 'file', limit: 5 });
    expect(data).toHaveProperty('hotspots');
    expect(data.hotspots.length).toBeGreaterThan(0);
    expect(data.hotspots.length).toBeLessThanOrEqual(5);
    // Should be sorted descending by fan-in
    for (let i = 1; i < data.hotspots.length; i++) {
      expect(data.hotspots[i - 1].fanIn).toBeGreaterThanOrEqual(data.hotspots[i].fanIn);
    }
  });

  test('returns directory hotspots', () => {
    const data = hotspotsData(dbPath, { metric: 'fan-in', level: 'directory', limit: 5 });
    expect(data).toHaveProperty('hotspots');
    for (const h of data.hotspots) {
      expect(h.kind).toBe('directory');
    }
  });

  test('supports coupling metric', () => {
    const data = hotspotsData(dbPath, { metric: 'coupling', level: 'file', limit: 3 });
    expect(data.metric).toBe('coupling');
    expect(data.hotspots.length).toBeGreaterThan(0);
  });
});

describe('moduleBoundariesData', () => {
  test('returns modules with cohesion above threshold', () => {
    const data = moduleBoundariesData(dbPath, { threshold: 0.0 });
    expect(data).toHaveProperty('modules');
    expect(data).toHaveProperty('count');
    for (const m of data.modules) {
      expect(m).toHaveProperty('directory');
      expect(m).toHaveProperty('cohesion');
      expect(m.cohesion).toBeGreaterThanOrEqual(0);
    }
  });

  test('high threshold may return fewer or no modules', () => {
    const data = moduleBoundariesData(dbPath, { threshold: 0.99 });
    // Either empty or all have high cohesion
    for (const m of data.modules) {
      expect(m.cohesion).toBeGreaterThanOrEqual(0.99);
    }
  });
});
