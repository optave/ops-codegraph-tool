/**
 * Unit tests for src/cfg.js — buildFunctionCFG
 *
 * Hand-crafted code snippets parsed with tree-sitter to verify
 * correct CFG block/edge construction.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { CFG_RULES } from '../../src/ast-analysis/rules/index.js';
import { walkWithVisitors } from '../../src/ast-analysis/visitor.js';
import { createCfgVisitor } from '../../src/ast-analysis/visitors/cfg-visitor.js';
import { createParsers } from '../../src/domain/parser.js';
import { buildFunctionCFG, makeCfgRules } from '../../src/features/cfg.js';
import { COMPLEXITY_RULES } from '../../src/features/complexity.js';

let jsParser: any;

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

// ─── Cross-language CFG tests ────────────────────────────────────────────

function makeLangHelpers(langId, parsers) {
  const parser = parsers.get(langId);
  if (!parser) return null;
  const langRules = COMPLEXITY_RULES.get(langId);
  if (!langRules) return null;

  function parseLang(code) {
    return parser.parse(code).rootNode;
  }

  function findFunc(node) {
    if (langRules.functionNodes.has(node.type)) return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = findFunc(node.child(i));
      if (result) return result;
    }
    return null;
  }

  function buildCFGLang(code) {
    const root = parseLang(code);
    const funcNode = findFunc(root);
    if (!funcNode) throw new Error(`No function found for ${langId}`);
    return buildFunctionCFG(funcNode, langId);
  }

  return { parseLang, findFunc, buildCFGLang };
}

// ── Python ───────────────────────────────────────────────────────────────

describe('buildFunctionCFG — Python', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('python', parsers);
  });

  it('empty function: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('def empty():\n    pass');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
  });

  it('if/elif/else chain (Pattern B)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def check(x):
    if x > 10:
        return "big"
    elif x > 0:
        return "small"
    else:
        return "negative"
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
    const trueBlocks = blockByType(cfg, 'branch_true');
    expect(trueBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('for loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def loop_fn():
    for i in range(10):
        print(i)
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('while loop with break', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def while_fn():
    while True:
        x = 1
        break
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
  });

  it('try/except/finally', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def safe():
    try:
        risky()
    except Exception:
        handle()
    finally:
        cleanup()
`);
    const catchBlocks = blockByType(cfg, 'catch');
    const finallyBlocks = blockByType(cfg, 'finally');
    expect(catchBlocks.length).toBe(1);
    expect(finallyBlocks.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'exception')).toBe(true);
  });

  it('return and raise', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def guard(x):
    if x < 0:
        raise ValueError("negative")
    return x
`);
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(cfg.edges.some((e) => e.targetIndex === exit.index && e.kind === 'exception')).toBe(
      true,
    );
    expect(cfg.edges.some((e) => e.targetIndex === exit.index && e.kind === 'return')).toBe(true);
  });
});

// ── Go ───────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — Go', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('go', parsers);
  });

  it('empty function: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('package main\nfunc empty() {}');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
  });

  it('if/else if/else (Pattern C — direct alternative)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
package main
func check(x int) string {
    if x > 10 {
        return "big"
    } else if x > 0 {
        return "small"
    } else {
        return "negative"
    }
}
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('for loop (Go only has for)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
package main
func loop_fn() {
    for i := 0; i < 10; i++ {
        println(i)
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('break and continue', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
package main
func brk() {
    for i := 0; i < 10; i++ {
        if i == 5 {
            break
        }
        if i == 3 {
            continue
        }
    }
}
`);
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'continue')).toBe(true);
  });

  it('switch statement', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
package main
func sw(x int) {
    switch x {
    case 1:
        println("one")
    case 2:
        println("two")
    default:
        println("other")
    }
}
`);
    const switchHeaders = cfg.blocks.filter((b) => b.type === 'condition' && b.label === 'switch');
    expect(switchHeaders.length).toBe(1);
    const caseBlocks = blockByType(cfg, 'case');
    expect(caseBlocks.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Rust ─────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — Rust', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('rust', parsers);
  });

  it('empty function: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('fn empty() {}');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
  });

  it('if/else', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
fn check(x: i32) -> &'static str {
    if x > 0 {
        return "positive";
    } else {
        return "non-positive";
    }
}
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBe(1);
    expect(blockByType(cfg, 'branch_true').length).toBe(1);
    expect(blockByType(cfg, 'branch_false').length).toBe(1);
  });

  it('loop (infinite loop) with break', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
fn infinite() {
    loop {
        let x = 1;
        break;
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(headers[0].label).toBe('loop');
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    // Infinite loop should NOT have a loop_exit edge
    const headerIdx = headers[0].index;
    expect(cfg.edges.some((e) => e.sourceIndex === headerIdx && e.kind === 'loop_exit')).toBe(
      false,
    );
  });

  it('while loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
fn while_fn() {
    let mut i = 0;
    while i < 10 {
        i += 1;
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('for loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
fn for_fn() {
    for i in 0..10 {
        println!("{}", i);
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
  });

  it('match expression', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
fn match_fn(x: i32) {
    match x {
        1 => println!("one"),
        2 => println!("two"),
        _ => println!("other"),
    }
}
`);
    const switchHeaders = cfg.blocks.filter((b) => b.type === 'condition' && b.label === 'switch');
    expect(switchHeaders.length).toBe(1);
    const caseBlocks = blockByType(cfg, 'case');
    expect(caseBlocks.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Java ─────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — Java', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('java', parsers);
  });

  it('empty method: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('class A { void empty() {} }');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
  });

  it('if/else if/else (Pattern C)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    String check(int x) {
        if (x > 10) {
            return "big";
        } else if (x > 0) {
            return "small";
        } else {
            return "negative";
        }
    }
}
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('for loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void loop_fn() {
        for (int i = 0; i < 10; i++) {
            System.out.println(i);
        }
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('enhanced for loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void each(int[] arr) {
        for (int x : arr) {
            System.out.println(x);
        }
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
  });

  it('while and do-while', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void loops() {
        int i = 0;
        while (i < 5) { i++; }
        do { i--; } while (i > 0);
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(2);
  });

  it('try/catch/finally', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void safe() {
        try {
            risky();
        } catch (Exception e) {
            handle();
        } finally {
            cleanup();
        }
    }
}
`);
    expect(blockByType(cfg, 'catch').length).toBe(1);
    expect(blockByType(cfg, 'finally').length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'exception')).toBe(true);
  });

  it('break and continue', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void brk() {
        for (int i = 0; i < 10; i++) {
            if (i == 5) break;
            if (i == 3) continue;
        }
    }
}
`);
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'continue')).toBe(true);
  });
});

// ── C# ───────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — C#', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('csharp', parsers);
  });

  it('empty method: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('class A { void Empty() {} }');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
  });

  it('if/else', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    string Check(int x) {
        if (x > 0) {
            return "positive";
        } else {
            return "non-positive";
        }
    }
}
`);
    expect(blockByType(cfg, 'condition').length).toBe(1);
    expect(blockByType(cfg, 'branch_true').length).toBe(1);
    expect(blockByType(cfg, 'branch_false').length).toBe(1);
  });

  it('for and foreach loops', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void Loops() {
        for (int i = 0; i < 10; i++) { Console.WriteLine(i); }
        foreach (var x in new int[]{1,2,3}) { Console.WriteLine(x); }
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(2);
  });

  it('try/catch/finally', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void Safe() {
        try {
            Risky();
        } catch (Exception e) {
            Handle();
        } finally {
            Cleanup();
        }
    }
}
`);
    expect(blockByType(cfg, 'catch').length).toBe(1);
    expect(blockByType(cfg, 'finally').length).toBe(1);
  });

  it('do-while', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
class A {
    void DoWhile() {
        int i = 0;
        do { i++; } while (i < 10);
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(headers[0].label).toBe('do-while');
  });
});

// ── Ruby ─────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — Ruby', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('ruby', parsers);
  });

  it('empty method: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('def empty; end');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
  });

  it('if/elsif/else (Pattern B)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def check(x)
  if x > 10
    return "big"
  elsif x > 0
    return "small"
  else
    return "negative"
  end
end
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('while loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def while_fn
  i = 0
  while i < 10
    i += 1
  end
end
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('unless (inverse if)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def unless_fn(x)
  unless x
    return "falsy"
  end
  return "truthy"
end
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBe(1);
  });

  it('until loop (inverse while)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def until_fn
  i = 0
  until i >= 10
    i += 1
  end
end
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
  });

  it('break and next (continue)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`
def brk
  i = 0
  while i < 10
    if i == 5
      break
    end
    if i == 3
      next
    end
    i += 1
  end
end
`);
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'continue')).toBe(true);
  });
});

// ── PHP ──────────────────────────────────────────────────────────────────

describe('buildFunctionCFG — PHP', () => {
  let helpers: any;

  beforeAll(async () => {
    const parsers = await createParsers();
    helpers = makeLangHelpers('php', parsers);
  });

  it('empty function: ENTRY → EXIT', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang('<?php function empty_fn() {}');
    const entry = cfg.blocks.find((b) => b.type === 'entry');
    const exit = cfg.blocks.find((b) => b.type === 'exit');
    expect(entry).toBeDefined();
    expect(exit).toBeDefined();
    expect(hasEdge(cfg, entry.index, exit.index, 'fallthrough')).toBe(true);
  });

  it('if/elseif/else (Pattern B)', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function check($x) {
    if ($x > 10) {
        return "big";
    } elseif ($x > 0) {
        return "small";
    } else {
        return "negative";
    }
}
`);
    const conditions = blockByType(cfg, 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
  });

  it('for loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function loop_fn() {
    for ($i = 0; $i < 10; $i++) {
        echo $i;
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'loop_back')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'loop_exit')).toBe(true);
  });

  it('foreach loop', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function each_fn($arr) {
    foreach ($arr as $x) {
        echo $x;
    }
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(1);
  });

  it('while and do-while', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function loops() {
    $i = 0;
    while ($i < 5) { $i++; }
    do { $i--; } while ($i > 0);
}
`);
    const headers = blockByType(cfg, 'loop_header');
    expect(headers.length).toBe(2);
  });

  it('try/catch/finally', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function safe() {
    try {
        risky();
    } catch (Exception $e) {
        handle();
    } finally {
        cleanup();
    }
}
`);
    expect(blockByType(cfg, 'catch').length).toBe(1);
    expect(blockByType(cfg, 'finally').length).toBe(1);
    expect(cfg.edges.some((e) => e.kind === 'exception')).toBe(true);
  });

  it('switch/case', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function sw($x) {
    switch ($x) {
        case 1:
            return "one";
        case 2:
            return "two";
        default:
            return "other";
    }
}
`);
    const switchHeaders = cfg.blocks.filter((b) => b.type === 'condition' && b.label === 'switch');
    expect(switchHeaders.length).toBe(1);
    const caseBlocks = blockByType(cfg, 'case');
    expect(caseBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it('break and continue', () => {
    if (!helpers) return;
    const cfg = helpers.buildCFGLang(`<?php
function brk() {
    for ($i = 0; $i < 10; $i++) {
        if ($i == 5) break;
        if ($i == 3) continue;
    }
}
`);
    expect(cfg.edges.some((e) => e.kind === 'break')).toBe(true);
    expect(cfg.edges.some((e) => e.kind === 'continue')).toBe(true);
  });
});

// ─── makeCfgRules validation ─────────────────────────────────────────────

describe('makeCfgRules', () => {
  it('throws on unknown key', () => {
    expect(() =>
      makeCfgRules({
        ifNode: 'if_statement',
        forNodes: new Set(['for_statement']),
        functionNodes: new Set(['function_declaration']),
        bogusKey: 'oops',
      }),
    ).toThrow('CFG rules: unknown key "bogusKey"');
  });

  it('throws when functionNodes is missing', () => {
    expect(() =>
      makeCfgRules({
        forNodes: new Set(['for_statement']),
      }),
    ).toThrow('CFG rules: functionNodes must be a non-empty Set');
  });

  it('throws when functionNodes is empty', () => {
    expect(() =>
      makeCfgRules({
        forNodes: new Set(['for_statement']),
        functionNodes: new Set(),
      }),
    ).toThrow('CFG rules: functionNodes must be a non-empty Set');
  });

  it('throws when forNodes is not a Set', () => {
    expect(() =>
      makeCfgRules({
        forNodes: ['for_statement'],
        functionNodes: new Set(['function_declaration']),
      }),
    ).toThrow('CFG rules: forNodes must be a Set');
  });

  it('returns valid rules with defaults filled in', () => {
    const rules = makeCfgRules({
      ifNode: 'if_statement',
      forNodes: new Set(['for_statement']),
      functionNodes: new Set(['function_declaration']),
    });
    expect(rules.ifNode).toBe('if_statement');
    expect(rules.elifNode).toBeNull();
    expect(rules.elseViaAlternative).toBe(false);
    expect(rules.forNodes).toEqual(new Set(['for_statement']));
    expect(rules.functionNodes).toEqual(new Set(['function_declaration']));
  });
});

// ─── CFG Visitor Parity Tests ─────────────────────────────────────────

/**
 * Run the CFG visitor on a code snippet and return the CFG for the first function.
 */
