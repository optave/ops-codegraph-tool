import type {
  CoreEdgeKind,
  CoreSymbolKind,
  DeadSubRole,
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
