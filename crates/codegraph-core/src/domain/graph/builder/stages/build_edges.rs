use std::collections::{HashMap, HashSet};

use napi_derive::napi;

use crate::domain::graph::builder::barrel_resolution::{self, BarrelContext, ReexportRef};
use crate::domain::graph::resolve;
use crate::types::{
    ArrayCallbackBinding, ArrayElemBinding, FnRefBinding, ForOfBinding, ObjectPropBinding,
    ObjectRestParamBinding, ParamBinding, SpreadArgBinding, ThisCallBinding,
};

/// Kind sets for hierarchy edge resolution -- mirrors the JS constants in
/// `build-edges.js` (`HIERARCHY_SOURCE_KINDS`, `EXTENDS_TARGET_KINDS`,
/// `IMPLEMENTS_TARGET_KINDS`).  Keeping them in one place prevents the
/// native/WASM drift that caused the original parity bug.
const HIERARCHY_SOURCE_KINDS: &[&str] = &["class", "struct", "record", "enum"];
const EXTENDS_TARGET_KINDS: &[&str] = &["class", "struct", "trait", "record"];
const IMPLEMENTS_TARGET_KINDS: &[&str] = &["interface", "trait", "class"];

/// Confidence penalty per alias hop — mirrors `PROPAGATION_HOP_PENALTY` in
/// `src/extractors/javascript.ts`.
pub(crate) const PROPAGATION_HOP_PENALTY: f64 = 0.1;

#[napi(object)]
pub struct NodeInfo {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
}

#[napi(object)]
pub struct CallInfo {
    pub name: String,
    pub line: u32,
    pub dynamic: Option<bool>,
    pub receiver: Option<String>,
}

#[napi(object)]
pub struct ImportedName {
    pub name: String,
    pub file: String,
}

#[napi(object)]
pub struct ClassInfo {
    pub name: String,
    pub extends: Option<String>,
    pub implements: Option<String>,
}

#[napi(object)]
pub struct DefInfo {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    /// Ordered parameter names for Phase 8.3c parameter-flow pts
    /// (mirrors `buildDefinitionParamsMap` input in build-edges.ts).
    pub params: Option<Vec<String>>,
}

#[napi(object)]
pub struct TypeMapInput {
    pub name: String,
    #[napi(js_name = "typeName")]
    pub type_name: String,
    /// Confidence: 0.9 = type annotation, 1.0 = constructor, 0.7 = factory.
    pub confidence: f64,
}

#[napi(object)]
pub struct FileEdgeInput {
    pub file: String,
    #[napi(js_name = "fileNodeId")]
    pub file_node_id: u32,
    pub definitions: Vec<DefInfo>,
    pub calls: Vec<CallInfo>,
    #[napi(js_name = "importedNames")]
    pub imported_names: Vec<ImportedName>,
    pub classes: Vec<ClassInfo>,
    #[napi(js_name = "typeMap")]
    pub type_map: Vec<TypeMapInput>,
    /// Function-reference bindings for Phase 8.3 pts analysis (optional).
    #[napi(js_name = "fnRefBindings")]
    pub fn_ref_bindings: Option<Vec<FnRefBinding>>,
    /// Phase 8.3c: argument-to-parameter bindings.
    #[napi(js_name = "paramBindings")]
    pub param_bindings: Option<Vec<ParamBinding>>,
    /// This-context bindings from `fn.call(ctx)` / `fn.apply(ctx)`.
    #[napi(js_name = "thisCallBindings")]
    pub this_call_bindings: Option<Vec<ThisCallBinding>>,
    /// Phase 8.3e: array-element bindings.
    #[napi(js_name = "arrayElemBindings")]
    pub array_elem_bindings: Option<Vec<ArrayElemBinding>>,
    /// Phase 8.3e: spread-argument bindings.
    #[napi(js_name = "spreadArgBindings")]
    pub spread_arg_bindings: Option<Vec<SpreadArgBinding>>,
    /// Phase 8.3e: for-of iteration bindings.
    #[napi(js_name = "forOfBindings")]
    pub for_of_bindings: Option<Vec<ForOfBinding>>,
    /// Phase 8.3e: Array.from callback bindings.
    #[napi(js_name = "arrayCallbackBindings")]
    pub array_callback_bindings: Option<Vec<ArrayCallbackBinding>>,
    /// Phase 8.3f: object-rest parameter bindings.
    #[napi(js_name = "objectRestParamBindings")]
    pub object_rest_param_bindings: Option<Vec<ObjectRestParamBinding>>,
    /// Phase 8.3f: object-property bindings.
    #[napi(js_name = "objectPropBindings")]
    pub object_prop_bindings: Option<Vec<ObjectPropBinding>>,
}

#[napi(object)]
pub struct ComputedEdge {
    #[napi(js_name = "sourceId")]
    pub source_id: u32,
    #[napi(js_name = "targetId")]
    pub target_id: u32,
    pub kind: String,
    pub confidence: f64,
    pub dynamic: u32,
}

/// Internal struct for caller resolution (def line range → node ID).
struct DefWithId<'a> {
    name: &'a str,
    kind: &'a str,
    line: u32,
    end_line: u32,
    node_id: Option<u32>,
}

/// Shared lookup context built once per `build_call_edges` invocation.
struct EdgeContext<'a> {
    nodes_by_name: HashMap<&'a str, Vec<&'a NodeInfo>>,
    nodes_by_name_and_file: HashMap<(&'a str, &'a str), Vec<&'a NodeInfo>>,
    nodes_by_file: HashMap<&'a str, Vec<&'a NodeInfo>>,
    builtin_set: HashSet<&'a str>,
    receiver_kinds: HashSet<&'a str>,
}

impl<'a> EdgeContext<'a> {
    fn new(all_nodes: &'a [NodeInfo], builtin_receivers: &'a [String]) -> Self {
        let mut nodes_by_name: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
        let mut nodes_by_name_and_file: HashMap<(&str, &str), Vec<&NodeInfo>> = HashMap::new();
        let mut nodes_by_file: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
        for node in all_nodes {
            nodes_by_name.entry(&node.name).or_default().push(node);
            nodes_by_name_and_file
                .entry((&node.name, &node.file))
                .or_default()
                .push(node);
            nodes_by_file.entry(&node.file).or_default().push(node);
        }
        let builtin_set: HashSet<&str> = builtin_receivers.iter().map(|s| s.as_str()).collect();
        let receiver_kinds: HashSet<&str> = ["class", "struct", "interface", "type", "module"]
            .iter().copied().collect();
        Self {
            nodes_by_name,
            nodes_by_name_and_file,
            nodes_by_file,
            builtin_set,
            receiver_kinds,
        }
    }
}

// ── Phase 8.3: points-to analysis ─────────────────────────────────────────

/// Maximum fixed-point iterations for the pts solver.
/// Mirrors `MAX_SOLVER_ITERATIONS` in `src/domain/graph/resolver/points-to.ts`.
/// TODO: wire through `CodegraphConfig.analysis.pointsToMaxIterations` once
/// config plumbing is in place (same pattern as `typePropagationDepth`).
const MAX_SOLVER_ITERATIONS: usize = 50;

/// Per-file points-to binding inputs, borrowed from a `FileEdgeInput`.
/// `fn_ref_bindings` must already include the `fn::this → ctx` conversions
/// from `this_call_bindings` (see `process_file`).
struct PtsBindings<'a> {
    fn_ref_bindings: &'a [FnRefBinding],
    param_bindings: &'a [ParamBinding],
    array_elem_bindings: &'a [ArrayElemBinding],
    spread_arg_bindings: &'a [SpreadArgBinding],
    for_of_bindings: &'a [ForOfBinding],
    array_callback_bindings: &'a [ArrayCallbackBinding],
    object_rest_param_bindings: &'a [ObjectRestParamBinding],
    object_prop_bindings: &'a [ObjectPropBinding],
}

/// Build a per-file points-to map.  Mirrors `buildPointsToMap` in
/// `src/domain/graph/resolver/points-to.ts` (full Phase 8.3–8.3f model).
///
/// Seeds every locally-defined callable and every imported name as pointing
/// to itself, generates inclusion constraints (`pts(lhs) ⊇ pts(rhsKey)`)
/// from every binding kind, then solves by fixed-point iteration.
fn build_points_to_map(
    bindings: &PtsBindings,
    def_names: &HashSet<&str>,
    imported_names: &HashMap<&str, &str>,
    definition_params: &HashMap<&str, Vec<&str>>,
) -> HashMap<String, HashSet<String>> {
    let mut pts: HashMap<String, HashSet<String>> = HashMap::new();
    for name in def_names {
        pts.entry(name.to_string()).or_default().insert(name.to_string());
    }
    for name in imported_names.keys() {
        pts.entry(name.to_string()).or_default().insert(name.to_string());
    }

    // Constraint list: pts(lhs) ⊇ pts(rhsKey). Member-expression rhs keys are
    // composite ("obj.method") and only flow when a prior seed exists — safe.
    let mut constraints: Vec<(String, String)> = bindings.fn_ref_bindings.iter().map(|b| {
        let rhs_key = match &b.rhs_receiver {
            Some(recv) => format!("{}.{}", recv, b.rhs),
            None => b.rhs.clone(),
        };
        (b.lhs.clone(), rhs_key)
    }).collect();

    // Phase 8.3c: parameter-flow constraints — `f(x)` at argIndex i adds
    // pts(f::param_i) ⊇ pts(x). Keys are scoped "callee::paramName" to prevent
    // collisions between same-named params across functions in one file.
    for pb in bindings.param_bindings {
        if let Some(params) = definition_params.get(pb.callee.as_str()) {
            if let Some(param_name) = params.get(pb.arg_index as usize) {
                constraints.push((format!("{}::{}", pb.callee, param_name), pb.arg_name.clone()));
            }
        }
    }

    // Phase 8.3e: array-element bindings — seed per-index entries, wildcard
    // `arr[*]` collects all elements via constraints.
    for ab in bindings.array_elem_bindings {
        let elem_key = format!("{}[{}]", ab.array_name, ab.index);
        pts.entry(elem_key.clone()).or_default().insert(ab.elem_name.clone());
        constraints.push((format!("{}[*]", ab.array_name), elem_key));
    }

    // Phase 8.3e: spread-argument constraints — `f(...arr)` maps known array
    // elements onto parameter slots; unknown sizes fall back to the wildcard.
    if !bindings.spread_arg_bindings.is_empty() {
        let mut array_max_index: HashMap<&str, i64> = HashMap::new();
        for ab in bindings.array_elem_bindings {
            let cur = array_max_index.entry(ab.array_name.as_str()).or_insert(-1);
            if i64::from(ab.index) > *cur { *cur = i64::from(ab.index); }
        }
        for sb in bindings.spread_arg_bindings {
            let Some(params) = definition_params.get(sb.callee.as_str()) else { continue };
            let max_idx = array_max_index.get(sb.array_name.as_str()).copied().unwrap_or(-1);
            // Safety: the cast to usize is only reached inside the `max_idx >= 0` guard,
            // so max_idx is non-negative here and cannot wrap to usize::MAX.
            if max_idx >= 0 {
                for i in 0..=(max_idx as usize) {
                    let param_idx = sb.start_index as usize + i;
                    let Some(param) = params.get(param_idx) else { break };
                    constraints.push((
                        format!("{}::{}", sb.callee, param),
                        format!("{}[{}]", sb.array_name, i),
                    ));
                }
            } else {
                for param in params.iter().skip(sb.start_index as usize) {
                    constraints.push((
                        format!("{}::{}", sb.callee, param),
                        format!("{}[*]", sb.array_name),
                    ));
                }
            }
        }
    }

    // Phase 8.3e: for-of constraints — `for (const x of arr)` inside `outer`
    // adds pts(outer::x) ⊇ pts(arr[*]).
    for fb in bindings.for_of_bindings {
        constraints.push((
            format!("{}::{}", fb.enclosing_func, fb.var_name),
            format!("{}[*]", fb.source_name),
        ));
    }

    // Phase 8.3e: Array.from(source, cb) — pts(cb::param0) ⊇ pts(source[*]).
    for cb in bindings.array_callback_bindings {
        if let Some(param0) = definition_params.get(cb.callee_name.as_str()).and_then(|p| p.first()) {
            constraints.push((
                format!("{}::{}", cb.callee_name, param0),
                format!("{}[*]", cb.source_name),
            ));
        }
    }

    // Phase 8.3f: object-rest dispatch — `function f({ ...rest })` + `f(obj)` +
    // `const obj = { prop: fn }` seeds pts("rest.prop") = {"fn"}.
    if !bindings.object_rest_param_bindings.is_empty()
        && !bindings.object_prop_bindings.is_empty()
        && !bindings.param_bindings.is_empty()
    {
        let mut param_by_callee_idx: HashMap<(&str, u32), Vec<&str>> = HashMap::new();
        for pb in bindings.param_bindings {
            param_by_callee_idx
                .entry((pb.callee.as_str(), pb.arg_index))
                .or_default()
                .push(pb.arg_name.as_str());
        }
        let mut props_by_object: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
        for ob in bindings.object_prop_bindings {
            props_by_object
                .entry(ob.object_name.as_str())
                .or_default()
                .push((ob.prop_name.as_str(), ob.value_name.as_str()));
        }
        for rb in bindings.object_rest_param_bindings {
            let Some(arg_names) = param_by_callee_idx.get(&(rb.callee.as_str(), rb.arg_index)) else {
                continue;
            };
            for arg_name in arg_names {
                let Some(props) = props_by_object.get(arg_name) else { continue };
                for (prop_name, value_name) in props {
                    if !def_names.contains(value_name) && !imported_names.contains_key(value_name) {
                        continue;
                    }
                    pts.entry(format!("{}.{}", rb.rest_name, prop_name))
                        .or_default()
                        .insert((*value_name).to_string());
                }
            }
        }
    }

    if constraints.is_empty() {
        return pts;
    }

    // Fixed-point iteration: propagate pts sets until no new information flows.
    for _ in 0..MAX_SOLVER_ITERATIONS {
        let mut changed = false;
        for (lhs, rhs_key) in &constraints {
            let rhs_pts: Option<Vec<String>> = pts.get(rhs_key.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.iter().cloned().collect());
            if let Some(targets) = rhs_pts {
                let entry = pts.entry(lhs.clone()).or_default();
                for t in targets {
                    if entry.insert(t) { changed = true; }
                }
            }
        }
        if !changed { break; }
    }
    pts
}