function buildCFGViaVisitor(code, langId = 'javascript') {
  const parser = langId === 'javascript' ? jsParser : null;
  if (!parser) throw new Error(`No parser for ${langId} in parity tests`);

  const tree = parser.parse(code);
  const cfgRules = CFG_RULES.get(langId);
  const visitor = createCfgVisitor(cfgRules);

  const walkerOpts = {
    functionNodeTypes: new Set(cfgRules.functionNodes),
    nestingNodeTypes: new Set(),
    getFunctionName: (node) => {
      const nameNode = node.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    },
  };

  const results = walkWithVisitors(tree.rootNode, [visitor], langId, walkerOpts);
  const cfgResults = results.cfg || [];
  if (cfgResults.length === 0) return { blocks: [], edges: [] };

  return { blocks: cfgResults[0].blocks, edges: cfgResults[0].edges };
}

/**
 * Compare two CFGs structurally: same block types/labels and same edge kinds/connectivity.
 */
function assertCfgParity(original, visitor, label) {
  // Same number of blocks and edges
  expect(visitor.blocks.length, `${label}: block count`).toBe(original.blocks.length);
  expect(visitor.edges.length, `${label}: edge count`).toBe(original.edges.length);

  // Same block types and labels (in order)
  const origBlockSig = original.blocks.map((b) => `${b.type}:${b.label}`);
  const visBlockSig = visitor.blocks.map((b) => `${b.type}:${b.label}`);
  expect(visBlockSig, `${label}: block signatures`).toEqual(origBlockSig);

  // Same edge connectivity (source→target:kind)
  const origEdgeSig = original.edges
    .map((e) => `${e.sourceIndex}->${e.targetIndex}:${e.kind}`)
    .sort();
  const visEdgeSig = visitor.edges
    .map((e) => `${e.sourceIndex}->${e.targetIndex}:${e.kind}`)
    .sort();
  expect(visEdgeSig, `${label}: edge signatures`).toEqual(origEdgeSig);
}

