/// Maximum recursion depth for AST traversal to prevent stack overflow
/// on deeply nested trees. Used by extractors, complexity, CFG, and dataflow.
pub const MAX_WALK_DEPTH: usize = 200;

// ─── Leiden community detection ─────────────────────────────────────
//
// Mirrors the TS reference implementation's defaults exactly (both must
// produce identical output — see leiden.rs's module doc for why):
//   - DEFAULT_MAX_LEVELS/DEFAULT_MAX_LOCAL_PASSES/GAIN_EPSILON:
//     src/graph/algorithms/leiden/optimiser.ts
//   - DEFAULT_REFINEMENT_THETA/DEFAULT_RESOLUTION:
//     optimiser.ts's normalizeOptions() and src/infrastructure/config.ts's
//     DEFAULTS.community
//   - DEFAULT_CAPACITY_GROWTH_FACTOR: src/graph/algorithms/leiden/partition.ts

/// Maximum number of coarsening levels.
pub const LEIDEN_DEFAULT_MAX_LEVELS: usize = 50;

/// Maximum number of local-move passes per level before stopping.
pub const LEIDEN_DEFAULT_MAX_LOCAL_PASSES: usize = 20;

/// Minimum quality gain to accept a node move (avoids floating-point noise).
pub const LEIDEN_GAIN_EPSILON: f64 = 1e-12;

/// Default Boltzmann temperature for the refinement phase's probabilistic
/// candidate selection (Algorithm 3, Traag et al. 2019).
pub const LEIDEN_DEFAULT_REFINEMENT_THETA: f64 = 1.0;

/// Default resolution (gamma) parameter for modularity optimization.
pub const LEIDEN_DEFAULT_RESOLUTION: f64 = 1.0;

/// Growth multiplier applied when a partition's per-community arrays need to
/// grow beyond their initial capacity (post-refinement disconnected-community
/// splitting can mint more community ids than the initial allocation).
pub const LEIDEN_DEFAULT_CAPACITY_GROWTH_FACTOR: f64 = 1.5;

/// Default random seed for deterministic community detection.
pub const DEFAULT_RANDOM_SEED: u32 = 42;

// ─── Dataflow analysis ──────────────────────────────────────────────

/// Maximum character length for truncated dataflow expressions.
pub const DATAFLOW_TRUNCATION_LIMIT: usize = 120;

// ─── Build pipeline ─────────────────────────────────────────────────

/// Maximum number of changed files eligible for the incremental fast path.
pub const FAST_PATH_MAX_CHANGED_FILES: usize = 5;

/// Minimum existing file count required before the fast path is considered.
/// Typed as `i64` to match `get_existing_file_count()` return type (SQLite row count).
pub const FAST_PATH_MIN_EXISTING_FILES: i64 = 20;