/// Return the concrete targets `call_name` flows to, excluding self-references.
/// Mirrors `resolveViaPointsTo` in `src/domain/graph/resolver/points-to.ts`.
fn resolve_via_points_to<'a>(
    call_name: &str,
    pts: &'a HashMap<String, HashSet<String>>,
) -> Vec<&'a str> {
    match pts.get(call_name) {
        None => vec![],
        Some(targets) => targets.iter()
            .filter(|t| t.as_str() != call_name)
            .map(|t| t.as_str())
            .collect(),
    }
}

/// Per-call-site inputs for `emit_pts_alias_edges`.
/// Groups the lookup parameters so the function stays within the argument-count limit.
struct PtsAliasCtx<'a> {
    pts: &'a HashMap<String, HashSet<String>>,
    lookup_name: &'a str,
    call_line: u32,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    rel_path: &'a str,
    imported_names: &'a HashMap<&'a str, &'a str>,
    type_map: &'a HashMap<&'a str, (&'a str, f64)>,
}

/// Resolve each pts alias of `lookup_name` and emit hop-penalised call edges.
/// Shared by the no-receiver gate and the receiver-key (`rest.prop()`) fallback;
/// mirrors the alias-emission loops in buildFileCallEdges (build-edges.ts).
fn emit_pts_alias_edges<'a>(
    ctx: &EdgeContext<'a>,
    alias_ctx: &PtsAliasCtx<'_>,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    for alias in resolve_via_points_to(alias_ctx.lookup_name, alias_ctx.pts) {
        let alias_imported_from = alias_ctx.imported_names.get(alias).copied();
        let alias_call = CallInfo {
            name: alias.to_string(),
            line: alias_ctx.call_line,
            dynamic: Some(true),
            receiver: None,
        };
        let mut alias_targets = resolve_call_targets(
            ctx, &alias_call, alias_ctx.rel_path, alias_imported_from, alias_ctx.type_map, alias_ctx.caller_name,
        );
        sort_targets_by_confidence(&mut alias_targets, alias_ctx.rel_path, alias_imported_from);
        for t in &alias_targets {
            let edge_key = ((alias_ctx.caller_id as u64) << 32) | (t.id as u64);
            if t.id != alias_ctx.caller_id && !seen_edges.contains(&edge_key) && !pts_edge_map.contains_key(&edge_key) {
                let conf = resolve::compute_confidence(alias_ctx.rel_path, &t.file, alias_imported_from)
                    - PROPAGATION_HOP_PENALTY;
                if conf > 0.0 {
                    pts_edge_map.insert(edge_key, edges.len());
                    edges.push(ComputedEdge {
                        source_id: alias_ctx.caller_id,
                        target_id: t.id,
                        kind: "calls".to_string(),
                        confidence: conf,
                        dynamic: alias_ctx.is_dynamic,
                    });
                }
            }
        }
    }
}

/// Build call, receiver, extends, and implements edges in Rust.
///
/// Mirrors the algorithm in builder.js `buildEdges` transaction (call edges
/// portion). Import edges are handled separately in JS.
#[napi]
pub fn build_call_edges(
    files: Vec<FileEdgeInput>,
    all_nodes: Vec<NodeInfo>,
    builtin_receivers: Vec<String>,
) -> Vec<ComputedEdge> {
    let ctx = EdgeContext::new(&all_nodes, &builtin_receivers);
    let mut edges = Vec::new();

    for file_input in &files {
        process_file(&ctx, file_input, &all_nodes, &mut edges);
    }

    edges
}

/// Per-file lookup structures built once and shared by the call/receiver/hierarchy
/// edge emission loops. Encapsulates what was formerly the setup block of `process_file`.
struct FileContext<'a> {
    rel_path: &'a str,
    file_node_id: u32,
    imported_names: HashMap<&'a str, &'a str>,
    type_map: HashMap<&'a str, (&'a str, f64)>,
    defs_with_ids: Vec<DefWithId<'a>>,
    pts_map: Option<HashMap<String, HashSet<String>>>,
    /// lhs names from the *raw* fnRefBindings only (thisCall conversions are
    /// scoped keys and never flat-matched). Used for case-(c) pts gate.
    fn_ref_binding_lhs: HashSet<&'a str>,
}

/// Build the per-file type map from the input's type_map entries.
/// Keeps the highest-confidence entry per name (first-wins on tie), matching
/// the JS `setTypeMapEntry` behaviour.
fn build_type_map<'a>(file_input: &'a FileEdgeInput) -> HashMap<&'a str, (&'a str, f64)> {
    let mut type_map: HashMap<&str, (&str, f64)> = HashMap::new();
    for tm in &file_input.type_map {
        let entry = type_map.entry(tm.name.as_str());
        match entry {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert((tm.type_name.as_str(), tm.confidence));
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if tm.confidence > e.get().1 {
                    e.insert((tm.type_name.as_str(), tm.confidence));
                }
            }
        }
    }
    type_map
}

/// Build the points-to map for a file.
///
/// Constructs the `PtsBindings` from `file_input`, merges `this_call_bindings`
/// into scoped `fn::this → ctx` fnRefBindings, builds `def_names` and
/// `definition_params`, then delegates to `build_points_to_map`.
/// Returns `None` when the file has no pts inputs (fast path).
///
/// Mirrors `buildPointsToMapForFile` in `src/domain/graph/resolver/points-to.ts`.
fn build_pts_map_for_file(
    file_input: &FileEdgeInput,
    imported_names: &HashMap<&str, &str>,
) -> Option<HashMap<String, HashSet<String>>> {
    let raw_fn_ref: &[FnRefBinding] = file_input.fn_ref_bindings.as_deref().unwrap_or(&[]);
    let this_calls: &[ThisCallBinding] = file_input.this_call_bindings.as_deref().unwrap_or(&[]);
    let bindings = PtsBindings {
        fn_ref_bindings: raw_fn_ref,
        param_bindings: file_input.param_bindings.as_deref().unwrap_or(&[]),
        array_elem_bindings: file_input.array_elem_bindings.as_deref().unwrap_or(&[]),
        spread_arg_bindings: file_input.spread_arg_bindings.as_deref().unwrap_or(&[]),
        for_of_bindings: file_input.for_of_bindings.as_deref().unwrap_or(&[]),
        array_callback_bindings: file_input.array_callback_bindings.as_deref().unwrap_or(&[]),
        object_rest_param_bindings: file_input.object_rest_param_bindings.as_deref().unwrap_or(&[]),
        object_prop_bindings: file_input.object_prop_bindings.as_deref().unwrap_or(&[]),
    };
    let has_pts_inputs = !bindings.fn_ref_bindings.is_empty()
        || !bindings.param_bindings.is_empty()
        || !bindings.array_elem_bindings.is_empty()
        || !bindings.spread_arg_bindings.is_empty()
        || !bindings.for_of_bindings.is_empty()
        || !bindings.array_callback_bindings.is_empty()
        || !bindings.object_rest_param_bindings.is_empty()
        || !bindings.object_prop_bindings.is_empty()
        || !this_calls.is_empty();
    if !has_pts_inputs {
        return None;
    }

    let def_names: HashSet<&str> = file_input.definitions.iter()
        .filter(|d| d.kind == "function" || d.kind == "method")
        .map(|d| d.name.as_str())
        .collect();
    // First-wins on duplicate names — mirrors buildDefinitionParamsMap.
    let mut definition_params: HashMap<&str, Vec<&str>> = HashMap::new();
    for d in &file_input.definitions {
        if d.kind != "function" && d.kind != "method" { continue; }
        let Some(params) = d.params.as_ref().filter(|p| !p.is_empty()) else { continue };
        definition_params.entry(d.name.as_str())
            .or_insert_with(|| params.iter().map(|s| s.as_str()).collect());
    }

    // Convert thisCallBindings into scoped fnRefBindings (`fn::this → ctx`) so
    // `this()` calls inside `fn` resolve via the scoped key `fn::this`.
    // The merged vec must outlive the PtsBindings borrow — stored here.
    let merged_fn_ref: Vec<FnRefBinding>;
    let final_bindings = if this_calls.is_empty() {
        bindings
    } else {
        let mut merged = raw_fn_ref.to_vec();
        merged.extend(this_calls.iter().map(|b| FnRefBinding {
            lhs: format!("{}::this", b.callee),
            rhs: b.this_arg.clone(),
            rhs_receiver: None,
        }));
        merged_fn_ref = merged;
        PtsBindings { fn_ref_bindings: &merged_fn_ref, ..bindings }
    };

    Some(build_points_to_map(&final_bindings, &def_names, imported_names, &definition_params))
}

