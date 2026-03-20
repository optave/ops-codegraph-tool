import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractGoSymbols } from '../../src/domain/parser.js';

describe('Go parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseGo(code) {
    const parser = parsers.get('go');
    if (!parser) throw new Error('Go parser not available');
    const tree = parser.parse(code);
    return extractGoSymbols(tree, 'test.go');
  }

  it('extracts function declarations', () => {
    const symbols = parseGo(
      `package main\nfunc greet(name string) string { return "hello " + name }`,
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function', line: 2 }),
    );
  });

  it('extracts method declarations with receiver', () => {
    const symbols = parseGo(`package main
type Server struct {}
func (s *Server) Start() error { return nil }
func (s Server) Name() string { return "" }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.Start', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.Name', kind: 'method' }),
    );
  });

  it('extracts struct types as struct kind', () => {
    const symbols = parseGo(`package main\ntype User struct { Name string; Age int }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'struct' }),
    );
  });

  it('extracts interface types', () => {
    const symbols = parseGo(`package main
type Reader interface {
  Read(p []byte) (n int, err error)
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Reader', kind: 'interface' }),
    );
  });

  it('extracts type aliases', () => {
    const symbols = parseGo(`package main\ntype ID string`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'ID', kind: 'type' }),
    );
  });

  it('extracts single imports', () => {
    const symbols = parseGo(`package main\nimport "fmt"`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'fmt', names: ['fmt'] }),
    );
  });

  it('extracts grouped imports', () => {
    const symbols = parseGo(`package main
import (
  "fmt"
  "os"
  "net/http"
)`);
    expect(symbols.imports).toHaveLength(3);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'net/http', names: ['http'] }),
    );
  });

  it('extracts aliased imports', () => {
    const symbols = parseGo(`package main\nimport myfmt "fmt"`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'fmt', names: ['myfmt'] }),
    );
  });

  it('matches struct to interface structurally', () => {
    const symbols = parseGo(`package main
type Writer interface {
  Write(p []byte) (n int, err error)
}
type MyBuffer struct { data []byte }
func (b *MyBuffer) Write(p []byte) (int, error) { return len(p), nil }
func (b *MyBuffer) Flush() error { return nil }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'MyBuffer', implements: 'Writer' }),
    );
  });

  it('does not match struct missing interface methods', () => {
    const symbols = parseGo(`package main
type ReadWriter interface {
  Read(p []byte) (n int, err error)
  Write(p []byte) (n int, err error)
}
type OnlyWriter struct {}
func (w *OnlyWriter) Write(p []byte) (int, error) { return 0, nil }`);
    const match = symbols.classes.find(
      (c) => c.name === 'OnlyWriter' && c.implements === 'ReadWriter',
    );
    expect(match).toBeUndefined();
  });

  it('matches multiple interfaces for one struct', () => {
    const symbols = parseGo(`package main
type Reader interface { Read() }
type Writer interface { Write() }
type File struct {}
func (f *File) Read() {}
func (f *File) Write() {}`);
    const impls = symbols.classes.filter((c) => c.name === 'File');
    expect(impls).toHaveLength(2);
    const ifaceNames = impls.map((c) => c.implements).sort();
    expect(ifaceNames).toEqual(['Reader', 'Writer']);
  });

  it('ignores empty interfaces (satisfied by everything)', () => {
    const symbols = parseGo(`package main
type Any interface {}
type Foo struct {}
func (f *Foo) Bar() {}`);
    const match = symbols.classes.find((c) => c.implements === 'Any');
    expect(match).toBeUndefined();
  });

  it('extracts call expressions', () => {
    const symbols = parseGo(`package main
import "fmt"
func main() { fmt.Println("hello"); greet("world") }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Println' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'greet' }));
  });
});
