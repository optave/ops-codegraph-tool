use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HalsteadMetrics {
    pub n1: u32,
    pub n2: u32,
    #[napi(js_name = "bigN1")]
    pub big_n1: u32,
    #[napi(js_name = "bigN2")]
    pub big_n2: u32,
    pub vocabulary: u32,
    pub length: u32,
    pub volume: f64,
    pub difficulty: f64,
    pub effort: f64,
    pub bugs: f64,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocMetrics {
    pub loc: u32,
    pub sloc: u32,
    #[napi(js_name = "commentLines")]
    pub comment_lines: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplexityMetrics {
    pub cognitive: u32,
    pub cyclomatic: u32,
    #[napi(js_name = "maxNesting")]
    pub max_nesting: u32,
    pub halstead: Option<HalsteadMetrics>,
    pub loc: Option<LocMetrics>,
    #[napi(js_name = "maintainabilityIndex")]
    pub maintainability_index: Option<f64>,
}

impl ComplexityMetrics {
    /// Construct a basic metrics result with only cognitive/cyclomatic/maxNesting.
    /// Used by `compute_function_complexity` and existing tests.
    pub fn basic(cognitive: u32, cyclomatic: u32, max_nesting: u32) -> Self {
        Self {
            cognitive,
            cyclomatic,
            max_nesting,
            halstead: None,
            loc: None,
            maintainability_index: None,
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Definition {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub end_line: Option<u32>,
    #[napi(ts_type = "string[] | undefined")]
    pub decorators: Option<Vec<String>>,
    pub complexity: Option<ComplexityMetrics>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Call {
    pub name: String,
    pub line: u32,
    pub dynamic: Option<bool>,
    pub receiver: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Import {
    pub source: String,
    pub names: Vec<String>,
    pub line: u32,
    pub type_only: Option<bool>,
    pub reexport: Option<bool>,
    pub wildcard_reexport: Option<bool>,
    // Language-specific flags
    pub python_import: Option<bool>,
    pub go_import: Option<bool>,
    pub rust_use: Option<bool>,
    pub java_import: Option<bool>,
    pub csharp_using: Option<bool>,
    pub ruby_require: Option<bool>,
    pub php_use: Option<bool>,
}

impl Import {
    pub fn new(source: String, names: Vec<String>, line: u32) -> Self {
        Self {
            source,
            names,
            line,
            type_only: None,
            reexport: None,
            wildcard_reexport: None,
            python_import: None,
            go_import: None,
            rust_use: None,
            java_import: None,
            csharp_using: None,
            ruby_require: None,
            php_use: None,
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassRelation {
    pub name: String,
    pub extends: Option<String>,
    pub implements: Option<String>,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportInfo {
    pub name: String,
    pub kind: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSymbols {
    pub file: String,
    pub definitions: Vec<Definition>,
    pub calls: Vec<Call>,
    pub imports: Vec<Import>,
    pub classes: Vec<ClassRelation>,
    pub exports: Vec<ExportInfo>,
    pub line_count: Option<u32>,
}

impl FileSymbols {
    pub fn new(file: String) -> Self {
        Self {
            file,
            definitions: Vec::new(),
            calls: Vec::new(),
            imports: Vec::new(),
            classes: Vec::new(),
            exports: Vec::new(),
            line_count: None,
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathAliases {
    pub base_url: Option<String>,
    pub paths: Vec<AliasMapping>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasMapping {
    pub pattern: String,
    pub targets: Vec<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResolutionInput {
    pub from_file: String,
    pub import_source: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedImport {
    pub from_file: String,
    pub import_source: String,
    pub resolved_path: String,
}
