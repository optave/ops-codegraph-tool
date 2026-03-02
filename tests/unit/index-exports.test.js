import { describe, expect, it } from 'vitest';

describe('index.js re-exports', () => {
  it('all re-exports resolve without errors', async () => {
    // Dynamic import validates that every re-exported module exists and
    // all named exports are resolvable. If any source file is missing,
    // this will throw ERR_MODULE_NOT_FOUND.
    const mod = await import('../../src/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });
});
