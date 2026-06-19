/**
 * Unit tests for extractDataflow() against parsed C++ ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — C++', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code: string) {
    const parser = parsers.get('cpp');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.cpp', [], 'cpp');
  }

  // ── Parameter extraction ──────────────────────────────────────────────

  describe('parameters', () => {
    it('extracts simple typed parameters', () => {
      const data = parseAndExtract('int add(int a, int b) { return a + b; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts reference parameters', () => {
      const data = parseAndExtract(
        '#include <vector>\nvoid fill(std::vector<int>& items, int val) { items.push_back(val); }',
      );
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'fill', paramName: 'items', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'fill', paramName: 'val', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts pointer parameters', () => {
      const data = parseAndExtract('void update(int *ptr, int val) { *ptr = val; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'update', paramName: 'ptr', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'update', paramName: 'val', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts parameters from pointer-returning function', () => {
      const data = parseAndExtract('int *clone(int *src, int n) { return src; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'clone', paramName: 'src', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'clone', paramName: 'n', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts parameters from qualified method definition', () => {
      const data = parseAndExtract('int MyClass::compute(int x, int y) { return x + y; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'compute', paramName: 'x', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'compute', paramName: 'y', paramIndex: 1 }),
        ]),
      );
    });
  });

  // ── Return statements ─────────────────────────────────────────────────

  describe('returns', () => {
    it('captures return expression referencing param', () => {
      const data = parseAndExtract('int double_val(int x) { return x * 2; }');
      expect(data?.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'double_val',
            referencedNames: expect.arrayContaining(['x']),
          }),
        ]),
      );
    });

    it('captures return from qualified method', () => {
      const data = parseAndExtract('int Foo::get(int key) { return key; }');
      expect(data?.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'get',
            referencedNames: expect.arrayContaining(['key']),
          }),
        ]),
      );
    });
  });

  // ── Assignment from calls ─────────────────────────────────────────────

  describe('assignments', () => {
    it('tracks typed init_declarator', () => {
      const data = parseAndExtract('void main() { int result = compute(); use(result); }');
      expect(data?.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'main',
            sourceCallName: 'compute',
          }),
        ]),
      );
    });

    it('tracks auto init_declarator', () => {
      const data = parseAndExtract('void main() { auto result = compute(); use(result); }');
      expect(data?.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'main',
            sourceCallName: 'compute',
          }),
        ]),
      );
    });
  });

  // ── Argument flows ────────────────────────────────────────────────────

  describe('argFlows', () => {
    it('detects parameter passed as argument', () => {
      const data = parseAndExtract('void process(int input) { transform(input); }');
      expect(data?.argFlows).toEqual(
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

    it('detects multiple arguments', () => {
      const data = parseAndExtract('void run(int a, int b) { combine(a, b); }');
      const flows = data?.argFlows.filter((f: any) => f.calleeName === 'combine');
      expect(flows).toHaveLength(2);
      expect(flows[0].argIndex).toBe(0);
      expect(flows[1].argIndex).toBe(1);
    });
  });

  // ── Mutation detection ────────────────────────────────────────────────

  describe('mutations', () => {
    it('detects push_back on vector parameter', () => {
      const data = parseAndExtract(
        'void addItem(std::vector<int>& items, int x) { items.push_back(x); }',
      );
      expect(data?.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'addItem', receiverName: 'items' }),
        ]),
      );
      expect(data?.mutations[0].mutatingExpr).toContain('push_back');
    });

    it('detects insert on set parameter', () => {
      const data = parseAndExtract('void addKey(std::set<int>& s, int k) { s.insert(k); }');
      expect(data?.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'addKey', receiverName: 's' }),
        ]),
      );
    });

    it('detects emplace_back on vector parameter', () => {
      const data = parseAndExtract(
        'void enqueue(std::vector<int>& q, int v) { q.emplace_back(v); }',
      );
      expect(data?.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'enqueue', receiverName: 'q' }),
        ]),
      );
    });

    it('detects clear on container parameter', () => {
      const data = parseAndExtract('void reset(std::vector<int>& v) { v.clear(); }');
      expect(data?.mutations).toEqual(
        expect.arrayContaining([expect.objectContaining({ funcName: 'reset', receiverName: 'v' })]),
      );
    });
  });

  // ── Multiple functions ────────────────────────────────────────────────

  describe('multiple top-level functions', () => {
    it('extracts params from each function separately', () => {
      const data = parseAndExtract('int foo(int x) { return x; }\nvoid bar(char c) { use(c); }');
      const fooParams = data?.parameters.filter((p: any) => p.funcName === 'foo');
      const barParams = data?.parameters.filter((p: any) => p.funcName === 'bar');
      expect(fooParams).toHaveLength(1);
      expect(fooParams[0].paramName).toBe('x');
      expect(barParams).toHaveLength(1);
      expect(barParams[0].paramName).toBe('c');
    });
  });
});
