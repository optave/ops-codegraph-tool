/**
 * Unit tests for extractDataflow() against parsed C# ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDataflow } from '../../src/features/dataflow.js';
import { createParsers } from '../../src/parser.js';

describe('extractDataflow — C#', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('csharp');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'Test.cs', [], 'csharp');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract(
        'class Test {\n  int Add(int a, int b) {\n    return a + b;\n  }\n}\n',
      );
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'Add', paramName: 'a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'Add', paramName: 'b', paramIndex: 1 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions', () => {
      const data = parseAndExtract(
        'class Test {\n  int Double(int x) {\n    return x * 2;\n  }\n}\n',
      );
      expect(data.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'Double',
            referencedNames: expect.arrayContaining(['x']),
          }),
        ]),
      );
    });
  });

  describe('assignments', () => {
    it('tracks variable from invocation', () => {
      const data = parseAndExtract(
        'class Test {\n  void Main() {\n    var result = Compute();\n  }\n}\n',
      );
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: 'result',
            callerFunc: 'Main',
            sourceCallName: 'Compute',
          }),
        ]),
      );
    });
  });

  describe('argFlows', () => {
    it('detects parameter passed as argument', () => {
      const data = parseAndExtract(
        'class Test {\n  void Process(string input) {\n    Transform(input);\n  }\n}\n',
      );
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'Process',
            calleeName: 'Transform',
            argIndex: 0,
            argName: 'input',
            confidence: 1.0,
          }),
        ]),
      );
    });
  });

  describe('mutations', () => {
    it('detects Add on parameter collection', () => {
      const data = parseAndExtract(
        'class Test {\n  void AddItem(List<string> items, string item) {\n    items.Add(item);\n  }\n}\n',
      );
      expect(data.mutations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'AddItem',
            receiverName: 'items',
          }),
        ]),
      );
    });
  });
});
