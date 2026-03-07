use std::collections::{HashMap, HashSet};

use napi_derive::napi;

use crate::import_resolution;

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
pub struct FileEdgeInput {
    pub file: String,
    #[napi(js_name = "fileNodeId")]
    pub file_node_id: u32,
    pub definitions: Vec<DefInfo>,
    pub calls: Vec<CallInfo>,
    #[napi(js_name = "importedNames")]
    pub imported_names: Vec<ImportedName>,
    pub classes: Vec<ClassInfo>,
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
    let builtin_set: HashSet<&str> = builtin_receivers.iter().map(|s| s.as_str()).collect();

    // Build lookup maps (mirrors nodesByName / nodesByNameAndFile in JS)
    let mut nodes_by_name: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
    let mut nodes_by_name_and_file: HashMap<(&str, &str), Vec<&NodeInfo>> = HashMap::new();

    for node in &all_nodes {
        nodes_by_name.entry(&node.name).or_default().push(node);
        nodes_by_name_and_file
            .entry((&node.name, &node.file))
            .or_default()
            .push(node);
    }

    let receiver_kinds: HashSet<&str> = ["class", "struct", "interface", "type", "module"]
        .iter()
        .copied()
        .collect();

    let mut edges = Vec::new();

    for file_input in &files {
        let rel_path = &file_input.file;
        let file_node_id = file_input.file_node_id;

        // Build imported names map (pre-resolved including barrels by JS)
        let imported_names: HashMap<&str, &str> = file_input
            .imported_names
            .iter()
            .map(|im| (im.name.as_str(), im.file.as_str()))
            .collect();

        // Build def → node ID map for caller resolution (match by name+kind+file+line)
        let file_nodes: Vec<&NodeInfo> = all_nodes.iter().filter(|n| n.file == *rel_path).collect();

        struct DefWithId<'a> {
            _name: &'a str,
            line: u32,
            end_line: u32,
            node_id: Option<u32>,
        }

        let defs_with_ids: Vec<DefWithId> = file_input
            .definitions
            .iter()
            .map(|d| {
                let node_id = file_nodes
                    .iter()
                    .find(|n| n.name == d.name && n.kind == d.kind && n.line == d.line)
                    .map(|n| n.id);
                DefWithId {
                    _name: &d.name,
                    line: d.line,
                    end_line: d.end_line.unwrap_or(u32::MAX),
                    node_id,
                }
            })
            .collect();

        // Call + receiver edge dedup (single set, matching JS seenCallEdges with recv| prefix)
        let mut seen_edges: HashSet<u64> = HashSet::new();

