/**
 * Unit tests for src/complexity.js
 *
 * Hand-crafted code snippets parsed with tree-sitter to verify
 * exact cognitive/cyclomatic/nesting values.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { COMPLEXITY_RULES, computeFunctionComplexity } from '../../src/complexity.js';
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
