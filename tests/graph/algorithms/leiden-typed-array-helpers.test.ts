import { describe, expect, it } from 'vitest';
import {
  fgetOrZero,
  igetOrZero,
} from '../../../src/graph/algorithms/leiden/typed-array-helpers.js';

describe('fgetOrZero', () => {
  it('returns the in-range value when it is truthy', () => {
    const a = new Float64Array([1, 2.5, -3]);
    expect(fgetOrZero(a, 0)).toBe(1);
    expect(fgetOrZero(a, 1)).toBe(2.5);
    expect(fgetOrZero(a, 2)).toBe(-3);
  });

  it('collapses an in-range zero to 0', () => {
    const a = new Float64Array([0, 5]);
    expect(fgetOrZero(a, 0)).toBe(0);
  });

  it('collapses an out-of-range index (positive or negative) to 0', () => {
    const a = new Float64Array([1, 2]);
    expect(fgetOrZero(a, 2)).toBe(0);
    expect(fgetOrZero(a, 99)).toBe(0);
    expect(fgetOrZero(a, -1)).toBe(0);
  });

  it('matches the two guards it replaces: `i < a.length ? fget(a, i) : 0` and `fget(a, i) || 0`', () => {
    const a = new Float64Array([0, 7, 0]);
    for (let i = -1; i <= a.length; i++) {
      const boundsGuard = i < a.length && i >= 0 ? (a[i] as number) : 0;
      const orZeroGuard = ((a[i] as number) || 0) as number;
      expect(fgetOrZero(a, i)).toBe(boundsGuard);
      expect(fgetOrZero(a, i)).toBe(orZeroGuard);
    }
  });
});

describe('igetOrZero', () => {
  it('returns the in-range value when it is truthy', () => {
    const a = new Int32Array([4, -6, 0]);
    expect(igetOrZero(a, 0)).toBe(4);
    expect(igetOrZero(a, 1)).toBe(-6);
  });

  it('collapses an in-range zero to 0', () => {
    const a = new Int32Array([0, 3]);
    expect(igetOrZero(a, 0)).toBe(0);
  });

  it('collapses an out-of-range index to 0', () => {
    const a = new Int32Array([1, 2]);
    expect(igetOrZero(a, 5)).toBe(0);
    expect(igetOrZero(a, -1)).toBe(0);
  });
});
