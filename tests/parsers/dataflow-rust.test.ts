/**
 * Unit tests for extractDataflow() against parsed Rust ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers } from '../../src/domain/parser.js';
import { extractDataflow } from '../../src/features/dataflow.js';

describe('extractDataflow — Rust', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('rust');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.rs', [], 'rust');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract('fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n');
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
      const data = parseAndExtract('fn double(x: i32) -> i32 {\n    return x * 2;\n}\n');
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
    it('tracks let binding from call', () => {
      const data = parseAndExtract(
        'fn main() {\n    let result = compute();\n    println!("{}", result);\n}\n',
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
      const data = parseAndExtract('fn process(input: String) {\n    transform(input);\n}\n');
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
    it('detects push on parameter', () => {
      const data = parseAndExtract(
        'fn add_item(items: &mut Vec<i32>, item: i32) {\n    items.push(item);\n}\n',
      );
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
