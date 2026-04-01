use std::collections::{HashMap, HashSet};

use napi_derive::napi;

use crate::import_resolution;

/// Kind sets for hierarchy edge resolution -- mirrors the JS constants in
/// `build-edges.js` (`HIERARCHY_SOURCE_KINDS`, `EXTENDS_TARGET_KINDS`,
/// `IMPLEMENTS_TARGET_KINDS`).  Keeping them in one place prevents the
/// native/WASM drift that caused the original parity bug.
const HIERARCHY_SOURCE_KINDS: &[&str] = &["class", "struct", "record", "enum"];
const EXTENDS_TARGET_KINDS: &[&str] = &["class", "struct", "trait", "record"];
const IMPLEMENTS_TARGET_KINDS: &[&str] = &["interface", "trait", "class"];

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
}

#[napi(object)]
pub struct TypeMapInput {
    pub name: String,
    #[napi(js_name = "typeName")]
    pub type_name: String,
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
    _name: &'a str,
    line: u32,
    end_line: u32,
    node_id: Option<u32>,
}

/// Shared lookup context built once per `build_call_edges` invocation.
struct EdgeContext<'a> {
    nodes_by_name: HashMap<&'a str, Vec<&'a NodeInfo>>,
    nodes_by_name_and_file: HashMap<(&'a str, &'a str), Vec<&'a NodeInfo>>,
    builtin_set: HashSet<&'a str>,
    receiver_kinds: HashSet<&'a str>,
}

impl<'a> EdgeContext<'a> {
    fn new(all_nodes: &'a [NodeInfo], builtin_receivers: &'a [String]) -> Self {
        let mut nodes_by_name: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
        let mut nodes_by_name_and_file: HashMap<(&str, &str), Vec<&NodeInfo>> = HashMap::new();
        for node in all_nodes {
            nodes_by_name.entry(&node.name).or_default().push(node);
            nodes_by_name_and_file
                .entry((&node.name, &node.file))
                .or_default()
                .push(node);
        }
        let builtin_set: HashSet<&str> = builtin_receivers.iter().map(|s| s.as_str()).collect();
        let receiver_kinds: HashSet<&str> = ["class", "struct", "interface", "type", "module"]
            .iter().copied().collect();
        Self { nodes_by_name, nodes_by_name_and_file, builtin_set, receiver_kinds }
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

/// Process a single file: build per-file maps and emit call/receiver/hierarchy edges.
fn process_file<'a>(
    ctx: &EdgeContext<'a>,
    file_input: &'a FileEdgeInput,
    all_nodes: &'a [NodeInfo],
    edges: &mut Vec<ComputedEdge>,
) {
    let rel_path = &file_input.file;
    let file_node_id = file_input.file_node_id;

    let imported_names: HashMap<&str, &str> = file_input
        .imported_names.iter()
        .map(|im| (im.name.as_str(), im.file.as_str()))
        .collect();

    let type_map: HashMap<&str, &str> = file_input
        .type_map.iter()
        .map(|tm| (tm.name.as_str(), tm.type_name.as_str()))
        .collect();

    let file_nodes: Vec<&NodeInfo> = all_nodes.iter().filter(|n| n.file == *rel_path).collect();
    let defs_with_ids: Vec<DefWithId> = file_input.definitions.iter().map(|d| {
        let node_id = file_nodes.iter()
            .find(|n| n.name == d.name && n.kind == d.kind && n.line == d.line)
            .map(|n| n.id);
        DefWithId { _name: &d.name, line: d.line, end_line: d.end_line.unwrap_or(u32::MAX), node_id }
    }).collect();

    let mut seen_edges: HashSet<u64> = HashSet::new();

    for call in &file_input.calls {
        if let Some(ref receiver) = call.receiver {
            if ctx.builtin_set.contains(receiver.as_str()) { continue; }
        }

        let caller_id = find_enclosing_caller(&defs_with_ids, call.line, file_node_id);
        let is_dynamic = if call.dynamic.unwrap_or(false) { 1u32 } else { 0u32 };
        let imported_from = imported_names.get(call.name.as_str()).copied();

        let mut targets = resolve_call_targets(ctx, call, rel_path, imported_from, &type_map);
        sort_targets_by_confidence(&mut targets, rel_path, imported_from);
        emit_call_edges(&targets, caller_id, is_dynamic, rel_path, imported_from, &mut seen_edges, edges);
        emit_receiver_edge(ctx, call, caller_id, rel_path, &type_map, &mut seen_edges, edges);
    }

    emit_hierarchy_edges(ctx, file_input, rel_path, edges);
}

/// Find the narrowest enclosing definition for a call at the given line.
fn find_enclosing_caller(defs: &[DefWithId], call_line: u32, file_node_id: u32) -> u32 {
    let mut caller_id = file_node_id;
    let mut caller_span = u32::MAX;
    for def in defs {
        if def.line <= call_line && call_line <= def.end_line {
            let span = def.end_line - def.line;
            if span < caller_span {
                if let Some(id) = def.node_id {
                    caller_id = id;
                    caller_span = span;
                }
            }
        }
    }
    caller_id
}

/// Multi-strategy call target resolution: import-aware → same-file → method → type-aware → scoped.
fn resolve_call_targets<'a>(
    ctx: &EdgeContext<'a>,
    call: &CallInfo,
    rel_path: &str,
    imported_from: Option<&str>,
    type_map: &HashMap<&str, &str>,
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

