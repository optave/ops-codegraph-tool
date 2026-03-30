import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractBashSymbols } from '../../src/domain/parser.js';

describe('Bash parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseBash(code) {
    const parser = parsers.get('bash');
    if (!parser) throw new Error('Bash parser not available');
    const tree = parser.parse(code);
    return extractBashSymbols(tree, 'test.sh');
  }

  it('extracts function definitions', () => {
    const symbols = parseBash(`function greet() { echo "hello"; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts function definitions (shorthand)', () => {
    const symbols = parseBash(`greet() { echo "hello"; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts command calls', () => {
    const symbols = parseBash(`#!/bin/bash\necho "hello"\nls -la`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'echo' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'ls' }));
  });

  it('extracts source imports', () => {
    const symbols = parseBash(`source ./utils.sh`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ bashSource: true }),
    );
  });

  it('extracts dot source imports', () => {
    const symbols = parseBash(`. ./config.sh`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ bashSource: true }),
    );
  });
});
