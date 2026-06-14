/**
 * Integration test for #1458: cross-class field annotation typeMap collision.
 *
 * Two classes with identically-named fields (`repo`) caused the later class's
 * annotation to overwrite the earlier one's bare typeMap key. `this.repo.save()`
 * inside UserService would resolve to OrderRepository instead of UserRepository.
 *
 * Fix: handleFieldDefTypeMap seeds `ClassName.field` at confidence 0.9 as the
 * primary key; the resolver checks the class-scoped key before bare fallback keys
 * for `this.` receivers so the correct type is always chosen.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  'services.ts': `
class OrderRepository {
  save(order: unknown) {}
}
class UserRepository {
  save(user: unknown) {}
}
class OrderService {
  private repo: OrderRepository;
  run() { this.repo.save({}); }
}
class UserService {
  private repo: UserRepository;
  run() { this.repo.save({}); }
}
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1458-'));
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

describe('cross-class field annotation typeMap collision (#1458)', () => {
  it('resolves this.repo.save() inside OrderService.run to OrderRepository.save', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find(
      (e) => e.src === 'OrderService.run' && e.tgt === 'OrderRepository.save',
    );
    expect(
      edge,
      'OrderService.run → OrderRepository.save edge missing; cross-class collision may be present',
    ).toBeDefined();
  });

  it('resolves this.repo.save() inside UserService.run to UserRepository.save', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'UserService.run' && e.tgt === 'UserRepository.save');
    expect(
      edge,
      'UserService.run → UserRepository.save edge missing; cross-class collision may be present',
    ).toBeDefined();
  });

  it('does not emit a false edge from OrderService.run to UserRepository.save', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const falseEdge = edges.find(
      (e) => e.src === 'OrderService.run' && e.tgt === 'UserRepository.save',
    );
    expect(falseEdge).toBeUndefined();
  });

  it('does not emit a false edge from UserService.run to OrderRepository.save', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const falseEdge = edges.find(
      (e) => e.src === 'UserService.run' && e.tgt === 'OrderRepository.save',
    );
    expect(falseEdge).toBeUndefined();
  });
});
