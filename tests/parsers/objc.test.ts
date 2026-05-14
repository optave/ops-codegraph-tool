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

  it('extracts keyword-selector method definitions with parameter names', () => {
    // The v3 grammar emits flat `identifier`+`method_parameter` children under
    // `method_definition` rather than wrapping them in `keyword_selector`. The
    // JS extractor must mirror `build_selector` / `extract_method_params` in
    // `crates/codegraph-core/src/extractors/objc.rs` so multi-keyword selectors
    // like `setName:age:` appear in `definitions` with their parameter names
    // populated. Otherwise these methods are silently dropped on the JS side.
    const symbols = parseObjC(`@implementation Foo
- (void)setName:(NSString *)name age:(int)age {
}
@end`);
    const method = symbols.definitions.find((d) => d.name === 'Foo.setName:age:');
    expect(method).toBeDefined();
    expect(method?.kind).toBe('method');
    expect(method?.children).toEqual([
      expect.objectContaining({ name: 'name', kind: 'parameter' }),
      expect.objectContaining({ name: 'age', kind: 'parameter' }),
    ]);
  });

  it('extracts @property names nested under struct_declarator', () => {
    // The v3 grammar does not expose `name` as a named field on
    // `property_declaration`; the identifier nests under
    // `struct_declaration > struct_declarator > [pointer_declarator >]
    // identifier`. Mirror `extract_property_name` in the Rust extractor so
    // pointer and non-pointer properties both surface as class children.
    const symbols = parseObjC(`@interface Foo : NSObject
@property (nonatomic, strong) NSString *name;
@property (nonatomic) int age;
@end`);
    const foo = symbols.definitions.find((d) => d.name === 'Foo');
    expect(foo).toBeDefined();
    expect(foo?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', kind: 'property' }),
        expect.objectContaining({ name: 'age', kind: 'property' }),
      ]),
    );
  });
});
