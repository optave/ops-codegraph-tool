/**
 * Unit tests for extractDataflow() against parsed PHP ASTs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractDataflow } from '../../src/features/dataflow.js';
import { createParsers } from '../../src/parser.js';

describe('extractDataflow — PHP', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseAndExtract(code) {
    const parser = parsers.get('php');
    if (!parser) return null;
    const tree = parser.parse(code);
    return extractDataflow(tree, 'test.php', [], 'php');
  }

  describe('parameters', () => {
    it('extracts simple parameters', () => {
      const data = parseAndExtract('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
      expect(data.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ funcName: 'add', paramName: '$a', paramIndex: 0 }),
          expect.objectContaining({ funcName: 'add', paramName: '$b', paramIndex: 1 }),
        ]),
      );
    });
  });

  describe('returns', () => {
    it('captures return expressions with referencedNames', () => {
      const data = parseAndExtract('<?php\nfunction double($x) {\n    return $x * 2;\n}\n');
      expect(data.returns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            funcName: 'double',
            referencedNames: expect.arrayContaining(['$x']),
          }),
        ]),
      );
    });

    it('captures multiple referencedNames in return', () => {
      const data = parseAndExtract('<?php\nfunction add($a, $b) {\n    return $a + $b;\n}\n');
      const ret = data.returns.find((r) => r.funcName === 'add');
      expect(ret).toBeDefined();
      expect(ret.referencedNames).toContain('$a');
      expect(ret.referencedNames).toContain('$b');
    });
  });

  describe('assignments', () => {
    it('tracks variable from function call', () => {
      const data = parseAndExtract(
        '<?php\nfunction main() {\n    $result = compute();\n    return $result;\n}\n',
      );
      expect(data.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            varName: '$result',
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
        '<?php\nfunction process($input) {\n    transform($input);\n}\n',
      );
      expect(data.argFlows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callerFunc: 'process',
            calleeName: 'transform',
            argIndex: 0,
            argName: '$input',
            confidence: 1.0,
          }),
        ]),
      );
    });
  });
});
