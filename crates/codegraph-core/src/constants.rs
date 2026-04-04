/// Maximum recursion depth for AST traversal to prevent stack overflow
/// on deeply nested trees. Used by extractors, complexity, CFG, and dataflow.
pub const MAX_WALK_DEPTH: usize = 200;

// ─── Louvain community detection ────────────────────────────────────

/// Maximum number of coarsening levels in the Louvain algorithm.
pub const LOUVAIN_MAX_LEVELS: usize = 50;

/// Maximum number of local-move passes per level before stopping.
pub const LOUVAIN_MAX_PASSES: usize = 20;

/// Minimum modularity gain to accept a node move (avoids floating-point noise).
pub const LOUVAIN_MIN_GAIN: f64 = 1e-12;

/// Default random seed for deterministic community detection.
pub const DEFAULT_RANDOM_SEED: u32 = 42;

// ─── Dataflow analysis ──────────────────────────────────────────────

/// Maximum character length for truncated dataflow expressions.
pub const DATAFLOW_TRUNCATION_LIMIT: usize = 120;

// ─── Build pipeline ─────────────────────────────────────────────────

/// Maximum number of changed files eligible for the incremental fast path.
pub const FAST_PATH_MAX_CHANGED_FILES: usize = 5;

/// Minimum existing file count required before the fast path is considered.
pub const FAST_PATH_MIN_EXISTING_FILES: usize = 20;