        for call in &file_input.calls {
            if let Some(ref receiver) = call.receiver {
                if builtin_set.contains(receiver.as_str()) {
                    continue;
                }
            }

            // Find enclosing caller (narrowest span)
            let mut caller_id = file_node_id;
            let mut caller_span = u32::MAX;

            for def in &defs_with_ids {
                if def.line <= call.line && call.line <= def.end_line {
                    let span = def.end_line - def.line;
                    if span < caller_span {
                        if let Some(id) = def.node_id {
                            caller_id = id;
                            caller_span = span;
                        }
                    }
                } else if def.line <= call.line && caller_id == file_node_id {
                    if let Some(id) = def.node_id {
                        caller_id = id;
                    }
                }
            }

            let is_dynamic = if call.dynamic.unwrap_or(false) {
                1u32
            } else {
                0u32
            };
            let imported_from = imported_names.get(call.name.as_str()).copied();

            // Resolve targets
            let mut targets: Vec<&NodeInfo> = Vec::new();

            if let Some(imp_file) = imported_from {
                targets = nodes_by_name_and_file
                    .get(&(call.name.as_str(), imp_file))
                    .cloned()
                    .unwrap_or_default();
            }

            if targets.is_empty() {
                // Same file
                targets = nodes_by_name_and_file
                    .get(&(call.name.as_str(), rel_path.as_str()))
                    .cloned()
                    .unwrap_or_default();

                if targets.is_empty() {
                    // Method name match
                    let suffix = format!(".{}", call.name);
                    let method_candidates: Vec<&NodeInfo> = nodes_by_name
                        .get(call.name.as_str())
                        .map(|v| {
                            v.iter()
                                .filter(|n| n.kind == "method" && n.name.ends_with(&suffix))
                                .copied()
                                .collect()
                        })
                        .unwrap_or_default();

                    if !method_candidates.is_empty() {
                        targets = method_candidates;
                    } else if call.receiver.is_none()
                        || call.receiver.as_deref() == Some("this")
                        || call.receiver.as_deref() == Some("self")
                        || call.receiver.as_deref() == Some("super")
                    {
                        // Scoped fallback — same-dir or parent-dir only
                        targets = nodes_by_name
                            .get(call.name.as_str())
                            .map(|v| {
                                v.iter()
                                    .filter(|n| {
                                        import_resolution::compute_confidence(
                                            rel_path, &n.file, None,
                                        ) >= 0.5
                                    })
                                    .copied()
                                    .collect()
                            })
                            .unwrap_or_default();
                    }
                }
            }

            // Sort by confidence (descending)
            if targets.len() > 1 {
                targets.sort_by(|a, b| {
                    let conf_a =
                        import_resolution::compute_confidence(rel_path, &a.file, imported_from);
                    let conf_b =
                        import_resolution::compute_confidence(rel_path, &b.file, imported_from);
                    conf_b
                        .partial_cmp(&conf_a)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }

            for t in &targets {
                let edge_key = ((caller_id as u64) << 32) | (t.id as u64);
                if t.id != caller_id && !seen_edges.contains(&edge_key) {
                    seen_edges.insert(edge_key);
                    let confidence =
                        import_resolution::compute_confidence(rel_path, &t.file, imported_from);
                    edges.push(ComputedEdge {
                        source_id: caller_id,
                        target_id: t.id,
                        kind: "calls".to_string(),
                        confidence,
                        dynamic: is_dynamic,
                    });
                }
            }

            // Receiver edge: caller → receiver type node
            if let Some(ref receiver) = call.receiver {
                if !builtin_set.contains(receiver.as_str())
                    && receiver != "this"
                    && receiver != "self"
                    && receiver != "super"
                {
                    let samefile = nodes_by_name_and_file
                        .get(&(receiver.as_str(), rel_path.as_str()))
                        .cloned()
                        .unwrap_or_default();
                    let candidates = if !samefile.is_empty() {
                        samefile
                    } else {
                        nodes_by_name
                            .get(receiver.as_str())
                            .cloned()
                            .unwrap_or_default()
                    };
                    let receiver_nodes: Vec<&NodeInfo> = candidates
                        .into_iter()
                        .filter(|n| receiver_kinds.contains(n.kind.as_str()))
                        .collect();

                    if let Some(recv_target) = receiver_nodes.first() {
                        // Use high bit to separate receiver keys from call keys (matches JS recv| prefix)
                        let recv_key =
                            (1u64 << 63) | ((caller_id as u64) << 32) | (recv_target.id as u64);
                        if !seen_edges.contains(&recv_key) {
                            seen_edges.insert(recv_key);
                            edges.push(ComputedEdge {
                                source_id: caller_id,
                                target_id: recv_target.id,
                                kind: "receiver".to_string(),
                                confidence: 0.7,
                                dynamic: 0,
                            });
                        }
                    }
                }
            }
        }

        // Class extends/implements edges
        for cls in &file_input.classes {
            let source_row = nodes_by_name_and_file
                .get(&(cls.name.as_str(), rel_path.as_str()))
                .and_then(|v| v.iter().find(|n| n.kind == "class"));

            if let Some(source) = source_row {
                if let Some(ref extends_name) = cls.extends {
                    let targets = nodes_by_name
                        .get(extends_name.as_str())
                        .map(|v| v.iter().filter(|n| n.kind == "class").collect::<Vec<_>>())
                        .unwrap_or_default();
                    for t in targets {
                        edges.push(ComputedEdge {
                            source_id: source.id,
                            target_id: t.id,
                            kind: "extends".to_string(),
                            confidence: 1.0,
                            dynamic: 0,
                        });
                    }
                }
                if let Some(ref implements_name) = cls.implements {
                    let targets = nodes_by_name
                        .get(implements_name.as_str())
                        .map(|v| {
                            v.iter()
                                .filter(|n| n.kind == "interface" || n.kind == "class")
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    for t in targets {
                        edges.push(ComputedEdge {
                            source_id: source.id,
                            target_id: t.id,
                            kind: "implements".to_string(),
                            confidence: 1.0,
                            dynamic: 0,
                        });
                    }
                }
            }
        }
    }

    edges
}
