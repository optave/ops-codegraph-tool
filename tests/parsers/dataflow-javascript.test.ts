/**
 * Unit tests for extractDataflow() against parsed JS/TS ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — JavaScript', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('javascript');
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.js', [], 'javascript');
  }

  // ── Parameter extraction ──────────────────────────────────────────────

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract(`function add(a, b) { return a + b; }`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts destructured object parameters', () => {
      const data = parseAndExtract(`function greet({ name, age }) { return name; }`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'greet', paramName: 'name' }),
          expect.objectContaining({ funcName: 'greet', paramName: 'age' }),
        ]),
      );
    });

    it('extracts destructured array parameters', () => {
      const data = parseAndExtract(`function first([head, tail]) { return head; }`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'first', paramName: 'head' }),
          expect.objectContaining({ funcName: 'first', paramName: 'tail' }),
        ]),
      );
    });

    it('extracts default parameters', () => {
      const data = parseAndExtract(`function inc(x, step = 1) { return x + step; }`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'inc', paramName: 'x', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'inc', paramName: 'step', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts rest parameters', () => {
      const data = parseAndExtract(`function sum(...nums) { return nums.reduce((a,b) => a+b); }`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'sum', paramName: 'nums', paramIndex: 0 }),
        ]),
      );
    });

    it('extracts arrow function parameters', () => {
      const data = parseAndExtract(`const multiply = (x, y) => x * y;`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'multiply', paramName: 'x', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'multiply', paramName: 'y', paramIndex: 1 }),
        ]),
      );
    });
  });

  // ── Return statements ─────────────────────────────────────────────────

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract(`function double(x) { return x * 2; }`);
      expect(data.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'double',
            referencedNames: expect.arrayContaining(['x']),
          }),
        ]),
      );
    });

    it('captures return with call expression', () => {
      const data = parseAndExtract(`function process(items) { return items.map(x => x); }`);
      expect(data.returns).toHaveLength(1);
      expect(data.returns[0].funcName).toBe('process');
      expect(data.returns[0].referencedNames).toContain('items');
    });
  });

  // ── Assignment from calls ─────────────────────────────────────────────

  describe('assignments', () => {
    it('tracks const x = foo()', () => {
      const data = parseAndExtract(`
        function main() {
          const result = compute();
          return result;
        }
      `);
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'main',
            sourceCallName: 'compute',
          }),
        ]),
      );
    });

    it('tracks destructured assignment from call', () => {
      const data = parseAndExtract(`
        function load() {
          const { data, error } = fetchData();
          return data;
        }
      `);
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ varName: 'data', sourceCallName: 'fetchData' }),
          expect.objectContaining({ varName: 'error', sourceCallName: 'fetchData' }),
        ]),
      );
    });
  });

  // ── Argument flows ────────────────────────────────────────────────────

  describe('argFlows', () => {
    it('detects parameter passed as argument', () => {
      const data = parseAndExtract(`
        function process(input) {
          transform(input);
        }
      `);
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'process',
            calleeName: 'transform',
            argIndex: 0,
            argName: 'input',
            confidence: 1.0,
          }),
        ]),
      );
    });

    it('detects variable intermediary with call return source', () => {
      const data = parseAndExtract(`
        function pipeline() {
          const val = getData();
          process(val);
        }
      `);
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'pipeline',
            calleeName: 'process',
            argName: 'val',
            confidence: 0.9,
          }),
        ]),
      );
    });

    it('tracks multiple arguments', () => {
      const data = parseAndExtract(`
        function run(a, b) {
          combine(a, b);
        }
      `);
      const flows = data.argFlows.filter((f) => f.calleeName === 'combine');
      expect(flows).toHaveLength(2);
      expect(flows[0].argIndex).toBe(0);
      expect(flows[1].argIndex).toBe(1);
    });
  });

  // ── Mutation detection ────────────────────────────────────────────────

  describe('mutations', () => {
    it('detects push on parameter', () => {
      const data = parseAndExtract(`
        function addItem(list, item) {
          list.push(item);
        }
      `);
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'addItem',
            receiverName: 'list',
          }),
        ]),
      );
      expect(data.mutations[0].mutatingExpr).toContain('push');
    });

    it('detects property assignment on parameter', () => {
      const data = parseAndExtract(`
        function setName(obj, name) {
          obj.name = name;
        }
      `);
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'setName',
            receiverName: 'obj',
          }),
        ]),
      );
    });

    it('detects splice mutation', () => {
      const data = parseAndExtract(`
        function removeFirst(arr) {
          arr.splice(0, 1);
        }
      `);
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'removeFirst',
            receiverName: 'arr',
          }),
        ]),
      );
    });
  });

  // ── Nested scopes ────────────────────────────────────────────────────

  describe('nested scopes', () => {
    it('separates parameters of outer and inner functions', () => {
      const data = parseAndExtract(`
        function outer(x) {
          function inner(y) {
            return y;
          }
          return inner(x);
        }
      `);
      const outerParams = data.parameters.filter((p) => p.funcName === 'outer');
      const innerParams = data.parameters.filter((p) => p.funcName === 'inner');
      expect(outerParams).toHaveLength(1);
      expect(outerParams[0].paramName).toBe('x');
      expect(innerParams).toHaveLength(1);
      expect(innerParams[0].paramName).toBe('y');
    });

    it('tracks argument flow from outer to inner function', () => {
      const data = parseAndExtract(`
        function outer(x) {
          function inner(y) {
            return y;
          }
          return inner(x);
        }
      `);
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'outer',
            calleeName: 'inner',
            argName: 'x',
          }),
        ]),
      );
    });
  });

  // ── Arrow implicit returns ────────────────────────────────────────────

  describe('arrow functions', () => {
    it('extracts parameters from arrow expressions', () => {
      const data = parseAndExtract(`const square = (n) => n * n;`);
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'square', paramName: 'n', paramIndex: 0 }),
        ]),
      );
    });
  });

  // ── Spread arguments ──────────────────────────────────────────────────

  describe('spread arguments', () => {
    it('tracks spread argument flow', () => {
      const data = parseAndExtract(`
        function forward(items) {
          process(...items);
        }
      `);
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'forward',
            calleeName: 'process',
            argName: 'items',
          }),
        ]),
      );
    });
  });

  // ── Non-declaration assignments ───────────────────────────────────────

  describe('non-declaration assignments', () => {
    it('tracks x = foo() without const/let/var', () => {
      const data = parseAndExtract(`
        function update() {
          let result: any;
          result = compute();
          return result;
        }
      `);
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'update',
            sourceCallName: 'compute',
          }),
        ]),
      );
    });
  });

  // ── Optional chaining ─────────────────────────────────────────────────

  describe('optional chaining', () => {
    it('resolves callee name through optional chain', () => {
      const data = parseAndExtract(`
        function safeFetch(client) {
          client?.fetch(client);
        }
      `);
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'safeFetch',
            calleeName: 'fetch',
            argName: 'client',
          }),
        ]),
      );
    });
  });
});
