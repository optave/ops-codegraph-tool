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
});
