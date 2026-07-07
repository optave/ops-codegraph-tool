/**
 * Node role classification — pure logic, no DB.
 *
 * Roles: entry, core, utility, adapter, leaf, dead-*, test-only
 *
 * Dead sub-categories refine the coarse "dead" bucket:
 *   dead-leaf       — constants (leaf nodes by definition; parameters and
 *                     genuine class/struct properties are excluded from
 *                     classification entirely rather than landing here — see below)
 *   dead-entry      — framework dispatch: CLI commands, MCP tools, event handlers
 *   dead-ffi        — cross-language FFI boundaries (e.g. Rust napi-rs bindings)
 *   dead-unresolved — genuinely unreferenced callables (the real dead code)
 *
 * `parameter`-kind nodes never reach this module in production — callers
 * (`features/structure.ts`, native `graph/classifiers/roles.rs`) exclude them
 * entirely, leaving `role` unset, the same treatment as `file`/`directory`
 * nodes. A parameter's liveness is a local dataflow question (is it referenced
 * within its own function body), not a call-graph reachability question, so
 * "no incoming call edges" carries zero dead-code signal for it (#1723).
 *
 * `property`-kind nodes that are genuine (non-interface) class/struct/object
 * fields also never reach this module in production, for the same reason and
 * with the same treatment (role left unset) — a field's liveness is a question
 * of whether it's read/written anywhere in its owning class, which codegraph
 * has no property-access/write edge tracking to answer (#1810).
 *
 * `method`/`property`-kind members of an interface/type declaration (e.g.
 * `interface Foo { bar: string }`) DO reach this module, but are recognized by
 * `isTypeDeclarationMember` and classified `leaf` unconditionally — they can
 * never gain inbound call edges by construction, so call-graph reachability
 * doesn't apply to them either (#1723).
 *
 * `entry` requires `kind IN ('function', 'method')` (plus the framework-prefix/
 * Commander-dispatch shortcuts, which are already kind-appropriate by
 * construction). An exported interface/type/constant/class with zero fan-in is
 * a data-shape declaration or config value — never invoked from outside the
 * codebase — so it can't be a real entry point; it's classified `leaf` instead
 * of inheriting `entry` merely from being exported (#1780).
 */

import type { DeadSubRole, Role } from '../../types.js';

export const FRAMEWORK_ENTRY_PREFIXES: readonly string[] = ['route:', 'event:', 'command:'];

// ── Dead sub-classification helpers ────────────────────────────────

const LEAF_KINDS = new Set(['parameter', 'property', 'constant']);

/**
 * Type definition kinds that are consumed via type annotations rather than calls.
 * These have no inbound call edges by design — they are "used" by type references,
 * struct literals, and generic parameters, none of which produce call edges.
 * If the same file has active callables, type definitions are almost certainly live.
 */
const TYPE_DEF_KINDS = new Set(['struct', 'enum', 'trait', 'type', 'interface', 'record']);

const FFI_EXTENSIONS = new Set(['.rs', '.c', '.cpp', '.h', '.go', '.java', '.cs']);

/** Path patterns indicating framework-dispatched entry points. */
const ENTRY_PATH_PATTERNS: readonly RegExp[] = [
  /cli[/\\]commands[/\\]/,
  /mcp[/\\]/,
  /routes?[/\\]/,
  /handlers?[/\\]/,
  /middleware[/\\]/,
];

/**
 * Well-known Commander.js dispatch method names.
 * When a method with one of these names lives in a file that matches
 * ENTRY_PATH_PATTERNS, it is the actual framework entry point — not merely a
 * candidate — so it must be classified as `entry` rather than `dead-entry`.
 *
 * `execute` — the action callback invoked by Commander on `program.action()`.
 * `validate` — a pre-execution argument/option validator called before `execute`.
 */
const COMMANDER_DISPATCH_NAMES = new Set(['execute', 'validate']);

export interface ClassifiableNode {
  kind?: string;
  file?: string;
}

/**
 * Minimal node shape needed to determine interface/type ownership by name —
 * a structural subset of `RoleClassificationNode` so callers holding only
 * `{ id, name, file }` rows (e.g. a raw `kind = 'property'` DB query, #1809)
 * can reuse `computeTypeDefNamesByFile`/`isTypeDeclarationMember` without
 * constructing a full classifier-input object.
 */
export interface NamedClassifiableNode {
  name: string;
  kind?: string;
  file?: string;
}

/**
 * Compute, per file, the set of symbol names that are `TYPE_DEF_KINDS`-kind
 * declarations (interface/type/struct/enum/trait/record). Used by
 * `isTypeDeclarationMember` to recognize `Owner.member`-qualified nodes whose
 * owner is a type-level declaration rather than a class.
 */
export function computeTypeDefNamesByFile(
  nodes: readonly NamedClassifiableNode[],
): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const n of nodes) {
    if (n.file && n.kind && TYPE_DEF_KINDS.has(n.kind)) {
      let names = byFile.get(n.file);
      if (!names) {
        names = new Set();
        byFile.set(n.file, names);
      }
      names.add(n.name);
    }
  }
  return byFile;
}

/**
 * True when `node` is a `method`/`property`-kind member of an interface/type
 * declared in the same file — e.g. TS `interface Foo { bar: string }` extracts
 * `bar` as a top-level `method`-kind definition named `Foo.bar` (#1723). Every
 * language extractor qualifies interface/type members as `Owner.member`
 * (mirroring class method qualification), so the owner name is recovered from
 * the prefix before the first `.` and looked up against same-file
 * `TYPE_DEF_KINDS` declarations. Class methods use the identical `Owner.member`
 * convention but are unaffected here because `class` is not in `TYPE_DEF_KINDS`
 * — they remain subject to normal dead-code detection.
 *
 * These members can never gain inbound call edges by construction — they are
 * consumed via type annotations and structural typing, never calls — so a
 * `fanIn === 0` reading carries zero dead-code signal for them, unlike a real
 * function/method where it does. Call-edge-based reachability just doesn't
 * apply to type-level declarations, so they must never be judged dead by it.
 */
