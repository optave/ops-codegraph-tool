/**
 * Unit tests for src/cfg.js — buildFunctionCFG
 *
 * Hand-crafted code snippets parsed with tree-sitter to verify
 * correct CFG block/edge construction.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildFunctionCFG } from '../../src/cfg.js';
import { COMPLEXITY_RULES } from '../../src/complexity.js';
import { createParsers } from '../../src/parser.js';

let jsParser;

beforeAll(async () => {
  const parsers = await createParsers();
  jsParser = parsers.get('javascript');
});

function parse(code) {
  const tree = jsParser.parse(code);
  return tree.rootNode;
}

function getFunctionNode(root) {
  const rules = COMPLEXITY_RULES.get('javascript');
  function find(node) {
    if (rules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = find(node.child(i));
      if (result) return result;
    }
    return null;
  }
  return find(root);
}

function buildCFG(code) {
  const root = parse(code);
  const funcNode = getFunctionNode(root);
  if (!funcNode) throw new Error('No function found in code snippet');
  return buildFunctionCFG(funcNode, 'javascript');
}

function hasEdge(cfg, sourceIndex, targetIndex, kind) {
  return cfg.edges.some(
    (e) => e.sourceIndex === sourceIndex && e.targetIndex === targetIndex && e.kind === kind,
  );
}

function blockByType(cfg, type) {
  return cfg.blocks.filter((b) => b.type === type);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('buildFunctionCFG', () => {
  describe('empty / simple functions', () => {
    it('empty function: ENTRY → EXIT', () => {
      const cfg = buildCFG('function empty() {}');
      expect(cfg.blocks.length).toBeGreaterThanOrEqual(2);
      const entry = cfg.blocks.find((b) => b.type === 'entry');
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      expect(entry).toBeDefined();
      expect(exit).toBeDefined();
      expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
    });

    it('simple function with no branching: ENTRY → body → EXIT', () => {
      const cfg = buildCFG(`
        function simple() {
          const a = 1;
          const b = 2;
          return a + b;
        }
      `);
      const entry = cfg.blocks.find((b) => b.type === 'entry');
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      expect(entry).toBeDefined();
      expect(exit).toBeDefined();
      // Should have return edge to exit
      expect(cfg.edges.some((e) => e.targetIndex === exit.index && e.kind === 'return')).toBe(true);
    });

    it('function with only statements (no return): body falls through to EXIT', () => {
      const cfg = buildCFG(`
        function noReturn() {
          const x = 1;
          console.log(x);
        }
      `);
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      expect(cfg.edges.some((e) => e.targetIndex === exit.index && e.kind === 'fallthrough')).toBe(
        true,
      );
    });
  });

  describe('if statements', () => {
    it('single if (no else): condition → [true branch, join]', () => {
      const cfg = buildCFG(`
        function singleIf(x) {
          if (x > 0) {
            console.log('positive');
          }
          return x;
        }
      `);
      const conditions = blockByType(cfg, 'condition');
      expect(conditions.length).toBe(1);
      const trueBlocks = blockByType(cfg, 'branch_true');
      expect(trueBlocks.length).toBe(1);
      // Condition has branch_true and branch_false edges
      const condIdx = conditions[0].index;
      expect(cfg.edges.some((e) => e.sourceIndex === condIdx && e.kind === 'branch_true')).toBe(
        true,
      );
      expect(cfg.edges.some((e) => e.sourceIndex === condIdx && e.kind === 'branch_false')).toBe(
        true,
      );
    });

    it('if/else: condition → [true, false] → join', () => {
      const cfg = buildCFG(`
        function ifElse(x) {
          if (x > 0) {
            return 'positive';
          } else {
            return 'non-positive';
          }
        }
      `);
      const conditions = blockByType(cfg, 'condition');
      expect(conditions.length).toBe(1);
      const trueBlocks = blockByType(cfg, 'branch_true');
      const falseBlocks = blockByType(cfg, 'branch_false');
      expect(trueBlocks.length).toBe(1);
      expect(falseBlocks.length).toBe(1);
    });

    it('if/else-if/else chain', () => {
      const cfg = buildCFG(`
        function chain(x) {
          if (x > 10) {
            return 'big';
          } else if (x > 0) {
            return 'small';
          } else {
            return 'negative';
          }
        }
      `);
      // Should have at least 2 conditions (if + else-if)
      const conditions = blockByType(cfg, 'condition');
      expect(conditions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('loops', () => {
    it('while loop: header → [body → loop_back, exit]', () => {
      const cfg = buildCFG(`
        function whileLoop(n) {
          let i = 0;
          while (i < n) {
            i++;
          }
          return i;
        }
      `);
      const headers = blockByType(cfg, 'loop_header');
      expect(headers.length).toBe(1);
      const bodyBlocks = blockByType(cfg, 'loop_body');
      expect(bodyBlocks.length).toBe(1);
      // Header has branch_true to body and loop_exit
      const hIdx = headers[0].index;
      expect(cfg.edges.some((e) => e.sourceIndex === hIdx && e.kind === 'branch_true')).toBe(true);
      expect(cfg.edges.some((e) => e.sourceIndex === hIdx && e.kind === 'loop_exit')).toBe(true);
      // Body has loop_back to header
      expect(cfg.edges.some((e) => e.kind === 'loop_back' && e.targetIndex === hIdx)).toBe(true);
    });

    it('for loop: header → [body → loop_back, exit]', () => {
      const cfg = buildCFG(`
        function forLoop() {
          for (let i = 0; i < 10; i++) {
            console.log(i);
          }
        }
      `);
      const headers = blockByType(cfg, 'loop_header');
      expect(headers.length).toBe(1);
      expect(headers[0].label).toBe('for');
      expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
      expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
    });

    it('for-in loop', () => {
      const cfg = buildCFG(`
        function forIn(obj) {
          for (const key in obj) {
            console.log(key);
          }
        }
      `);
      const headers = blockByType(cfg, 'loop_header');
      expect(headers.length).toBe(1);
      expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    });

    it('do-while loop: body → condition → [loop_back, exit]', () => {
      const cfg = buildCFG(`
        function doWhile() {
          let i = 0;
          do {
            i++;
          } while (i < 10);
          return i;
        }
      `);
      const headers = blockByType(cfg, 'loop_header');
      expect(headers.length).toBe(1);
      expect(headers[0].label).toBe('do-while');
      const bodyBlocks = blockByType(cfg, 'loop_body');
      expect(bodyBlocks.length).toBe(1);
      // Condition has loop_back to body and loop_exit
      const hIdx = headers[0].index;
      expect(cfg.edges.some((e) => e.sourceIndex === hIdx && e.kind === 'loop_back')).toBe(true);
      expect(cfg.edges.some((e) => e.sourceIndex === hIdx && e.kind === 'loop_exit')).toBe(true);
    });
  });

  describe('break and continue', () => {
    it('break in loop: terminates → loop exit', () => {
      const cfg = buildCFG(`
        function withBreak() {
          for (let i = 0; i < 10; i++) {
            if (i === 5) break;
            console.log(i);
          }
        }
      `);
      expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    });

    it('continue in loop: terminates → loop header', () => {
      const cfg = buildCFG(`
        function withContinue() {
          for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) continue;
            console.log(i);
          }
        }
      `);
      expect(cfg.edges.some((e) => e.kind === 'continue')).toBe(true);
    });
  });

  describe('switch statement', () => {
    it('switch/case: header → each case → join', () => {
      const cfg = buildCFG(`
        function switchCase(x) {
          switch (x) {
            case 1:
              return 'one';
            case 2:
              return 'two';
            default:
              return 'other';
          }
        }
      `);
      const conditions = cfg.blocks.filter((b) => b.type === 'condition' && b.label === 'switch');
      expect(conditions.length).toBe(1);
      const caseBlocks = blockByType(cfg, 'case');
      expect(caseBlocks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('try/catch/finally', () => {
    it('try/catch: try body → [catch via exception, join]', () => {
      const cfg = buildCFG(`
        function tryCatch() {
          try {
            riskyCall();
          } catch (e) {
            console.error(e);
          }
        }
      `);
      const catchBlocks = blockByType(cfg, 'catch');
      expect(catchBlocks.length).toBe(1);
      expect(cfg.edges.some((e) => e.kind === 'exception')).toBe(true);
    });

    it('try/catch/finally: try → [catch, finally] → exit', () => {
      const cfg = buildCFG(`
        function tryCatchFinally() {
          try {
            riskyCall();
          } catch (e) {
            console.error(e);
          } finally {
            cleanup();
          }
        }
      `);
      const catchBlocks = blockByType(cfg, 'catch');
      const finallyBlocks = blockByType(cfg, 'finally');
      expect(catchBlocks.length).toBe(1);
      expect(finallyBlocks.length).toBe(1);
    });

    it('try/finally (no catch)', () => {
      const cfg = buildCFG(`
        function tryFinally() {
          try {
            riskyCall();
          } finally {
            cleanup();
          }
        }
      `);
      const finallyBlocks = blockByType(cfg, 'finally');
      expect(finallyBlocks.length).toBe(1);
    });
  });

  describe('early return and throw', () => {
    it('early return terminates path → EXIT', () => {
      const cfg = buildCFG(`
        function earlyReturn(x) {
          if (x < 0) {
            return -1;
          }
          return x * 2;
        }
      `);
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      const returnEdges = cfg.edges.filter(
        (e) => e.targetIndex === exit.index && e.kind === 'return',
      );
      // Two returns: the early return and the final return
      expect(returnEdges.length).toBe(2);
    });

    it('throw terminates path → EXIT via exception', () => {
      const cfg = buildCFG(`
        function throwError(x) {
          if (x < 0) {
            throw new Error('negative');
          }
          return x;
        }
      `);
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      expect(cfg.edges.some((e) => e.targetIndex === exit.index && e.kind === 'exception')).toBe(
        true,
      );
    });
  });

  describe('nested structures', () => {
    it('nested loops with break resolves to correct enclosing loop', () => {
      const cfg = buildCFG(`
        function nested() {
          for (let i = 0; i < 10; i++) {
            for (let j = 0; j < 10; j++) {
              if (j === 5) break;
            }
          }
        }
      `);
      const headers = blockByType(cfg, 'loop_header');
      expect(headers.length).toBe(2);
      expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    });

    it('if inside loop', () => {
      const cfg = buildCFG(`
        function ifInLoop() {
          for (let i = 0; i < 10; i++) {
            if (i > 5) {
              console.log('big');
            } else {
              console.log('small');
            }
          }
        }
      `);
      expect(blockByType(cfg, 'loop_header').length).toBe(1);
      expect(blockByType(cfg, 'condition').length).toBe(1);
      expect(blockByType(cfg, 'branch_true').length).toBe(1);
      expect(blockByType(cfg, 'branch_false').length).toBe(1);
    });
  });

  describe('arrow functions and methods', () => {
    it('arrow function with block body', () => {
      const cfg = buildCFG(`
        const fn = (x) => {
          if (x) return 1;
          return 0;
        };
      `);
      expect(cfg.blocks.find((b) => b.type === 'entry')).toBeDefined();
      expect(cfg.blocks.find((b) => b.type === 'exit')).toBeDefined();
    });

    it('arrow function with expression body: ENTRY → EXIT', () => {
      const cfg = buildCFG(`
        const fn = (x) => x + 1;
      `);
      const entry = cfg.blocks.find((b) => b.type === 'entry');
      const exit = cfg.blocks.find((b) => b.type === 'exit');
      expect(entry).toBeDefined();
      expect(exit).toBeDefined();
      // Expression body: entry → body → exit
      expect(cfg.blocks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('block and edge counts', () => {
    it('complex function has reasonable block/edge counts', () => {
      const cfg = buildCFG(`
        function complex(arr) {
          if (!arr) return null;
          const result = [];
          for (const item of arr) {
            if (item.skip) continue;
            try {
              result.push(transform(item));
            } catch (e) {
              console.error(e);
            }
          }
          return result;
        }
      `);
      // Should have meaningful structure
      expect(cfg.blocks.length).toBeGreaterThan(5);
      expect(cfg.edges.length).toBeGreaterThan(5);
      // Must have entry and exit
      expect(cfg.blocks.find((b) => b.type === 'entry')).toBeDefined();
      expect(cfg.blocks.find((b) => b.type === 'exit')).toBeDefined();
    });
  });

  describe('unsupported language', () => {
    it('returns empty CFG for unsupported language', () => {
      const root = parse('function foo() { return 1; }');
      const funcNode = getFunctionNode(root);
      const cfg = buildFunctionCFG(funcNode, 'haskell');
      expect(cfg.blocks).toEqual([]);
      expect(cfg.edges).toEqual([]);
    });
  });
});
