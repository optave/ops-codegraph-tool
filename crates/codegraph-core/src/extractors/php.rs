use tree_sitter::{Node, Tree};
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct PhpExtractor;

impl SymbolExtractor for PhpExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

fn find_php_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_declaration" | "trait_declaration" | "enum_declaration" => {
                return parent
                    .child_by_field_name("name")
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "function_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = extract_php_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "php"),
                    children: opt_children(children),
                });
            }
        }

        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                let children = extract_php_class_properties(node, source);
                symbols.definitions.push(Definition {
                    name: class_name.clone(),
                    kind: "class".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: opt_children(children),
                });

                // Extends
                let base_clause = node
                    .child_by_field_name("base_clause")
                    .or_else(|| find_child(node, "base_clause"));
                if let Some(base_clause) = base_clause {
                    for i in 0..base_clause.child_count() {
                        if let Some(child) = base_clause.child(i) {
                            if child.kind() == "name" || child.kind() == "qualified_name" {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.clone(),
                                    extends: Some(node_text(&child, source).to_string()),
                                    implements: None,
                                    line: start_line(node),
                                });
                                break;
                            }
                        }
                    }
                }

                // Implements
                let interface_clause = find_child(node, "class_interface_clause");
                if let Some(interface_clause) = interface_clause {
                    for i in 0..interface_clause.child_count() {
                        if let Some(child) = interface_clause.child(i) {
                            if child.kind() == "name" || child.kind() == "qualified_name" {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.clone(),
                                    extends: None,
                                    implements: Some(node_text(&child, source).to_string()),
                                    line: start_line(node),
                                });
                            }
                        }
                    }
                }
            }
        }

        "interface_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let iface_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: iface_name.clone(),
                    kind: "interface".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: None,
                });
                if let Some(body) = node.child_by_field_name("body") {
                    for i in 0..body.child_count() {
                        if let Some(child) = body.child(i) {
                            if child.kind() == "method_declaration" {
                                if let Some(meth_name) = child.child_by_field_name("name") {
                                    symbols.definitions.push(Definition {
                                        name: format!(
                                            "{}.{}",
                                            iface_name,
                                            node_text(&meth_name, source)
                                        ),
                                        kind: "method".to_string(),
                                        line: start_line(&child),
                                        end_line: Some(end_line(&child)),
                                        decorators: None,
                                        complexity: compute_all_metrics(&child, source, "php"),
                                        children: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        "trait_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "trait".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: None,
                });
            }
        }

        "enum_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let enum_name = node_text(&name_node, source).to_string();
                let children = extract_php_enum_cases(node, source);
                symbols.definitions.push(Definition {
                    name: enum_name,
                    kind: "enum".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: opt_children(children),
                });
            }
        }

        "method_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_class = find_php_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let children = extract_php_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "php"),
                    children: opt_children(children),
                });
            }
        }

        "namespace_use_declaration" => {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    if child.kind() == "namespace_use_clause" {
                        let name_node = find_child(&child, "qualified_name")
                            .or_else(|| find_child(&child, "name"));
                        if let Some(name_node) = name_node {
                            let full_path = node_text(&name_node, source).to_string();
                            let last_name = full_path.split('\\').last().unwrap_or("").to_string();
                            let alias = child.child_by_field_name("alias");
                            let alias_text = alias
                                .map(|a| node_text(&a, source).to_string())
                                .unwrap_or(last_name);
                            let mut imp =
                                Import::new(full_path, vec![alias_text], start_line(node));
                            imp.php_use = Some(true);
                            symbols.imports.push(imp);
                        }
                    }
                    // Single use clause without wrapper
                    if child.kind() == "qualified_name" || child.kind() == "name" {
                        let full_path = node_text(&child, source).to_string();
                        let last_name = full_path.split('\\').last().unwrap_or("").to_string();
                        let mut imp =
                            Import::new(full_path, vec![last_name], start_line(node));
                        imp.php_use = Some(true);
                        symbols.imports.push(imp);
                    }
                }
            }
        }

        "function_call_expression" => {
            let fn_node = node
                .child_by_field_name("function")
                .or_else(|| node.child(0));
            if let Some(fn_node) = fn_node {
                match fn_node.kind() {
                    "name" | "identifier" => {
                        symbols.calls.push(Call {
                            name: node_text(&fn_node, source).to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                    "qualified_name" => {
                        let text = node_text(&fn_node, source);
                        let last = text.split('\\').last().unwrap_or("");
                        symbols.calls.push(Call {
                            name: last.to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                    _ => {}
                }
            }
        }

        "member_call_expression" => {
            if let Some(name) = node.child_by_field_name("name") {
                let receiver = node.child_by_field_name("object")
                    .map(|obj| node_text(&obj, source).to_string());
                symbols.calls.push(Call {
                    name: node_text(&name, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                });
            }
        }

        "scoped_call_expression" => {
            if let Some(name) = node.child_by_field_name("name") {
                let receiver = node.child_by_field_name("scope")
                    .map(|s| node_text(&s, source).to_string());
                symbols.calls.push(Call {
                    name: node_text(&name, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                });
            }
        }

        "object_creation_expression" => {
            // Skip 'new' keyword (child 0) and get class node (child 1)
            if let Some(class_node) = node.child(1) {
                if class_node.kind() == "name" || class_node.kind() == "qualified_name" {
                    let text = node_text(&class_node, source);
                    let last = text.split('\\').last().unwrap_or("");
                    symbols.calls.push(Call {
                        name: last.to_string(),
                        line: start_line(node),
                        dynamic: None,
                        receiver: None,
                    });
                }
            }
        }

        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_node(&child, source, symbols);
        }
    }
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_php_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "formal_parameters"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "simple_parameter"
                    || child.kind() == "variadic_parameter"
                    || child.kind() == "property_promotion_parameter"
                {
                    if let Some(name_node) = child.child_by_field_name("name") {
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

fn extract_php_class_properties(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "property_declaration" {
                    // Walk property_element children
                    for j in 0..child.child_count() {
                        if let Some(elem) = child.child(j) {
                            if elem.kind() == "property_element" {
                                if let Some(name_node) = elem.child(0) {
                                    if name_node.kind() == "variable_name" {
                                        props.push(child_def(
                                            node_text(&name_node, source).to_string(),
                                            "property",
                                            start_line(&child),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    props
}

fn extract_php_enum_cases(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut cases = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "enum_declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_case" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        cases.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    cases
}