describe('CFG visitor parity with buildFunctionCFG', () => {
  const cases = [
    ['empty function', 'function empty() {}'],
    [
      'simple return',
      `function simple() {
        const a = 1;
        return a;
      }`,
    ],
    [
      'no return (fallthrough)',
      `function noReturn() {
        const x = 1;
        console.log(x);
      }`,
    ],
    [
      'single if (no else)',
      `function singleIf(x) {
        if (x > 0) {
          console.log('positive');
        }
        return x;
      }`,
    ],
    [
      'if/else',
      `function ifElse(x) {
        if (x > 0) {
          return 'positive';
        } else {
          return 'non-positive';
        }
      }`,
    ],
    [
      'if/else-if/else chain',
      `function chain(x) {
        if (x > 10) {
          return 'big';
        } else if (x > 0) {
          return 'small';
        } else {
          return 'negative';
        }
      }`,
    ],
    [
      'while loop',
      `function whileLoop(n) {
        let i = 0;
        while (i < n) {
          i++;
        }
        return i;
      }`,
    ],
    [
      'for loop',
      `function forLoop() {
        for (let i = 0; i < 10; i++) {
          console.log(i);
        }
      }`,
    ],
    [
      'for-in loop',
      `function forIn(obj) {
        for (const key in obj) {
          console.log(key);
        }
      }`,
    ],
    [
      'do-while loop',
      `function doWhile() {
        let i = 0;
        do {
          i++;
        } while (i < 10);
        return i;
      }`,
    ],
    [
      'break in loop',
      `function withBreak() {
        for (let i = 0; i < 10; i++) {
          if (i === 5) break;
          console.log(i);
        }
      }`,
    ],
    [
      'continue in loop',
      `function withContinue() {
        for (let i = 0; i < 10; i++) {
          if (i % 2 === 0) continue;
          console.log(i);
        }
      }`,
    ],
    [
      'switch/case',
      `function switchCase(x) {
        switch (x) {
          case 1:
            return 'one';
          case 2:
            return 'two';
          default:
            return 'other';
        }
      }`,
    ],
    [
      'try/catch',
      `function tryCatch() {
        try {
          riskyCall();
        } catch (e) {
          console.error(e);
        }
      }`,
    ],
    [
      'try/catch/finally',
      `function tryCatchFinally() {
        try {
          riskyCall();
        } catch (e) {
          console.error(e);
        } finally {
          cleanup();
        }
      }`,
    ],
    [
      'try/finally (no catch)',
      `function tryFinally() {
        try {
          riskyCall();
        } finally {
          cleanup();
        }
      }`,
    ],
    [
      'early return',
      `function earlyReturn(x) {
        if (x < 0) {
          return -1;
        }
        return x * 2;
      }`,
    ],
    [
      'throw',
      `function throwError(x) {
        if (x < 0) {
          throw new Error('negative');
        }
        return x;
      }`,
    ],
    [
      'nested loops with break',
      `function nested() {
        for (let i = 0; i < 10; i++) {
          for (let j = 0; j < 10; j++) {
            if (j === 5) break;
          }
        }
      }`,
    ],
    [
      'if inside loop',
      `function ifInLoop() {
        for (let i = 0; i < 10; i++) {
          if (i > 5) {
            console.log('big');
          } else {
            console.log('small');
          }
        }
      }`,
    ],
    [
      'arrow function with block body',
      `const fn = (x) => {
        if (x) return 1;
        return 0;
      };`,
    ],
    ['arrow function with expression body', `const fn = (x) => x + 1;`],
    [
      'complex function',
      `function complex(arr) {
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
      }`,
    ],
  ];

  for (const [label, code] of cases) {
    it(`parity: ${label}`, () => {
      const original = buildCFG(code);
      const visitor = buildCFGViaVisitor(code);
      assertCfgParity(original, visitor, label);
    });
  }
});

