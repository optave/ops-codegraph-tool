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

/**
 * Bounds-checked community-accumulator read: `i < a.length ? (fget(a, i) || 0) : 0`.
 *
 * Community ids are sometimes probed before the community itself has been
 * grown into a given per-community accumulator array (e.g. a brand-new
 * `newC` about to receive its first member) — the bounds check treats that
 * as a not-yet-existing community contributing zero, matching
 * `getNeighborEdgeWeightToCommunity`/`getOutEdgeWeightToCommunity`/
 * `getInEdgeWeightFromCommunity` in partition.ts, which every other reader
 * of these arrays already goes through.
 *
 * The `|| 0` is not reachable today: every array this is used with in this
 * codebase (communityTotalStrength/In/Out, neighborEdgeWeightToCommunity,
 * outEdgeWeightToCommunity, inEdgeWeightFromCommunity) is a dense,
 * zero-initialized Float64Array populated purely by +=/-= over edge weights
 * and node strengths that are scrubbed of NaN/undefined at
 * `makeGraphAdapter` construction time (`+linkWeight(attrs) || 0` /
 * `+nodeSize(attrs) || 0` in adapter.ts) — so a bare bounds-checked `fget`
 * would return the identical value. Kept for defense-in-depth against a
 * future change to that invariant, and so callers reading either array
 * family use one consistent, already-safe accessor instead of
 * hand-rolling the same ternary+`||` per call site (see issue #1755).
 */
export function fgetOrZero(a: Float64Array, i: number): number {
  return i < a.length ? fget(a, i) || 0 : 0;
}

/** In-place compound addition: `a[i] += v`, safe under noUncheckedIndexedAccess. */
export function taAdd(a: Float64Array, i: number, v: number): void {
  a[i] = fget(a, i) + v;
}
