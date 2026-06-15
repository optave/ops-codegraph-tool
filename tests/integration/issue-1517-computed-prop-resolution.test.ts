/**
 * Integration test for #1517: computed property name method resolution at call sites.
 *
 * PR #1509 added extraction of computed class/object-literal method names like
 * `['myMethod']()`. The name was stored with brackets (`['myMethod']`), but call
 * sites use the plain property name (`obj.myMethod()`), causing silent resolution
 * failures — no call edge was created even though the method existed.
 *
 * Fix: handleMethodCapture (WASM) and handle_method_def (native) now strip the
 * brackets and quotes from string-literal computed keys, storing the method as
 * `myMethod` (or `ClassName.myMethod` for class methods). Non-string computed
 * keys like `[Symbol.iterator]` are skipped — they cannot be resolved at
 * dot-notation call sites.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'service.js': `
class ApiClient {
  ['fetchData'](url) {
    return url;
  }
  ['postData'](url, body) {
    return body;
  }
  regularMethod() {
    return 42;
  }
}

const client = new ApiClient();
client.fetchData('https://example.com');
client.postData('https://example.com', {});
client.regularMethod();
`,

  'utils.js': `
const helpers = {
  ['formatDate'](date) {
    return date.toString();
  },
  ['parseQuery'](str) {
    return str;
  },
  regularHelper() {
    return true;
  },
};

helpers.formatDate(new Date());
helpers.parseQuery('foo=bar');
helpers.regularHelper();
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1517-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string }>;
  } finally {
    db.close();
  }
}

function readNodes(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
    }>;
  } finally {
    db.close();
  }
}

describe('computed property name method resolution (#1517) — WASM', () => {
  it('stores computed class method under plain name (no brackets)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodes(dbPath);
    const fetchDataNode = nodes.find((n) => n.name === 'ApiClient.fetchData');
    expect(
      fetchDataNode,
      'ApiClient.fetchData node missing — computed method name stored with brackets instead of plain name',
    ).toBeDefined();
    expect(fetchDataNode!.kind).toBe('method');
  });

  it('stores computed object-literal method under plain name (no brackets)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodes(dbPath);
    const formatDateNode = nodes.find((n) => n.name === 'formatDate');
    expect(
      formatDateNode,
      'formatDate node missing — computed method name stored with brackets instead of plain name',
    ).toBeDefined();
    expect(formatDateNode!.kind).toBe('method');
  });

  it('does not store any node with brackets in its name from computed keys', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodes(dbPath);
    const bracketedNodes = nodes.filter((n) => n.name.includes('['));
    expect(
      bracketedNodes,
      `Found nodes with brackets in name (bracket representation leaked): ${bracketedNodes.map((n) => n.name).join(', ')}`,
    ).toHaveLength(0);
  });

  it('resolves call to computed class method at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'ApiClient.fetchData');
    expect(
      edge,
      'No call edge to ApiClient.fetchData — computed class method not resolvable at call site',
    ).toBeDefined();
  });

  it('resolves call to second computed class method at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'ApiClient.postData');
    expect(
      edge,
      'No call edge to ApiClient.postData — computed class method not resolvable at call site',
    ).toBeDefined();
  });

  it('resolves call to regular (non-computed) class method at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'ApiClient.regularMethod');
    expect(
      edge,
      'No call edge to ApiClient.regularMethod — regular method resolution broken by fix',
    ).toBeDefined();
  });

  it('resolves call to computed object-literal method at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'formatDate');
    expect(
      edge,
      'No call edge to formatDate — computed object-literal method not resolvable at call site',
    ).toBeDefined();
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Guards that handle_method_def in Rust applies the same bracket-stripping as
// the four WASM paths. Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'computed property name method resolution (#1517) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1517-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('stores computed class method under plain name (no brackets)', () => {
      const nodes = readNodes(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const node = nodes.find((n) => n.name === 'ApiClient.fetchData');
      expect(
        node,
        'ApiClient.fetchData missing in native output — handle_method_def may not strip brackets',
      ).toBeDefined();
      expect(node!.kind).toBe('method');
    });

    it('does not store any node with brackets in its name from computed keys', () => {
      const nodes = readNodes(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const bracketed = nodes.filter((n) => n.name.includes('['));
      expect(
        bracketed,
        `Native output has bracket-leaked nodes: ${bracketed.map((n) => n.name).join(', ')}`,
      ).toHaveLength(0);
    });

    it('resolves call to computed class method at dot-notation call site', () => {
      const edges = readCallEdges(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const edge = edges.find((e) => e.tgt === 'ApiClient.fetchData');
      expect(
        edge,
        'No native call edge to ApiClient.fetchData — computed method not resolvable in native engine',
      ).toBeDefined();
    });
  },
);
