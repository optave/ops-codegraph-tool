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
});