/// Build all per-file lookup structures needed for edge emission.
fn build_file_context<'a>(
    file_input: &'a FileEdgeInput,
    all_nodes: &'a [NodeInfo],
) -> FileContext<'a> {
    let rel_path = file_input.file.as_str();
    let imported_names: HashMap<&str, &str> = file_input
        .imported_names.iter()
        .map(|im| (im.name.as_str(), im.file.as_str()))
        .collect();
    let type_map = build_type_map(file_input);
    let file_nodes: Vec<&NodeInfo> = all_nodes.iter().filter(|n| n.file == rel_path).collect();
    let defs_with_ids: Vec<DefWithId> = file_input.definitions.iter().map(|d| {
        let node_id = file_nodes.iter()
            .find(|n| n.name == d.name && n.kind == d.kind && n.line == d.line)
            .map(|n| n.id);
        DefWithId {
            name: &d.name,
            kind: &d.kind,
            line: d.line,
            end_line: d.end_line.unwrap_or(u32::MAX),
            node_id,
        }
    }).collect();
    let pts_map = build_pts_map_for_file(file_input, &imported_names);
    let raw_fn_ref: &[FnRefBinding] = file_input.fn_ref_bindings.as_deref().unwrap_or(&[]);
    // Case (c) flat-key gate set: lhs names from the *raw* fnRefBindings only
    // (thisCall conversions are scoped keys and never flat-matched).
    let fn_ref_binding_lhs: HashSet<&str> = raw_fn_ref.iter().map(|b| b.lhs.as_str()).collect();
    FileContext {
        rel_path,
        file_node_id: file_input.file_node_id,
        imported_names,
        type_map,
        defs_with_ids,
        pts_map,
        fn_ref_binding_lhs,
    }
}

/// Resolve and emit pts-alias edges for a no-receiver unresolved call.
///
/// Implements the four-case gate from buildFileCallEdges (build-edges.ts):
///   (a) dynamic alias calls — flat `call.name` lookup;
///   (b) parameter / this-rebinding / for-of variable calls — scoped key
///       `caller::name`, with the `<module>::name` sentinel for top-level for-of loops;
///   (c) module-level alias bindings (`const f = handler`, `f = fn.bind(ctx)`)
///       — flat key, gated on fnRefBindingLhs so self-seeded local definitions never fire.
/// Confidence is penalised by one hop to reflect the indirection.
fn emit_no_receiver_pts_edges<'a>(
    ctx: &EdgeContext<'a>,
    fc: &FileContext<'a>,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    let pts = match fc.pts_map.as_ref() { Some(p) => p, None => return };
    let is_dyn_call = call.dynamic.unwrap_or(false);
    let scoped_key = if caller_name.is_empty() { None } else {
        Some(format!("{}::{}", caller_name, call.name))
            .filter(|k| pts.contains_key(k.as_str()))
    };
    let module_key = if caller_name.is_empty() {
        Some(format!("<module>::{}", call.name))
            .filter(|k| pts.contains_key(k.as_str()))
    } else {
        None
    };
    let flat_ok = !is_dyn_call
        && fc.fn_ref_binding_lhs.contains(call.name.as_str())
        && pts.contains_key(call.name.as_str());
    let lookup_name: Option<String> = if is_dyn_call {
        Some(call.name.clone())
    } else if let Some(k) = scoped_key {
        Some(k)
    } else if let Some(k) = module_key {
        Some(k)
    } else if flat_ok {
        Some(call.name.clone())
    } else {
        None
    };
    if let Some(lookup_name) = lookup_name {
        emit_pts_alias_edges(
            ctx,
            &PtsAliasCtx {
                pts,
                lookup_name: &lookup_name,
                call_line: call.line,
                caller_id,
                caller_name,
                is_dynamic,
                rel_path: fc.rel_path,
                imported_names: &fc.imported_names,
                type_map: &fc.type_map,
            },
            seen_edges,
            pts_edge_map,
            edges,
        );
    }
}

/// Resolve and emit pts-alias edges for a receiver call via object-rest bindings.
///
/// Phase 8.3f: `rest.prop()` resolves when pts["rest.prop"] was seeded by the
/// rest-dispatch chain. Builtin receivers are already skipped at the call-loop top.
fn emit_receiver_pts_edges<'a>(
    ctx: &EdgeContext<'a>,
    fc: &FileContext<'a>,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    let (receiver, pts) = match (call.receiver.as_deref(), fc.pts_map.as_ref()) {
        (Some(r), Some(p)) => (r, p),
        _ => return,
    };
    if receiver == "this" || receiver == "self" || receiver == "super" { return; }
    let receiver_key = format!("{}.{}", receiver, call.name);
    if !pts.contains_key(receiver_key.as_str()) { return; }
    emit_pts_alias_edges(
        ctx,
        &PtsAliasCtx {
            pts,
            lookup_name: &receiver_key,
            call_line: call.line,
            caller_id,
            caller_name,
            is_dynamic,
            rel_path: fc.rel_path,
            imported_names: &fc.imported_names,
            type_map: &fc.type_map,
        },
        seen_edges,
        pts_edge_map,
        edges,
    );
}

/// Process a single file: build per-file lookup context and emit call/receiver/hierarchy edges.
fn process_file<'a>(
    ctx: &EdgeContext<'a>,
    file_input: &'a FileEdgeInput,
    all_nodes: &'a [NodeInfo],
    edges: &mut Vec<ComputedEdge>,
) {
    let fc = build_file_context(file_input, all_nodes);

    // Phase 8.3: tracks pts-resolved edges separately from seen_edges so that a
    // subsequent direct call to the same caller→target pair can upgrade confidence
    // in-place rather than being silently dropped by the dedup guard.
    // Mirrors `ptsEdgeRows` in `src/domain/graph/builder/stages/build-edges.ts`.
    // Key: edge_key (same as seen_edges). Value: index into `edges` vec.
    let mut seen_edges: HashSet<u64> = HashSet::new();
    let mut pts_edge_map: HashMap<u64, usize> = HashMap::new();

    for call in &file_input.calls {
        if let Some(ref receiver) = call.receiver {
            if ctx.builtin_set.contains(receiver.as_str()) { continue; }
        }

        let (caller_id, caller_name) = find_enclosing_caller(&fc.defs_with_ids, call.line, fc.file_node_id);
        let is_dynamic = if call.dynamic.unwrap_or(false) { 1u32 } else { 0u32 };
        let imported_from = fc.imported_names.get(call.name.as_str()).copied();

        let mut targets = resolve_call_targets(ctx, call, fc.rel_path, imported_from, &fc.type_map, caller_name);
        sort_targets_by_confidence(&mut targets, fc.rel_path, imported_from);
        emit_call_edges(&targets, caller_id, is_dynamic, fc.rel_path, imported_from, &mut seen_edges, &mut pts_edge_map, edges);

        if targets.is_empty() && call.receiver.is_none() {
            emit_no_receiver_pts_edges(ctx, &fc, call, caller_id, caller_name, is_dynamic, &seen_edges, &mut pts_edge_map, edges);
        }

        if targets.is_empty() {
            emit_receiver_pts_edges(ctx, &fc, call, caller_id, caller_name, is_dynamic, &seen_edges, &mut pts_edge_map, edges);
        }

        emit_receiver_edge(ctx, call, caller_id, fc.rel_path, &fc.type_map, &fc.imported_names, &mut seen_edges, edges);
    }

    emit_hierarchy_edges(ctx, file_input, fc.rel_path, edges);
}

/// Callable definition kinds — only function/method bodies act as enclosing
/// caller scopes.  Variable/constant bindings are a lower-priority fallback
/// tier for top-level bindings like Haskell `main = do …` (kind `variable`).
/// Mirrors `CALLABLE_KINDS` / `TOP_LEVEL_BINDING_KINDS` in call-resolver.ts.
fn is_callable_kind(kind: &str) -> bool {
    kind == "function" || kind == "method"
}

fn is_top_level_binding_kind(kind: &str) -> bool {
    kind == "variable" || kind == "constant"
}

/// Find the narrowest enclosing definition for a call at the given line.
///
/// Two-pass strategy (mirrors `findCaller` in call-resolver.ts):
///   Pass 1 — narrowest enclosing function/method.  Local variable declarations
///             inside a function body must not shadow the enclosing function.
///   Pass 2 — widest (outermost) enclosing variable/constant binding.  Used as
///             fallback when no function/method encloses the call (e.g. Haskell
///             top-level `main = do …` is a `bind` node with kind `variable`).
///
/// Tie-breaking in Pass 1: when two callable definitions have the same span,
/// prefer the bare (unqualified) name over the dot-containing qualified name.
/// Object-literal methods are extracted twice by the Rust extractor — once as
/// `o1.f(function)` from `extract_object_literal_functions` (called eagerly
/// inside `handle_var_decl`) and once as `f(method)` from `handle_method_def`
/// (called later during the child walk). The WASM extractor emits `f(method)`
/// first (query captures run before the walk-phase `extractObjectLiteralFunctions`),
/// so WASM's strict-less-than tie-break naturally picks the bare name.
/// Applying the same preference here aligns native attribution with WASM and with
/// the jelly-micro ground-truth expected-edges (which use bare `f`/`g` names).
/// Names with angle brackets (e.g. `B.<static:36:2>`) are synthetic static-block
/// nodes excluded from the bare-preference rule.
///
/// Returns `(caller_id, caller_name)` — `caller_name` is `""` when the call
/// falls back to file scope.
fn find_enclosing_caller<'a>(defs: &[DefWithId<'a>], call_line: u32, file_node_id: u32) -> (u32, &'a str) {
    let mut fn_caller_id: Option<u32> = None;
    let mut fn_caller_name = "";
    let mut fn_caller_span = u32::MAX;

    // For variable/constant bindings we pick the WIDEST span (outermost binding),
    // not the narrowest, so that nested `let` bindings inside `main`'s do-block
    // do not shadow `main` itself.  The outermost enclosing variable is the
    // "function-like" top-level binding (e.g. Haskell `main = do …`).
    // var_caller_span starts at 0 — any real spanning binding has span >= 0
    // and we overwrite only when span is strictly greater.
    let mut var_caller_id: Option<u32> = None;
    let mut var_caller_name = "";
    // Using i64 so the initial sentinel (-1) is always beaten by a real span (>= 0).
    let mut var_caller_span: i64 = -1;

    for def in defs {
        if def.line <= call_line && call_line <= def.end_line {
            let span = def.end_line.saturating_sub(def.line);
            if is_callable_kind(def.kind) {
                // On a strict span improvement always take the new candidate.
                // On a tie, prefer bare names over qualified names so native matches WASM:
                // both pick `f(method)` over `o1.f(function)` when an object-literal method
                // is extracted under both names at the same line. Synthetic angle-bracket
                // nodes (e.g. `B.<static:36:2>`) are excluded on both sides of the comparison.
                let is_improvement = span < fn_caller_span;
                let is_tie_prefer_bare = span == fn_caller_span
                    && !def.name.contains('.')
                    && !def.name.contains('<')
                    && fn_caller_name.contains('.')
                    && !fn_caller_name.contains('<');
                if is_improvement || is_tie_prefer_bare {
                    if let Some(id) = def.node_id {
                        fn_caller_id = Some(id);
                        fn_caller_name = def.name;
                        fn_caller_span = span;
                    }
                }
            } else if is_top_level_binding_kind(def.kind) {
                if (span as i64) > var_caller_span {
                    if let Some(id) = def.node_id {
                        var_caller_id = Some(id);
                        var_caller_name = def.name;
                        var_caller_span = span as i64;
                    }
                }
            }
        }
    }

    // Prefer function/method over variable/constant binding.
    if let Some(id) = fn_caller_id {
        return (id, fn_caller_name);
    }
    if let Some(id) = var_caller_id {
        return (id, var_caller_name);
    }
    (file_node_id, "")
}

