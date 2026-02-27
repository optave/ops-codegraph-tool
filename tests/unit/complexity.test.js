/**
 * Unit tests for src/complexity.js
 *
 * Hand-crafted code snippets parsed with tree-sitter to verify
 * exact cognitive/cyclomatic/nesting values.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  COMPLEXITY_RULES,
  computeFunctionComplexity,
  computeHalsteadMetrics,
  computeLOCMetrics,
  computeMaintainabilityIndex,
  HALSTEAD_RULES,
} from '../../src/complexity.js';
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

function getFunctionBody(root) {
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

function analyze(code) {
  const root = parse(code);
  const funcNode = getFunctionBody(root);
  if (!funcNode) throw new Error('No function found in code snippet');
  return computeFunctionComplexity(funcNode, 'javascript');
}

describe('computeFunctionComplexity', () => {
  it('returns null for unsupported languages', () => {
    const result = computeFunctionComplexity({}, 'unknown_lang');
    expect(result).toBeNull();
  });

  it('simple function — no branching', () => {
    const result = analyze(`
      function simple(a, b) {
        return a + b;
      }
    `);
    expect(result).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if statement', () => {
    const result = analyze(`
      function check(x) {
        if (x > 0) {
          return true;
        }
        return false;
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('nested if', () => {
    const result = analyze(`
      function nested(x, y) {
        if (x > 0) {
          if (y > 0) {
            return true;
          }
        }
        return false;
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('if / else-if / else chain', () => {
    const result = analyze(`
      function classify(x) {
        if (x > 0) {
          return 'positive';
        } else if (x < 0) {
          return 'negative';
        } else {
          return 'zero';
        }
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('switch statement with cases', () => {
    const result = analyze(`
      function sw(x) {
        switch (x) {
          case 1: return 'one';
          case 2: return 'two';
          default: return 'other';
        }
      }
    `);
    expect(result.cognitive).toBe(1);
    expect(result.cyclomatic).toBe(3);
    expect(result.maxNesting).toBe(1);
  });

  it('logical operators — same operator sequence', () => {
    const result = analyze(`
      function check(a, b, c) {
        if (a && b && c) {
          return true;
        }
      }
    `);
    expect(result.cognitive).toBe(2);
    expect(result.cyclomatic).toBe(4);
  });

  it('logical operators — mixed operators', () => {
    const result = analyze(`
      function check(a, b, c) {
        if (a && b || c) {
          return true;
        }
      }
    `);
    expect(result.cognitive).toBe(3);
    expect(result.cyclomatic).toBe(4);
  });

  it('for loop with nested if', () => {
    const result = analyze(`
      function search(arr, target) {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === target) {
            return i;
          }
        }
        return -1;
      }
    `);
    expect(result).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('try/catch', () => {
    const result = analyze(`
      function safeParse(str) {
        try {
          return JSON.parse(str);
        } catch (e) {
          return null;
        }
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('ternary expression', () => {
    const result = analyze(`
      function abs(x) {
        return x >= 0 ? x : -x;
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('nested lambda increases nesting', () => {
    const result = analyze(`
      function outer() {
        const inner = () => {
          if (true) {
            return 1;
          }
        };
      }
    `);
    expect(result.cognitive).toBe(2);
    expect(result.cyclomatic).toBe(2);
    expect(result.maxNesting).toBe(2);
  });

  it('while loop', () => {
    const result = analyze(`
      function countdown(n) {
        while (n > 0) {
          n--;
        }
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('do-while loop', () => {
    const result = analyze(`
      function atLeastOnce(n) {
        do {
          n--;
        } while (n > 0);
      }
    `);
    expect(result).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('complex realistic function', () => {
    const result = analyze(`
      function processItems(items, options) {
        if (!items || items.length === 0) {
          return [];
        }
        const results = [];
        for (const item of items) {
          if (item.type === 'A') {
            if (item.value > 10) {
              results.push(item);
            }
          } else if (item.type === 'B') {
            try {
              results.push(transform(item));
            } catch (e) {
              if (options?.strict) {
                throw e;
              }
            }
          }
        }
        return results;
      }
    `);
    expect(result.cognitive).toBeGreaterThan(5);
    expect(result.cyclomatic).toBeGreaterThan(3);
    expect(result.maxNesting).toBeGreaterThanOrEqual(3);
  });
});

describe('COMPLEXITY_RULES', () => {
  it('supports javascript, typescript, tsx', () => {
    expect(COMPLEXITY_RULES.has('javascript')).toBe(true);
    expect(COMPLEXITY_RULES.has('typescript')).toBe(true);
    expect(COMPLEXITY_RULES.has('tsx')).toBe(true);
  });

  it('returns undefined for unsupported languages', () => {
    expect(COMPLEXITY_RULES.has('python')).toBe(false);
    expect(COMPLEXITY_RULES.has('go')).toBe(false);
  });
});

// ─── Halstead Metrics ─────────────────────────────────────────────────────

function analyzeHalstead(code) {
  const root = parse(code);
  const funcNode = getFunctionBody(root);
  if (!funcNode) throw new Error('No function found in code snippet');
  return computeHalsteadMetrics(funcNode, 'javascript');
}

describe('computeHalsteadMetrics', () => {
  it('returns null for unsupported language', () => {
    const result = computeHalsteadMetrics({}, 'unknown_lang');
    expect(result).toBeNull();
  });

  it('simple function has n1>0, n2>0, volume>0', () => {
    const result = analyzeHalstead(`
      function add(a, b) {
        return a + b;
      }
    `);
    expect(result).not.toBeNull();
    expect(result.n1).toBeGreaterThan(0);
    expect(result.n2).toBeGreaterThan(0);
    expect(result.volume).toBeGreaterThan(0);
    expect(result.difficulty).toBeGreaterThan(0);
    expect(result.effort).toBeGreaterThan(0);
    expect(result.bugs).toBeGreaterThan(0);
  });

  it('empty function body does not crash', () => {
    const result = analyzeHalstead(`
      function empty() {}
    `);
    expect(result).not.toBeNull();
    expect(result.vocabulary).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.volume)).toBe(true);
    expect(Number.isFinite(result.difficulty)).toBe(true);
  });

  it('complex function has greater volume than simple', () => {
    const simple = analyzeHalstead(`
      function add(a, b) { return a + b; }
    `);
    const complex = analyzeHalstead(`
      function process(items, options) {
        const results = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === 'A') {
            results.push(items[i].value * 2 + options.offset);
          } else if (items[i].type === 'B') {
            results.push(items[i].value / 3 - options.offset);
          }
        }
        return results;
      }
    `);
    expect(complex.volume).toBeGreaterThan(simple.volume);
  });

  it('repeated operands increase difficulty', () => {
    // Same identifier used many times vs distinct identifiers
    const repeated = analyzeHalstead(`
      function rep(x) {
        return x + x + x + x + x;
      }
    `);
    const distinct = analyzeHalstead(`
      function dist(a, b, c, d, e) {
        return a + b + c + d + e;
      }
    `);
    // With more distinct operands, difficulty per operand is lower
    expect(repeated.difficulty).toBeGreaterThan(distinct.difficulty);
  });
});

describe('HALSTEAD_RULES', () => {
  it('supports javascript, typescript, tsx', () => {
    expect(HALSTEAD_RULES.has('javascript')).toBe(true);
    expect(HALSTEAD_RULES.has('typescript')).toBe(true);
    expect(HALSTEAD_RULES.has('tsx')).toBe(true);
  });

  it('does not support python or go', () => {
    expect(HALSTEAD_RULES.has('python')).toBe(false);
    expect(HALSTEAD_RULES.has('go')).toBe(false);
  });
});

// ─── LOC Metrics ──────────────────────────────────────────────────────────

describe('computeLOCMetrics', () => {
  it('counts lines correctly', () => {
    const root = parse(`
      function multi(a, b) {
        // comment
        const x = a + b;

        return x;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.loc).toBeGreaterThan(1);
    expect(result.sloc).toBeGreaterThan(0);
    expect(result.commentLines).toBeGreaterThanOrEqual(1);
  });

  it('detects comment lines', () => {
    const root = parse(`
      function commented() {
        // line comment
        /* block comment */
        * star comment
        return 1;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.commentLines).toBeGreaterThanOrEqual(3);
  });

  it('SLOC excludes blanks and comments', () => {
    const root = parse(`
      function blank() {

        // comment

        return 1;
      }
    `);
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.sloc).toBeLessThan(result.loc);
  });

  it('single-line function', () => {
    const root = parse('function one() { return 1; }');
    const funcNode = getFunctionBody(root);
    const result = computeLOCMetrics(funcNode);
    expect(result.loc).toBe(1);
    expect(result.sloc).toBe(1);
    expect(result.commentLines).toBe(0);
  });
});

