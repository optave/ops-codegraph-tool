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
    /// Set when the underlying AST node structurally has no executable body
    /// (an interface/protocol/trait method signature, an abstract method with
    /// no block, a Rust trait `function_signature_item`, etc). Mirrors the TS
    /// `Definition.bodyless` signal — see `hasFuncBody` in
    /// `src/ast-analysis/apply-results.ts` (issue #1922). A dotted name alone
    /// does not imply this: it's the normal qualified name for real bodied
    /// class/struct/impl/module methods across every extractor.
    pub bodyless: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Call {
    pub name: String,
    pub line: u32,
    pub dynamic: Option<bool>,
    pub receiver: Option<String>,
    #[napi(js_name = "dynamicKind")]
    pub dynamic_kind: Option<String>,
    #[napi(js_name = "keyExpr")]
    pub key_expr: Option<String>,
}

/// `import { X as Y }`: the local binding name (Y) paired with the original
/// name exported by the source module (X). Mirrors TS `Import.renamedImports`.
/// See `Import.renamed_imports` for why this is needed (#1730).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenamedImport {
    pub local: String,
    pub imported: String,
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
    /// For `import { X as Y }` specifiers: the local binding name (Y) mapped to
    /// the original name exported by the source module (X). `names` always
    /// carries the local (post-rename) binding — this field lets call-edge
    /// resolution recover the *original* symbol name to look up in the
    /// imported file when a call site uses the local alias (#1730). Only
    /// populated for specifiers that actually rename a binding. Mirrors TS
    /// `Import.renamedImports`.
    #[napi(js_name = "renamedImports")]
    pub renamed_imports: Option<Vec<RenamedImport>>,
    /// Local binding names (post-alias, matching entries in `names`) that
    /// carry an inline per-specifier `type`/`typeof` modifier
    /// (`import { type X }`), as distinct from a whole-statement
    /// `import type { X }` (already covered by `type_only`). Only populated
    /// for specifiers that actually use the modifier — mirrors
    /// `renamed_imports`'s sparse-population convention. Lets a mixed
    /// statement (`import { value, type Foo }`) still credit `Foo` with a
    /// symbol-level `imports-type` edge. Mirrors TS `Import.typeOnlyNames`
    /// (#1813).
    #[napi(js_name = "typeOnlyNames")]
    pub type_only_names: Option<Vec<String>>,
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
    /// Marks a CJS destructured require binding (`const { X } = require('./m')`).
    /// When true, this entry feeds imported_names for receiver-edge resolution
    /// but must NOT produce a DB import edge (mirrors WASM cjsRequireBindings, #1678).
    #[napi(js_name = "cjsRequire")]
    pub cjs_require: Option<bool>,
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
            renamed_imports: None,
            type_only_names: None,
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
            cjs_require: None,
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
    /// Confidence: 0.9 = type annotation, 1.0 = constructor, 0.7 = factory.
    /// Used to resolve conflicts when the same name appears multiple times.
    pub confidence: f64,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeCallAssignment {
    #[napi(js_name = "varName")]
    pub var_name: String,
    #[napi(js_name = "calleeName")]
    pub callee_name: String,
    #[napi(js_name = "receiverTypeName")]
    pub receiver_type_name: Option<String>,
}

/// Function-reference binding for Phase 8.3 points-to analysis.
/// Records `const alias = fn` and `const alias = obj.method` patterns.
/// Mirrors the `FnRefBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FnRefBinding {
    pub lhs: String,
    pub rhs: String,
    #[napi(js_name = "rhsReceiver")]
    pub rhs_receiver: Option<String>,
}

/// Argument-to-parameter binding at a call site (Phase 8.3c).
/// Records `f(x)` where `x` is an identifier that may carry a function reference.
/// Mirrors the `ParamBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamBinding {
    pub callee: String,
    #[napi(js_name = "argIndex")]
    pub arg_index: u32,
    #[napi(js_name = "argName")]
    pub arg_name: String,
}

/// This-context binding from `fn.call(ctx, ...)` / `fn.apply(ctx, ...)`.
/// Mirrors the `ThisCallBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThisCallBinding {
    pub callee: String,
    #[napi(js_name = "thisArg")]
    pub this_arg: String,
}

/// Array-element binding from `const arr = [fn1, fn2]` (Phase 8.3e).
/// Mirrors the `ArrayElemBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrayElemBinding {
    #[napi(js_name = "arrayName")]
    pub array_name: String,
    pub index: u32,
    #[napi(js_name = "elemName")]
    pub elem_name: String,
}

/// Spread-argument binding from `f(...arr)` (Phase 8.3e).
/// Mirrors the `SpreadArgBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpreadArgBinding {
    pub callee: String,
    #[napi(js_name = "arrayName")]
    pub array_name: String,
    #[napi(js_name = "startIndex")]
    pub start_index: u32,
}

/// For-of iteration binding from `for (const x of arr)` (Phase 8.3e).
/// Mirrors the `ForOfBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForOfBinding {
    #[napi(js_name = "varName")]
    pub var_name: String,
    #[napi(js_name = "sourceName")]
    pub source_name: String,
    #[napi(js_name = "enclosingFunc")]
    pub enclosing_func: String,
}

