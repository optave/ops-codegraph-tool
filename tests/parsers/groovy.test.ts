import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractGroovySymbols } from '../../src/domain/parser.js';

describe('Groovy parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseGroovy(code: string) {
    const parser = parsers.get('groovy');
    if (!parser) throw new Error('Groovy parser not available');
    const tree = parser.parse(code);
    return extractGroovySymbols(tree, 'test.groovy');
  }

  it('extracts class declarations', () => {
    const symbols = parseGroovy(`class MyService {
    String name
    void process() {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyService', kind: 'class' }),
    );
  });

  it('extracts method declarations', () => {
    const symbols = parseGroovy(`class Calc {
    int add(int a, int b) {
        return a + b
    }
}`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'method' }));
  });

  it('extracts import statements', () => {
    const symbols = parseGroovy(`import groovy.json.JsonSlurper`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'groovy.json.JsonSlurper' }),
    );
  });

  it('extracts interface declarations', () => {
    const symbols = parseGroovy(`interface Processor {
    void process()
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Processor', kind: 'interface' }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseGroovy(`enum Color {
    RED, GREEN, BLUE
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts command-style (juxt) function calls', () => {
    // Gradle DSL pattern: `task` and `apply` are invoked command-style without
    // parens. The grammar emits these as `juxt_function_call` nodes; missing
    // dispatch silently drops them from the call graph.
    const symbols = parseGroovy(`apply plugin: 'java'
task someTask {
    doLast {
        println "hello"
    }
}`);
    const callNames = symbols.calls.map((c) => c.name);
    expect(callNames).toContain('apply');
    expect(callNames).toContain('task');
    expect(callNames).toContain('println');
  });
});
