import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractObjCSymbols } from '../../src/domain/parser.js';

describe('Objective-C parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseObjC(code: string) {
    const parser = parsers.get('objc');
    if (!parser) throw new Error('Objective-C parser not available');
    const tree = parser.parse(code);
    return extractObjCSymbols(tree, 'test.m');
  }

  it('extracts class interface declarations', () => {
    const symbols = parseObjC(`@interface MyClass : NSObject
- (void)doSomething;
@end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyClass', kind: 'class' }),
    );
  });

  it('extracts protocol declarations', () => {
    const symbols = parseObjC(`@protocol MyDelegate
- (void)didFinish;
@end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyDelegate', kind: 'interface' }),
    );
  });

  it('extracts C function definitions', () => {
    const symbols = parseObjC(`void helper(int x) {
    return;
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'helper', kind: 'function' }),
    );
  });

  it('extracts #import as imports', () => {
    const symbols = parseObjC(`#import <Foundation/Foundation.h>`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'Foundation/Foundation.h' }),
    );
  });

  it('extracts inheritance', () => {
    const symbols = parseObjC(`@interface MyView : UIView
@end`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'MyView', extends: 'UIView' }),
    );
  });

  it('extracts @import module statements', () => {
    // tree-sitter-objc v3 emits `module_import` for `@import` statements.
    // The Rust extractor dispatches on this node type and the JS extractor
    // must match it to keep engine parity (otherwise every `@import` is
    // silently dropped on the JS side).
    const symbols = parseObjC(`@import Foundation;`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'Foundation', names: ['Foundation'] }),
    );
  });

  it('extracts C-style function calls without a `function` field', () => {
    // tree-sitter-objc does not expose a `function` field on `call_expression`,
    // so the JS extractor must fall back to the first identifier child —
    // matching the Rust side. Otherwise C calls like `printf(...)` are
    // silently dropped.
    const symbols = parseObjC(`void main() {
    printf("hello");
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'printf' }));
  });

  it('builds keyword-selector calls from message expressions', () => {
    // The grammar tags each keyword identifier with the `method` field rather
    // than exposing a single `selector` field. Mirror the Rust assembly so
    // selectors like `initWithName:age:` are recorded identically.
    const symbols = parseObjC(`void main() {
    [obj initWithName:@"x" age:10];
}`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'initWithName:age:', receiver: 'obj' }),
    );
  });
});