/// Multi-strategy call target resolution: import-aware → same-file → type-aware → scoped.
/// `caller_name` is the enclosing function/method name (e.g. `"Shape.describe"`) used to scope
/// `this`/`self`/`super` dispatch to the caller's own class before falling back to a broader scan.
/// Mirrors `resolveCallTargets` / `resolveByMethodOrGlobal` in call-resolver.ts.
fn resolve_call_targets<'a>(
    ctx: &EdgeContext<'a>,
    call: &CallInfo,
    rel_path: &str,
    imported_from: Option<&str>,
    type_map: &HashMap<&str, (&str, f64)>,
    caller_name: &str,
) -> Vec<&'a NodeInfo> {
    // 1. Import-aware resolution
    if let Some(imp_file) = imported_from {
        let targets = ctx.nodes_by_name_and_file
            .get(&(call.name.as_str(), imp_file))
            .cloned().unwrap_or_default();
        if !targets.is_empty() { return targets; }
    }

    // 2. Same-file resolution
    let targets = ctx.nodes_by_name_and_file
        .get(&(call.name.as_str(), rel_path))
        .cloned().unwrap_or_default();
    if !targets.is_empty() { return targets; }

    // 3. Type-aware resolution via receiver → type map.
    // Strips "this." prefix so `this.repo.method()` resolves via typeMap["repo"]
    // or typeMap["this.repo"] (both seeded by the class-field extractor).
    if let Some(ref receiver) = call.receiver {
        let effective_receiver = if receiver.starts_with("this.") {
            &receiver["this.".len()..]
        } else {
            receiver.as_str()
        };
        // Phase 8.3f: callee-scoped rest-param key (`callee::restName`) avoids
        // same-name rest-binding collisions across functions in the same file (#1358).
        let rest_param_key = format!("{}::{}", caller_name, effective_receiver);
        // Class-scoped key (`ClassName.prop`) seeded by `this.prop = new Ctor()` and
        // field annotations — prevents false edges when multiple classes define the same
        // property name (issues #1323, #1458). Consulted first for `this.` receivers so
        // bare fallback keys (confidence 0.6) don't shadow the correct per-class entry.
        let class_scoped_key = if receiver.starts_with("this.") && !caller_name.is_empty() {
            caller_name
                .rfind('.')
                .map(|dot| format!("{}.{}", &caller_name[..dot], effective_receiver))
        } else {
            None
        };
        let type_lookup = class_scoped_key.as_deref().and_then(|k| type_map.get(k))
            .or_else(|| type_map.get(effective_receiver))
            .or_else(|| type_map.get(receiver.as_str()))
            .or_else(|| if caller_name.is_empty() { None } else { type_map.get(rest_param_key.as_str()) });
        // Inline new-expression receiver: `(new Foo).bar()` — extract the constructor name
        // when no typeMap entry exists for the complex receiver expression.
        // Mirrors the regex `/^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/` in call-resolver.ts.
        let inline_new_type = if type_lookup.is_none() {
            extract_inline_new_type(receiver)
        } else {
            None
        };
        // Use typeMap-resolved type or inline-new-extracted type, whichever is available.
        let resolved_type = type_lookup.map(|&(t, _)| t).or(inline_new_type.as_deref());
        if let Some(type_name) = resolved_type {
            let qualified = format!("{}.{}", type_name, call.name);
            let typed: Vec<&NodeInfo> = ctx.nodes_by_name
                .get(qualified.as_str())
                .map(|v| v.iter()
                    .filter(|n| n.kind == "method"
                        && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                    .copied().collect())
                .unwrap_or_default();
            if !typed.is_empty() { return typed; }
            // Prototype alias: `Foo.prototype.bar = identifier` seeds typeMap['Foo.bar'] = identifier.
            // After the direct method lookup misses (no definition emitted for this method),
            // check if the typeMap holds an alias to a standalone function.
            // Mirrors the protoAlias fallback in resolveByMethodOrGlobal in call-resolver.ts.
            if let Some(&(proto_target, _)) = type_map.get(qualified.as_str()) {
                let resolved: Vec<&NodeInfo> = ctx.nodes_by_name
                    .get(proto_target)
                    .map(|v| v.iter()
                        .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                        .copied().collect())
                    .unwrap_or_default();
                if !resolved.is_empty() { return resolved; }
            }
        }
        // 3.5. Direct qualified method lookup: ClassName.staticMethod() or ClassName.instanceMethod()
        // when the receiver is a class name with no typeMap entry. Handles static method calls
        // like `Validators.IsValidEmail()` where the receiver IS the class.
        // Matches both "method" and "function" kinds to cover field-initializer synthetic defs.
        // ORDER: must run before composite pts lookup (3.6) to match WASM call-resolver.ts ordering.
        // Guard: skip when inline_new_type is Some — mirrors TS `!typeName` which is false when the
        // inline-new regex extracted a type (e.g. `(new Foo).bar()` → typeName='Foo' → skip).
        if type_lookup.is_none() && inline_new_type.is_none() {
            let qualified = format!("{}.{}", effective_receiver, call.name);
            let direct: Vec<&NodeInfo> = ctx.nodes_by_name
                .get(qualified.as_str())
                .map(|v| v.iter()
                    .filter(|n| (n.kind == "method" || n.kind == "function")
                        && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                    .copied().collect())
                .unwrap_or_default();
            if !direct.is_empty() { return direct; }
        }

        // 3.6. Phase 8.3d: composite pts key — `obj.prop = fn` seeds typeMap['obj.prop']
        let composite_key = format!("{}.{}", receiver, call.name);
        if let Some(&(pts_target, _)) = type_map.get(composite_key.as_str()) {
            let resolved: Vec<&NodeInfo> = ctx.nodes_by_name
                .get(pts_target)
                .map(|v| v.iter()
                    .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                    .copied().collect())
                .unwrap_or_default();
            if !resolved.is_empty() { return resolved; }
        }
    }

    // 4. Scoped fallback (this/self/super or no receiver)
    if call.receiver.is_none()
        || call.receiver.as_deref() == Some("this")
        || call.receiver.as_deref() == Some("self")
        || call.receiver.as_deref() == Some("super")
    {
        // Phase 8.3f: accessor this-dispatch via Object.defineProperty.
        // When a plain function (no class prefix in caller_name) is registered as a get/set
        // accessor for `obj`, typeMap seeds 'callerName:this' = 'obj'. Resolve this.method()
        // via typeMap['obj.method'] → the concrete definition. Runs before the broad exact-name
        // lookup to avoid false positives from unrelated same-file definitions.
        if call.receiver.as_deref() == Some("this") && !caller_name.is_empty() && !caller_name.contains('.') {
            let accessor_key = format!("{}:this", caller_name);
            if let Some(&(obj_name, _)) = type_map.get(accessor_key.as_str()) {
                let obj_method_key = format!("{}.{}", obj_name, call.name);
                if let Some(&(target_fn, _)) = type_map.get(obj_method_key.as_str()) {
                    let accessor_resolved: Vec<&NodeInfo> = ctx.nodes_by_name
                        .get(target_fn)
                        .map(|v| v.iter()
                            .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                            .copied().collect())
                        .unwrap_or_default();
                    if !accessor_resolved.is_empty() { return accessor_resolved; }
                }
            }
        }

        // First try exact name match (e.g. an unqualified function named "area").
        let exact: Vec<&NodeInfo> = ctx.nodes_by_name
            .get(call.name.as_str())
            .map(|v| v.iter()
                .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                .copied().collect())
            .unwrap_or_default();
        if !exact.is_empty() { return exact; }

        // Class-scoped exact lookup: prefer `ClassName.method` when the caller is a qualified
        // method (e.g. `this.area()` or plain `area()` in `Shape.describe` → try `Shape.area`).
        // Covers both this/self/super dispatch AND no-receiver static sibling calls (e.g.
        // `IsValidEmail()` inside `Validators.ValidateUser` → `Validators.IsValidEmail`).
        // This avoids false edges to unrelated classes that happen to have a method with the
        // same name in the same file.
        //
        // For JS/TS, bare (no-receiver) calls are module-scoped — there is no implicit class
        // binding. Skip the same-class fallback for bare calls in those languages to prevent
        // false positives (e.g. `flush()` inside `Processor.run` must not resolve to
        // `Processor.flush`). this/self/super calls are unaffected.
        let is_bare_call = call.receiver.is_none();
        if !caller_name.is_empty() && !(is_bare_call && is_module_scoped_language(rel_path)) {
            if let Some(dot_idx) = caller_name.rfind('.') {
                // Extract only the segment immediately before the method name so that
                // 'Namespace.ClassName.method' yields 'ClassName', not 'Namespace.ClassName'.
                // Symbols are stored under their bare class name, not their qualified path.
                let seg_start = caller_name[..dot_idx].rfind('.').map(|p| p + 1).unwrap_or(0);
                let class_prefix = &caller_name[seg_start..dot_idx];
                let qualified = format!("{}.{}", class_prefix, call.name);
                let class_scoped: Vec<&NodeInfo> = ctx.nodes_by_name
                    .get(qualified.as_str())
                    .map(|v| v.iter()
                        .filter(|n| n.kind == "method"
                            && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                        .copied().collect())
                    .unwrap_or_default();
                if !class_scoped.is_empty() { return class_scoped; }
            }
        }

        // Broader fallback: same-file suffix scan.  Only for this/self/super (not no-receiver
        // plain calls) to avoid false positives on global function calls inside class methods.
        // Always restricts to the caller's own class prefix to avoid false edges to unrelated
        // classes in the same file (e.g. this.area() inside Shape.describe must never yield
        // Calculator.area, even when Calculator.area is the only method with that name).
        if call.receiver.is_some() {
            let suffix = format!(".{}", call.name);
            if let Some(file_nodes) = ctx.nodes_by_file.get(rel_path) {
                let same_file_methods: Vec<&NodeInfo> = file_nodes.iter()
                    .filter(|n| n.kind == "method" && n.name.ends_with(&suffix))
                    .copied()
                    .collect();
                if !same_file_methods.is_empty() {
                    if let Some(dot_pos) = caller_name.find('.') {
                        let caller_prefix = format!("{}.", &caller_name[..dot_pos]);
                        let caller_scoped: Vec<&NodeInfo> = same_file_methods.iter()
                            .filter(|n| n.name.starts_with(&caller_prefix))
                            .copied()
                            .collect();
                        if !caller_scoped.is_empty() { return caller_scoped; }
                    }
                }
            }
        }
        return exact; // empty
    }

    Vec::new()
}

/// Languages where bare `foo()` calls inside a class method are lexically scoped
/// to the module, not the class — there is no implicit this/class binding.
/// Mirrors `MODULE_SCOPED_BARE_CALL_EXTENSIONS` in call-resolver.ts.
fn is_module_scoped_language(rel_path: &str) -> bool {
    match rel_path.rsplit_once('.') {
        Some((_, ext)) => matches!(ext, "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" | "cts"),
        None => false,
    }
}

/// Extract the constructor name from an inline `new` receiver expression.
///
/// Mirrors the regex `/^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/` used in call-resolver.ts.
/// Handles `(new Foo)` and `(new Foo('arg'))` receivers that arise when the call site
/// is `(new Foo).method()` without a named variable binding.
///
/// Only extracts names that start with an uppercase letter, `_`, or `$` to avoid
/// false positives on plain lowercase constructor calls (rare but present in legacy code).
fn extract_inline_new_type(receiver: &str) -> Option<String> {
    let s = receiver.strip_prefix('(').unwrap_or(receiver).trim_start();
    let s = s.strip_prefix("new")?;
    if !s.starts_with(|c: char| c.is_whitespace()) { return None; }
    let s = s.trim_start();
    let end = s.find(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .unwrap_or(s.len());
    let name = &s[..end];
    if name.is_empty() { return None; }
    let first = name.chars().next()?;
    if first.is_uppercase() || first == '_' || first == '$' {
        Some(name.to_string())
    } else {
        None
    }
}

/// Sort targets by confidence descending.
fn sort_targets_by_confidence(targets: &mut Vec<&NodeInfo>, rel_path: &str, imported_from: Option<&str>) {
    if targets.len() > 1 {
        targets.sort_by(|a, b| {
            let conf_a = resolve::compute_confidence(rel_path, &a.file, imported_from);
            let conf_b = resolve::compute_confidence(rel_path, &b.file, imported_from);
            conf_b.partial_cmp(&conf_a).unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// Emit call edges from caller to resolved targets (deduped).
fn emit_call_edges(
    targets: &[&NodeInfo], caller_id: u32, is_dynamic: u32,
    rel_path: &str, imported_from: Option<&str>,
    seen_edges: &mut HashSet<u64>, pts_edge_map: &mut HashMap<u64, usize>, edges: &mut Vec<ComputedEdge>,
) {
    for t in targets {
        let edge_key = ((caller_id as u64) << 32) | (t.id as u64);
        if t.id != caller_id && !seen_edges.contains(&edge_key) {
            let confidence = resolve::compute_confidence(rel_path, &t.file, imported_from);
            if let Some(&pts_idx) = pts_edge_map.get(&edge_key) {
                // A pts-resolved edge already exists for this caller→target pair with a
                // penalised confidence. Upgrade it to the direct-call confidence in-place,
                // then promote to seen_edges so no further processing is needed.
                // Mirrors the ptsEdgeRows upgrade path in build-edges.ts.
                if let Some(pts_row) = edges.get_mut(pts_idx) {
                    pts_row.confidence = confidence;
                    pts_row.dynamic = is_dynamic; // direct call overrides alias dynamic flag
                }
                pts_edge_map.remove(&edge_key);
                seen_edges.insert(edge_key);
            } else {
                seen_edges.insert(edge_key);
                edges.push(ComputedEdge {
                    source_id: caller_id, target_id: t.id,
                    kind: "calls".to_string(), confidence, dynamic: is_dynamic,
                });
            }
        }
    }
}

/// Emit a receiver edge from caller to the receiver's type node (if applicable).
fn emit_receiver_edge(
    ctx: &EdgeContext, call: &CallInfo, caller_id: u32, rel_path: &str,
    type_map: &HashMap<&str, (&str, f64)>,
    imported_names: &HashMap<&str, &str>,
    seen_edges: &mut HashSet<u64>, edges: &mut Vec<ComputedEdge>,
) {
    let Some(ref receiver) = call.receiver else { return };
    if ctx.builtin_set.contains(receiver.as_str())
        || receiver == "this" || receiver == "self" || receiver == "super"
    { return; }

    let type_entry = type_map.get(receiver.as_str());
    let effective_receiver = type_entry.map(|&(t, _)| t).unwrap_or(receiver.as_str());

    // Block global fallback only when the same-file node is a local definition,
    // not when it's an import artifact (e.g. `const { C } = require(…)` seeds a
    // kind="function" node in the importer but the real class lives elsewhere).
    // A locally-defined `function C(){}` owns the name — no cross-file class
    // should shadow it (issue #1539).  Mirror of JS resolveReceiverEdge logic.
    let samefile_all: Vec<&NodeInfo> = ctx.nodes_by_name_and_file
        .get(&(effective_receiver, rel_path))
        .cloned().unwrap_or_default();
    let is_local_definition = !samefile_all.is_empty()
        && !imported_names.contains_key(effective_receiver);
    let samefile_candidates: Vec<&NodeInfo> = samefile_all.iter()
        .copied()
        .filter(|n| ctx.receiver_kinds.contains(n.kind.as_str()))
        .collect();
    let receiver_nodes: Vec<&NodeInfo> = if is_local_definition {
        samefile_candidates
    } else {
        // Fall back to any cross-file class/struct/interface candidate.
        ctx.nodes_by_name.get(effective_receiver).cloned().unwrap_or_default()
            .into_iter()
            .filter(|n| ctx.receiver_kinds.contains(n.kind.as_str()))
            .collect()
    };

    if let Some(recv_target) = receiver_nodes.first() {
        // High bit separates receiver keys from call keys (matches JS recv| prefix)
        let recv_key = (1u64 << 63) | ((caller_id as u64) << 32) | (recv_target.id as u64);
        if !seen_edges.contains(&recv_key) {
            seen_edges.insert(recv_key);
            // Use the stored typeMap confidence when the receiver was type-resolved,
            // mirroring `typeConfidence ?? (typeName ? 0.9 : 0.7)` in resolveReceiverEdge.
            let confidence = type_entry.map(|&(_, c)| c).unwrap_or(0.7);
            edges.push(ComputedEdge {
                source_id: caller_id, target_id: recv_target.id,
                kind: "receiver".to_string(), confidence, dynamic: 0,
            });
        }
    }
}

/// Emit extends and implements edges for class hierarchy declarations.
fn emit_hierarchy_edges(
    ctx: &EdgeContext, file_input: &FileEdgeInput, rel_path: &str,
    edges: &mut Vec<ComputedEdge>,
) {
    for cls in &file_input.classes {
        let source_row = ctx.nodes_by_name_and_file
            .get(&(cls.name.as_str(), rel_path))
            .and_then(|v| v.iter().find(|n| HIERARCHY_SOURCE_KINDS.contains(&n.kind.as_str())));

        let Some(source) = source_row else { continue };

        if let Some(ref extends_name) = cls.extends {
            let targets = ctx.nodes_by_name.get(extends_name.as_str())
                .map(|v| v.iter().filter(|n| EXTENDS_TARGET_KINDS.contains(&n.kind.as_str())).collect::<Vec<_>>())
                .unwrap_or_default();
            for t in targets {
                edges.push(ComputedEdge {
                    source_id: source.id, target_id: t.id,
                    kind: "extends".to_string(), confidence: 1.0, dynamic: 0,
                });
            }
        }
        if let Some(ref implements_name) = cls.implements {
            let targets = ctx.nodes_by_name.get(implements_name.as_str())
                .map(|v| v.iter().filter(|n| IMPLEMENTS_TARGET_KINDS.contains(&n.kind.as_str())).collect::<Vec<_>>())
                .unwrap_or_default();
            for t in targets {
                edges.push(ComputedEdge {
                    source_id: source.id, target_id: t.id,
                    kind: "implements".to_string(), confidence: 1.0, dynamic: 0,
                });
            }
        }
    }
}

// ── Import edges (native) ──────────────────────────────────────────────

#[napi(object)]
pub struct ImportInfo {
    pub source: String,
    pub names: Vec<String>,
    pub reexport: bool,
    #[napi(js_name = "typeOnly")]
    pub type_only: bool,
    #[napi(js_name = "dynamicImport")]
    pub dynamic_import: bool,
    #[napi(js_name = "wildcardReexport")]
    pub wildcard_reexport: bool,
}

#[napi(object)]
pub struct ImportEdgeFileInput {
    pub file: String,
    #[napi(js_name = "fileNodeId")]
    pub file_node_id: u32,
    #[napi(js_name = "isBarrelOnly")]
    pub is_barrel_only: bool,
    pub imports: Vec<ImportInfo>,
    #[napi(js_name = "definitionNames")]
    pub definition_names: Vec<String>,
}

#[napi(object)]
pub struct ReexportEntryInput {
    pub source: String,
    pub names: Vec<String>,
    #[napi(js_name = "wildcardReexport")]
    pub wildcard_reexport: bool,
}

#[napi(object)]
pub struct FileReexports {
    pub file: String,
    pub reexports: Vec<ReexportEntryInput>,
}

#[napi(object)]
pub struct FileNodeEntry {
    pub file: String,
    #[napi(js_name = "nodeId")]
    pub node_id: u32,
}

#[napi(object)]
pub struct ResolvedImportEntry {
    pub key: String,
    #[napi(js_name = "resolvedPath")]
    pub resolved_path: String,
}

/// A symbol node entry for type-only import resolution.
/// Maps (name, file) → nodeId so the native engine can create symbol-level
/// `imports-type` edges (parity with the JS `buildImportEdges` path).
#[napi(object)]
pub struct SymbolNodeEntry {
    pub name: String,
    pub file: String,
    #[napi(js_name = "nodeId")]
    pub node_id: u32,
}

/// Shared lookup context for import edge building.
struct ImportEdgeContext<'a> {
    resolved: HashMap<&'a str, &'a str>,
    reexport_map: HashMap<&'a str, &'a [ReexportEntryInput]>,
    file_node_map: HashMap<&'a str, u32>,
    barrel_set: HashSet<&'a str>,
    file_defs: HashMap<&'a str, HashSet<&'a str>>,
    /// Symbol node lookup: (name, file) → node ID.
    /// Used to create symbol-level `imports-type` edges for type-only imports.
    symbol_node_map: HashMap<(&'a str, &'a str), u32>,
}

impl<'a> ImportEdgeContext<'a> {
    fn new(
        resolved_imports: &'a [ResolvedImportEntry],
        file_reexports: &'a [FileReexports],
        file_node_ids: &'a [FileNodeEntry],
        barrel_files: &'a [String],
        files: &'a [ImportEdgeFileInput],
        symbol_nodes: &'a [SymbolNodeEntry],
    ) -> Self {
        let mut resolved = HashMap::with_capacity(resolved_imports.len());
        for ri in resolved_imports {
            resolved.insert(ri.key.as_str(), ri.resolved_path.as_str());
        }

        let mut reexport_map: HashMap<&str, &[ReexportEntryInput]> =
            HashMap::with_capacity(file_reexports.len());
        for fr in file_reexports {
            reexport_map.insert(fr.file.as_str(), fr.reexports.as_slice());
        }

        let mut file_node_map = HashMap::with_capacity(file_node_ids.len());
        for entry in file_node_ids {
            file_node_map.insert(entry.file.as_str(), entry.node_id);
        }

        let barrel_set: HashSet<&str> = barrel_files.iter().map(|s| s.as_str()).collect();

        let mut file_defs: HashMap<&str, HashSet<&str>> = HashMap::with_capacity(files.len());
        for f in files {
            let defs: HashSet<&str> = f.definition_names.iter().map(|s| s.as_str()).collect();
            file_defs.insert(f.file.as_str(), defs);
        }

        let mut symbol_node_map = HashMap::with_capacity(symbol_nodes.len());
        for entry in symbol_nodes {
            symbol_node_map.insert((entry.name.as_str(), entry.file.as_str()), entry.node_id);
        }

        Self { resolved, reexport_map, file_node_map, barrel_set, file_defs, symbol_node_map }
    }
}

impl<'a> BarrelContext for ImportEdgeContext<'a> {
    fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>> {
        self.reexport_map.get(barrel_path).map(|entries| {
            entries
                .iter()
                .map(|re| ReexportRef {
                    source: re.source.as_str(),
                    names: &re.names,
                    wildcard_reexport: re.wildcard_reexport,
                })
                .collect()
        })
    }

    fn has_definition(&self, file_path: &str, symbol: &str) -> bool {
        self.file_defs
            .get(file_path)
            .map_or(false, |defs| defs.contains(symbol))
    }
}

/// Build import and barrel-through edges in Rust.
///
/// Mirrors `buildImportEdges()` + `buildBarrelEdges()` in build-edges.ts.
/// All import paths must be pre-resolved on the JS side before calling.
#[napi]
pub fn build_import_edges(
    files: Vec<ImportEdgeFileInput>,
    resolved_imports: Vec<ResolvedImportEntry>,
    file_reexports: Vec<FileReexports>,
    file_node_ids: Vec<FileNodeEntry>,
    barrel_files: Vec<String>,
    root_dir: String,
    #[napi(ts_arg_type = "SymbolNodeEntry[] | undefined")]
    symbol_nodes: Option<Vec<SymbolNodeEntry>>,
) -> Vec<ComputedEdge> {
    let empty_symbols = Vec::new();
    let symbols_ref = symbol_nodes.as_deref().unwrap_or(&empty_symbols);
    let ctx = ImportEdgeContext::new(
        &resolved_imports,
        &file_reexports,
        &file_node_ids,
        &barrel_files,
        &files,
        symbols_ref,
    );

    let mut edges = Vec::new();
    let normalized_root = root_dir.replace('\\', "/");
    for file_input in &files {
        let abs_file = format!("{normalized_root}/{}", file_input.file);
        for imp in &file_input.imports {
            process_single_import(&mut edges, file_input, imp, &abs_file, &ctx);
        }
    }
    edges
}

// ── build_import_edges helpers ──────────────────────────────────────────

/// Strip a `"* as "` / `"*\tas "` prefix from an import name so the bare
/// symbol can be looked up against the target's exports. JS equivalent:
/// `name.replace(/^\*\s+as\s+/, '')`.
fn strip_star_as_prefix(name: &str) -> &str {
    if name.starts_with("* as ") || name.starts_with("*\tas ") {
        &name[5..]
    } else {
        name
    }
}

/// Classify an import into its edge kind: reexports / imports-type /
/// dynamic-imports / imports. Mirrors the JS classifier in `build-edges.ts`.
fn classify_import_edge_kind(imp: &ImportInfo) -> &'static str {
    if imp.reexport {
        "reexports"
    } else if imp.type_only {
        "imports-type"
    } else if imp.dynamic_import {
        "dynamic-imports"
    } else {
        "imports"
    }
}

/// For a `type` import targeting a barrel or resolved file, emit one
/// symbol-level `imports-type` edge per named symbol so the target symbols
/// receive fan-in credit and aren't misclassified as dead code.
fn emit_type_only_symbol_edges(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    resolved_path: &str,
    ctx: &ImportEdgeContext,
) {
    if !imp.type_only || ctx.symbol_node_map.is_empty() {
        return;
    }
    for name in &imp.names {
        let clean_name = strip_star_as_prefix(name);
        let barrel_target = if ctx.barrel_set.contains(resolved_path) {
            let mut visited = HashSet::new();
            barrel_resolution::resolve_barrel_export(ctx, resolved_path, clean_name, &mut visited)
        } else {
            None
        };
        let sym_id = barrel_target
            .as_deref()
            .and_then(|f| ctx.symbol_node_map.get(&(clean_name, f)))
            .or_else(|| ctx.symbol_node_map.get(&(clean_name, resolved_path)));
        if let Some(&id) = sym_id {
            edges.push(ComputedEdge {
                source_id: file_input.file_node_id,
                target_id: id,
                kind: "imports-type".to_string(),
                confidence: 1.0,
                dynamic: 0,
            });
        }
    }
}

/// For a non-reexport import targeting a barrel file, walk the barrel
/// chain for each named symbol and emit a barrel-through edge to the
/// ultimate definition file. Deduplicates target files via
/// `resolved_sources`.
fn emit_barrel_through_edges(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    resolved_path: &str,
    edge_kind: &str,
    ctx: &ImportEdgeContext,
) {
    if imp.reexport || !ctx.barrel_set.contains(resolved_path) {
        return;
    }
    let barrel_kind = match edge_kind {
        "imports-type" => "imports-type",
        "dynamic-imports" => "dynamic-imports",
        _ => "imports",
    };
    let mut resolved_sources: HashSet<String> = HashSet::new();
    for name in &imp.names {
        let clean_name = strip_star_as_prefix(name);
        let mut visited = HashSet::new();
        let actual = barrel_resolution::resolve_barrel_export(
            ctx,
            resolved_path,
            clean_name,
            &mut visited,
        );
        let actual_source = match actual {
            Some(s) => s,
            None => continue,
        };
        if actual_source == resolved_path || resolved_sources.contains(&actual_source) {
            continue;
        }
        if let Some(&actual_node_id) = ctx.file_node_map.get(actual_source.as_str()) {
            edges.push(ComputedEdge {
                source_id: file_input.file_node_id,
                target_id: actual_node_id,
                kind: barrel_kind.to_string(),
                confidence: 0.9,
                dynamic: 0,
            });
        }
        resolved_sources.insert(actual_source);
    }
}

/// Process a single import from a file, emitting the primary file-to-file
/// edge plus any type-symbol and barrel-through edges.
fn process_single_import(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    abs_file: &str,
    ctx: &ImportEdgeContext,
) {
    if file_input.is_barrel_only && !imp.reexport {
        return;
    }
    let resolve_key = format!("{abs_file}|{}", imp.source);
    let resolved_path = match ctx.resolved.get(resolve_key.as_str()) {
        Some(p) => *p,
        None => return,
    };
    let target_node_id = match ctx.file_node_map.get(resolved_path) {
        Some(id) => *id,
        None => return,
    };
    let edge_kind = classify_import_edge_kind(imp);
    edges.push(ComputedEdge {
        source_id: file_input.file_node_id,
        target_id: target_node_id,
        kind: edge_kind.to_string(),
        confidence: 1.0,
        dynamic: 0,
    });
    emit_type_only_symbol_edges(edges, file_input, imp, resolved_path, ctx);
    emit_barrel_through_edges(edges, file_input, imp, resolved_path, edge_kind, ctx);
}

#[cfg(test)]
mod import_edge_tests {
    use super::*;

    fn make_file(file: &str, node_id: u32, imports: Vec<ImportInfo>, defs: Vec<&str>) -> ImportEdgeFileInput {
        ImportEdgeFileInput {
            file: file.to_string(),
            file_node_id: node_id,
            is_barrel_only: false,
            imports,
            definition_names: defs.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    fn make_import(source: &str, names: Vec<&str>, reexport: bool, type_only: bool, dynamic: bool) -> ImportInfo {
        ImportInfo {
            source: source.to_string(),
            names: names.into_iter().map(|s| s.to_string()).collect(),
            reexport,
            type_only,
            dynamic_import: dynamic,
            wildcard_reexport: false,
        }
    }

    fn make_resolved(from_abs: &str, source: &str, resolved: &str) -> ResolvedImportEntry {
        ResolvedImportEntry {
            key: format!("{}|{}", from_abs, source),
            resolved_path: resolved.to_string(),
        }
    }

    fn make_node_entry(file: &str, id: u32) -> FileNodeEntry {
        FileNodeEntry { file: file.to_string(), node_id: id }
    }

    #[test]
    fn basic_import_edge() {
        let files = vec![make_file("src/app.ts", 1, vec![
            make_import("./utils", vec!["foo"], false, false, false),
        ], vec!["main"])];
        let resolved = vec![make_resolved("/root/src/app.ts", "./utils", "src/utils.ts")];
        let node_ids = vec![make_node_entry("src/app.ts", 1), make_node_entry("src/utils.ts", 2)];

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string(), None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].source_id, 1);
        assert_eq!(edges[0].target_id, 2);
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[0].confidence, 1.0);
    }

    #[test]
    fn reexport_edge() {
        let files = vec![make_file("src/index.ts", 1, vec![
            make_import("./utils", vec!["foo"], true, false, false),
        ], vec![])];
        let resolved = vec![make_resolved("/root/src/index.ts", "./utils", "src/utils.ts")];
        let node_ids = vec![make_node_entry("src/index.ts", 1), make_node_entry("src/utils.ts", 2)];

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string(), None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "reexports");
    }

    #[test]
    fn type_only_edge() {
        let files = vec![make_file("src/app.ts", 1, vec![
            make_import("./types", vec!["MyType"], false, true, false),
        ], vec![])];
        let resolved = vec![make_resolved("/root/src/app.ts", "./types", "src/types.ts")];
        let node_ids = vec![make_node_entry("src/app.ts", 1), make_node_entry("src/types.ts", 2)];

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string(), None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "imports-type");
    }

    #[test]
    fn dynamic_import_edge() {
        let files = vec![make_file("src/app.ts", 1, vec![
            make_import("./lazy", vec!["Lazy"], false, false, true),
        ], vec![])];
        let resolved = vec![make_resolved("/root/src/app.ts", "./lazy", "src/lazy.ts")];
        let node_ids = vec![make_node_entry("src/app.ts", 1), make_node_entry("src/lazy.ts", 2)];

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string(), None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "dynamic-imports");
    }

    #[test]
    fn barrel_only_skips_non_reexport() {
        let mut file = make_file("src/index.ts", 1, vec![
            make_import("./a", vec!["a"], false, false, false),
            make_import("./b", vec!["b"], true, false, false),
        ], vec![]);
        file.is_barrel_only = true;
        let resolved = vec![
            make_resolved("/root/src/index.ts", "./a", "src/a.ts"),
            make_resolved("/root/src/index.ts", "./b", "src/b.ts"),
        ];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/a.ts", 2),
            make_node_entry("src/b.ts", 3),
        ];

        let edges = build_import_edges(vec![file], resolved, vec![], node_ids, vec![], "/root".to_string(), None);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "reexports");
        assert_eq!(edges[0].target_id, 3);
    }

    #[test]
    fn barrel_resolution_simple() {
        let files = vec![
            make_file("src/app.ts", 1, vec![
                make_import("./index", vec!["foo"], false, false, false),
            ], vec!["main"]),
            make_file("src/index.ts", 10, vec![], vec![]),
            make_file("src/utils.ts", 20, vec![], vec!["foo"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./index", "src/index.ts")];
        let reexports = vec![FileReexports {
            file: "src/index.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/utils.ts".to_string(),
                names: vec!["foo".to_string()],
                wildcard_reexport: false,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/index.ts", 10),
            make_node_entry("src/utils.ts", 20),
        ];
        let barrels = vec!["src/index.ts".to_string()];

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string(), None);
        assert_eq!(edges.len(), 2);
        // First: direct import to barrel
        assert_eq!(edges[0].target_id, 10);
        assert_eq!(edges[0].confidence, 1.0);
        // Second: barrel-through to actual source
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
        assert_eq!(edges[1].kind, "imports");
    }

    #[test]
    fn barrel_chain_two_levels() {
        let files = vec![
            make_file("src/app.ts", 1, vec![
                make_import("./index", vec!["deep"], false, false, false),
            ], vec![]),
            make_file("src/index.ts", 10, vec![], vec![]),
            make_file("src/mid.ts", 20, vec![], vec![]),
            make_file("src/deep.ts", 30, vec![], vec!["deep"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./index", "src/index.ts")];
        let reexports = vec![
            FileReexports {
                file: "src/index.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/mid.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                }],
            },
            FileReexports {
                file: "src/mid.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/deep.ts".to_string(),
                    names: vec!["deep".to_string()],
                    wildcard_reexport: false,
                }],
            },
        ];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/index.ts", 10),
            make_node_entry("src/deep.ts", 30),
        ];
        let barrels = vec!["src/index.ts".to_string()];

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string(), None);
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].target_id, 30);
        assert_eq!(edges[1].confidence, 0.9);
    }

    #[test]
    fn barrel_cycle_detection() {
        let files = vec![
            make_file("src/app.ts", 1, vec![
                make_import("./a", vec!["x"], false, false, false),
            ], vec![]),
            make_file("src/a.ts", 10, vec![], vec![]),
            make_file("src/b.ts", 20, vec![], vec![]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./a", "src/a.ts")];
        let reexports = vec![
            FileReexports {
                file: "src/a.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/b.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                }],
            },
            FileReexports {
                file: "src/b.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/a.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                }],
            },
        ];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/a.ts", 10),
        ];
        let barrels = vec!["src/a.ts".to_string()];

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string(), None);
        // Only the direct import edge, no barrel-through (cycle prevents resolution)
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_id, 10);
    }

    #[test]
    fn wildcard_reexport_resolution() {
        let files = vec![
            make_file("src/app.ts", 1, vec![
                make_import("./barrel", vec!["helper"], false, false, false),
            ], vec![]),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/helpers.ts", 20, vec![], vec!["helper"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./barrel", "src/barrel.ts")];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/helpers.ts".to_string(),
                names: vec![],
                wildcard_reexport: true,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/helpers.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string(), None);
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
    }

    #[test]
    fn dedup_barrel_sources() {
        // Two names from same barrel both resolve to the same actual source
        let files = vec![
            make_file("src/app.ts", 1, vec![
                make_import("./barrel", vec!["a", "b"], false, false, false),
            ], vec![]),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/real.ts", 20, vec![], vec!["a", "b"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./barrel", "src/barrel.ts")];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/real.ts".to_string(),
                names: vec!["a".to_string(), "b".to_string()],
                wildcard_reexport: false,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/real.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string(), None);
        // 1 direct import + 1 barrel-through (deduped, not 2)
        assert_eq!(edges.len(), 2);
    }
}

