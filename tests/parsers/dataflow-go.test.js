/**
 * Unit tests for extractDataflow() against parsed Go ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDataflow } from '../../src/features/dataflow.js';
import { createParsers } from '../../src/domain/parser.js';

describe('extractDataflow — Go', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('go');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.go', [], 'go');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract(
        'package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n',
      );
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts multi-name parameters', () => {
      const data = parseAndExtract('package main\nfunc add(a, b int) int {\n\treturn a + b\n}\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a' }),
          expect.objectContaining({ funcName: 'add', paramName: 'b' }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract('package main\nfunc double(x int) int {\n\treturn x * 2\n}\n');
      expect(data.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'double',
            referencedNames: expect.arrayContaining(['x']),
          }),
        ]),
      );
    });
  });

  describe('assignments', () => {
    it('tracks short var declaration from call', () => {
      const data = parseAndExtract(
        'package main\nfunc main() {\n\tresult := compute()\n\t_ = result\n}\n',
      );
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
  });

  describe('argFlows', () => {
    it('detects parameter passed as argument', () => {
      const data = parseAndExtract(
        'package main\nfunc process(input string) {\n\ttransform(input)\n}\n',
      );
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
  });
});
