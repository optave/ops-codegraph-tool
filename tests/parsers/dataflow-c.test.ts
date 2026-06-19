/**
 * Unit tests for extractDataflow() against parsed C ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — C', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code: string) {
    const parser = parsers.get('c');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.c', [], 'c');
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

    it('extracts pointer parameters', () => {
      const data = parseAndExtract('void update(int *ptr, int val) { *ptr = val; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'update', paramName: 'ptr', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'update', paramName: 'val', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts single char* parameter', () => {
      const data = parseAndExtract('int strlen_custom(char *s) { return 0; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'strlen_custom', paramName: 's', paramIndex: 0 }),
        ]),
      );
    });

    it('extracts parameters from void function', () => {
      const data = parseAndExtract('void swap(int a, int b) { int tmp = a; a = b; b = tmp; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'swap', paramName: 'a' }),
          expect.objectContaining({ funcName: 'swap', paramName: 'b' }),
        ]),
      );
    });

    it('extracts parameters from pointer-returning function', () => {
      const data = parseAndExtract('char *copy(char *dst, char *src) { return dst; }');
      expect(data?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'copy', paramName: 'dst', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'copy', paramName: 'src', paramIndex: 1 }),
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

    it('captures return referencing multiple params', () => {
      const data = parseAndExtract('int add(int a, int b) { return a + b; }');
      expect(data?.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'add',
            referencedNames: expect.arrayContaining(['a', 'b']),
          }),
        ]),
      );
    });
  });

  // ── Assignment from calls ─────────────────────────────────────────────

  describe('assignments', () => {
    it('tracks int result = compute() (init_declarator)', () => {
      const data = parseAndExtract('int main() { int result = compute(); return result; }');
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

    it('tracks result = compute() (assignment_expression)', () => {
      const data = parseAndExtract('int main() { int result; result = compute(); return result; }');
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

    it('detects variable intermediary passed as argument', () => {
      const data = parseAndExtract('void pipeline() { int val = getData(); process(val); }');
      expect(data?.argFlows).toEqual(
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
  });

  // ── Nested functions ──────────────────────────────────────────────────

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
