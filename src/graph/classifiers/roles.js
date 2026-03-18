/**
 * Node role classification — pure logic, no DB.
 *
 * Roles: entry, core, utility, adapter, leaf, dead-*, test-only
 *
 * Dead sub-categories refine the coarse "dead" bucket:
 *   dead-leaf       — parameters, properties, constants (leaf nodes by definition)
 *   dead-entry      — framework dispatch: CLI commands, MCP tools, event handlers
 *   dead-ffi        — cross-language FFI boundaries (e.g. Rust napi-rs bindings)
 *   dead-unresolved — genuinely unreferenced callables (the real dead code)
 */

export const FRAMEWORK_ENTRY_PREFIXES = ['route:', 'event:', 'command:'];

// ── Dead sub-classification helpers ────────────────────────────────

const LEAF_KINDS = new Set(['parameter', 'property', 'constant']);

const FFI_EXTENSIONS = new Set(['.rs', '.c', '.cpp', '.h', '.go', '.java', '.cs']);

/** Path patterns indicating framework-dispatched entry points. */
const ENTRY_PATH_PATTERNS = [
  /cli[/\\]commands[/\\]/,
  /mcp[/\\]/,
  /routes?[/\\]/,
  /handlers?[/\\]/,
  /middleware[/\\]/,
];

/**
 * Refine a "dead" classification into a sub-category.
 *
 * @param {{ kind?: string, file?: string }} node
 * @returns {'dead-leaf'|'dead-entry'|'dead-ffi'|'dead-unresolved'}
 */
function classifyDeadSubRole(node) {
  // Leaf kinds are dead by definition — they can't have callers
  if (node.kind && LEAF_KINDS.has(node.kind)) return 'dead-leaf';

  if (node.file) {
    // Cross-language FFI: compiled-language files in a JS/TS project
    const dotIdx = node.file.lastIndexOf('.');
    if (dotIdx !== -1 && FFI_EXTENSIONS.has(node.file.slice(dotIdx))) return 'dead-ffi';

    // Framework-dispatched entry points (CLI commands, MCP tools, routes)
    if (ENTRY_PATH_PATTERNS.some((p) => p.test(node.file))) return 'dead-entry';
  }

  return 'dead-unresolved';
}

// ── Helpers ────────────────────────────────────────────────────────

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Classify nodes into architectural roles based on fan-in/fan-out metrics.
 *
 * @param {{ id: string, name: string, kind?: string, file?: string, fanIn: number, fanOut: number, isExported: boolean, testOnlyFanIn?: number }[]} nodes
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
    const hasProdFanIn = typeof node.productionFanIn === 'number';

    let role;
    const isFrameworkEntry = FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p));
    if (isFrameworkEntry) {
      role = 'entry';
    } else if (node.fanIn === 0 && !node.isExported) {
      role = node.testOnlyFanIn > 0 ? 'test-only' : classifyDeadSubRole(node);
    } else if (node.fanIn === 0 && node.isExported) {
      role = 'entry';
    } else if (hasProdFanIn && node.fanIn > 0 && node.productionFanIn === 0) {
      role = 'test-only';
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
