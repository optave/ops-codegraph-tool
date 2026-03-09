// ── Symbol kind constants ───────────────────────────────────────────
// Original 10 kinds — used as default query scope
export const CORE_SYMBOL_KINDS = [
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
];

// Sub-declaration kinds (Phase 1)
export const EXTENDED_SYMBOL_KINDS = [
  'parameter',
  'property',
  'constant',
  // Phase 2 (reserved, not yet extracted):
  // 'constructor', 'namespace', 'decorator', 'getter', 'setter',
];

// Full set for --kind validation and MCP enum
export const EVERY_SYMBOL_KIND = [...CORE_SYMBOL_KINDS, ...EXTENDED_SYMBOL_KINDS];

// Backward compat: ALL_SYMBOL_KINDS stays as the core 10
export const ALL_SYMBOL_KINDS = CORE_SYMBOL_KINDS;

// ── Edge kind constants ─────────────────────────────────────────────
// Core edge kinds — coupling and dependency relationships
export const CORE_EDGE_KINDS = [
  'imports',
  'imports-type',
  'reexports',
  'calls',
  'extends',
  'implements',
  'contains',
];

// Structural edge kinds — parent/child and type relationships
export const STRUCTURAL_EDGE_KINDS = ['parameter_of', 'receiver'];

// Full set for MCP enum and validation
export const EVERY_EDGE_KIND = [...CORE_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS];

export const VALID_ROLES = ['entry', 'core', 'utility', 'adapter', 'dead', 'leaf'];
