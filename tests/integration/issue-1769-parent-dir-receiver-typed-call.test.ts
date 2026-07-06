/**
 * Regression test for #1769: a function parameter typed with a class name,
 * declared in a *different, less-deeply-nested directory*, must still
 * resolve method calls on that parameter back to the class's declaration.
 *
 * Root cause: `computeConfidenceJS` (and its Rust mirror `compute_confidence`)
 * scored directory proximity using a fixed-depth check — comparing the
 * parent of the caller's directory to the parent of the target's directory.
 * That check only matched when both files sat at the *same* depth, so a
 * subdirectory file (e.g. `graph/algorithms/bfs.ts`) calling a method on a
 * class declared in its direct parent directory (`graph/model.ts`) was
 * scored as maximally distant (0.3) — well below the 0.5 threshold used by
 * the call-edge resolver's typed-method lookup (`resolveViaTypedMethod` in
 * src/domain/graph/resolver/strategy.ts), so the call edge was silently
 * dropped even though the parameter's type annotation correctly resolved
 * `foo: Foo` to `typeMap['foo'] = 'Foo'`.
 *
 * Setup mirrors the real-world shape from src/graph/algorithms/bfs.ts calling
 * src/graph/model.ts:
 *   - model.ts (parent directory): `export class Foo { bar(x): number {...} }`
 *   - algorithms/consumer.ts (child directory): a function whose PARAMETER is
 *     typed `foo: Foo` (via type annotation, not `new Foo()` construction)
 *     calls `foo.bar(x)`.
 *
 * Expected: a `calls` edge from `useFoo` to `Foo.bar`, in both engines.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
  },
  include: ['**/*.ts'],
});

const MODEL_TS = `
export class Foo {
  bar(x: number): number {
    return x + 1;
  }
}
`;

// Nested one directory deeper than model.ts — mirrors graph/algorithms/bfs.ts
// receiving a `graph: CodeGraph` parameter from graph/model.ts.
const CONSUMER_TS = `
import type { Foo } from '../model.js';

export function useFoo(foo: Foo, x: number): number {
  return foo.bar(x);
}
`;

let tmpWasm: string;
let tmpNative: string;

function writeFixture(dir: string): void {
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG);
  // Both files live under a shared `graph/` directory — NOT at the fixture
  // root — so their relative-path depths mirror the real src/graph/model.ts
  // vs src/graph/algorithms/bfs.ts shape. Placing model.ts directly at the
  // fixture root would make `path.dirname()` hit its "." fixed point at the
  // same recursion depth for both files, which accidentally masks the #1769
  // bug (the old fixed-depth check happens to coincide at the filesystem
  // root regardless of the asymmetry it's supposed to detect).
  fs.mkdirSync(path.join(dir, 'graph', 'algorithms'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graph', 'model.ts'), MODEL_TS);
  fs.writeFileSync(path.join(dir, 'graph', 'algorithms', 'consumer.ts'), CONSUMER_TS);
}

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1769-wasm-'));
  writeFixture(tmpWasm);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1769-native-'));
  writeFixture(tmpNative);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
});

function hasCallEdge(dbPath: string, sourceName: string, targetName: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls' AND n1.name = ? AND n2.name = ?`,
      )
      .get(sourceName, targetName);
    return row !== undefined;
  } finally {
    db.close();
  }
}

describe('parameter-typed receiver call to a parent-directory class (#1769)', () => {
  it('WASM: resolves foo.bar(x) to Foo.bar across a child->parent directory boundary', () => {
    expect(hasCallEdge(path.join(tmpWasm, '.codegraph', 'graph.db'), 'useFoo', 'Foo.bar')).toBe(
      true,
    );
  });

  it('Native: resolves foo.bar(x) to Foo.bar across a child->parent directory boundary', () => {
    expect(hasCallEdge(path.join(tmpNative, '.codegraph', 'graph.db'), 'useFoo', 'Foo.bar')).toBe(
      true,
    );
  });
});