#[cfg(test)]
mod call_edge_tests {
    use super::*;

    fn node(id: u32, name: &str, kind: &str, file: &str, line: u32) -> NodeInfo {
        NodeInfo { id, name: name.to_string(), kind: kind.to_string(), file: file.to_string(), line }
    }

    fn def(name: &str, kind: &str, line: u32, end_line: u32) -> DefInfo {
        DefInfo {
            name: name.to_string(),
            kind: kind.to_string(),
            line,
            end_line: Some(end_line),
            params: None,
        }
    }

    fn call(name: &str, line: u32, receiver: Option<&str>) -> CallInfo {
        CallInfo { name: name.to_string(), line, dynamic: None, receiver: receiver.map(|s| s.to_string()) }
    }

    fn type_map_entry(name: &str, type_name: &str, confidence: f64) -> TypeMapInput {
        TypeMapInput { name: name.to_string(), type_name: type_name.to_string(), confidence }
    }

    fn make_file(
        file: &str,
        file_node_id: u32,
        defs: Vec<DefInfo>,
        calls: Vec<CallInfo>,
        type_map: Vec<TypeMapInput>,
        classes: Vec<ClassInfo>,
    ) -> FileEdgeInput {
        FileEdgeInput {
            file: file.to_string(),
            file_node_id,
            definitions: defs,
            calls,
            imported_names: vec![],
            classes,
            type_map,
            fn_ref_bindings: None,
            param_bindings: None,
            this_call_bindings: None,
            array_elem_bindings: None,
            spread_arg_bindings: None,
            for_of_bindings: None,
            array_callback_bindings: None,
            object_rest_param_bindings: None,
            object_prop_bindings: None,
        }
    }

