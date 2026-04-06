use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct PhpExtractor;

impl SymbolExtractor for PhpExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_php_node);
        walk_tree(&tree.root_node(), source, &mut symbols, match_php_type_map);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &PHP_AST_CONFIG);
        symbols
    }
}

const PHP_CLASS_KINDS: &[&str] = &["class_declaration", "trait_declaration", "enum_declaration"];

fn find_php_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, PHP_CLASS_KINDS, source)
}

fn match_php_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => handle_function_def(node, source, symbols),
        "class_declaration" => handle_class_decl(node, source, symbols),
        "interface_declaration" => handle_interface_decl(node, source, symbols),
        "trait_declaration" => handle_trait_decl(node, source, symbols),
        "enum_declaration" => handle_enum_decl(node, source, symbols),
        "method_declaration" => handle_method_decl(node, source, symbols),
        "namespace_use_declaration" => handle_namespace_use(node, source, symbols),
        "function_call_expression" => handle_function_call(node, source, symbols),
        "member_call_expression" => handle_member_call(node, source, symbols),
        "scoped_call_expression" => handle_scoped_call(node, source, symbols),
        "object_creation_expression" => handle_object_creation(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_php_parameters(node, source);
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "php"),
            cfg: build_function_cfg(node, "php", source),
            children: opt_children(children),
        });
    }
}

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let class_name = node_text(&name_node, source).to_string();
    let children = extract_php_class_properties(node, source);
    symbols.definitions.push(Definition {
        name: class_name.clone(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
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

fn handle_interface_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let iface_name = node_text(&name_node, source).to_string();
    symbols.definitions.push(Definition {
        name: iface_name.clone(),
        kind: "interface".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
    if let Some(body) = node.child_by_field_name("body") {
        for i in 0..body.child_count() {
            let Some(child) = body.child(i) else { continue };
            if child.kind() != "method_declaration" { continue; }
            if let Some(meth_name) = child.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: format!("{}.{}", iface_name, node_text(&meth_name, source)),
                    kind: "method".to_string(),
                    line: start_line(&child),
                    end_line: Some(end_line(&child)),
                    decorators: None,
                    complexity: compute_all_metrics(&child, source, "php"),
                    cfg: build_function_cfg(&child, "php", source),
                    children: None,
                });
            }
        }
    }
}

fn handle_trait_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "trait".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_enum_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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
            cfg: None,
            children: opt_children(children),
        });
    }
}

fn handle_method_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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
            cfg: build_function_cfg(node, "php", source),
            children: opt_children(children),
        });
    }
}

fn handle_namespace_use(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
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
                let mut imp = Import::new(full_path, vec![alias_text], start_line(node));
                imp.php_use = Some(true);
                symbols.imports.push(imp);
            }
        }
        // Single use clause without wrapper
        if child.kind() == "qualified_name" || child.kind() == "name" {
            let full_path = node_text(&child, source).to_string();
            let last_name = full_path.split('\\').last().unwrap_or("").to_string();
            let mut imp = Import::new(full_path, vec![last_name], start_line(node));
            imp.php_use = Some(true);
            symbols.imports.push(imp);
        }
    }
}

fn handle_function_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let fn_node = node.child_by_field_name("function").or_else(|| node.child(0));
    let Some(fn_node) = fn_node else { return };
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

fn handle_member_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_scoped_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_object_creation(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(class_node) = node.child(1) else { return };
    if class_node.kind() != "name" && class_node.kind() != "qualified_name" { return; }
    let text = node_text(&class_node, source);
    let last = text.split('\\').last().unwrap_or("");
    symbols.calls.push(Call {
        name: last.to_string(),
        line: start_line(node),
        dynamic: None,
        receiver: None,
    });
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
    let Some(body) = body else { return props };
    for i in 0..body.child_count() {
        let Some(child) = body.child(i) else { continue };
        if child.kind() == "property_declaration" {
            collect_property_element_names(&child, source, &mut props);
        }
    }
    props
}

fn collect_property_element_names(decl: &Node, source: &[u8], props: &mut Vec<Definition>) {
    for j in 0..decl.child_count() {
        let Some(elem) = decl.child(j) else { continue };
        if elem.kind() != "property_element" { continue; }
        let Some(name_node) = elem.child(0) else { continue };
        if name_node.kind() == "variable_name" {
            props.push(child_def(
                node_text(&name_node, source).to_string(),
                "property",
                start_line(decl),
            ));
        }
    }
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

fn extract_php_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "named_type" | "name" | "qualified_name" => Some(node_text(type_node, source)),
        "optional_type" => {
            // ?MyType → skip the ? and get inner type
            type_node.child(1)
                .or_else(|| type_node.child(0))
                .and_then(|inner| extract_php_type_name(&inner, source))
        }
        // Skip union/intersection types (too ambiguous)
        "union_type" | "intersection_type" => None,
        _ => None,
    }
}

fn match_php_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "simple_parameter" | "variadic_parameter" | "property_promotion_parameter" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_php_type_name(&type_node, source) {
                    let name_node = node.child_by_field_name("name")
                        .or_else(|| find_child(node, "variable_name"));
                    if let Some(name_node) = name_node {
                        symbols.type_map.push(TypeMapEntry {
                            name: node_text(&name_node, source).to_string(),
                            type_name: type_name.to_string(),
                            confidence: 0.9,
                        });
                    }
                }
            }
        }
        _ => {}
    }
}
