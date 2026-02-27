use napi_derive::napi;
use serde::{Deserialize, Serialize};

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComplexityMetrics {
    pub cognitive: u32,
    pub cyclomatic: u32,
    #[napi(js_name = "maxNesting")]
    pub max_nesting: u32,
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
