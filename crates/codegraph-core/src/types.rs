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
pub struct CfgBlock {
    pub index: u32,
    #[napi(js_name = "type")]
    pub block_type: String,
    #[napi(js_name = "startLine")]
    pub start_line: Option<u32>,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub label: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfgEdge {
    #[napi(js_name = "sourceIndex")]
    pub source_index: u32,
    #[napi(js_name = "targetIndex")]
    pub target_index: u32,
    pub kind: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CfgData {
    pub blocks: Vec<CfgBlock>,
    pub edges: Vec<CfgEdge>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Definition {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    #[napi(ts_type = "string[] | undefined")]
    pub decorators: Option<Vec<String>>,
    pub complexity: Option<ComplexityMetrics>,
    pub cfg: Option<CfgData>,
    #[napi(ts_type = "Definition[] | undefined")]
    pub children: Option<Vec<Definition>>,
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
    #[napi(js_name = "typeOnly")]
    pub type_only: Option<bool>,
    pub reexport: Option<bool>,
    #[napi(js_name = "wildcardReexport")]
    pub wildcard_reexport: Option<bool>,
    // Language-specific flags
    #[napi(js_name = "pythonImport")]
    pub python_import: Option<bool>,
    #[napi(js_name = "goImport")]
    pub go_import: Option<bool>,
    #[napi(js_name = "rustUse")]
    pub rust_use: Option<bool>,
    #[napi(js_name = "javaImport")]
    pub java_import: Option<bool>,
    #[napi(js_name = "csharpUsing")]
    pub csharp_using: Option<bool>,
    #[napi(js_name = "rubyRequire")]
    pub ruby_require: Option<bool>,
    #[napi(js_name = "phpUse")]
    pub php_use: Option<bool>,
    #[napi(js_name = "dynamicImport")]
    pub dynamic_import: Option<bool>,
    #[napi(js_name = "cInclude")]
    pub c_include: Option<bool>,
    #[napi(js_name = "kotlinImport")]
    pub kotlin_import: Option<bool>,
    #[napi(js_name = "swiftImport")]
    pub swift_import: Option<bool>,
    #[napi(js_name = "scalaImport")]
    pub scala_import: Option<bool>,
    #[napi(js_name = "bashSource")]
    pub bash_source: Option<bool>,
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
            dynamic_import: None,
            c_include: None,
            kotlin_import: None,
            swift_import: None,
            scala_import: None,
            bash_source: None,
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
pub struct AstNode {
    pub kind: String,
    pub name: String,
    pub line: u32,
    pub text: Option<String>,
    pub receiver: Option<String>,
}

// ─── Dataflow Types ──────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowParam {
    #[napi(js_name = "funcName")]
    pub func_name: String,
    #[napi(js_name = "paramName")]
    pub param_name: String,
    #[napi(js_name = "paramIndex")]
    pub param_index: u32,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowReturn {
    #[napi(js_name = "funcName")]
    pub func_name: String,
    pub expression: String,
    #[napi(js_name = "referencedNames")]
    pub referenced_names: Vec<String>,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowAssignment {
    #[napi(js_name = "varName")]
    pub var_name: String,
    #[napi(js_name = "callerFunc")]
    pub caller_func: Option<String>,
    #[napi(js_name = "sourceCallName")]
    pub source_call_name: String,
    pub expression: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowArgFlow {
    #[napi(js_name = "callerFunc")]
    pub caller_func: Option<String>,
    #[napi(js_name = "calleeName")]
    pub callee_name: String,
    #[napi(js_name = "argIndex")]
    pub arg_index: u32,
    #[napi(js_name = "argName")]
    pub arg_name: Option<String>,
    #[napi(js_name = "bindingType")]
    pub binding_type: Option<String>,
    pub confidence: f64,
    pub expression: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowMutation {
    #[napi(js_name = "funcName")]
    pub func_name: Option<String>,
    #[napi(js_name = "receiverName")]
    pub receiver_name: String,
    #[napi(js_name = "bindingType")]
    pub binding_type: Option<String>,
    #[napi(js_name = "mutatingExpr")]
    pub mutating_expr: String,
    pub line: u32,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataflowResult {
    pub parameters: Vec<DataflowParam>,
    pub returns: Vec<DataflowReturn>,
    pub assignments: Vec<DataflowAssignment>,
    #[napi(js_name = "argFlows")]
    pub arg_flows: Vec<DataflowArgFlow>,
    pub mutations: Vec<DataflowMutation>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeMapEntry {
    pub name: String,
    #[napi(js_name = "typeName")]
    pub type_name: String,
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
    #[napi(js_name = "astNodes")]
    pub ast_nodes: Vec<AstNode>,
    pub dataflow: Option<DataflowResult>,
    #[napi(js_name = "lineCount")]
    pub line_count: Option<u32>,
    #[napi(js_name = "typeMap")]
    pub type_map: Vec<TypeMapEntry>,
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
            ast_nodes: Vec::new(),
            dataflow: None,
            line_count: None,
            type_map: Vec::new(),
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