// ─── CFG-derived Cyclomatic Complexity Tests ──────────────────────────

describe('CFG-derived cyclomatic complexity', () => {
  it('empty function: cyclomatic = 1', () => {
    const cfg = buildCFG('function empty() {}');
    expect(cfg.cyclomatic).toBe(1);
  });

  it('single if: cyclomatic = 2', () => {
    const cfg = buildCFG(`
      function singleIf(x) {
        if (x > 0) {
          console.log('positive');
        }
        return x;
      }
    `);
    expect(cfg.cyclomatic).toBe(2);
  });

  it('if/else: cyclomatic = 2', () => {
    const cfg = buildCFG(`
      function ifElse(x) {
        if (x > 0) {
          return 'positive';
        } else {
          return 'non-positive';
        }
      }
    `);
    expect(cfg.cyclomatic).toBe(2);
  });

  it('if/else-if/else: cyclomatic = 3', () => {
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
    expect(cfg.cyclomatic).toBe(3);
  });

  it('while loop: cyclomatic = 2', () => {
    const cfg = buildCFG(`
      function whileLoop(n) {
        while (n > 0) {
          n--;
        }
      }
    `);
    expect(cfg.cyclomatic).toBe(2);
  });

  it('for loop with break: cyclomatic = 3', () => {
    const cfg = buildCFG(`
      function withBreak() {
        for (let i = 0; i < 10; i++) {
          if (i === 5) break;
        }
      }
    `);
    expect(cfg.cyclomatic).toBe(3);
  });

  it('switch with 3 cases + default: cyclomatic = 4', () => {
    const cfg = buildCFG(`
      function sw(x) {
        switch (x) {
          case 1: return 'one';
          case 2: return 'two';
          case 3: return 'three';
          default: return 'other';
        }
      }
    `);
    expect(cfg.cyclomatic).toBe(4);
  });

  it('formula is E - N + 2', () => {
    const cfg = buildCFG(`
      function complex(x) {
        if (x > 0) {
          for (let i = 0; i < x; i++) {
            console.log(i);
          }
        }
        return x;
      }
    `);
    const expected = cfg.edges.length - cfg.blocks.length + 2;
    expect(cfg.cyclomatic).toBe(expected);
    expect(cfg.cyclomatic).toBeGreaterThanOrEqual(1);
  });
});
