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

import type { DeadSubRole, Role } from '../../types.js';

export const FRAMEWORK_ENTRY_PREFIXES: readonly string[] = ['route:', 'event:', 'command:'];

// ── Dead sub-classification helpers ────────────────────────────────

const LEAF_KINDS = new Set(['parameter', 'property', 'constant']);

const FFI_EXTENSIONS = new Set(['.rs', '.c', '.cpp', '.h', '.go', '.java', '.cs']);

/** Path patterns indicating framework-dispatched entry points. */
const ENTRY_PATH_PATTERNS: readonly RegExp[] = [
  /cli[/\\]commands[/\\]/,
  /mcp[/\\]/,
  /routes?[/\\]/,
  /handlers?[/\\]/,
  /middleware[/\\]/,
];

export interface ClassifiableNode {
  kind?: string;
  file?: string;
}

/**
 * Refine a "dead" classification into a sub-category.
 */
function classifyDeadSubRole(node: ClassifiableNode): DeadSubRole {
  // Leaf kinds are dead by definition — they can't have callers
  if (node.kind && LEAF_KINDS.has(node.kind)) return 'dead-leaf';

  if (node.file) {
    // Cross-language FFI: compiled-language files in a JS/TS project
    // Priority: dead-ffi is checked before dead-entry deliberately — an FFI
    // boundary is a more fundamental classification than a path-based hint.
    // A .so/.dll in a routes/ directory is still FFI, not an entry point.
    const dotIdx = node.file.lastIndexOf('.');
    if (dotIdx !== -1 && FFI_EXTENSIONS.has(node.file.slice(dotIdx))) return 'dead-ffi';

    // Framework-dispatched entry points (CLI commands, MCP tools, routes)
    if (ENTRY_PATH_PATTERNS.some((p) => p.test(node.file!))) return 'dead-entry';
  }

  return 'dead-unresolved';
}

// ── Helpers ────────────────────────────────────────────────────────

export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface RoleClassificationNode {
  id: string;
  name: string;
  kind?: string;
  file?: string;
  fanIn: number;
  fanOut: number;
  isExported: boolean;
  testOnlyFanIn?: number;
  productionFanIn?: number;
  /** True when the same file contains at least one non-constant callable connected to the graph (fanIn > 0 or fanOut > 0). */
  hasActiveFileSiblings?: boolean;
}

/**
 * Compute median fan-in and fan-out across nodes with non-zero values.
 * Used as thresholds for "high" fan-in/out classification.
 */
function computeFanMedians(nodes: RoleClassificationNode[]): { fanIn: number; fanOut: number } {
  const nonZeroFanIn = nodes
    .filter((n) => n.fanIn > 0)
    .map((n) => n.fanIn)
    .sort((a, b) => a - b);
  const nonZeroFanOut = nodes
    .filter((n) => n.fanOut > 0)
    .map((n) => n.fanOut)
    .sort((a, b) => a - b);
  return { fanIn: median(nonZeroFanIn), fanOut: median(nonZeroFanOut) };
}

/**
 * Classify a node with `fanIn === 0` that is not exported.
 * Covers framework-active constants, test-only callables, and the dead-* family.
 */
function classifyUnreferencedNode(node: RoleClassificationNode): Role {
  if (node.kind === 'constant' && node.hasActiveFileSiblings) {
    // Constants consumed via identifier reference (not calls) have no
    // inbound call edges. If the same file has active callables, the
    // constant is almost certainly used locally — classify as leaf.
    return 'leaf';
  }
  if (node.testOnlyFanIn != null && node.testOnlyFanIn > 0) return 'test-only';
  return classifyDeadSubRole(node);
}

/**
 * Pick a role from fan-in/fan-out shape: core/utility/adapter/leaf.
 * Called after entry/test-only/dead cases have been ruled out.
 */
function classifyByFanShape(highIn: boolean, highOut: boolean): Role {
  if (highIn && !highOut) return 'core';
  if (highIn && highOut) return 'utility';
  if (!highIn && highOut) return 'adapter';
  return 'leaf';
}

/**
 * Apply role-classification rules to a single node.
 * Order matters — framework entries are tagged first, then dead/test cases,
 * then the fan-in/fan-out shape decides among the structural roles.
 */
function classifyNodeRole(node: RoleClassificationNode, medFanIn: number, medFanOut: number): Role {
  if (FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p))) return 'entry';

  if (node.fanIn === 0) {
    return node.isExported ? 'entry' : classifyUnreferencedNode(node);
  }

  const hasProdFanIn = typeof node.productionFanIn === 'number';
  if (hasProdFanIn && node.productionFanIn === 0 && !node.isExported) return 'test-only';

  const highIn = node.fanIn >= medFanIn;
  const highOut = node.fanOut >= medFanOut && node.fanOut > 0;
  return classifyByFanShape(highIn, highOut);
}

/**
 * Classify nodes into architectural roles based on fan-in/fan-out metrics.
 */
export function classifyRoles(
  nodes: RoleClassificationNode[],
  medianOverrides?: { fanIn: number; fanOut: number },
): Map<string, Role> {
  if (nodes.length === 0) return new Map();

  const { fanIn: medFanIn, fanOut: medFanOut } = medianOverrides ?? computeFanMedians(nodes);

  const result = new Map<string, Role>();
  for (const node of nodes) {
    result.set(node.id, classifyNodeRole(node, medFanIn, medFanOut));
  }
  return result;
}
