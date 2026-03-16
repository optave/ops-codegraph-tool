/**
 * Query-vs-Walk parity tests for JS/TS/TSX extractors.
 *
 * Parses each snippet twice:
 *   1. Query path — via parseFileAuto (uses compiled tree-sitter Query)
 *   2. Walk path  — direct extractSymbols(tree, filePath) with no query (manual tree walk)
 *
 * Both paths must produce identical symbols.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, getParser, parseFileAuto } from '../../src/domain/parser.js';
import { extractSymbols } from '../../src/extractors/javascript.js';

let parsers;

beforeAll(async () => {
  parsers = await createParsers();
});

/** Strip undefined optional fields for stable comparison. */
function normalize(symbols) {
  if (!symbols) return symbols;
  return {
    definitions: (symbols.definitions || [])
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        line: d.line,
        endLine: d.endLine ?? null,
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    calls: (symbols.calls || [])
      .map((c) => ({
        name: c.name,
        line: c.line,
        ...(c.receiver ? { receiver: c.receiver } : {}),
        ...(c.dynamic ? { dynamic: true } : {}),
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    imports: (symbols.imports || [])
      .map((i) => ({
        source: i.source,
        names: [...(i.names || [])].sort(),
        line: i.line,
        ...(i.reexport ? { reexport: true } : {}),
        ...(i.wildcardReexport ? { wildcardReexport: true } : {}),
        ...(i.typeOnly ? { typeOnly: true } : {}),
        ...(i.dynamicImport ? { dynamicImport: true } : {}),
      }))
      .sort((a, b) => a.line - b.line),
    classes: (symbols.classes || [])
      .map((c) => ({
        name: c.name,
        ...(c.extends ? { extends: c.extends } : {}),
        ...(c.implements ? { implements: c.implements } : {}),
        line: c.line,
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    exports: (symbols.exports || [])
      .map((e) => ({
        name: e.name,
        kind: e.kind,
        line: e.line,
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
  };
}

function walkExtract(code, filePath) {
  const parser = getParser(parsers, filePath);
  if (!parser) throw new Error(`No parser for ${filePath}`);
  const tree = parser.parse(code);
  // Call without query → triggers extractSymbolsWalk
  return extractSymbols(tree, filePath);
}

async function queryExtract(code, filePath) {
  // parseFileAuto with engine:'wasm' passes the compiled query from _queryCache
  return parseFileAuto(filePath, code, { engine: 'wasm' });
}

const cases = [
  {
    name: 'functions and arrow functions',
    file: 'test.js',
    code: `
function greet(name) { return 'Hello ' + name; }
const add = (a, b) => a + b;
greet('world');
add(1, 2);
`,
  },
  {
    name: 'class with methods and inheritance',
    file: 'test.js',
    code: `
class Animal {
  speak() { return 'generic'; }
}
class Dog extends Animal {
  speak() { return 'woof'; }
  fetch(item) { return item; }
}
new Dog().speak();
`,
  },
  {
    name: 'imports and re-exports',
    file: 'test.js',
    code: `
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
export { default as Widget } from './Widget';
export * from './utils';
readFile('file.txt');
`,
  },
  {
    name: 'method calls with receivers',
    file: 'test.js',
    code: `
obj.method();
standalone();
this.foo();
arr[0].bar();
a.b.c();
`,
  },
  {
    name: 'CommonJS require patterns',
    file: 'test.js',
    code: `
const fs = require('fs');
const { join } = require('path');
module.exports = { fs };
`,
  },
  {
    name: 'Commander callback patterns',
    file: 'test.js',
    code: `
program.command('build [dir]').action(async (dir, opts) => { run(); });
program.command('query <name>').action(() => { search(); });
program.command('test').action(handleTest);
`,
  },
  {
    name: 'Express route patterns',
    file: 'test.js',
    code: `
app.get('/api/users', (req, res) => { res.json([]); });
router.post('/api/items', async (req, res) => { save(); });
`,
  },
  {
    name: 'event emitter patterns',
    file: 'test.js',
    code: `
emitter.on('data', (chunk) => { process(chunk); });
server.once('listening', () => { log(); });
emitter.on('error', handleError);
`,
  },
  {
    name: 'exported function and class declarations',
    file: 'test.js',
    code: `
export function serve(port) { listen(port); }
export class Server {
  start() { this.init(); }
}
`,
  },
  {
    name: 'dynamic call patterns (.call/.apply)',
    file: 'test.js',
    code: `
fn.call(null, arg);
obj.apply(undefined, args);
method.bind(ctx);
`,
  },
  {
    name: 'dynamic import() expressions',
    file: 'test.js',
    code: `
const { readFile } = await import('fs/promises');
const { readFile: rf } = await import('node:fs/promises');
const mod = await import('./utils.js');
import('./side-effect.js');
`,
  },
  // TypeScript-specific
  {
    name: 'TS interfaces and type aliases',
    file: 'test.ts',
    code: `
interface Greeter { greet(name: string): string; }
type ID = string | number;
class MyGreeter implements Greeter {
  greet(name: string) { return name; }
}
`,
  },
  {
    name: 'TS import type',
    file: 'test.ts',
    code: `
import type { Config } from './config';
import { readFile } from 'fs/promises';
function load(): Config { return readFile('cfg.json'); }
`,
  },
  // TSX
  {
    name: 'TSX component with extends',
    file: 'test.tsx',
    code: `
import React from 'react';
class Button extends React.Component {
  render() { return <button />; }
}
export default Button;
`,
  },
];

describe('Query vs Walk parity', () => {
  for (const { name, file, code } of cases) {
    it(`${file.split('.').pop().toUpperCase()} — ${name}`, async () => {
      const walkResult = normalize(walkExtract(code, file));
      const queryResult = normalize(await queryExtract(code, file));
      expect(queryResult).toEqual(walkResult);
    });
  }
});