    // 3. Method name match
    let suffix = format!(".{}", call.name);
    let method_candidates: Vec<&NodeInfo> = ctx.nodes_by_name
        .get(call.name.as_str())
        .map(|v| v.iter().filter(|n| n.kind == "method" && n.name.ends_with(&suffix)).copied().collect())
        .unwrap_or_default();
    if !method_candidates.is_empty() { return method_candidates; }

    // 4. Type-aware resolution via receiver → type map
    if let Some(ref receiver) = call.receiver {
        if let Some(type_name) = type_map.get(receiver.as_str()) {
            let qualified = format!("{}.{}", type_name, call.name);
            let typed: Vec<&NodeInfo> = ctx.nodes_by_name
                .get(qualified.as_str())
                .map(|v| v.iter().filter(|n| n.kind == "method").copied().collect())
                .unwrap_or_default();
            if !typed.is_empty() { return typed; }
        }
    }

    // 5. Scoped fallback (this/self/super or no receiver)
    if call.receiver.is_none()
        || call.receiver.as_deref() == Some("this")
        || call.receiver.as_deref() == Some("self")
        || call.receiver.as_deref() == Some("super")
    {
        return ctx.nodes_by_name
            .get(call.name.as_str())
            .map(|v| v.iter()
                .filter(|n| import_resolution::compute_confidence(rel_path, &n.file, None) >= 0.5)
                .copied().collect())
            .unwrap_or_default();
    }

    Vec::new()
}

