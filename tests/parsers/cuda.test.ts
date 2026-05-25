import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractCudaSymbols } from '../../src/domain/parser.js';

describe('CUDA parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseCuda(code: string) {
    const parser = parsers.get('cuda');
    if (!parser) throw new Error('CUDA parser not available');
    const tree = parser.parse(code);
    return extractCudaSymbols(tree, 'test.cu');
  }

  it('extracts function definitions', () => {
    const symbols = parseCuda(`void hostFunction(int n) {
    return;
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'hostFunction', kind: 'function' }),
    );
  });

  it('extracts struct definitions', () => {
    const symbols = parseCuda(`struct Vec3 {
    float x, y, z;
};`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Vec3', kind: 'struct' }),
    );
  });

  it('extracts class definitions', () => {
    const symbols = parseCuda(`class CudaManager {
public:
    void init();
};`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'CudaManager', kind: 'class' }),
    );
  });

  it('extracts #include as imports', () => {
    const symbols = parseCuda(`#include <cuda_runtime.h>`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: 'cuda_runtime.h' }));
  });

  it('extracts call expressions', () => {
    const symbols = parseCuda(`void foo() {
    cudaMalloc(&ptr, size);
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'cudaMalloc' }));
  });

  it('unwraps function-type parameter to bare identifier', () => {
    // `int callback(int)` as a parameter parses as a `function_declarator`
    // whose inner `declarator` is the identifier. Drill through it so the
    // parameter name is `callback`, not `callback(int)`. Matches
    // `unwrap_cuda_declarator` in `crates/codegraph-core/src/extractors/cuda.rs`.
    const symbols = parseCuda(`void process(int callback(int)) {}`);
    const process = symbols.definitions.find((d) => d.name === 'process');
    expect(process).toBeDefined();
    expect(process?.children).toBeDefined();
    expect(process?.children?.length).toBe(1);
    expect(process?.children?.[0]?.name).toBe('callback');
    expect(process?.children?.[0]?.kind).toBe('parameter');
  });

  it('keeps function-pointer class fields and skips real methods', () => {
    // Regression for follow-up #1204: a `field_declaration` whose declarator
    // is a `function_declarator` wrapping a `parenthesized_declarator` is a
    // function-pointer field, not a method declaration — keep it as a
    // property with the inner identifier as its name.
    const symbols = parseCuda(`class Service {
    void method(int);
    void (*callback)(int);
    int (*const arr_cb[3])(double);
    void (&ref_cb)(int);
    int counter;
};`);
    const cls = symbols.definitions.find((d) => d.name === 'Service');
    expect(cls).toBeDefined();
    const childNames = (cls?.children ?? []).map((c) => c.name);
    expect(childNames).toEqual(expect.arrayContaining(['callback', 'arr_cb', 'ref_cb', 'counter']));
    // The real method declaration is still skipped at the field level.
    expect(childNames).not.toContain('method');
  });
});
