import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CJS require goes through Node's native loader — needs Node >= 22.6 for .ts
const [_major, _minor] = process.versions.node.split('.').map(Number);
const canStripTypes = _major > 22 || (_major === 22 && _minor >= 6);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));

describe('index.js re-exports', () => {
  it('package.json exports map points to CJS wrapper', () => {
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.exports['.'].require).toBe('./dist/index.cjs');
  });

  it('all re-exports resolve without errors', async () => {
    // Dynamic import validates that every re-exported module exists and
    // all named exports are resolvable. If any source file is missing,
    // this will throw ERR_MODULE_NOT_FOUND.
    const mod = await import('../../src/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });

  it.skipIf(!canStripTypes)('CJS wrapper resolves to the same exports', async () => {
    const require = createRequire(import.meta.url);
    const cjs = await require('../../src/index.cjs');
    const esm = await import('../../src/index.js');
    // Every named ESM export should resolve to a real value, not undefined.
    // CJS import() produces a separate module namespace so reference equality
    // (toBe) is not possible, but we verify the export exists, is defined,
    // and has the same type as its ESM counterpart.
    for (const key of Object.keys(esm)) {
      if (key === 'default') continue;
      expect(cjs[key], `CJS export "${key}" is missing or undefined`).toBeDefined();
      expect(typeof cjs[key]).toBe(typeof esm[key]);
    }

    // Symmetric check: CJS should not have extra keys beyond ESM exports.
    const esmKeys = new Set(Object.keys(esm).filter((k) => k !== 'default'));
    const cjsKeys = new Set(Object.keys(cjs).filter((k) => k !== 'default'));
    expect(cjsKeys).toEqual(esmKeys);
  });
});