/// Sort targets by confidence descending.
fn sort_targets_by_confidence(targets: &mut Vec<&NodeInfo>, rel_path: &str, imported_from: Option<&str>) {
    if targets.len() > 1 {
        targets.sort_by(|a, b| {
            let conf_a = import_resolution::compute_confidence(rel_path, &a.file, imported_from);
            let conf_b = import_resolution::compute_confidence(rel_path, &b.file, imported_from);
            conf_b.partial_cmp(&conf_a).unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// Emit call edges from caller to resolved targets (deduped).
fn emit_call_edges(
    targets: &[&NodeInfo], caller_id: u32, is_dynamic: u32,
    rel_path: &str, imported_from: Option<&str>,
    seen_edges: &mut HashSet<u64>, edges: &mut Vec<ComputedEdge>,
) {
    for t in targets {
        let edge_key = ((caller_id as u64) << 32) | (t.id as u64);
        if t.id != caller_id && !seen_edges.contains(&edge_key) {
            seen_edges.insert(edge_key);
            let confidence = import_resolution::compute_confidence(rel_path, &t.file, imported_from);
            edges.push(ComputedEdge {
                source_id: caller_id, target_id: t.id,
                kind: "calls".to_string(), confidence, dynamic: is_dynamic,
            });
        }
    }
}

/// Emit a receiver edge from caller to the receiver's type node (if applicable).
fn emit_receiver_edge(
    ctx: &EdgeContext, call: &CallInfo, caller_id: u32, rel_path: &str,
    type_map: &HashMap<&str, &str>,
    seen_edges: &mut HashSet<u64>, edges: &mut Vec<ComputedEdge>,
) {
    let Some(ref receiver) = call.receiver else { return };
    if ctx.builtin_set.contains(receiver.as_str())
        || receiver == "this" || receiver == "self" || receiver == "super"
    { return; }

    let effective_receiver = type_map.get(receiver.as_str()).copied().unwrap_or(receiver.as_str());
    let type_resolved = effective_receiver != receiver.as_str();

    let samefile = ctx.nodes_by_name_and_file
        .get(&(effective_receiver, rel_path))
        .cloned().unwrap_or_default();
    let candidates = if !samefile.is_empty() { samefile } else {
        ctx.nodes_by_name.get(effective_receiver).cloned().unwrap_or_default()
    };
    let receiver_nodes: Vec<&NodeInfo> = candidates.into_iter()
        .filter(|n| ctx.receiver_kinds.contains(n.kind.as_str())).collect();

    if let Some(recv_target) = receiver_nodes.first() {
        // High bit separates receiver keys from call keys (matches JS recv| prefix)
        let recv_key = (1u64 << 63) | ((caller_id as u64) << 32) | (recv_target.id as u64);
        if !seen_edges.contains(&recv_key) {
            seen_edges.insert(recv_key);
            let confidence = if type_resolved { 0.9 } else { 0.7 };
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

/// Shared lookup context for import edge building.
struct ImportEdgeContext<'a> {
    resolved: HashMap<&'a str, &'a str>,
    reexport_map: HashMap<&'a str, &'a [ReexportEntryInput]>,
    file_node_map: HashMap<&'a str, u32>,
    barrel_set: HashSet<&'a str>,
    file_defs: HashMap<&'a str, HashSet<&'a str>>,
}

impl<'a> ImportEdgeContext<'a> {
    fn new(
        resolved_imports: &'a [ResolvedImportEntry],
        file_reexports: &'a [FileReexports],
        file_node_ids: &'a [FileNodeEntry],
        barrel_files: &'a [String],
        files: &'a [ImportEdgeFileInput],
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

        Self { resolved, reexport_map, file_node_map, barrel_set, file_defs }
    }
}

/// Recursively resolve a symbol through barrel reexport chains.
/// Mirrors `resolveBarrelExport()` in resolve-imports.ts.
fn resolve_barrel_export<'a>(
    ctx: &'a ImportEdgeContext<'a>,
    barrel_path: &'a str,
    symbol_name: &str,
    visited: &mut HashSet<&'a str>,
) -> Option<&'a str> {
    if visited.contains(barrel_path) {
        return None;
    }
    visited.insert(barrel_path);

    let reexports = ctx.reexport_map.get(barrel_path)?;

    for re in reexports.iter() {
        // Named reexports (non-wildcard)
        if !re.names.is_empty() && !re.wildcard_reexport {
            if re.names.iter().any(|n| n == symbol_name) {
                if let Some(defs) = ctx.file_defs.get(re.source.as_str()) {
                    if defs.contains(symbol_name) {
                        return Some(re.source.as_str());
                    }
                    let deeper = resolve_barrel_export(ctx, re.source.as_str(), symbol_name, visited);
                    if deeper.is_some() {
                        return deeper;
                    }
                }
                // Fallback: return source even if no definition found
                return Some(re.source.as_str());
            }
            continue;
        }

        // Wildcard or empty-names reexports
        if re.wildcard_reexport || re.names.is_empty() {
            if let Some(defs) = ctx.file_defs.get(re.source.as_str()) {
                if defs.contains(symbol_name) {
                    return Some(re.source.as_str());
                }
                let deeper = resolve_barrel_export(ctx, re.source.as_str(), symbol_name, visited);
                if deeper.is_some() {
                    return deeper;
                }
            }
        }
    }

    None
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
) -> Vec<ComputedEdge> {
    let ctx = ImportEdgeContext::new(
        &resolved_imports,
        &file_reexports,
        &file_node_ids,
        &barrel_files,
        &files,
    );

    let mut edges = Vec::new();

    for file_input in &files {
        let abs_file = format!("{}/{}", root_dir, file_input.file);

        for imp in &file_input.imports {
            // Barrel-only files: only emit reexport edges
            if file_input.is_barrel_only && !imp.reexport {
                continue;
            }

            // Look up resolved path
            let resolve_key = format!("{}|{}", abs_file, imp.source);
            let resolved_path = match ctx.resolved.get(resolve_key.as_str()) {
                Some(p) => *p,
                None => continue,
            };

            // Look up target file node ID
            let target_node_id = match ctx.file_node_map.get(resolved_path) {
                Some(id) => *id,
                None => continue,
            };

            // Determine edge kind
            let edge_kind = if imp.reexport {
                "reexports"
            } else if imp.type_only {
                "imports-type"
            } else if imp.dynamic_import {
                "dynamic-imports"
            } else {
                "imports"
            };

            edges.push(ComputedEdge {
                source_id: file_input.file_node_id,
                target_id: target_node_id,
                kind: edge_kind.to_string(),
                confidence: 1.0,
                dynamic: 0,
            });

            // Barrel resolution: if not reexport and target is a barrel file
            if !imp.reexport && ctx.barrel_set.contains(resolved_path) {
                let mut resolved_sources: HashSet<&str> = HashSet::new();
                for name in &imp.names {
                    let clean_name = if name.starts_with("* as ") || name.starts_with("*\tas ") {
                        // Strip "* as " prefix — regex replacement in JS: /^\*\s+as\s+/
                        match name.find(" as ") {
                            Some(pos) => &name[pos + 4..],
                            None => name.as_str(),
                        }
                    } else {
                        name.as_str()
                    };

                    let mut visited = HashSet::new();
                    let actual = resolve_barrel_export(&ctx, resolved_path, clean_name, &mut visited);

                    if let Some(actual_source) = actual {
                        if actual_source != resolved_path && !resolved_sources.contains(actual_source) {
                            resolved_sources.insert(actual_source);
                            if let Some(&actual_node_id) = ctx.file_node_map.get(actual_source) {
                                let barrel_kind = match edge_kind {
                                    "imports-type" => "imports-type",
                                    "dynamic-imports" => "dynamic-imports",
                                    _ => "imports",
                                };
                                edges.push(ComputedEdge {
                                    source_id: file_input.file_node_id,
                                    target_id: actual_node_id,
                                    kind: barrel_kind.to_string(),
                                    confidence: 0.9,
                                    dynamic: 0,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    edges
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

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string());
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

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string());
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

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string());
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

        let edges = build_import_edges(files, resolved, vec![], node_ids, vec![], "/root".to_string());
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

        let edges = build_import_edges(vec![file], resolved, vec![], node_ids, vec![], "/root".to_string());
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

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string());
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

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string());
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

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string());
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

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string());
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

        let edges = build_import_edges(files, resolved, reexports, node_ids, barrels, "/root".to_string());
        // 1 direct import + 1 barrel-through (deduped, not 2)
        assert_eq!(edges.len(), 2);
    }
}
