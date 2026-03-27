/**
 * Unit tests for extractDataflow() against parsed Python ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — Python', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('python');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.py', [], 'python');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract('def add(a, b):\n    return a + b\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });

    it('extracts typed parameters', () => {
      const data = parseAndExtract('def greet(name: str, age: int):\n    return name\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'greet', paramName: 'name' }),
          expect.objectContaining({ funcName: 'greet', paramName: 'age' }),
        ]),
      );
    });

    it('extracts default parameters', () => {
      const data = parseAndExtract('def inc(x, step=1):\n    return x + step\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'inc', paramName: 'x', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'inc', paramName: 'step', paramIndex: 1 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract('def double(x):\n    return x * 2\n');
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
    it('tracks result = compute()', () => {
      const data = parseAndExtract('def main():\n    result = compute()\n    return result\n');
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
      const data = parseAndExtract('def process(input):\n    transform(input)\n');
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

  describe('mutations', () => {
    it('detects append on parameter', () => {
      const data = parseAndExtract('def add_item(items, item):\n    items.append(item)\n');
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'add_item',
            receiverName: 'items',
          }),
        ]),
      );
    });
  });
});
