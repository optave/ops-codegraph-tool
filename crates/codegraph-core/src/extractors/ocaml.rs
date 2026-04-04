use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct OcamlExtractor;

impl SymbolExtractor for OcamlExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_ocaml_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &OCAML_AST_CONFIG);
        symbols
    }
}

fn match_ocaml_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "value_definition" => handle_ocaml_value_def(node, source, symbols),
        "module_definition" => handle_ocaml_module_def(node, source, symbols),
        "type_definition" => handle_ocaml_type_def(node, source, symbols),
        "class_definition" => handle_ocaml_class_def(node, source, symbols),
        "open_module" => handle_ocaml_open(node, source, symbols),
        "application_expression" => handle_ocaml_application(node, source, symbols),
        // Shared node types present in both .ml and .mli files
        "value_specification" => handle_ocaml_value_spec(node, source, symbols),
        "external" => handle_ocaml_external(node, source, symbols),
        "module_type_definition" => handle_ocaml_module_type_def(node, source, symbols),
        "exception_definition" => handle_ocaml_exception_def(node, source, symbols),
        _ => {}
    }
}

fn handle_ocaml_value_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "let_binding" {
                handle_ocaml_let_binding(&child, source, symbols);
            }
        }
    }
}

fn handle_ocaml_let_binding(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let pattern = match node.child_by_field_name("pattern").or_else(|| node.child(0)) {
        Some(p) => p,
        None => return,
    };

    let name = extract_ocaml_pattern_name(&pattern, source);
    let name = match name {
        Some(n) => n,
        None => return,
    };

    let has_params = has_ocaml_params(node);

    if has_params {
        symbols.definitions.push(Definition {
            name,
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "ocaml"),
            cfg: build_function_cfg(node, "ocaml", source),
            children: None,
        });
    } else {
        symbols.definitions.push(Definition {
            name,
            kind: "variable".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn extract_ocaml_pattern_name(pattern: &Node, source: &[u8]) -> Option<String> {
    match pattern.kind() {
        "value_name" | "identifier" => Some(node_text(pattern, source).to_string()),
        "parenthesized_operator" => Some(node_text(pattern, source).to_string()),
        _ => {
            find_child(pattern, "value_name")
                .or_else(|| find_child(pattern, "identifier"))
                .map(|n| node_text(&n, source).to_string())
        }
    }
}

fn has_ocaml_params(let_binding: &Node) -> bool {
    for i in 0..let_binding.child_count() {
        if let Some(child) = let_binding.child(i) {
            if child.kind() == "parameter" || child.kind() == "value_pattern" {
                return true;
            }
        }
    }
    false
}

fn handle_ocaml_module_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let binding = match find_child(node, "module_binding") {
        Some(b) => b,
        None => return,
    };

    let name_node = binding.child_by_field_name("name")
        .or_else(|| find_child(&binding, "module_name"))
        .or_else(|| find_child(&binding, "identifier"));
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "module".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_ocaml_type_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() != "type_binding" {
                continue;
            }

            let name_node = child.child_by_field_name("name")
                .or_else(|| find_child(&child, "type_constructor"))
                .or_else(|| find_child(&child, "identifier"));
            if let Some(name) = name_node {
                let mut children = Vec::new();
                extract_ocaml_type_constructors(&child, source, &mut children);

                symbols.definitions.push(Definition {
                    name: node_text(&name, source).to_string(),
                    kind: "type".to_string(),
                    line: start_line(&child),
                    end_line: Some(end_line(&child)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: opt_children(children),
                });
            }
        }
    }
}

fn extract_ocaml_type_constructors(type_binding: &Node, source: &[u8], children: &mut Vec<Definition>) {
    for i in 0..type_binding.child_count() {
        if let Some(child) = type_binding.child(i) {
            if child.kind() == "constructor_declaration" {
                let name = find_child(&child, "constructor_name")
                    .or_else(|| find_child(&child, "identifier"));
                if let Some(n) = name {
                    children.push(child_def(
                        node_text(&n, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
        }
    }
}

fn handle_ocaml_class_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let binding = match find_child(node, "class_binding") {
        Some(b) => b,
        None => return,
    };

    let name_node = binding.child_by_field_name("name")
        .or_else(|| find_child(&binding, "identifier"));
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "class".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_ocaml_open(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut module_name: Option<String> = None;
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "module_path" | "module_name" | "extended_module_path" | "constructor_name" => {
                    module_name = Some(node_text(&child, source).to_string());
                    break;
                }
                _ => {}
            }
        }
    }

    if let Some(name) = module_name {
        let last = name.split('.').last().unwrap_or(&name).to_string();
        symbols.imports.push(Import::new(name, vec![last], start_line(node)));
    }
}

/// Handle `val name : type` declarations in .mli files.
fn handle_ocaml_value_spec(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "value_name")
        .or_else(|| find_child(node, "parenthesized_operator"));
    if let Some(name) = name_node {
        // Check if the type signature contains `->` (function type)
        let has_arrow = node.child_by_field_name("type")
            .map(|t| has_descendant_kind(&t, "function_type"))
            .unwrap_or(false);
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: if has_arrow { "function" } else { "variable" }.to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

/// Handle `external name : type = "c_name"` declarations in .mli files.
fn handle_ocaml_external(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "value_name")
        .or_else(|| find_child(node, "parenthesized_operator"));
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

/// Handle `module type S = sig ... end` declarations in .mli files.
fn handle_ocaml_module_type_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "module_type_name");
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "interface".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

/// Handle `exception Foo of bar` and `exception Foo = Bar` declarations.
fn handle_ocaml_exception_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Standard: `exception Foo of bar` — name is inside constructor_declaration
    let constructor = find_child(node, "constructor_declaration");
    let name_node = if let Some(ref decl) = constructor {
        find_child(decl, "constructor_name")
    } else {
        // Fallback for `exception Foo = Bar` (alias) — name is directly on the node
        find_child(node, "constructor_name")
    };
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "type".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

/// Check if any descendant has the given node kind.
fn has_descendant_kind(node: &Node, kind: &str) -> bool {
    if node.kind() == kind {
        return true;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if has_descendant_kind(&child, kind) {
                return true;
            }
        }
    }
    false
}

fn handle_ocaml_application(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child(0) {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "value_path" | "value_name" | "identifier" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "field_get_expression" => {
            let field = func_node.child_by_field_name("field")
                .or_else(|| find_child(&func_node, "value_name"))
                .or_else(|| find_child(&func_node, "identifier"));
            let record = func_node.child(0);
            if let Some(f) = field {
                symbols.calls.push(Call {
                    name: node_text(&f, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: record.and_then(|r| {
                        if r.id() != f.id() { Some(node_text(&r, source).to_string()) } else { None }
                    }),
                });
            }
        }
        _ => {}
    }
}
