/**
 * Seeded PRNG (mulberry32).
 * Drop-in replacement for ngraph.random — only nextDouble() is needed.
 *
 * @param {number} [seed]
 * @returns {{ nextDouble(): number }}
 */
export function createRng(seed = 42) {
  let s = seed | 0;
  return {
    nextDouble() {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