/// Array-callback binding from `Array.from(arr, cb)` (Phase 8.3e).
/// Mirrors the `ArrayCallbackBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrayCallbackBinding {
    #[napi(js_name = "sourceName")]
    pub source_name: String,
    #[napi(js_name = "calleeName")]
    pub callee_name: String,
}

/// Object-rest parameter binding from `function f({ a, ...rest })` (Phase 8.3f).
/// Mirrors the `ObjectRestParamBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectRestParamBinding {
    pub callee: String,
    #[napi(js_name = "restName")]
    pub rest_name: String,
    #[napi(js_name = "argIndex")]
    pub arg_index: u32,
}

/// Object-property binding from `const obj = { e4 }` / `{ e4: fn }` (Phase 8.3f).
/// Mirrors the `ObjectPropBinding` interface in `src/types.ts`.
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectPropBinding {
    #[napi(js_name = "objectName")]
    pub object_name: String,
    #[napi(js_name = "propName")]
    pub prop_name: String,
    #[napi(js_name = "valueName")]
    pub value_name: String,
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
    #[napi(js_name = "returnTypeMap")]
    pub return_type_map: Vec<TypeMapEntry>,
    #[napi(js_name = "callAssignments")]
    pub call_assignments: Vec<NativeCallAssignment>,
    /// Phase 8.3: function-reference bindings for points-to analysis.
    #[napi(js_name = "fnRefBindings")]
    pub fn_ref_bindings: Vec<FnRefBinding>,
    /// Phase 8.3c: argument-to-parameter bindings for parameter-flow pts.
    #[napi(js_name = "paramBindings")]
    pub param_bindings: Vec<ParamBinding>,
    /// This-context bindings from `fn.call(ctx)` / `fn.apply(ctx)`.
    #[napi(js_name = "thisCallBindings")]
    pub this_call_bindings: Vec<ThisCallBinding>,
    /// Phase 8.3e: array-element bindings from `const arr = [fn1, fn2]`.
    #[napi(js_name = "arrayElemBindings")]
    pub array_elem_bindings: Vec<ArrayElemBinding>,
    /// Phase 8.3e: spread-argument bindings from `f(...arr)`.
    #[napi(js_name = "spreadArgBindings")]
    pub spread_arg_bindings: Vec<SpreadArgBinding>,
    /// Phase 8.3e: for-of iteration variable bindings.
    #[napi(js_name = "forOfBindings")]
    pub for_of_bindings: Vec<ForOfBinding>,
    /// Phase 8.3e: array callback bindings from `Array.from(arr, cb)`.
    #[napi(js_name = "arrayCallbackBindings")]
    pub array_callback_bindings: Vec<ArrayCallbackBinding>,
    /// Phase 8.3f: object-rest parameter bindings from `function f({ ...rest })`.
    #[napi(js_name = "objectRestParamBindings")]
    pub object_rest_param_bindings: Vec<ObjectRestParamBinding>,
    /// Phase 8.3f: object-property bindings from `const obj = { fn }`.
    #[napi(js_name = "objectPropBindings")]
    pub object_prop_bindings: Vec<ObjectPropBinding>,
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
            return_type_map: Vec::new(),
            call_assignments: Vec::new(),
            fn_ref_bindings: Vec::new(),
            param_bindings: Vec::new(),
            this_call_bindings: Vec::new(),
            array_elem_bindings: Vec::new(),
            spread_arg_bindings: Vec::new(),
            for_of_bindings: Vec::new(),
            array_callback_bindings: Vec::new(),
            object_rest_param_bindings: Vec::new(),
            object_prop_bindings: Vec::new(),
        }
    }
}

// ─── Standalone Analysis Result Types ────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionComplexityResult {
    pub name: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub complexity: ComplexityMetrics,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCfgResult {
    pub name: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    pub cfg: CfgData,
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

/// A single monorepo workspace package, mirroring `WorkspaceEntry` in
/// `src/infrastructure/config.ts`. `entry` is `None` when no resolvable
/// entry point was found for the package (missing `main`/`source`/index
/// file). Serves double duty: passed as a napi array argument to
/// `resolve_import`/`resolve_imports` for the per-call FFI path, and
/// deserialized from the `workspaces_json` blob `NativeDatabase::build_graph`
/// receives for the full Rust orchestrator path (both use the same
/// `{ packageName, dir, entry }` JSON shape).
///
/// `#[serde(rename_all = "camelCase")]` is required here even though
/// `#[napi(object)]` already camelCases fields for direct FFI calls — that
/// conversion is a separate mechanism from `serde_json`, which only sees the
/// literal Rust field names unless told otherwise. Without it,
/// `serde_json::from_str` on `workspaces_json` (camelCase, produced by
/// `JSON.stringify(getWorkspacesForNative(...))`) fails with "missing field
/// `package_name`" (mirrors `BuildPathAliases`'s reason for existing
/// alongside `PathAliases` in infrastructure/config.rs).
#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePackage {
    pub package_name: String,
    pub dir: String,
    pub entry: Option<String>,
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
