/**
 * Unit tests for the shared, DB-free result-merging logic extracted to
 * `src/ast-analysis/apply-results.ts` (issue #1850). Both `ast-analysis/engine.ts`
 * and `domain/wasm-worker-entry.ts` now import these functions instead of
 * maintaining independent copies — this file exercises the merge logic
 * directly, and guards against the CFG-derived cyclomatic override
 * regression (#1743) at the unit level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasFuncBody,
  indexByLine,
  matchResultToDef,
  storeCfgResults,
  storeComplexityResults,
} from '../../src/ast-analysis/apply-results.js';
import type { Definition, TreeSitterNode, WalkResults } from '../../src/types.js';

/** Minimal fake tree-sitter node satisfying only what the merge functions read. */
function fakeFuncNode(row: number, name: string | null, text = 'function f() {}'): TreeSitterNode {
  return {
    startPosition: { row, column: 0 },
    text,
    childForFieldName: (field: string) => (field === 'name' && name ? { text: name } : null),
  } as unknown as TreeSitterNode;
}

function fakeDef(overrides: Partial<Definition> = {}): Definition {
  return {
    name: 'foo',
    kind: 'function',
    line: 5,
    endLine: 10,
    ...overrides,
  } as Definition;
}

describe('hasFuncBody', () => {
  it('is true for a function/method with a real multi-line body', () => {
    expect(hasFuncBody({ name: 'foo', kind: 'function', line: 5, endLine: 10 })).toBe(true);
    expect(hasFuncBody({ name: 'bar', kind: 'method', line: 5, endLine: 10 })).toBe(true);
  });

  it('is false for non-function/method kinds', () => {
    expect(hasFuncBody({ name: 'Foo', kind: 'class', line: 5, endLine: 10 })).toBe(false);
  });

  it('is false when endLine is missing or not after line (type signature, not a body)', () => {
    expect(hasFuncBody({ name: 'foo', kind: 'function', line: 5 })).toBe(false);
    expect(hasFuncBody({ name: 'foo', kind: 'function', line: 5, endLine: 5 })).toBe(false);
  });

  it('is true for a dotted name with a real body (Class.method, module-table function, receiver method) — issue #1922', () => {
    // A dotted name alone must never disqualify a real, bodied function: it's the normal
    // qualified name for class/struct/impl methods (`Class.method`) and module-table
    // functions (Lua's `M.foo`, Go/Java/C#/PHP/Rust receiver or impl methods) across every
    // extractor. Regression guard for the bug where the file-level "does this file need
    // complexity" gate (`defs.some(hasFuncBody)`) went false for an entire file when every
    // function in it happened to have a dotted name.
    expect(hasFuncBody({ name: 'Foo.bar', kind: 'method', line: 5, endLine: 10 })).toBe(true);
    expect(hasFuncBody({ name: 'M.foo', kind: 'method', line: 5, endLine: 10 })).toBe(true);
  });

  it('is false when the extractor marks the definition bodyless (interface/trait/abstract signature)', () => {
    expect(
      hasFuncBody({ name: 'Foo.bar', kind: 'method', line: 5, endLine: 10, bodyless: true }),
    ).toBe(false);
    // Even a non-dotted signature-only declaration is excluded via `bodyless`.
    expect(
      hasFuncBody({ name: 'bar', kind: 'function', line: 5, endLine: 10, bodyless: true }),
    ).toBe(false);
  });
});

describe('indexByLine / matchResultToDef', () => {
  it('indexes results by 1-based start line and matches by name when multiple share a line', () => {
    const results = [{ funcNode: fakeFuncNode(4, 'a') }, { funcNode: fakeFuncNode(4, 'b') }];
    const byLine = indexByLine(results);
    expect(byLine.get(5)).toHaveLength(2);

    expect(matchResultToDef(byLine.get(5), 'b')).toBe(results[1]);
    // Falls back to the first candidate when no name matches.
    expect(matchResultToDef(byLine.get(5), 'nonexistent')).toBe(results[0]);
  });

  it('returns undefined when there are no candidates at all', () => {
    expect(matchResultToDef(undefined, 'a')).toBeUndefined();
  });
});

