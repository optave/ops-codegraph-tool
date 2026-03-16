/**
 * Tests for the shared DFS visitor framework (src/ast-analysis/visitor.js).
 */
import { describe, expect, it } from 'vitest';

// We need a tree-sitter tree to test. Use the JS parser.
let parse;

async function ensureParser() {
  if (parse) return;
  const { createParsers, getParser } = await import('../../src/domain/parser.js');
  const parsers = await createParsers();
  parse = (code) => {
    // getParser needs a path to determine language
    const p = getParser(parsers, 'test.js');
    return p.parse(code);
  };
}

const { walkWithVisitors } = await import('../../src/ast-analysis/visitor.js');

describe('walkWithVisitors', () => {
  it('calls enterNode for every node in the tree', async () => {
    await ensureParser();
    const tree = parse('const x = 1;');
    const visited = [];
    const visitor = {
      name: 'counter',
      enterNode(node) {
        visited.push(node.type);
      },
      finish() {
        return visited.length;
      },
    };

    const results = walkWithVisitors(tree.rootNode, [visitor], 'javascript');
    expect(results.counter).toBeGreaterThan(0);
    expect(visited.length).toBeGreaterThan(0);
    // The root node type should be 'program'
    expect(visited[0]).toBe('program');
  });

  it('calls exitNode after all children are visited', async () => {
    await ensureParser();
    const tree = parse('const x = 1;');
    const order = [];
    const visitor = {
      name: 'order',
      enterNode(node) {
        order.push(`enter:${node.type}`);
      },
      exitNode(node) {
        order.push(`exit:${node.type}`);
      },
    };

    walkWithVisitors(tree.rootNode, [visitor], 'javascript');
    // program should be first enter and last exit
    expect(order[0]).toBe('enter:program');
    expect(order[order.length - 1]).toBe('exit:program');
  });

  it('supports multiple visitors in a single walk', async () => {
    await ensureParser();
    const tree = parse('function foo() { return 1; }');
    const v1types = [];
    const v2types = [];

    const v1 = {
      name: 'v1',
      enterNode(node) {
        v1types.push(node.type);
      },
      finish: () => v1types,
    };
    const v2 = {
      name: 'v2',
      enterNode(node) {
        v2types.push(node.type);
      },
      finish: () => v2types,
    };

    const results = walkWithVisitors(tree.rootNode, [v1, v2], 'javascript');
    // Both visitors see the same nodes
    expect(results.v1).toEqual(results.v2);
  });

  it('calls enterFunction/exitFunction at function boundaries', async () => {
    await ensureParser();
    const tree = parse('function foo() { return 1; }');
    const events = [];

    const visitor = {
      name: 'funcTracker',
      enterFunction(_node, name) {
        events.push(`enter:${name}`);
      },
      exitFunction(_node, name) {
        events.push(`exit:${name}`);
      },
      finish: () => events,
    };

    const results = walkWithVisitors(tree.rootNode, [visitor], 'javascript', {
      functionNodeTypes: new Set(['function_declaration']),
      getFunctionName: (node) => {
        const nameNode = node.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      },
    });

    expect(results.funcTracker).toEqual(['enter:foo', 'exit:foo']);
  });

  it('skipChildren only affects the requesting visitor', async () => {
    await ensureParser();
    const tree = parse('function foo() { const x = 1; }');
    const v1nodes = [];
    const v2nodes = [];

    const v1 = {
      name: 'skipper',
      enterNode(node) {
        v1nodes.push(node.type);
        // Skip children of function_declaration
        if (node.type === 'function_declaration') {
          return { skipChildren: true };
        }
      },
      finish: () => v1nodes,
    };
    const v2 = {
      name: 'full',
      enterNode(node) {
        v2nodes.push(node.type);
      },
      finish: () => v2nodes,
    };

    walkWithVisitors(tree.rootNode, [v1, v2], 'javascript', {
      functionNodeTypes: new Set(['function_declaration']),
      getFunctionName: () => 'foo',
    });

    // v1 skipped descendants of function_declaration
    expect(v1nodes).toContain('function_declaration');
    expect(v1nodes).not.toContain('lexical_declaration');

    // v2 saw everything
    expect(v2nodes).toContain('function_declaration');
    expect(v2nodes).toContain('lexical_declaration');
  });

  it('tracks nestingLevel with nestingNodeTypes', async () => {
    await ensureParser();
    const tree = parse('function foo() { if (true) { while (true) {} } }');
    const levels = [];

    const visitor = {
      name: 'nesting',
      enterNode(node, ctx) {
        if (node.type === 'while_statement') {
          levels.push(ctx.nestingLevel);
        }
      },
      finish: () => levels,
    };

    const results = walkWithVisitors(tree.rootNode, [visitor], 'javascript', {
      nestingNodeTypes: new Set(['if_statement', 'while_statement', 'for_statement']),
    });

    // The while is inside an if, so nesting = 1 when we enter the while node
    expect(results.nesting).toEqual([1]);
  });

  it('maintains scopeStack across nested functions', async () => {
    await ensureParser();
    const tree = parse('function outer() { function inner() { return 1; } }');
    const depths = [];

    const visitor = {
      name: 'scope',
      enterFunction(_node, name, ctx) {
        depths.push({ name, depth: ctx.scopeStack.length });
      },
      finish: () => depths,
    };

    const results = walkWithVisitors(tree.rootNode, [visitor], 'javascript', {
      functionNodeTypes: new Set(['function_declaration']),
      getFunctionName: (node) => {
        const n = node.childForFieldName('name');
        return n ? n.text : null;
      },
    });

    // outer is at depth 1 (just pushed), inner at depth 2
    expect(results.scope).toEqual([
      { name: 'outer', depth: 1 },
      { name: 'inner', depth: 2 },
    ]);
  });

  it('init is called before the walk', async () => {
    await ensureParser();
    const tree = parse('const x = 1;');
    let initCalled = false;
    let initBeforeEnter = false;

    const visitor = {
      name: 'initTest',
      init(langId) {
        initCalled = true;
        expect(langId).toBe('javascript');
      },
      enterNode() {
        if (initCalled) initBeforeEnter = true;
      },
    };

    walkWithVisitors(tree.rootNode, [visitor], 'javascript');
    expect(initCalled).toBe(true);
    expect(initBeforeEnter).toBe(true);
  });

  it('returns undefined for visitors without finish()', async () => {
    await ensureParser();
    const tree = parse('const x = 1;');
    const visitor = { name: 'noFinish' };

    const results = walkWithVisitors(tree.rootNode, [visitor], 'javascript');
    expect(results.noFinish).toBeUndefined();
  });
});
