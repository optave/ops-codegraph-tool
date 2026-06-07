/**
 * Integration test for #1317: prototype-based method call resolution.
 *
 * Verifies that the call-resolver correctly builds edges for:
 *   1. `Foo.prototype.bar = function(){}` — direct method definition
 *   2. `(new Foo).bar()` — inline new-expression receiver
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  'proto.js': `
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
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1317-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  await buildGraph(tmpDir, { incremental: false, skipRegistry: true });
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

describe('prototype method resolution (#1317)', () => {
  it('emits Dog.bark as a method definition', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const node = db.prepare(`SELECT name, kind FROM nodes WHERE name = 'Dog.bark'`).get() as
        | { name: string; kind: string }
        | undefined;
      expect(node).toBeDefined();
      expect(node?.kind).toBe('method');
    } finally {
      db.close();
    }
  });

  it('resolves d.bark() call to Dog.bark via typeMap receiver type', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const barkEdge = edges.find((e) => e.tgt === 'Dog.bark');
    expect(barkEdge).toBeDefined();
  });

  it('resolves (new Dog(...)).bark() inline-new receiver call to Dog.bark', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    // makeAndBark calls (new Dog('Rex')).bark() — inline new receiver
    const inlineNewEdge = edges.find((e) => e.src === 'makeAndBark' && e.tgt === 'Dog.bark');
    expect(inlineNewEdge).toBeDefined();
  });
});
