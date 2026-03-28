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
    pub line: i32,
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
    pub line: i32,
    pub end_line: Option<i32>,
}

/// Adjacent edge row — mirrors `AdjacentEdgeRow`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeAdjacentEdgeRow {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: i32,
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
