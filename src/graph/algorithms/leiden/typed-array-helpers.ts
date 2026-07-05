/**
 * Typed-array safe-access helpers shared by the leiden algorithm files.
 *
 * Typed arrays always return a number for in-bounds access, but
 * noUncheckedIndexedAccess widens the return type to `number | undefined`.
 * These helpers keep index reads and compound-assignment patterns (`+=`)
 * readable in this performance-critical code, without partition.ts,
 * adapter.ts, and index.ts each maintaining their own hand-copied variant
 * (previously named fget/iget/u8get in two files and taGet/taAdd in the
 * third — same idiom, three independent copies).
 */

export function fget(a: Float64Array, i: number): number {
  return a[i] as number;
}

export function iget(a: Int32Array, i: number): number {
  return a[i] as number;
}

export function u8get(a: Uint8Array, i: number): number {
  return a[i] as number;
}

/** In-place compound addition: `a[i] += v`, safe under noUncheckedIndexedAccess. */
export function taAdd(a: Float64Array, i: number, v: number): void {
  a[i] = fget(a, i) + v;
}
