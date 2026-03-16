/**
 * Unit tests for extractDataflow() against parsed Ruby ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDataflow } from '../../src/features/dataflow.js';
import { createParsers } from '../../src/domain/parser.js';

describe('extractDataflow — Ruby', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('ruby');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.rb', [], 'ruby');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract('def add(a, b)\n  return a + b\nend\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures explicit return', () => {
      const data = parseAndExtract('def double(x)\n  return x * 2\nend\n');
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
    it('tracks variable from method call', () => {
      const data = parseAndExtract('def main\n  result = compute()\n  return result\nend\n');
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
      const data = parseAndExtract('def process(input)\n  transform(input)\nend\n');
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
