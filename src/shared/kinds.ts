import path from 'node:path';
import { TYPESCRIPT_EXTENSIONS } from '../domain/parser.js';
import type {
  CoreEdgeKind,
  CoreSymbolKind,
  DeadSubRole,
  DynamicKind,
  EdgeKind,
  ExtendedSymbolKind,
  Role,
  StructuralEdgeKind,
  SymbolKind,
} from '../types.js';

// ── Symbol kind constants ───────────────────────────────────────────
// Original 10 kinds — used as default query scope
export const CORE_SYMBOL_KINDS: readonly CoreSymbolKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'struct',
  'enum',
  'trait',
  'record',
  'module',
] as const;

// Sub-declaration kinds (Phase 1)
export const EXTENDED_SYMBOL_KINDS: readonly ExtendedSymbolKind[] = [
  'parameter',
  'property',
  'constant',
  // Phase 2 (reserved, not yet extracted):
  // 'constructor', 'namespace', 'decorator', 'getter', 'setter',
] as const;

// Full set for --kind validation and MCP enum
export const EVERY_SYMBOL_KIND: readonly SymbolKind[] = [
  ...CORE_SYMBOL_KINDS,
  ...EXTENDED_SYMBOL_KINDS,
];

/**
 * Symbol kinds that represent an actual invocable definition. A call site can
 * legitimately target one of these — a class, interface, struct, or plain
 * variable/constant binding cannot, in the general case, and must never win a
 * same-name lookup that has no other type/receiver information to narrow it.
 *
 * Guards the "no other signal" tiers of call resolution — the same-file
 * bare-name lookup in `resolveCallTargets` and `resolveByGlobal`'s exact
 * global-name match (`call-resolver.ts`, `resolver/strategy.ts`) — so an
 * unrelated same-named class/interface/variable never masquerades as a real
 * callable target purely because those lookups otherwise carry no kind filter
 * (#1888).
 */
export const CALLABLE_SYMBOL_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

// Backward compat: ALL_SYMBOL_KINDS stays as the core 10
export const ALL_SYMBOL_KINDS: readonly CoreSymbolKind[] = CORE_SYMBOL_KINDS;

// ── Edge kind constants ─────────────────────────────────────────────
// Core edge kinds — coupling and dependency relationships
export const CORE_EDGE_KINDS: readonly CoreEdgeKind[] = [
  'imports',
  'imports-type',
  'dynamic-imports',
  'reexports',
  'calls',
  'extends',
  'implements',
  'contains',
] as const;

// Structural edge kinds — parent/child and type relationships
export const STRUCTURAL_EDGE_KINDS: readonly StructuralEdgeKind[] = [
  'parameter_of',
  'receiver',
] as const;

// Full set for MCP enum and validation
export const EVERY_EDGE_KIND: readonly EdgeKind[] = [...CORE_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS];

// Dead sub-categories — refine the coarse "dead" bucket
export const DEAD_ROLE_PREFIX = 'dead';
export const DEAD_SUB_ROLES: readonly DeadSubRole[] = [
  'dead-leaf',
  'dead-entry',
  'dead-ffi',
  'dead-unresolved',
] as const;

export const VALID_ROLES: readonly Role[] = [
  'entry',
  'core',
  'utility',
  'adapter',
  'dead',
  'test-only',
  'leaf',
  ...DEAD_SUB_ROLES,
];

// ── Dynamic call classification ──────────────────────────────────────
// Dynamic kinds that cannot be resolved statically — a call site tagged with
// one of these, and left with no resolved target, gets a confidence=0.0 sink
// edge to its file node instead of being silently dropped. Shared by the
// WASM/JS full-build path (`buildFileCallEdges`, stages/build-edges.ts) and
// the incremental single-file rebuild path (`buildCallEdges`,
// builder/incremental.ts) — both must emit the same sink edges (#1852).
export const FLAG_ONLY_DYNAMIC_KINDS: ReadonlySet<DynamicKind> = new Set([
  'eval',
  'computed-key',
  'reflection',
  'unresolved-dynamic',
]);

// ── TypeScript type-erasure classification ──────────────────────────
// Symbol kinds that are compile-time-only in TypeScript — interfaces and
// type aliases are erased before runtime, so a symbol of one of these kinds
// can never receive a `calls` edge. Importing one — with or without the
// `type` keyword — is the only consumption signal `codegraph exports` can
// observe for these kinds (#1833).
export const TYPE_ERASED_SYMBOL_KINDS: ReadonlySet<string> = new Set(['interface', 'type']);

/**
 * True when a named import specifier resolving to `kind` in `file` can only
 * ever be consumed as a type — i.e. it's a TypeScript interface/type-alias
 * declaration, which no `calls` edge could ever target regardless of the
 * `type` keyword on the importing statement.
 *
 * Scoped to `.ts`/`.tsx` files because other languages reuse the 'interface'/
 * 'type' node kinds for constructs that *are* runtime-observable (e.g. a Go
 * `type` alias, a Java `interface` implemented and dispatched through at
 * runtime) — crediting those on mere import would mask genuinely dead code
 * instead of fixing a false positive.
 */
export function isTypeErasedImportTarget(kind: string, file: string): boolean {
  return TYPE_ERASED_SYMBOL_KINDS.has(kind) && TYPESCRIPT_EXTENSIONS.has(path.extname(file));
}
