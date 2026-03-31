use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct ZigExtractor;

impl SymbolExtractor for ZigExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_zig_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &ZIG_AST_CONFIG);
        symbols
    }
}

fn match_zig_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" => handle_zig_function(node, source, symbols),
        "variable_declaration" => handle_zig_variable(node, source, symbols),
        "call_expression" => handle_zig_call(node, source, symbols),
        "builtin_function" => handle_zig_builtin(node, source, symbols),
        "test_declaration" => handle_zig_test(node, source, symbols),
        _ => {}
    }
}

fn handle_zig_function(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    let parent_struct = find_zig_parent_struct(node, source);
    let name_text = node_text(&name_node, source);
    let (full_name, kind) = match &parent_struct {
        Some(s) => (format!("{}.{}", s, name_text), "method"),
        None => (name_text.to_string(), "function"),
    };

    let params = extract_zig_params(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "zig"),
        cfg: build_function_cfg(node, "zig", source),
        children: opt_children(params),
    });
}

fn extract_zig_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(param_list) = func_node.child_by_field_name("parameters") {
        for i in 0..param_list.child_count() {
            if let Some(child) = param_list.child(i) {
                if child.kind() == "parameter" {
                    if let Some(name_node) = find_child(&child, "identifier") {
                        params.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "parameter",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    params
}

fn handle_zig_variable(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };
    let name = node_text(&name_node, source).to_string();

    // Check for struct/enum/union
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "struct_declaration" => {
                    let members = extract_zig_container_fields(&child, source);
                    symbols.definitions.push(Definition {
                        name,
                        kind: "struct".to_string(),
                        line: start_line(node),
                        end_line: Some(end_line(node)),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: opt_children(members),
                    });
                    return;
                }
                "enum_declaration" => {
                    symbols.definitions.push(Definition {
                        name,
                        kind: "enum".to_string(),
                        line: start_line(node),
                        end_line: Some(end_line(node)),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: None,
                    });
                    return;
                }
                "union_declaration" => {
                    symbols.definitions.push(Definition {
                        name,
                        kind: "struct".to_string(),
                        line: start_line(node),
                        end_line: Some(end_line(node)),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: None,
                    });
                    return;
                }
                _ => {}
            }
        }
    }

    // Check for @import
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "builtin_function" {
                if let Some(builtin_id) = find_child(&child, "builtin_identifier") {
                    if node_text(&builtin_id, source) == "@import" {
                        if let Some(args) = find_child(&child, "arguments") {
                            for j in 0..args.child_count() {
                                if let Some(arg) = args.child(j) {
                                    if arg.kind() == "string_literal" || arg.kind() == "string" {
                                        let raw = node_text(&arg, source);
                                        let source_path = raw.trim_matches('"').to_string();
                                        symbols.imports.push(Import::new(
                                            source_path,
                                            vec![name],
                                            start_line(node),
                                        ));
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Regular const/var
    let is_const = node_has_child_text(node, source, "const");
    symbols.definitions.push(Definition {
        name,
        kind: if is_const { "constant" } else { "variable" }.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn extract_zig_container_fields(container: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    for i in 0..container.child_count() {
        if let Some(child) = container.child(i) {
            if child.kind() == "container_field" {
                let name_node = child.child_by_field_name("name")
                    .or_else(|| find_child(&child, "identifier"));
                if let Some(n) = name_node {
                    fields.push(child_def(
                        node_text(&n, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    fields
}

fn handle_zig_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child_by_field_name("function").or_else(|| node.child(0)) {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "field_expression" | "field_access" => {
            let field = func_node.child_by_field_name("field")
                .or_else(|| func_node.child_by_field_name("member"));
            let value = func_node.child(0);
            if let Some(f) = field {
                symbols.calls.push(Call {
                    name: node_text(&f, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: value.map(|v| node_text(&v, source).to_string()),
                });
            }
        }
        _ => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
    }
}

fn handle_zig_builtin(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let builtin_id = match find_child(node, "builtin_identifier") {
        Some(n) => n,
        None => return,
    };

    let name = node_text(&builtin_id, source);
    if name == "@import" && node.parent().map(|p| p.kind()) != Some("variable_declaration") {
        if let Some(args) = find_child(node, "arguments") {
            for i in 0..args.child_count() {
                if let Some(arg) = args.child(i) {
                    if arg.kind() == "string_literal" || arg.kind() == "string" {
                        let raw = node_text(&arg, source);
                        let source_path = raw.trim_matches('"').to_string();
                        symbols.imports.push(Import::new(
                            source_path,
                            vec!["@import".to_string()],
                            start_line(node),
                        ));
                        return;
                    }
                }
            }
        }
    }

    symbols.calls.push(Call {
        name: name.to_string(),
        line: start_line(node),
        dynamic: None,
        receiver: None,
    });
}

fn handle_zig_test(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut name = "test".to_string();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "string_literal" || child.kind() == "identifier" {
                name = node_text(&child, source).trim_matches('"').to_string();
                break;
            }
        }
    }

    symbols.definitions.push(Definition {
        name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn find_zig_parent_struct<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "struct_declaration" || parent.kind() == "union_declaration" {
            // The name is in the grandparent variable_declaration
            if let Some(gp) = parent.parent() {
                if gp.kind() == "variable_declaration" {
                    if let Some(name_node) = find_child(&gp, "identifier") {
                        return Some(node_text(&name_node, source).to_string());
                    }
                }
            }
        }
        current = parent.parent();
    }
    None
}

// TODO: wire into Definition once the struct gains a `visibility` field
#[allow(dead_code)]
fn is_zig_pub(node: &Node, source: &[u8]) -> bool {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if node_text(&child, source) == "pub" {
                return true;
            }
        }
    }
    false
}

fn node_has_child_text(node: &Node, source: &[u8], text: &str) -> bool {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if node_text(&child, source) == text {
                return true;
            }
        }
    }
    false
}