    /// Mirrors the sample-project scenario: `const calc = new Calculator()` then
    /// `calc.compute(5, 6)` inside `main`. The native engine must emit a
    /// `receiver` edge from `main` → `Calculator`.
    #[test]
    fn receiver_edge_via_type_map() {
        let all_nodes = vec![
            node(1, "main",       "function", "index.js", 3),
            node(2, "Calculator", "class",    "utils.js", 1),
            node(3, "compute",    "method",   "utils.js", 3),
        ];

        let files = vec![make_file(
            "index.js",
            /* file_node_id */ 10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 1.0)],
            vec![],
        )];

        let edges = build_call_edges(files, all_nodes, vec![]);

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "expected a receiver edge but got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
        let re = receiver_edge.unwrap();
        assert_eq!(re.source_id, 1, "receiver edge source should be main (id=1)");
        assert_eq!(re.target_id, 2, "receiver edge target should be Calculator (id=2)");
    }

    /// Regression: when the same file has a `kind="function"` node for the
    /// effective receiver created by a destructured import (e.g.
    /// `const { Calculator } = require('./utils')`), that import artifact must
    /// NOT block the fallback to the global class node in another file.
    /// The import must be listed in `imported_names` so the resolver knows it
    /// is an import artifact, not a local function-constructor definition.
    #[test]
    fn receiver_edge_imported_function_node_falls_through_to_global_class() {
        let all_nodes = vec![
            node(1, "main",       "function", "index.js", 3),
            // Destructured import `const { Calculator } = require('./utils')` → kind "function" in index.js
            node(4, "Calculator", "function", "index.js", 1),
            node(2, "Calculator", "class",    "utils.js", 1),
            node(3, "compute",    "method",   "utils.js", 3),
        ];

        let mut file = make_file(
            "index.js",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 1.0)],
            vec![],
        );
        // Mark `Calculator` as an imported name so the resolver treats the
        // same-file kind="function" node as an import artifact and falls through.
        file.imported_names = vec![ImportedName { name: "Calculator".to_string(), file: "utils.js".to_string() }];

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "imported 'function' node must not block fallback to global class; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
        let re = receiver_edge.unwrap();
        assert_eq!(re.target_id, 2, "receiver edge must point to Calculator class (id=2), not import artifact (id=4)");
    }

    /// Issue #1539: `function C(){}` (function constructor) in the same file as
    /// `var v = new C(); v.foo()` must block the global fallback to any cross-file
    /// class `C`.  A locally-defined function constructor owns the name in its
    /// file — no cross-file class should win over it.
    #[test]
    fn receiver_edge_local_function_ctor_blocks_global_class() {
        let all_nodes = vec![
            node(1, "C",     "function", "prototypes.js", 1),  // local function constructor
            node(2, "C.foo", "method",   "prototypes.js", 3),
            node(3, "C",     "class",    "classes.js",    1),  // cross-file class with same name
        ];

        // No imported_names — `C` is locally defined.
        let files = vec![make_file(
            "prototypes.js",
            10,
            vec![def("C", "function", 1, 2)],
            vec![call("foo", 8, Some("v"))],
            vec![type_map_entry("v", "C", 1.0)],
            vec![],
        )];

        let edges = build_call_edges(files, all_nodes, vec![]);

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_none(),
            "local function constructor must block global class fallback — no receiver edge expected; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Issue #1453: `this.logger.error()` inside `UserService.create` where the
    /// constructor seeded the class-scoped key `UserService.logger → Logger`.
    /// The resolver must fall back to the `ClassName.prop` typeMap key (#1323).
    #[test]
    fn class_scoped_type_map_key_resolves_this_prop_receiver() {
        let all_nodes = vec![
            node(1, "UserService.create", "method", "svc.js", 10),
            node(2, "Logger.error", "method", "logger.js", 5),
            node(3, "Logger", "class", "logger.js", 1),
        ];
        let files = vec![make_file(
            "svc.js",
            10,
            vec![def("UserService.create", "method", 10, 20)],
            vec![call("error", 15, Some("this.logger"))],
            vec![type_map_entry("UserService.logger", "Logger", 1.0)],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        assert!(
            edges.iter().any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected calls edge UserService.create → Logger.error; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Phase 8.3f (#1358): callee-scoped rest-param key `callee::restName` must
    /// be consulted when the bare receiver has no typeMap entry.
    #[test]
    fn rest_param_scoped_type_map_key() {
        let all_nodes = vec![
            node(1, "useRest", "function", "a.js", 1),
            node(2, "E4.e4", "method", "a.js", 30),
        ];
        let files = vec![make_file(
            "a.js",
            10,
            vec![def("useRest", "function", 1, 10)],
            vec![call("e4", 5, Some("eerest"))],
            vec![type_map_entry("useRest::eerest", "E4", 0.85)],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        assert!(
            edges.iter().any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected calls edge useRest → E4.e4 via rest-param key; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Bare (no-receiver) calls in JS/TS are module-scoped: `flush()` inside
    /// `Processor.run` must NOT resolve to `Processor.flush` (#1422 parity).
    #[test]
    fn bare_call_in_js_skips_same_class_fallback() {
        let all_nodes = vec![
            node(1, "Processor.run", "method", "proc.js", 10),
            node(2, "Processor.flush", "method", "proc.js", 30),
        ];
        let files = vec![make_file(
            "proc.js",
            10,
            vec![def("Processor.run", "method", 10, 20)],
            vec![call("flush", 15, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        assert!(
            !edges.iter().any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "bare call must not resolve to same-class sibling in a module-scoped language"
        );
    }

    /// In class-scoped languages (e.g. C#), bare sibling calls DO resolve:
    /// `IsValidEmail()` inside `Validators.ValidateUser` → `Validators.IsValidEmail`.
    #[test]
    fn bare_call_in_class_scoped_language_resolves_sibling() {
        let all_nodes = vec![
            node(1, "Validators.ValidateUser", "method", "v.cs", 10),
            node(2, "Validators.IsValidEmail", "method", "v.cs", 30),
        ];
        let files = vec![make_file(
            "v.cs",
            10,
            vec![def("Validators.ValidateUser", "method", 10, 20)],
            vec![call("IsValidEmail", 15, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        assert!(
            edges.iter().any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "bare sibling call must resolve in a class-scoped language; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// `self.area()` inside a namespace-qualified method `Geo.Shape.describe`
    /// must resolve via the bare class segment (`Shape.area`), not the full
    /// prefix (`Geo.Shape.area`) — symbols are stored under their bare class name.
    #[test]
    fn class_scoped_fallback_uses_segment_before_method() {
        let all_nodes = vec![
            node(1, "Geo.Shape.describe", "method", "s.py", 10),
            node(2, "Shape.area", "method", "s.py", 30),
        ];
        let files = vec![make_file(
            "s.py",
            10,
            vec![def("Geo.Shape.describe", "method", 10, 20)],
            vec![call("area", 15, Some("self"))],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        assert!(
            edges.iter().any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected Geo.Shape.describe → Shape.area via bare class segment; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Receiver-edge confidence must propagate the stored typeMap confidence
    /// (e.g. 0.85 from a pts property-write) instead of a flat 0.9 — mirrors
    /// `typeConfidence ?? (typeName ? 0.9 : 0.7)` in resolveReceiverEdge.
    #[test]
    fn receiver_edge_uses_stored_type_map_confidence() {
        let all_nodes = vec![
            node(1, "main", "function", "index.js", 3),
            node(2, "Calculator", "class", "utils.js", 1),
            node(3, "Calculator.compute", "method", "utils.js", 3),
        ];
        let files = vec![make_file(
            "index.js",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 0.85)],
            vec![],
        )];
        let edges = build_call_edges(files, all_nodes, vec![]);
        let re = edges.iter().find(|e| e.kind == "receiver").expect("receiver edge");
        assert!(
            (re.confidence - 0.85).abs() < 1e-9,
            "expected stored confidence 0.85, got {}",
            re.confidence
        );
    }

    /// When the receiver name is already a class (not a variable), the edge
    /// should still be emitted using the raw receiver name as lookup key.
    #[test]
    fn receiver_edge_direct_class_name() {
        let all_nodes = vec![
            node(1, "main",       "function", "index.js", 1),
            node(2, "Calculator", "class",    "utils.js", 1),
        ];

        let files = vec![make_file(
            "index.js",
            10,
            vec![def("main", "function", 1, 5)],
            vec![call("compute", 3, Some("Calculator"))],
            vec![],  // no typeMap — receiver IS the class name
            vec![],
        )];

        let edges = build_call_edges(files, all_nodes, vec![]);

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(receiver_edge.is_some(), "expected receiver edge for direct class-name receiver");
        assert_eq!(receiver_edge.unwrap().target_id, 2);
    }

    // ── Points-to constraint solver (parity with buildPointsToMap) ──────────

    fn def_with_params(name: &str, line: u32, end_line: u32, params: &[&str]) -> DefInfo {
        DefInfo {
            name: name.to_string(),
            kind: "function".to_string(),
            line,
            end_line: Some(end_line),
            params: Some(params.iter().map(|s| s.to_string()).collect()),
        }
    }

    /// `hof(target)` + `cb()` inside `hof(cb)` must emit hof→target via the
    /// param-flow constraint `hof::cb ⊇ target`.
    #[test]
    fn pts_param_flow_resolves_callback_through_parameter() {
        let all_nodes = vec![
            node(1, "hof",    "function", "lib.js", 1),
            node(2, "target", "function", "lib.js", 5),
            node(3, "main",   "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![
                def_with_params("hof", 1, 3, &["cb"]),
                def("target", "function", 5, 6),
                def("main", "function", 8, 10),
            ],
            vec![call("cb", 2, None), call("hof", 9, None)],
            vec![],
            vec![],
        );
        file.param_bindings = Some(vec![ParamBinding {
            callee: "hof".to_string(),
            arg_index: 0,
            arg_name: "target".to_string(),
        }]);

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        assert!(
            edges.iter().any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge hof→target; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
        assert!(
            edges.iter().any(|e| e.source_id == 3 && e.target_id == 1 && e.kind == "calls"),
            "expected direct edge main→hof; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
    }

    /// `invoker.call(handler, 10)` + `this()` inside `invoker` must emit
    /// invoker→handler via the thisCallBinding conversion `invoker::this ⊇ handler`.
    #[test]
    fn pts_this_call_binding_resolves_this_invocation() {
        let all_nodes = vec![
            node(1, "invoker",     "function", "lib.js", 1),
            node(2, "handler",     "function", "lib.js", 5),
            node(3, "runCallThis", "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![
                def("invoker", "function", 1, 3),
                def("handler", "function", 5, 6),
                def("runCallThis", "function", 8, 10),
            ],
            vec![
                // this() inside invoker
                call("this", 2, None),
                // invoker.call(handler, 10) — extractor emits dynamic call to invoker
                CallInfo { name: "invoker".to_string(), line: 9, dynamic: Some(true), receiver: None },
            ],
            vec![],
            vec![],
        );
        file.this_call_bindings = Some(vec![ThisCallBinding {
            callee: "invoker".to_string(),
            this_arg: "handler".to_string(),
        }]);

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        assert!(
            edges.iter().any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge invoker→handler; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
        assert!(
            edges.iter().any(|e| e.source_id == 3 && e.target_id == 1 && e.kind == "calls"),
            "expected direct edge runCallThis→invoker; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
    }

    /// for-of over a function array: `for (const cb of arr) cb()` must emit
    /// iterPlain→forOf1 and iterPlain→forOf2 through the wildcard constraint
    /// `iterPlain::cb ⊇ arr[*]`.
    #[test]
    fn pts_for_of_over_array_elements_resolves_all_elements() {
        let all_nodes = vec![
            node(1, "forOf1",   "function", "for-of.js", 1),
            node(2, "forOf2",   "function", "for-of.js", 3),
            node(3, "iterPlain", "function", "for-of.js", 6),
        ];
        let mut file = make_file(
            "for-of.js",
            10,
            vec![
                def("forOf1", "function", 1, 2),
                def("forOf2", "function", 3, 4),
                def("iterPlain", "function", 6, 9),
            ],
            vec![call("cb", 8, None)],
            vec![],
            vec![],
        );
        file.array_elem_bindings = Some(vec![
            ArrayElemBinding { array_name: "arr".to_string(), index: 0, elem_name: "forOf1".to_string() },
            ArrayElemBinding { array_name: "arr".to_string(), index: 1, elem_name: "forOf2".to_string() },
        ]);
        file.for_of_bindings = Some(vec![ForOfBinding {
            var_name: "cb".to_string(),
            source_name: "arr".to_string(),
            enclosing_func: "iterPlain".to_string(),
        }]);

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        for target in [1u32, 2u32] {
            assert!(
                edges.iter().any(|e| e.source_id == 3 && e.target_id == target && e.kind == "calls"),
                "expected pts edge iterPlain→node{}; got: {:?}",
                target,
                edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
            );
        }
    }

    /// Object-rest dispatch: `f3(obj)` where `obj = {{ e4 }}` and `f3({{...rest}})`
    /// calls `rest.e4()` — resolves via the seeded pts key `rest.e4`.
    #[test]
    fn pts_object_rest_receiver_call_resolves_via_seeded_prop() {
        let all_nodes = vec![
            node(1, "f3",   "function", "lib.js", 1),
            node(2, "e4",   "function", "other.js", 1),
            node(3, "main", "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![def("f3", "function", 1, 3), def("main", "function", 8, 10)],
            vec![
                // eerest.e4() inside f3
                CallInfo { name: "e4".to_string(), line: 2, dynamic: None, receiver: Some("eerest".to_string()) },
                call("f3", 9, None),
            ],
            vec![],
            vec![],
        );
        file.imported_names = vec![ImportedName { name: "e4".to_string(), file: "other.js".to_string() }];
        file.param_bindings = Some(vec![ParamBinding {
            callee: "f3".to_string(),
            arg_index: 0,
            arg_name: "obj".to_string(),
        }]);
        file.object_rest_param_bindings = Some(vec![ObjectRestParamBinding {
            callee: "f3".to_string(),
            rest_name: "eerest".to_string(),
            arg_index: 0,
        }]);
        file.object_prop_bindings = Some(vec![ObjectPropBinding {
            object_name: "obj".to_string(),
            prop_name: "e4".to_string(),
            value_name: "e4".to_string(),
        }]);

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        assert!(
            edges.iter().any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge f3→e4 via rest receiver; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
    }

    /// Spread dispatch: `callAll(...fns)` with `fns = [x, y]` flows the array
    /// elements into callAll's parameters positionally.
    #[test]
    fn pts_spread_args_flow_array_elements_into_params() {
        let all_nodes = vec![
            node(1, "callAll", "function", "spread.js", 1),
            node(2, "x",       "function", "spread.js", 5),
            node(3, "y",       "function", "spread.js", 6),
            node(4, "main",    "function", "spread.js", 8),
        ];
        let mut file = make_file(
            "spread.js",
            10,
            vec![
                def_with_params("callAll", 1, 3, &["a", "b"]),
                def("x", "function", 5, 5),
                def("y", "function", 6, 6),
                def("main", "function", 8, 10),
            ],
            vec![call("a", 2, None), call("b", 2, None), call("callAll", 9, None)],
            vec![],
            vec![],
        );
        file.array_elem_bindings = Some(vec![
            ArrayElemBinding { array_name: "fns".to_string(), index: 0, elem_name: "x".to_string() },
            ArrayElemBinding { array_name: "fns".to_string(), index: 1, elem_name: "y".to_string() },
        ]);
        file.spread_arg_bindings = Some(vec![SpreadArgBinding {
            callee: "callAll".to_string(),
            array_name: "fns".to_string(),
            start_index: 0,
        }]);

        let edges = build_call_edges(vec![file], all_nodes, vec![]);

        assert!(
            edges.iter().any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge callAll→x; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
        assert!(
            edges.iter().any(|e| e.source_id == 1 && e.target_id == 3 && e.kind == "calls"),
            "expected pts edge callAll→y; got: {:?}",
            edges.iter().map(|e| (e.source_id, e.target_id, &e.kind)).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod inline_new_type_tests {
    use super::extract_inline_new_type;

    #[test]
    fn parens_new_uppercase() {
        assert_eq!(extract_inline_new_type("(new Foo)"), Some("Foo".to_string()));
    }

    #[test]
    fn parens_new_with_args() {
        // (new Foo('arg')) — parens and constructor args
        assert_eq!(extract_inline_new_type("(new Foo('arg'))"), Some("Foo".to_string()));
    }

    #[test]
    fn no_parens_new_uppercase() {
        assert_eq!(extract_inline_new_type("new Bar"), Some("Bar".to_string()));
    }

    #[test]
    fn underscore_prefix_accepted() {
        assert_eq!(extract_inline_new_type("new _Factory"), Some("_Factory".to_string()));
    }

    #[test]
    fn dollar_prefix_accepted() {
        assert_eq!(extract_inline_new_type("new $Service"), Some("$Service".to_string()));
    }

    #[test]
    fn lowercase_constructor_rejected() {
        // `new foo()` — lowercase, should return None to avoid false positives
        assert_eq!(extract_inline_new_type("new foo"), None);
    }

    #[test]
    fn not_a_new_expression() {
        // plain receiver name — no `new` keyword
        assert_eq!(extract_inline_new_type("myVar"), None);
    }

    #[test]
    fn new_without_whitespace_is_not_new_keyword() {
        // `newFoo` — not a `new` keyword, just an identifier
        assert_eq!(extract_inline_new_type("newFoo"), None);
    }
}
