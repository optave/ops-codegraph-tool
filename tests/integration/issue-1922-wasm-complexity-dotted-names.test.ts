/**
 * Integration test for #1922: WASM complexity engine skips an entire file when
 * every function/method in it has a dotted name.
 *
 * `hasFuncBody()` used to treat any dotted name (`Class.method`, `M.foo`) as a
 * "type-signature stub, not a real body" — a proxy that happened to be true for
 * the one case that motivated it (TS interface `method_signature`) but false for
 * every other dotted-name producer: Lua's `M.foo` module-table pattern, Go/Java/
 * C#/PHP/Rust receiver or impl methods, and even a plain `Class.method` in any
 * language. When *every* function/method definition in a file had a dotted name,
 * the file-level "does this file need WASM complexity" gate (`defs.some(...)`)
 * went false for the whole file, and none of its functions got complexity data.
 *
 * The fix replaces the name-shape heuristic with `Definition.bodyless`, a direct
 * signal the extractor sets from the AST node's body field. This test builds
 * fixtures reproducing the exact reported patterns (Lua module table, Go
 * receiver-only file) plus a mixed TS file (real dotted method + a genuinely
 * bodyless multi-line interface signature) to guard against regressing the
 * original interface-stub-filtering behavior the heuristic was protecting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  // Lua module-table pattern: every function has a dotted name (M.foo), and every
  // one has a real, multi-line body.
  'repo.lua': `
local M = {}

function M.save(id, value)
  if value < 0 then
    return false
  end
  for i = 1, 3 do
    if i == value then
      return true
    end
  end
  return true
end

function M.find(id)
  if id == nil then
    return nil
  end
  return id
end

return M
`,
  // Go receiver-only file: no free functions, only dotted receiver methods —
  // each with a real, multi-line body.
  'repo.go': `
package main

type Repo struct {
	items map[string]int
}

func (r *Repo) Save(id string, value int) bool {
	if value < 0 {
		return false
	}
	for i := 0; i < 3; i++ {
		if i == value {
			r.items[id] = value
		}
	}
	return true
}

func (r *Repo) Find(id string) (int, bool) {
	v, ok := r.items[id]
	if !ok {
		return 0, false
	}
	return v, true
}
`,
  // Mixed TS file: a real class method (dotted, bodied) alongside a genuinely
  // bodyless interface method signature that spans multiple lines (the exact
  // shape the original dot-check was added to exclude, per #606).
  'repo.ts': `
interface Repository {
  save(
    id: string,
    value: number,
  ): boolean;
}

class InMemoryRepository implements Repository {
  private items: Map<string, number> = new Map();

  save(id: string, value: number): boolean {
    if (value < 0) {
      return false;
    }
    for (let i = 0; i < 3; i++) {
      if (i === value) {
        this.items.set(id, value);
      }
    }
    return true;
  }
}
`,
};

let tmpDir: string;
let dbPath: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1922-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function complexityRows(file: string): Array<{ name: string; cyclomatic: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n.name AS name, fc.cyclomatic AS cyclomatic
         FROM function_complexity fc
         JOIN nodes n ON n.id = fc.node_id
         WHERE n.file = ?
         ORDER BY n.name`,
      )
      .all(file) as Array<{ name: string; cyclomatic: number }>;
  } finally {
    db.close();
  }
}

describe('issue #1922: WASM complexity file-level gate with all-dotted-name files', () => {
  it('computes complexity for every function in a Lua module-table file (M.foo pattern)', () => {
    const rows = complexityRows('repo.lua');
    expect(rows.map((r) => r.name).sort()).toEqual(['M.find', 'M.save']);
    const save = rows.find((r) => r.name === 'M.save');
    // save() has 2 branches (if value<0, if i==value) — cyclomatic must reflect
    // the real body, not a trivial/absent value.
    expect(save?.cyclomatic).toBeGreaterThan(1);
  });

  it('computes complexity for every method in a Go receiver-only file (no free functions)', () => {
    const rows = complexityRows('repo.go');
    expect(rows.map((r) => r.name).sort()).toEqual(['Repo.Find', 'Repo.Save']);
    const save = rows.find((r) => r.name === 'Repo.Save');
    expect(save?.cyclomatic).toBeGreaterThan(1);
  });

  it('computes complexity for a real dotted class method while still excluding the bodyless interface stub', () => {
    const rows = complexityRows('repo.ts');
    const names = rows.map((r) => r.name);
    // The real, bodied class method must be present with real complexity.
    expect(names).toContain('InMemoryRepository.save');
    const save = rows.find((r) => r.name === 'InMemoryRepository.save');
    expect(save?.cyclomatic).toBeGreaterThan(1);
    // The interface's multi-line, bodyless method signature must NOT get a
    // spurious complexity entry (regression guard for the original #606 intent).
    expect(names).not.toContain('Repository.save');
  });
});
