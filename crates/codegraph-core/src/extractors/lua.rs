use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct LuaExtractor;

impl SymbolExtractor for LuaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_lua_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &LUA_AST_CONFIG);
        symbols
    }
}

fn match_lua_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" => handle_lua_function_decl(node, source, symbols),
        "function_call" => handle_lua_function_call(node, source, symbols),
        _ => {}
    }
}

fn handle_lua_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    let (name, kind) = match name_node.kind() {
        "method_index_expression" => {
            let table = name_node.child_by_field_name("table");
            let method = name_node.child_by_field_name("method");
            match (table, method) {
                (Some(t), Some(m)) => (
                    format!("{}.{}", node_text(&t, source), node_text(&m, source)),
                    "method",
                ),
                _ => (node_text(&name_node, source).to_string(), "function"),
            }
        }
        "dot_index_expression" => {
            let table = name_node.child_by_field_name("table");
            let field = name_node.child_by_field_name("field");
            match (table, field) {
                (Some(t), Some(f)) => (
                    format!("{}.{}", node_text(&t, source), node_text(&f, source)),
                    "method",
                ),
                _ => (node_text(&name_node, source).to_string(), "function"),
            }
        }
        _ => (node_text(&name_node, source).to_string(), "function"),
    };

    let params = extract_lua_params(node, source);

    symbols.definitions.push(Definition {
        name,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "lua"),
        cfg: build_function_cfg(node, "lua", source),
        children: opt_children(params),
    });
}

fn extract_lua_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(param_list) = func_node.child_by_field_name("parameters") {
        for i in 0..param_list.child_count() {
            if let Some(child) = param_list.child(i) {
                if child.kind() == "identifier" {
                    params.push(child_def(
                        node_text(&child, source).to_string(),
                        "parameter",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    params
}

fn handle_lua_function_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    // Check for require() as import
    if name_node.kind() == "identifier" && node_text(&name_node, source) == "require" {
        if let Some(args) = node.child_by_field_name("arguments") {
            if let Some(str_arg) = find_child(&args, "string") {
                let raw = node_text(&str_arg, source);
                let source_path = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
                symbols.imports.push(Import::new(
                    source_path,
                    vec!["require".to_string()],
                    start_line(node),
                ));
                return;
            }
        }
    }

    match name_node.kind() {
        "method_index_expression" => {
            let method = name_node.child_by_field_name("method");
            let table = name_node.child_by_field_name("table");
            if let Some(m) = method {
                symbols.calls.push(Call {
                    name: node_text(&m, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: table.map(|t| node_text(&t, source).to_string()),
                });
            }
        }
        "dot_index_expression" => {
            let field = name_node.child_by_field_name("field");
            let table = name_node.child_by_field_name("table");
            if let Some(f) = field {
                symbols.calls.push(Call {
                    name: node_text(&f, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: table.map(|t| node_text(&t, source).to_string()),
                });
            }
        }
        _ => {
            symbols.calls.push(Call {
                name: node_text(&name_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
    }
}
