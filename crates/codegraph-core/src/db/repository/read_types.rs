//! Return-type structs for NativeDatabase read queries.
//!
//! Each struct maps to a TypeScript row type used by the Repository interface.
//! All structs derive `#[napi(object)]` for automatic JS serialization.

use napi_derive::napi;

/// Full node row — mirrors `NodeRow` in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeNodeRow {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
    pub parent_id: Option<i32>,
    pub exported: Option<i32>,
    pub qualified_name: Option<String>,
    pub scope: Option<String>,
    pub visibility: Option<String>,
    pub role: Option<String>,
}

/// Node row with fan-in count — mirrors `NodeRowWithFanIn`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeNodeRowWithFanIn {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
    pub parent_id: Option<i32>,
    pub exported: Option<i32>,
    pub qualified_name: Option<String>,
    pub scope: Option<String>,
    pub visibility: Option<String>,
    pub role: Option<String>,
    pub fan_in: i32,
}

/// Triage node row — mirrors `TriageNodeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeTriageNodeRow {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
    pub parent_id: Option<i32>,
    pub exported: Option<i32>,
    pub qualified_name: Option<String>,
    pub scope: Option<String>,
    pub visibility: Option<String>,
    pub role: Option<String>,
    pub fan_in: i32,
    pub cognitive: i32,
    pub mi: f64,
    pub cyclomatic: i32,
    pub max_nesting: i32,
    pub churn: i32,
}

/// Minimal node ID row — mirrors `NodeIdRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeNodeIdRow {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub line: Option<i32>,
}

/// Child node row — mirrors `ChildNodeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeChildNodeRow {
    pub name: String,
    pub kind: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
    pub qualified_name: Option<String>,
    pub scope: Option<String>,
    pub visibility: Option<String>,
}

/// Related node row (callers/callees) — mirrors `RelatedNodeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeRelatedNodeRow {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
}

/// Adjacent edge row — mirrors `AdjacentEdgeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeAdjacentEdgeRow {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub edge_kind: String,
}

/// Import edge row — mirrors `ImportEdgeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeImportEdgeRow {
    pub file: String,
    pub edge_kind: String,
}

/// Intra-file call edge — mirrors `IntraFileCallEdge`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeIntraFileCallEdge {
    pub caller_name: String,
    pub callee_name: String,
}

/// Callable node row (for graph construction) — mirrors `CallableNodeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeCallableNodeRow {
    pub id: i32,
    pub name: String,
    pub kind: String,
    pub file: String,
}

/// Call edge row — mirrors `CallEdgeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeCallEdgeRow {
    pub source_id: i32,
    pub target_id: i32,
    pub confidence: Option<f64>,
}

/// File node row — mirrors `FileNodeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeFileNodeRow {
    pub id: i32,
    pub name: String,
    pub file: String,
}

/// Import graph edge row — mirrors `ImportGraphEdgeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeImportGraphEdgeRow {
    pub source_id: i32,
    pub target_id: i32,
}

/// Complexity metrics — mirrors `ComplexityMetrics` from Repository.
/// Named differently from the extractor-level ComplexityMetrics in types.rs.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeComplexityMetrics {
    pub cognitive: i32,
    pub cyclomatic: i32,
    pub max_nesting: i32,
    pub maintainability_index: Option<f64>,
    pub halstead_volume: Option<f64>,
}

// ── Batched query return types ─────────────────────────────────────────

/// Kind + count pair for GROUP BY queries.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct KindCount {
    pub kind: String,
    pub count: i32,
}

/// Role + count pair for role distribution queries.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct RoleCount {
    pub role: String,
    pub count: i32,
}

/// File hotspot entry with fan-in/fan-out.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FileHotspot {
    pub file: String,
    pub fan_in: i32,
    pub fan_out: i32,
}

/// Complexity summary statistics.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ComplexitySummary {
    pub analyzed: i32,
    pub avg_cognitive: f64,
    pub avg_cyclomatic: f64,
    pub max_cognitive: i32,
    pub max_cyclomatic: i32,
    pub avg_mi: f64,
    pub min_mi: f64,
}

/// Embedding metadata.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct EmbeddingInfo {
    pub count: i32,
    pub model: Option<String>,
    pub dim: Option<i32>,
    pub built_at: Option<String>,
}

/// Quality metrics for graph stats.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct QualityMetrics {
    pub callable_total: i32,
    pub callable_with_callers: i32,
    pub call_edges: i32,
    pub high_conf_call_edges: i32,
}

/// Combined graph statistics — replaces ~11 separate queries in module-map.ts.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct GraphStats {
    pub total_nodes: i32,
    pub total_edges: i32,
    pub nodes_by_kind: Vec<KindCount>,
    pub edges_by_kind: Vec<KindCount>,
    pub role_counts: Vec<RoleCount>,
    pub quality: QualityMetrics,
    pub hotspots: Vec<FileHotspot>,
    pub complexity: Option<ComplexitySummary>,
    pub embeddings: Option<EmbeddingInfo>,
}

/// Dataflow edge with joined node info.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DataflowQueryEdge {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub param_index: Option<i32>,
    pub expression: Option<String>,
    pub confidence: Option<f64>,
}

/// All 6 directional dataflow edge sets for a node.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DataflowEdgesResult {
    pub flows_to_out: Vec<DataflowQueryEdge>,
    pub flows_to_in: Vec<DataflowQueryEdge>,
    pub returns_out: Vec<DataflowQueryEdge>,
    pub returns_in: Vec<DataflowQueryEdge>,
    pub mutates_out: Vec<DataflowQueryEdge>,
    pub mutates_in: Vec<DataflowQueryEdge>,
}

/// Hotspot row from node_metrics join.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeHotspotRow {
    pub name: String,
    pub kind: String,
    pub line_count: Option<i32>,
    pub symbol_count: Option<i32>,
    pub import_count: Option<i32>,
    pub export_count: Option<i32>,
    pub fan_in: Option<i32>,
    pub fan_out: Option<i32>,
    pub cohesion: Option<f64>,
    pub file_count: Option<i32>,
}

/// Fan-in/fan-out metrics for a single node.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FanMetric {
    pub node_id: i32,
    pub fan_in: i32,
    pub fan_out: i32,
}

// ── Composite query return types (fnDeps) ─────────────────────────────

/// A single caller/callee node in fnDeps results.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FnDepsNode {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
}

/// A caller node with optional hierarchy resolution info.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FnDepsCallerNode {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub via_hierarchy: Option<String>,
}

/// A group of transitive callers at a specific BFS depth.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FnDepsTransitiveGroup {
    pub depth: i32,
    pub callers: Vec<FnDepsNode>,
}

/// A single symbol's dependency entry in the fnDeps result.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FnDepsEntry {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: Option<i32>,
    pub end_line: Option<i32>,
    pub role: Option<String>,
    pub file_hash: Option<String>,
    pub callees: Vec<FnDepsNode>,
    pub callers: Vec<FnDepsCallerNode>,
    pub transitive_callers: Vec<FnDepsTransitiveGroup>,
}

/// Complete fnDeps result returned from a single native call.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FnDepsResult {
    pub name: String,
    pub results: Vec<FnDepsEntry>,
}