describe('storeComplexityResults', () => {
  it('applies AST-derived complexity metrics to the matching definition', () => {
    const def = fakeDef();
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo', 'function foo() {\n  return 1;\n}'),
          funcName: 'foo',
          metrics: { cognitive: 3, cyclomatic: 26, maxNesting: 2 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'javascript');

    expect(def.complexity).toBeDefined();
    expect(def.complexity?.cyclomatic).toBe(26);
    expect(def.complexity?.cognitive).toBe(3);
    expect(def.complexity?.maxNesting).toBe(2);
    expect(def.complexity?.loc).toBeDefined();
  });

  it('does not overwrite a definition that already has complexity', () => {
    const def = fakeDef({ complexity: { cognitive: 1, cyclomatic: 1, maxNesting: 0 } });
    const results: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 9, cyclomatic: 9, maxNesting: 9 },
        },
      ],
    };

    storeComplexityResults(results, [def], 'javascript');

    expect(def.complexity?.cyclomatic).toBe(1);
  });
});

describe('storeCfgResults', () => {
  it('stores CFG blocks/edges without touching complexity.cyclomatic (regression guard for #1743)', () => {
    const def = fakeDef();
    // AST-derived cyclomatic (correctly counts &&/||/??/nested closures).
    const complexityResults: WalkResults = {
      complexity: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          funcName: 'foo',
          metrics: { cognitive: 3, cyclomatic: 26, maxNesting: 2 },
        },
      ],
    };
    storeComplexityResults(complexityResults, [def], 'javascript');
    expect(def.complexity?.cyclomatic).toBe(26);

    // CFG block/edge count that, if wrongly applied as McCabe's `edges - blocks + 2`,
    // would collapse cyclomatic to 1 (the exact #1743 symptom).
    const results: WalkResults = {
      cfg: [
        {
          funcNode: fakeFuncNode(4, 'foo'),
          blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 10 }],
          edges: [],
        },
      ],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg?.blocks).toHaveLength(1);
    // The AST-derived cyclomatic must survive the CFG merge untouched.
    expect(def.complexity?.cyclomatic).toBe(26);
  });

  it('does not overwrite a definition that already has CFG blocks', () => {
    const existingCfg = {
      blocks: [{ id: 0, label: 'entry', startLine: 5, endLine: 10 }],
      edges: [],
    };
    const def = fakeDef({ cfg: existingCfg });
    const results: WalkResults = {
      cfg: [{ funcNode: fakeFuncNode(4, 'foo'), blocks: [], edges: [] }],
    };

    storeCfgResults(results, [def]);

    expect(def.cfg).toBe(existingCfg);
  });
});

describe('shared module is actually used by both call sites (drift guard, #1850)', () => {
  it('ast-analysis/engine.ts imports the merge functions from apply-results.ts instead of redefining them', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/ast-analysis/engine.ts'), 'utf-8');
    expect(src).toMatch(/from ['"]\.\/apply-results\.js['"]/);
    expect(src).not.toMatch(/^function storeCfgResults/m);
    expect(src).not.toMatch(/^function storeComplexityResults/m);
    expect(src).not.toMatch(/^function hasFuncBody/m);
  });

  it('domain/wasm-worker-entry.ts imports the merge functions from apply-results.ts instead of redefining them', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/domain/wasm-worker-entry.ts'),
      'utf-8',
    );
    expect(src).toMatch(/from ['"]\.\.\/ast-analysis\/apply-results\.js['"]/);
    expect(src).not.toMatch(/^function storeCfgResults/m);
    expect(src).not.toMatch(/^function storeComplexityResults/m);
    expect(src).not.toMatch(/^function hasFuncBody/m);
  });
});
