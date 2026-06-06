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
    // pts key is scoped: "runWith::fn" → {myHandler}
    const defNames = new Set(['runWith', 'myHandler']);
    const defParams = new Map([['runWith', ['fn']]]);
    const paramBindings = [{ callee: 'runWith', argIndex: 0, argName: 'myHandler' }];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    expect(resolveViaPointsTo('runWith::fn', pts)).toEqual(['myHandler']);
    // bare name has no entry (scoping prevents cross-function collision)
    expect(resolveViaPointsTo('fn', pts)).toEqual([]);
  });

  it('does not add constraint for out-of-range argIndex', () => {
    const defNames = new Set(['f', 'handler']);
    const defParams = new Map([['f', ['a']]]); // only 1 param
    const paramBindings = [{ callee: 'f', argIndex: 1, argName: 'handler' }]; // index 1 out of range
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    expect(resolveViaPointsTo('f::a', pts)).toEqual([]);
  });

  it('ignores call when callee is not in definitionParams (cross-module or untracked)', () => {
    const defNames = new Set(['handler']);
    const defParams = NO_DEF_PARAMS; // empty — callee 'externalFn' not local
    const paramBindings = [{ callee: 'externalFn', argIndex: 0, argName: 'handler' }];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    // No scoped entry is added for externalFn::p0 or similar
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
    expect(resolveViaPointsTo('withBoth::errFn', pts)).toEqual(['onError']);
    expect(resolveViaPointsTo('withBoth::successFn', pts)).toEqual(['onSuccess']);
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
    // run::fn → h → realHandler
    expect(resolveViaPointsTo('run::fn', pts)).toContain('realHandler');
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
    // run::fn has a constraint pts(run::fn) ⊇ pts(fn); pts(fn) = {fn} (seeded).
    // run::fn resolves to ['fn'] but self-reference filter in resolveViaPointsTo
    // only filters exact matches of the lookup key — 'run::fn' !== 'fn', so 'fn'
    // is returned. The caller (buildFileCallEdges) then resolves 'fn' as a concrete
    // locally-defined function, which is the correct behavior.
    expect(resolveViaPointsTo('run::fn', pts)).toContain('fn');
    // bare 'fn' is seeded but not modified by parameter constraints
    expect(resolveViaPointsTo('fn', pts)).toEqual([]);
  });

  it('scoped keys prevent same-named parameter collision across functions', () => {
    // function runA(fn) { fn(); }  called as runA(handlerA)
    // function runB(fn) { fn(); }  called as runB(handlerB)
    // Without scoping, pts('fn') = {handlerA, handlerB}, causing spurious edges.
    // With scoping: pts('runA::fn') = {handlerA}, pts('runB::fn') = {handlerB}.
    const defNames = new Set(['runA', 'runB', 'handlerA', 'handlerB']);
    const defParams = new Map([
      ['runA', ['fn']],
      ['runB', ['fn']],
    ]);
    const paramBindings = [
      { callee: 'runA', argIndex: 0, argName: 'handlerA' },
      { callee: 'runB', argIndex: 0, argName: 'handlerB' },
    ];
    const pts = buildPointsToMap([], defNames, NO_IMPORTS, paramBindings, defParams);
    // Each function's parameter resolves only to its own call-site argument.
    expect(resolveViaPointsTo('runA::fn', pts)).toEqual(['handlerA']);
    expect(resolveViaPointsTo('runB::fn', pts)).toEqual(['handlerB']);
    // Bare 'fn' has no pts entry (it was never added as a key).
    expect(resolveViaPointsTo('fn', pts)).toEqual([]);
  });
});
