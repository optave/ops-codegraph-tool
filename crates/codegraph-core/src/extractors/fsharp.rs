use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct FSharpExtractor;

impl SymbolExtractor for FSharpExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_fsharp_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &FSHARP_AST_CONFIG);
        symbols
    }
}

fn match_fsharp_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "named_module" => handle_named_module(node, source, symbols),
        "function_declaration_left" => handle_function_decl(node, source, symbols),
        "type_definition" => handle_type_def(node, source, symbols),
        "import_decl" => handle_import_decl(node, source, symbols),
        "application_expression" => handle_application(node, source, symbols),
        "dot_expression" => handle_dot_expression(node, source, symbols),
        _ => {}
    }
}

/// Find the enclosing `named_module` and return its identifier text.
fn enclosing_module_name(node: &Node, source: &[u8]) -> Option<String> {
    let module = find_parent_of_type(node, "named_module")?;
    let id = find_child(&module, "long_identifier")?;
    Some(node_text(&id, source).to_string())
}

fn handle_named_module(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "long_identifier") {
        Some(n) => n,
        None => return,
    };
    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // function_declaration_left: first child is the function name identifier,
    // followed by argument_patterns.
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };
    let raw_name = node_text(&name_node, source).to_string();

    let params = extract_fsharp_params(node, source);
    let module_name = enclosing_module_name(node, source);
    let qualified = match module_name {
        Some(m) => format!("{}.{}", m, raw_name),
        None => raw_name,
    };

    // JS extractor uses the parent's endLine (the function_or_value_defn) for
    // a tighter bound; do the same to preserve parity.
    let end = node.parent().unwrap_or(*node);

    symbols.definitions.push(Definition {
        name: qualified,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(&end)),
        decorators: None,
        complexity: compute_all_metrics(&end, source, "fsharp"),
        cfg: build_function_cfg(&end, "fsharp", source),
        children: opt_children(params),
    });
}

fn extract_fsharp_params(decl_left: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(arg_patterns) = find_child(decl_left, "argument_patterns") {
        collect_param_identifiers(&arg_patterns, source, &mut params);
    }
    params
}

fn collect_param_identifiers(node: &Node, source: &[u8], params: &mut Vec<Definition>) {
    if node.kind() == "identifier" {
        params.push(child_def(
            node_text(node, source).to_string(),
            "parameter",
            start_line(node),
        ));
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_param_identifiers(&child, source, params);
        }
    }
}

fn handle_type_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // type_definition contains union_type_defn, record_type_defn, etc.
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        let kind = child.kind();
        if !matches!(
            kind,
            "union_type_defn"
                | "record_type_defn"
                | "type_abbreviation_defn"
                | "class_type_defn"
                | "interface_type_defn"
                | "type_defn"
        ) {
            continue;
        }

        let name = match find_child(&child, "type_name") {
            Some(type_name) => find_child(&type_name, "identifier")
                .map(|n| node_text(&n, source).to_string())
                .unwrap_or_else(|| node_text(&type_name, source).to_string()),
            None => match find_child(&child, "identifier") {
                Some(id) => node_text(&id, source).to_string(),
                None => continue,
            },
        };

        let mut children: Vec<Definition> = Vec::new();
        extract_type_members(&child, source, &mut children);

        symbols.definitions.push(Definition {
            name,
            kind: determine_type_kind(kind).to_string(),
            line: start_line(&child),
            end_line: Some(end_line(&child)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
        });
    }
}

fn determine_type_kind(node_kind: &str) -> &'static str {
    match node_kind {
        "union_type_defn" => "enum",
        "record_type_defn" => "record",
        "class_type_defn" => "class",
        "interface_type_defn" => "interface",
        _ => "type",
    }
}

fn extract_type_members(type_defn: &Node, source: &[u8], children: &mut Vec<Definition>) {
    for i in 0..type_defn.child_count() {
        let child = match type_defn.child(i) {
            Some(c) => c,
            None => continue,
        };

        match child.kind() {
            "union_type_case" => {
                if let Some(name) = find_child(&child, "identifier") {
                    children.push(child_def(
                        node_text(&name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
            "record_field" => {
                let name_node = child
                    .child_by_field_name("name")
                    .or_else(|| find_child(&child, "identifier"));
                if let Some(name) = name_node {
                    children.push(child_def(
                        node_text(&name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
            // Recurse into container nodes that hold cases/fields.
            "union_type_cases" | "record_fields" => {
                extract_type_members(&child, source, children);
            }
            _ => {}
        }
    }
}

fn handle_import_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let module_node = match find_child(node, "long_identifier") {
        Some(n) => n,
        None => return,
    };

    let source_name = node_text(&module_node, source).to_string();
    let last = source_name
        .split('.')
        .last()
        .unwrap_or(&source_name)
        .to_string();

    symbols
        .imports
        .push(Import::new(source_name, vec![last], start_line(node)));
}

fn handle_application(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child(0) {
        Some(n) => n,
        None => return,
    };

    // Mirrors the JS extractor's `handleApplication`: the full dotted name
    // (e.g. `Service.createUser`) is stored in `name`. Splitting `name` into
    // `(receiver, method)` would diverge from the JS engine's output and
    // change which resolution rules fire downstream.
    match func_node.kind() {
        "identifier" | "long_identifier" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "long_identifier_or_op" => {
            // Inner child is either `long_identifier` (qualified, e.g.
            // `Repository.save`) or `identifier` (bare, e.g. `validateUser`).
            // Fall back to the wrapper text if neither exists (e.g.
            // operator forms like `( + )`).
            let inner = find_child(&func_node, "long_identifier")
                .or_else(|| find_child(&func_node, "identifier"));
            let name = match inner {
                Some(n) => node_text(&n, source).to_string(),
                None => node_text(&func_node, source).to_string(),
            };
            symbols.calls.push(Call {
                name,
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        _ => {}
    }
}

fn handle_dot_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Mirrors the JS extractor's `handleDotExpression`: collect identifier
    // segments and emit `name = last`, `receiver = everything-before`.
    let mut parts: Vec<String> = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "identifier" | "long_identifier" => {
                    parts.push(node_text(&child, source).to_string());
                }
                _ => {}
            }
        }
    }
    if parts.len() >= 2 {
        let method = parts.last().cloned().unwrap_or_default();
        let receiver = parts[..parts.len() - 1].join(".");
        symbols.calls.push(Call {
            name: method,
            line: start_line(node),
            dynamic: None,
            receiver: Some(receiver),
        });
    }
}
