//! Standalone analysis functions exposed via napi-rs.
//!
//! These allow the JS engine to call Rust for individual analysis passes
//! (complexity, CFG, dataflow) without going through the full parse pipeline.
//! Each function parses the source internally, finds function nodes, and
//! returns per-function results that the JS engine matches to definitions by line.

use tree_sitter::{Node, Parser};

use crate::cfg::{build_function_cfg, get_cfg_rules};
use crate::complexity::{compute_all_metrics, lang_rules};
use crate::constants::MAX_WALK_DEPTH;
use crate::dataflow::extract_dataflow;
use crate::parser_registry::LanguageKind;
use crate::types::{DataflowResult, FunctionCfgResult, FunctionComplexityResult};

/// Extract the name of a function/method node via the "name" field.
fn function_name<'a>(node: &'a Node, source: &'a [u8]) -> String {
    node.child_by_field_name("name")
        .map(|n| n.utf8_text(source).unwrap_or("<anonymous>").to_string())
        .unwrap_or_else(|| "<anonymous>".to_string())
}

/// Collect all function/method nodes from the AST using a DFS walk.
/// Uses the complexity rules' `function_nodes` list to identify function node types.
fn collect_function_nodes<'a>(
    root: &'a Node<'a>,
    function_types: &[&str],
    depth: usize,
) -> Vec<Node<'a>> {
    let mut result = Vec::new();
    if depth >= MAX_WALK_DEPTH {
        return result;
    }
    if function_types.contains(&root.kind()) {
        result.push(*root);
    }
    for i in 0..root.child_count() {
        if let Some(child) = root.child(i) {
            result.extend(collect_function_nodes(&child, function_types, depth + 1));
        }
    }
    result
}

/// Parse source code and return a tree + language kind, or None if unsupported.
fn parse_source(source: &str, file_path: &str) -> Option<(tree_sitter::Tree, LanguageKind)> {
    let lang = LanguageKind::from_extension(file_path)
        .or_else(|| LanguageKind::from_lang_id(file_path))?;
    let mut parser = Parser::new();
    parser.set_language(&lang.tree_sitter_language()).ok()?;
    let tree = parser.parse(source.as_bytes(), None)?;
    Some((tree, lang))
}

/// Analyze complexity metrics for all functions in the given source.
/// Returns per-function results with name, line, and full complexity metrics.
pub fn analyze_complexity_standalone(
    source: &str,
    file_path: &str,
) -> Vec<FunctionComplexityResult> {
    let (tree, lang) = match parse_source(source, file_path) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let lang_id = lang.lang_id_str();
    let rules = match lang_rules(lang_id) {
        Some(r) => r,
        None => return Vec::new(),
    };

    let root = tree.root_node();
    let func_nodes = collect_function_nodes(&root, rules.function_nodes, 0);
    let source_bytes = source.as_bytes();

    func_nodes
        .into_iter()
        .filter_map(|node| {
            let metrics = compute_all_metrics(&node, source_bytes, lang_id)?;
            let name = function_name(&node, source_bytes);
            let line = node.start_position().row as u32 + 1;
            let end_line = Some(node.end_position().row as u32 + 1);
            Some(FunctionComplexityResult {
                name,
                line,
                end_line,
                complexity: metrics,
            })
        })
        .collect()
}

/// Build control-flow graphs for all functions in the given source.
/// Returns per-function results with name, line, and CFG data.
pub fn build_cfg_standalone(source: &str, file_path: &str) -> Vec<FunctionCfgResult> {
    let (tree, lang) = match parse_source(source, file_path) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let lang_id = lang.lang_id_str();
    if get_cfg_rules(lang_id).is_none() {
        return Vec::new();
    }

    // Use complexity rules' function_nodes to find functions (CFG rules don't list them)
    let func_types = match lang_rules(lang_id) {
        Some(r) => r.function_nodes,
        None => return Vec::new(),
    };

    let root = tree.root_node();
    let func_nodes = collect_function_nodes(&root, func_types, 0);
    let source_bytes = source.as_bytes();

    func_nodes
        .into_iter()
        .filter_map(|node| {
            let cfg = build_function_cfg(&node, lang_id, source_bytes)?;
            let name = function_name(&node, source_bytes);
            let line = node.start_position().row as u32 + 1;
            let end_line = Some(node.end_position().row as u32 + 1);
            Some(FunctionCfgResult {
                name,
                line,
                end_line,
                cfg,
            })
        })
        .collect()
}

/// Extract dataflow analysis for the given source.
/// Returns file-level dataflow result (parameters, returns, assignments, arg flows, mutations).
pub fn extract_dataflow_standalone(source: &str, file_path: &str) -> Option<DataflowResult> {
    let (tree, lang) = parse_source(source, file_path)?;
    extract_dataflow(&tree, source.as_bytes(), lang.lang_id_str())
}
