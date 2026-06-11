/**
 * Integration test for #1317: prototype-based method call resolution.
 *
 * Verifies that both WASM and native engines correctly build edges for:
 *   1. `Foo.prototype.bar = function(){}` — direct method definition
 *   2. `(new Foo).bar()` — inline new-expression receiver
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_CODE = `
function Animal(name) {
  this.name = name;
}
Animal.prototype.speak = function() {
  return this.name + ' speaks';
};

function Dog(name) {
  Animal.call(this, name);
}
Dog.prototype = Object.create(Animal.prototype);
Dog.prototype.bark = function() {
  return this.name + ' barks';
};

function makeAndBark() {
  // inline new-expression receiver: (new Dog('Rex')).bark()
  return (new Dog('Rex')).bark();
}

const d = new Dog('Buddy');
d.speak();
d.bark();
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1317-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'proto.js'), FIXTURE_CODE);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1317-native-'));
  fs.writeFileSync(path.join(tmpNative, 'proto.js'), FIXTURE_CODE);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
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

function getNode(dbPath: string, name: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT name, kind FROM nodes WHERE name = ?`).get(name) as
      | { name: string; kind: string }
      | undefined;
  } finally {
    db.close();
  }
}

describe('prototype method resolution (#1317)', () => {
  it('WASM: emits Dog.bark as a method definition', () => {
    const node = getNode(path.join(tmpWasm, '.codegraph', 'graph.db'), 'Dog.bark');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('method');
  });

  it('WASM: resolves d.bark() call to Dog.bark via typeMap receiver type', () => {
    const edges = readCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'proto.js' && e.tgt === 'Dog.bark')).toBeDefined();
  });

  it('WASM: resolves (new Dog(...)).bark() inline-new receiver call to Dog.bark', () => {
    const edges = readCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'makeAndBark' && e.tgt === 'Dog.bark')).toBeDefined();
  });

  it('Native: emits Dog.bark as a method definition', () => {
    const node = getNode(path.join(tmpNative, '.codegraph', 'graph.db'), 'Dog.bark');
    expect(node).toBeDefined();
    expect(node?.kind).toBe('method');
  });

  it('Native: resolves d.bark() call to Dog.bark via typeMap receiver type', () => {
    const edges = readCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'proto.js' && e.tgt === 'Dog.bark')).toBeDefined();
  });

  it('Native: resolves (new Dog(...)).bark() inline-new receiver call to Dog.bark', () => {
    const edges = readCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'makeAndBark' && e.tgt === 'Dog.bark')).toBeDefined();
  });
});
