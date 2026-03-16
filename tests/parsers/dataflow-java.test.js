/**
 * Unit tests for extractDataflow() against parsed Java ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — Java', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('java');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'Test.java', [], 'java');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract(
        'class Test {\n  int add(int a, int b) {\n    return a + b;\n  }\n}\n',
      );
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract(
        'class Test {\n  int double(int x) {\n    return x * 2;\n  }\n}\n',
      );
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
    it('tracks variable from method invocation', () => {
      const data = parseAndExtract(
        'class Test {\n  void main() {\n    String result = compute();\n  }\n}\n',
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
        'class Test {\n  void process(String input) {\n    transform(input);\n  }\n}\n',
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

  describe('mutations', () => {
    it('detects add on parameter collection', () => {
      const data = parseAndExtract(
        'class Test {\n  void addItem(List<String> items, String item) {\n    items.add(item);\n  }\n}\n',
      );
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'addItem',
            receiverName: 'items',
          }),
        ]),
      );
    });
  });
});
