/**
 * Node role classification — pure logic, no DB.
 *
 * Roles: entry, core, utility, adapter, leaf, dead
 */

export const FRAMEWORK_ENTRY_PREFIXES = ['route:', 'event:', 'command:'];

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Classify nodes into architectural roles based on fan-in/fan-out metrics.
 *
 * @param {{ id: string, name: string, fanIn: number, fanOut: number, isExported: boolean }[]} nodes
 * @returns {Map<string, string>} nodeId → role
 */
export function classifyRoles(nodes) {
  if (nodes.length === 0) return new Map();

  const nonZeroFanIn = nodes
    .filter((n) => n.fanIn > 0)
    .map((n) => n.fanIn)
    .sort((a, b) => a - b);
  const nonZeroFanOut = nodes
    .filter((n) => n.fanOut > 0)
    .map((n) => n.fanOut)
    .sort((a, b) => a - b);

  const medFanIn = median(nonZeroFanIn);
  const medFanOut = median(nonZeroFanOut);

  const result = new Map();

  for (const node of nodes) {
    const highIn = node.fanIn >= medFanIn && node.fanIn > 0;
    const highOut = node.fanOut >= medFanOut && node.fanOut > 0;

    let role;
    const isFrameworkEntry = FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p));
    if (isFrameworkEntry) {
      role = 'entry';
    } else if (node.fanIn === 0 && !node.isExported) {
      role = 'dead';
    } else if (node.fanIn === 0 && node.isExported) {
      role = 'entry';
    } else if (highIn && !highOut) {
      role = 'core';
    } else if (highIn && highOut) {
      role = 'utility';
    } else if (!highIn && highOut) {
      role = 'adapter';
    } else {
      role = 'leaf';
    }

    result.set(node.id, role);
  }

  return result;
}