export function isTypeDeclarationMember(
  node: NamedClassifiableNode,
  typeDefNamesByFile: Map<string, Set<string>>,
): boolean {
  if (node.kind !== 'method' && node.kind !== 'property') return false;
  if (!node.file) return false;
  const dotIdx = node.name.indexOf('.');
  if (dotIdx === -1) return false;
  const ownerName = node.name.slice(0, dotIdx);
  return typeDefNamesByFile.get(node.file)?.has(ownerName) ?? false;
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
  /**
   * True when the same file contains at least one callable connected to the graph
   * (fanIn > 0 or fanOut > 0) that is not itself an annotation-only kind.
   * Annotation-only kinds are `constant` and all members of `TYPE_DEF_KINDS`
   * (struct, enum, trait, type, interface, record) — these are excluded because
   * they are consumed via references/type-annotations rather than call edges and
   * would otherwise produce a circular dependency in the active-file heuristic.
   * Populated only for `constant` and `TYPE_DEF_KINDS` nodes; `undefined` for
   * regular callables (functions, methods, classes, etc.) which don't need it.
   */
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
  if (node.hasActiveFileSiblings) {
    if (node.kind === 'constant') {
      // Constants consumed via identifier reference (not calls) have no
      // inbound call edges. If the same file has active callables, the
      // constant is almost certainly used locally — classify as leaf.
      return 'leaf';
    }
    if (node.kind && TYPE_DEF_KINDS.has(node.kind)) {
      // Type definitions (struct, enum, trait, type, interface, record) are
      // consumed via type annotations and struct literals — not calls — so they
      // never get inbound call edges. If the same file has active callables,
      // these types are almost certainly live — classify as leaf.
      return 'leaf';
    }
    if (node.kind === 'method' && node.fanOut > 0) {
      // Methods implementing interfaces are dispatched via conditional property
      // access e.g. `if (v.enterFunction) v.enterFunction(...)`. Codegraph
      // resolves the call to the property accessor rather than to the concrete
      // method implementation, so the method has no inbound call edge. We
      // require `fanOut > 0` as evidence of non-triviality, mirroring the
      // function case — trivially-inert dead helper methods remain visible.
      return 'leaf';
    }
    if (node.kind === 'function' && node.fanOut > 0) {
      // Functions referenced as logical-or fallback defaults — e.g.
      // `const fn = options._fetchLatest || fetchLatestVersion` — appear as
      // value references, not call sites, so no call edge is produced. We
      // require `fanOut > 0` as evidence that the function is non-trivial
      // (i.e. it calls something), ruling out truly inert dead helpers.
      //
      // NOTE (#1771): this used to also be the only thing rescuing functions
      // referenced as object-literal property values (dispatch tables, e.g.
      // `{ resolve: someFunction }`) — and only by coincidence, for whichever
      // of those functions happened to have fanOut > 0 themselves. That
      // pattern now gets a real `calls` edge (dynamicKind 'value-ref') at
      // extraction time, so it no longer depends on this heuristic. Kept
      // here as a fallback for value-reference shapes that still produce no
      // edge at all — the logical-or default above, and others (ternary
      // defaults, array-of-functions elements, default parameter values)
      // that aren't extracted as edges yet.
      return 'leaf';
    }
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
 * Order matters — type-level members are ruled out first (they can never be
 * judged by call-graph reachability at all), then framework entries, then
 * dead/test cases, then the fan-in/fan-out shape decides among the structural
 * roles.
 */
function classifyNodeRole(
  node: RoleClassificationNode,
  medFanIn: number,
  medFanOut: number,
  typeDefNamesByFile: Map<string, Set<string>>,
): Role {
  // Interface/type members (#1723) — never subject to call-graph dead-code
  // detection, regardless of fan-in/fan-out/export status.
  if (isTypeDeclarationMember(node, typeDefNamesByFile)) return 'leaf';

  if (FRAMEWORK_ENTRY_PREFIXES.some((p) => node.name.startsWith(p))) return 'entry';

  if (node.fanIn === 0) {
    if (!node.isExported) {
      // Well-known Commander.js dispatch methods (execute, validate) in framework
      // directories are confirmed entry points, not candidates. Promote them to
      // `entry` directly so they don't appear in `--role dead` output.
      if (
        node.file &&
        COMMANDER_DISPATCH_NAMES.has(node.name) &&
        ENTRY_PATH_PATTERNS.some((p) => p.test(node.file!))
      ) {
        return 'entry';
      }
      return classifyUnreferencedNode(node);
    }
    // Exported, zero fan-in. A genuine entry point (CLI command handler, exported
    // API function called from outside the codebase, ESM loader hook, MCP tool
    // handler, etc.) is always a function or method. Every other exported kind
    // (interface/type/constant/class) is a live, intentional part of the public
    // surface — but a data shape or config value, not something invoked from
    // outside the codebase — so it's `leaf`: never `dead-*` (#1583) and never
    // `entry` (#1780), regardless of whether the file has other active siblings.
    return node.kind === 'function' || node.kind === 'method' ? 'entry' : 'leaf';
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
  const typeDefNamesByFile = computeTypeDefNamesByFile(nodes);

  const result = new Map<string, Role>();
  for (const node of nodes) {
    result.set(node.id, classifyNodeRole(node, medFanIn, medFanOut, typeDefNamesByFile));
  }
  return result;
}
