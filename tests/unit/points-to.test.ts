/**
 * Unit tests for the points-to solver — Phase 8.3 alias constraints and
 * Phase 8.3c parameter-flow constraints.
 */
import { describe, expect, it } from 'vitest';
import { buildPointsToMap, resolveViaPointsTo } from '../../src/domain/graph/resolver/points-to.js';

const NO_IMPORTS: ReadonlyMap<string, string> = new Map();
const NO_DEF_PARAMS: ReadonlyMap<string, readonly string[]> = new Map();

describe('buildPointsToMap — alias constraints (Phase 8.3)', () => {
  it('seeds locally-defined functions to themselves', () => {
    const pts = buildPointsToMap([], new Set(['foo', 'bar']), NO_IMPORTS);
    expect(resolveViaPointsTo('foo', pts)).toEqual([]);
    expect(resolveViaPointsTo('bar', pts)).toEqual([]);
  });

  it('propagates simple alias: const fn = handler', () => {
    const pts = buildPointsToMap([{ lhs: 'fn', rhs: 'handler' }], new Set(['handler']), NO_IMPORTS);
    expect(resolveViaPointsTo('fn', pts)).toEqual(['handler']);
  });

  it('propagates member-expression alias: const fn = obj.method', () => {
    const pts = buildPointsToMap(
      [
        { lhs: 'h', rhs: 'method', rhsReceiver: 'obj' },
        { lhs: 'obj.method', rhs: 'realMethod' },
      ],
      new Set(['realMethod']),
      NO_IMPORTS,
    );
    // h → obj.method → realMethod (two hops, should converge)
    const targets = resolveViaPointsTo('h', pts);
    expect(targets).toContain('realMethod');
  });
});

describe('buildPointsToMap — parameter-flow constraints (Phase 8.3c)', () => {
  it('adds pts constraint for parameter when callee is locally defined', () => {
    // function runWith(fn) { fn(); }
    // function myHandler() {}
    // runWith(myHandler);
    const defNames = new Set(['runWith', 'myHandler']);
    const defParams = new Map([['runWith', ['fn']]]);
    const paramBindings = [{ callee: 'runWith', argIndex: 0, argName: 'myHandler' }];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    expect(resolveViaPointsTo('fn', pts)).toEqual(['myHandler']);
  });

  it('does not add constraint for out-of-range argIndex', () => {
    const defNames = new Set(['f', 'handler']);
    const defParams = new Map([['f', ['a']]]); // only 1 param
    const paramBindings = [{ callee: 'f', argIndex: 1, argName: 'handler' }]; // index 1 out of range
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    expect(resolveViaPointsTo('a', pts)).toEqual([]);
  });

  it('ignores call when callee is not in definitionParams (cross-module or untracked)', () => {
    const defNames = new Set(['handler']);
    const defParams = NO_DEF_PARAMS; // empty — callee 'externalFn' not local
    const paramBindings = [{ callee: 'externalFn', argIndex: 0, argName: 'handler' }];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    // No 'p0' or any new pts entry from the constraint
    expect([...pts.keys()]).toEqual(['handler']);
  });

  it('handles multiple parameters — routes to correct parameter name', () => {
    // function withBoth(errFn, successFn) { ... }
    // withBoth(onError, onSuccess);
    const defNames = new Set(['withBoth', 'onError', 'onSuccess']);
    const defParams = new Map([['withBoth', ['errFn', 'successFn']]]);
    const paramBindings = [
      { callee: 'withBoth', argIndex: 0, argName: 'onError' },
      { callee: 'withBoth', argIndex: 1, argName: 'onSuccess' },
    ];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    expect(resolveViaPointsTo('errFn', pts)).toEqual(['onError']);
    expect(resolveViaPointsTo('successFn', pts)).toEqual(['onSuccess']);
  });

  it('propagates through alias + parameter chain (two-hop)', () => {
    // const h = realHandler;       → fn alias binding
    // function run(fn) { fn(); }   → paramBinding
    // run(h);                       → paramBinding
    const defNames = new Set(['run', 'realHandler']);
    const fnRefs = [{ lhs: 'h', rhs: 'realHandler' }];
    const defParams = new Map([['run', ['fn']]]);
    const paramBindings = [{ callee: 'run', argIndex: 0, argName: 'h' }];
    const pts = buildPointsToMap(fnRefs, defNames, NO_IMPORTS, paramBindings, defParams);
    // fn → h → realHandler
    expect(resolveViaPointsTo('fn', pts)).toContain('realHandler');
  });

  it('produces no constraint when paramBindings is absent', () => {
    const defNames = new Set(['f', 'g']);
    const pts = buildPointsToMap([], defNames, NO_IMPORTS);
    expect(resolveViaPointsTo('f', pts)).toEqual([]);
    expect(resolveViaPointsTo('g', pts)).toEqual([]);
  });

  it('does not introduce self-referential pts entries for parameter names', () => {
    // Ensures that a parameter name that also matches a local function is not confused
    const defNames = new Set(['fn', 'run']); // 'fn' is both a local def AND a param name of 'run'
    const defParams = new Map([['run', ['fn']]]);
    const paramBindings = [{ callee: 'run', argIndex: 0, argName: 'fn' }];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    // pts('fn') seeds to {'fn'} from definitionNames; param constraint adds pts('fn') ⊇ pts('fn')
    // which is a no-op. resolveViaPointsTo filters self-reference, so returns [].
    expect(resolveViaPointsTo('fn', pts)).toEqual([]);
  });
});
