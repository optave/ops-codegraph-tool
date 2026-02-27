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

  it('supports all 10 languages, not hcl', () => {
    for (const lang of ['python', 'go', 'rust', 'java', 'c_sharp', 'ruby', 'php']) {
      expect(COMPLEXITY_RULES.has(lang)).toBe(true);
    }
    expect(COMPLEXITY_RULES.has('hcl')).toBe(false);
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

  it('supports all 10 languages, not hcl', () => {
    for (const lang of ['python', 'go', 'rust', 'java', 'c_sharp', 'ruby', 'php']) {
      expect(HALSTEAD_RULES.has(lang)).toBe(true);
    }
    expect(HALSTEAD_RULES.has('hcl')).toBe(false);
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

// ─── Multi-Language Complexity Tests ─────────────────────────────────────

function makeHelpers(langId, parsersPromise) {
  const rules = COMPLEXITY_RULES.get(langId);
  let parser;
  let available = false;
  beforeAll(async () => {
    const parsers = await parsersPromise;
    parser = parsers.get(langId);
    available = !!parser;
  });
  beforeEach(({ skip }) => {
    if (!available) skip();
  });
  const parse = (code) => parser.parse(code).rootNode;
  const getFunction = (root) => {
    function find(node) {
      if (rules.functionNodes.has(node.type)) return node;
      for (let i = 0; i < node.childCount; i++) {
        const r = find(node.child(i));
        if (r) return r;
      }
      return null;
    }
    return find(root);
  };
  const analyze = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeFunctionComplexity(funcNode, langId);
  };
  const halstead = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeHalsteadMetrics(funcNode, langId);
  };
  const loc = (code) => {
    const funcNode = getFunction(parse(code));
    if (!funcNode) throw new Error(`No function found in ${langId} snippet`);
    return computeLOCMetrics(funcNode, langId);
  };
  return { parse, getFunction, analyze, halstead, loc };
}

// Shared parsers promise to avoid re-initializing per suite
let _parsersPromise;
function sharedParsers() {
  if (!_parsersPromise) _parsersPromise = createParsers();
  return _parsersPromise;
}

// ─── Python ──────────────────────────────────────────────────────────────

describe('Python complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('python', sharedParsers());

  it('simple function', () => {
    const r = analyze('def add(a, b):\n    return a + b\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('def check(x):\n    if x > 0:\n        return True\n    return False\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elif/else chain', () => {
    const r = analyze(
      'def classify(x):\n    if x > 0:\n        return "pos"\n    elif x < 0:\n        return "neg"\n    else:\n        return "zero"\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'def nested(x, y):\n    if x > 0:\n        if y > 0:\n            return True\n    return False\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'def search(arr, t):\n    for item in arr:\n        if item == t:\n            return True\n    return False\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('while loop', () => {
    const r = analyze('def countdown(n):\n    while n > 0:\n        n -= 1\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('try/except', () => {
    const r = analyze(
      'def safe(s):\n    try:\n        return int(s)\n    except ValueError:\n        return None\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze('def check(a, b):\n    if a and b:\n        return True\n');
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('def add(a, b):\n    return a + b\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # comments detected', () => {
    const l = loc('def f():\n    # comment\n    return 1\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });
});

// ─── Go ──────────────────────────────────────────────────────────────────

describe('Go complexity', () => {
  const { analyze, halstead } = makeHelpers('go', sharedParsers());

  it('simple function', () => {
    const r = analyze('package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'package main\nfunc check(x int) bool {\n\tif x > 0 {\n\t\treturn true\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'package main\nfunc classify(x int) string {\n\tif x > 0 {\n\t\treturn "pos"\n\t} else if x < 0 {\n\t\treturn "neg"\n\t} else {\n\t\treturn "zero"\n\t}\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'package main\nfunc nested(x int, y int) bool {\n\tif x > 0 {\n\t\tif y > 0 {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'package main\nfunc search(arr []int, t int) bool {\n\tfor _, v := range arr {\n\t\tif v == t {\n\t\t\treturn true\n\t\t}\n\t}\n\treturn false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      'package main\nfunc sw(x int) string {\n\tswitch x {\n\tcase 1:\n\t\treturn "one"\n\tcase 2:\n\t\treturn "two"\n\tdefault:\n\t\treturn "other"\n\t}\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze(
      'package main\nfunc check(a bool, b bool) bool {\n\tif a && b {\n\t\treturn true\n\t}\n\treturn false\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Rust ────────────────────────────────────────────────────────────────

describe('Rust complexity', () => {
  const { analyze, halstead } = makeHelpers('rust', sharedParsers());

  it('simple function', () => {
    const r = analyze('fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'fn check(x: i32) -> bool {\n    if x > 0 {\n        return true;\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'fn classify(x: i32) -> &str {\n    if x > 0 {\n        "pos"\n    } else if x < 0 {\n        "neg"\n    } else {\n        "zero"\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'fn nested(x: i32, y: i32) -> bool {\n    if x > 0 {\n        if y > 0 {\n            return true;\n        }\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('loop with condition', () => {
    const r = analyze(
      'fn search(arr: &[i32], t: i32) -> bool {\n    for v in arr {\n        if *v == t {\n            return true;\n        }\n    }\n    false\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('match expression', () => {
    const r = analyze(
      'fn sw(x: i32) -> &str {\n    match x {\n        1 => "one",\n        2 => "two",\n        _ => "other",\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze(
      'fn check(a: bool, b: bool) -> bool {\n    if a && b {\n        return true;\n    }\n    false\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Java ────────────────────────────────────────────────────────────────

describe('Java complexity', () => {
  const { analyze, halstead } = makeHelpers('java', sharedParsers());

  it('simple method', () => {
    const r = analyze('class C {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'class C {\n    boolean check(int x) {\n        if (x > 0) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'class C {\n    String classify(int x) {\n        if (x > 0) {\n            return "pos";\n        } else if (x < 0) {\n            return "neg";\n        } else {\n            return "zero";\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'class C {\n    boolean nested(int x, int y) {\n        if (x > 0) {\n            if (y > 0) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('for loop with condition', () => {
    const r = analyze(
      'class C {\n    int search(int[] arr, int t) {\n        for (int i = 0; i < arr.length; i++) {\n            if (arr[i] == t) {\n                return i;\n            }\n        }\n        return -1;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('try/catch', () => {
    const r = analyze(
      'class C {\n    int safe(String s) {\n        try {\n            return Integer.parseInt(s);\n        } catch (Exception e) {\n            return 0;\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze(
      'class C {\n    boolean check(boolean a, boolean b) {\n        if (a && b) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('class C {\n    int add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── C# ──────────────────────────────────────────────────────────────────

describe('C# complexity', () => {
  const { analyze, halstead } = makeHelpers('c_sharp', sharedParsers());

  it('simple method', () => {
    const r = analyze('class C {\n    int Add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      'class C {\n    bool Check(int x) {\n        if (x > 0) {\n            return true;\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/else-if/else chain', () => {
    const r = analyze(
      'class C {\n    string Classify(int x) {\n        if (x > 0) {\n            return "pos";\n        } else if (x < 0) {\n            return "neg";\n        } else {\n            return "zero";\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'class C {\n    bool Nested(int x, int y) {\n        if (x > 0) {\n            if (y > 0) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('foreach with condition', () => {
    const r = analyze(
      'class C {\n    bool Search(int[] arr, int t) {\n        foreach (var v in arr) {\n            if (v == t) {\n                return true;\n            }\n        }\n        return false;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      'class C {\n    string Sw(int x) {\n        switch (x) {\n            case 1: return "one";\n            case 2: return "two";\n            default: return "other";\n        }\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('try/catch', () => {
    const r = analyze(
      'class C {\n    int Safe(string s) {\n        try {\n            return int.Parse(s);\n        } catch (Exception e) {\n            return 0;\n        }\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('halstead: positive volume', () => {
    const h = halstead('class C {\n    int Add(int a, int b) {\n        return a + b;\n    }\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });
});

// ─── Ruby ────────────────────────────────────────────────────────────────

describe('Ruby complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('ruby', sharedParsers());

  it('simple method', () => {
    const r = analyze('def add(a, b)\n  a + b\nend\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze('def check(x)\n  if x > 0\n    return true\n  end\n  false\nend\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elsif/else chain', () => {
    const r = analyze(
      'def classify(x)\n  if x > 0\n    "pos"\n  elsif x < 0\n    "neg"\n  else\n    "zero"\n  end\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      'def nested(x, y)\n  if x > 0\n    if y > 0\n      return true\n    end\n  end\n  false\nend\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('while loop', () => {
    const r = analyze('def countdown(n)\n  while n > 0\n    n -= 1\n  end\nend\n');
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('case/when', () => {
    const r = analyze(
      'def sw(x)\n  case x\n  when 1\n    "one"\n  when 2\n    "two"\n  else\n    "other"\n  end\nend\n',
    );
    expect(r.cognitive).toBe(2); // case + else
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('logical operators', () => {
    const r = analyze('def check(a, b)\n  if a && b\n    return true\n  end\n  false\nend\n');
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('def add(a, b)\n  a + b\nend\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # comments detected', () => {
    const l = loc('def f()\n  # comment\n  1\nend\n');
    expect(l.commentLines).toBeGreaterThanOrEqual(1);
  });
});

// ─── PHP ─────────────────────────────────────────────────────────────────

describe('PHP complexity', () => {
  const { analyze, halstead, loc } = makeHelpers('php', sharedParsers());

  it('simple function', () => {
    const r = analyze('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
    expect(r).toEqual({ cognitive: 0, cyclomatic: 1, maxNesting: 0 });
  });

  it('single if', () => {
    const r = analyze(
      '<?php\nfunction check($x) {\n    if ($x > 0) {\n        return true;\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('if/elseif/else chain', () => {
    const r = analyze(
      '<?php\nfunction classify($x) {\n    if ($x > 0) {\n        return "pos";\n    } elseif ($x < 0) {\n        return "neg";\n    } else {\n        return "zero";\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 1 });
  });

  it('nested if', () => {
    const r = analyze(
      '<?php\nfunction nested($x, $y) {\n    if ($x > 0) {\n        if ($y > 0) {\n            return true;\n        }\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('foreach with condition', () => {
    const r = analyze(
      '<?php\nfunction search($arr, $t) {\n    foreach ($arr as $v) {\n        if ($v == $t) {\n            return true;\n        }\n    }\n    return false;\n}\n',
    );
    expect(r).toEqual({ cognitive: 3, cyclomatic: 3, maxNesting: 2 });
  });

  it('switch', () => {
    const r = analyze(
      '<?php\nfunction sw($x) {\n    switch ($x) {\n        case 1: return "one";\n        case 2: return "two";\n        default: return "other";\n    }\n}\n',
    );
    expect(r.cognitive).toBe(1);
    expect(r.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('try/catch', () => {
    const r = analyze(
      '<?php\nfunction safe($s) {\n    try {\n        return intval($s);\n    } catch (Exception $e) {\n        return 0;\n    }\n}\n',
    );
    expect(r).toEqual({ cognitive: 1, cyclomatic: 2, maxNesting: 1 });
  });

  it('logical operators', () => {
    const r = analyze(
      '<?php\nfunction check($a, $b) {\n    if ($a && $b) {\n        return true;\n    }\n    return false;\n}\n',
    );
    expect(r.cognitive).toBe(2);
    expect(r.cyclomatic).toBe(3);
  });

  it('halstead: positive volume', () => {
    const h = halstead('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
    expect(h).not.toBeNull();
    expect(h.volume).toBeGreaterThan(0);
  });

  it('LOC: # and // comments detected', () => {
    const l = loc(
      '<?php\nfunction f() {\n    # hash comment\n    // slash comment\n    return 1;\n}\n',
    );
    expect(l.commentLines).toBeGreaterThanOrEqual(2);
  });
});
