/**
 * Tests for the unified parser API (parseFileAuto / parseFilesAuto / getActiveEngine).
 *
 * These tests always work: when native is unavailable they exercise the WASM fallback.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getActiveEngine, parseFileAuto, parseFilesAuto } from '../../src/parser.js';

describe('Unified parser API', () => {
  describe('getActiveEngine', () => {
    it('returns an object with name and version', () => {
      const engine = getActiveEngine();
      expect(engine).toHaveProperty('name');
      expect(['native', 'wasm']).toContain(engine.name);
      expect(engine).toHaveProperty('version');
    });

    it('respects engine=wasm override', () => {
      const engine = getActiveEngine({ engine: 'wasm' });
      expect(engine.name).toBe('wasm');
      expect(engine.version).toBeNull();
    });

    it('throws when engine=native is explicitly requested but unavailable', () => {
      const engine = getActiveEngine();
      if (engine.name === 'native') return; // skip — native is available
      expect(() => getActiveEngine({ engine: 'native' })).toThrow(/[Nn]ative/);
    });
  });

  describe('parseFileAuto', () => {
    it('parses a simple JS function declaration', async () => {
      const symbols = await parseFileAuto(
        'test.js',
        'function greet(name) { return "hello " + name; }',
      );
      expect(symbols).not.toBeNull();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'greet', kind: 'function', line: 1 }),
      );
    });

    it('parses arrow function assignments', async () => {
      const symbols = await parseFileAuto('test.js', 'const add = (a, b) => a + b;');
      expect(symbols).not.toBeNull();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'add', kind: 'function' }),
      );
    });

    it('extracts imports', async () => {
      const symbols = await parseFileAuto('test.js', "import { foo } from './bar.js';");
      expect(symbols).not.toBeNull();
      expect(symbols.imports.length).toBeGreaterThan(0);
      expect(symbols.imports[0].source).toBe('./bar.js');
      expect(symbols.imports[0].names).toContain('foo');
    });

    it('extracts call expressions', async () => {
      const symbols = await parseFileAuto('test.js', 'function f() { g(); }');
      expect(symbols).not.toBeNull();
      expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'g' }));
    });

    it('extracts classes', async () => {
      const symbols = await parseFileAuto('test.js', 'class Foo extends Bar { baz() {} }');
      expect(symbols).not.toBeNull();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Foo', kind: 'class' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Foo.baz', kind: 'method' }),
      );
    });

    it('returns uniform shape with all five fields', async () => {
      const symbols = await parseFileAuto('test.js', 'const x = 1;');
      expect(symbols).not.toBeNull();
      expect(symbols).toHaveProperty('definitions');
      expect(symbols).toHaveProperty('calls');
      expect(symbols).toHaveProperty('imports');
      expect(symbols).toHaveProperty('classes');
      expect(symbols).toHaveProperty('exports');
      expect(Array.isArray(symbols.definitions)).toBe(true);
      expect(Array.isArray(symbols.calls)).toBe(true);
      expect(Array.isArray(symbols.imports)).toBe(true);
      expect(Array.isArray(symbols.classes)).toBe(true);
      expect(Array.isArray(symbols.exports)).toBe(true);
    });

    it('works when forced to WASM engine', async () => {
      const symbols = await parseFileAuto('test.js', 'function hello() {}', { engine: 'wasm' });
      expect(symbols).not.toBeNull();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'hello', kind: 'function' }),
      );
    });

    it('parses Python when forced to WASM', async () => {
      const symbols = await parseFileAuto('test.py', 'def greet():\n    pass', { engine: 'wasm' });
      expect(symbols).not.toBeNull();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'greet', kind: 'function' }),
      );
    });
  });

  describe('parseFilesAuto', () => {
    it('parses fixture project files', async () => {
      const fixtureDir = path.resolve('tests/fixtures/sample-project');
      const filePaths = [
        path.join(fixtureDir, 'math.js'),
        path.join(fixtureDir, 'utils.js'),
        path.join(fixtureDir, 'index.js'),
      ];

      const result = await parseFilesAuto(filePaths, fixtureDir);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(3);

      // Check that math.js was parsed
      const mathSymbols = result.get('math.js');
      expect(mathSymbols).toBeDefined();
      expect(mathSymbols.definitions.length).toBeGreaterThan(0);
    });

    it('returns Map<relPath, symbols> with correct shapes', async () => {
      const fixtureDir = path.resolve('tests/fixtures/sample-project');
      const filePaths = [path.join(fixtureDir, 'math.js')];

      const result = await parseFilesAuto(filePaths, fixtureDir);
      const symbols = result.get('math.js');
      expect(symbols).toBeDefined();
      expect(symbols).toHaveProperty('definitions');
      expect(symbols).toHaveProperty('calls');
      expect(symbols).toHaveProperty('imports');
      expect(symbols).toHaveProperty('classes');
      expect(symbols).toHaveProperty('exports');
    });
  });
});