// ─── Maintainability Index ────────────────────────────────────────────────

describe('computeMaintainabilityIndex', () => {
  it('trivial function has high MI (>70)', () => {
    // Low volume, low cyclomatic, low SLOC → high MI
    const mi = computeMaintainabilityIndex(10, 1, 3);
    expect(mi).toBeGreaterThan(70);
  });

  it('complex function has low MI (<30)', () => {
    // High volume, high cyclomatic, high SLOC → low MI
    const mi = computeMaintainabilityIndex(5000, 30, 200);
    expect(mi).toBeLessThan(30);
  });

  it('comments improve MI', () => {
    const without = computeMaintainabilityIndex(500, 10, 50);
    const with_ = computeMaintainabilityIndex(500, 10, 50, 0.3);
    expect(with_).toBeGreaterThan(without);
  });

  it('normalized to 0-100 range', () => {
    // Very high values should clamp to 0
    const low = computeMaintainabilityIndex(100000, 100, 5000);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(100);

    // Very low values should clamp near 100
    const high = computeMaintainabilityIndex(1, 1, 1);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(100);
  });

  it('handles zero guards (no NaN/Infinity)', () => {
    const result = computeMaintainabilityIndex(0, 0, 0);
    expect(Number.isFinite(result)).toBe(true);
    expect(Number.isNaN(result)).toBe(false);

    const result2 = computeMaintainabilityIndex(0, 0, 0, 0);
    expect(Number.isFinite(result2)).toBe(true);
  });
});
