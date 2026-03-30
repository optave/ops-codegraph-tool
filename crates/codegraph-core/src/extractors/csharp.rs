use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct CSharpExtractor;

impl SymbolExtractor for CSharpExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &CSHARP_AST_CONFIG);
        extract_csharp_type_map(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

const CSHARP_TYPE_KINDS: &[&str] = &[
    "class_declaration", "struct_declaration", "interface_declaration",
    "enum_declaration", "record_declaration",
];

fn find_csharp_parent_type(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, CSHARP_TYPE_KINDS, source)
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    walk_node_depth(node, source, symbols, 0);
}

fn walk_node_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                let children = extract_csharp_class_fields(node, source);
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
                extract_csharp_base_types(node, &class_name, source, symbols);
            }
        }

        "struct_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: name.clone(),
                    kind: "struct".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
                extract_csharp_base_types(node, &name, source, symbols);
            }
        }

        "record_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: name.clone(),
                    kind: "record".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
                extract_csharp_base_types(node, &name, source, symbols);
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
                    cfg: None,
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
                                        complexity: compute_all_metrics(&child, source, "csharp"),
                                        cfg: build_function_cfg(&child, "csharp", source),
                                        children: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        "enum_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let enum_name = node_text(&name_node, source).to_string();
                let children = extract_csharp_enum_members(node, source);
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

        "method_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_type = find_csharp_parent_type(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_type {
                    Some(pt) => format!("{}.{}", pt, name),
                    None => name.to_string(),
                };
                let children = extract_csharp_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "csharp"),
                    cfg: build_function_cfg(node, "csharp", source),
                    children: opt_children(children),
                });
            }
        }

        "constructor_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_type = find_csharp_parent_type(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_type {
                    Some(pt) => format!("{}.{}", pt, name),
                    None => name.to_string(),
                };
                let children = extract_csharp_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "csharp"),
                    cfg: build_function_cfg(node, "csharp", source),
                    children: opt_children(children),
                });
            }
        }

        "property_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_type = find_csharp_parent_type(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_type {
                    Some(pt) => format!("{}.{}", pt, name),
                    None => name.to_string(),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "csharp"),
                    cfg: build_function_cfg(node, "csharp", source),
                    children: None,
                });
            }
        }

        "using_directive" => {
            let name_node = node
                .child_by_field_name("name")
                .or_else(|| find_child(node, "qualified_name"))
                .or_else(|| find_child(node, "identifier"));
            if let Some(name_node) = name_node {
                let full_path = node_text(&name_node, source).to_string();
                let last_name = full_path.split('.').last().unwrap_or("").to_string();
                let mut imp = Import::new(full_path, vec![last_name], start_line(node));
                imp.csharp_using = Some(true);
                symbols.imports.push(imp);
            }
        }

        "invocation_expression" => {
            let fn_node = node
                .child_by_field_name("function")
                .or_else(|| node.child(0));
            if let Some(fn_node) = fn_node {
                match fn_node.kind() {
                    "identifier" => {
                        symbols.calls.push(Call {
                            name: node_text(&fn_node, source).to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                    "member_access_expression" => {
                        if let Some(name) = fn_node.child_by_field_name("name") {
                            let receiver = fn_node.child_by_field_name("expression")
                                .map(|expr| node_text(&expr, source).to_string());
                            symbols.calls.push(Call {
                                name: node_text(&name, source).to_string(),
                                line: start_line(node),
                                dynamic: None,
                                receiver,
                            });
                        }
                    }
                    "generic_name" | "member_binding_expression" => {
                        let name = fn_node
                            .child_by_field_name("name")
                            .or_else(|| fn_node.child(0));
                        if let Some(name) = name {
                            symbols.calls.push(Call {
                                name: node_text(&name, source).to_string(),
                                line: start_line(node),
                                dynamic: None,
                                receiver: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        "object_creation_expression" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = if type_node.kind() == "generic_name" {
                    type_node
                        .child_by_field_name("name")
                        .or_else(|| type_node.child(0))
                        .map(|n| node_text(&n, source).to_string())
                } else {
                    Some(node_text(&type_node, source).to_string())
                };
                if let Some(name) = type_name {
                    symbols.calls.push(Call {
                        name,
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
            walk_node_depth(&child, source, symbols, depth + 1);
        }
    }
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_csharp_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "parameter_list"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "parameter" {
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

fn extract_csharp_class_fields(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "field_declaration" {
                    // Walk variable_declaration inside
                    for j in 0..child.child_count() {
                        if let Some(decl) = child.child(j) {
                            if decl.kind() == "variable_declaration" {
                                for k in 0..decl.child_count() {
                                    if let Some(declarator) = decl.child(k) {
                                        if declarator.kind() == "variable_declarator" {
                                            if let Some(name_node) = declarator.child_by_field_name("name")
                                                .or_else(|| declarator.child(0))
                                            {
                                                if name_node.kind() == "identifier" {
                                                    fields.push(child_def(
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
            }
        }
    }
    fields
}

fn extract_csharp_enum_members(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut members = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "enum_member_declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_member_declaration" {
                    if let Some(name_node) = child.child_by_field_name("name")
                        .or_else(|| child.child(0))
                    {
                        if name_node.kind() == "identifier" {
                            members.push(child_def(
                                node_text(&name_node, source).to_string(),
                                "constant",
                                start_line(&child),
                            ));
                        }
                    }
                }
            }
        }
    }
    members
}

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_csharp_base_types(
    node: &Node,
    class_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    // tree-sitter-c-sharp exposes base_list as a child node type, not a field,
    // so child_by_field_name("bases") returns None — fall back to find_child.
    let base_list = node
        .child_by_field_name("bases")
        .or_else(|| find_child(node, "base_list"));
    let base_list = match base_list {
        Some(bl) => bl,
        None => return,
    };

    for i in 0..base_list.child_count() {
        if let Some(child) = base_list.child(i) {
            match child.kind() {
                "identifier" | "qualified_name" => {
                    symbols.classes.push(ClassRelation {
                        name: class_name.to_string(),
                        extends: Some(node_text(&child, source).to_string()),
                        implements: None,
                        line: start_line(node),
                    });
                }
                "generic_name" => {
                    let name = child
                        .child_by_field_name("name")
                        .or_else(|| child.child(0));
                    if let Some(name) = name {
                        symbols.classes.push(ClassRelation {
                            name: class_name.to_string(),
                            extends: Some(node_text(&name, source).to_string()),
                            implements: None,
                            line: start_line(node),
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

// ── Type map extraction ─────────────────────────────────────────────────────

fn extract_csharp_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "identifier" | "qualified_name" => Some(node_text(type_node, source)),
        "predefined_type" => None, // skip int, string, etc.
        "generic_name" => type_node.child(0).map(|n| node_text(&n, source)),
        "nullable_type" => {
            type_node.child(0).and_then(|inner| extract_csharp_type_name(&inner, source))
        }
        _ => None,
    }
}

fn extract_csharp_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    extract_csharp_type_map_depth(node, source, symbols, 0);
}

fn extract_csharp_type_map_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "variable_declaration" => {
            let type_node = node.child_by_field_name("type").or_else(|| node.child(0));
            if let Some(type_node) = type_node {
                if type_node.kind() != "var_keyword" && type_node.kind() != "implicit_type" {
                    if let Some(type_name) = extract_csharp_type_name(&type_node, source) {
                        for i in 0..node.child_count() {
                            if let Some(child) = node.child(i) {
                                if child.kind() == "variable_declarator" {
                                    let name_node = child.child_by_field_name("name")
                                        .or_else(|| child.child(0));
                                    if let Some(name_node) = name_node {
                                        if name_node.kind() == "identifier" {
                                            symbols.type_map.push(TypeMapEntry {
                                                name: node_text(&name_node, source).to_string(),
                                                type_name: type_name.to_string(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        "parameter" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_csharp_type_name(&type_node, source) {
                    if let Some(name_node) = node.child_by_field_name("name") {
                        symbols.type_map.push(TypeMapEntry {
                            name: node_text(&name_node, source).to_string(),
                            type_name: type_name.to_string(),
                        });
                    }
                }
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_csharp_type_map_depth(&child, source, symbols, depth + 1);
        }
    }
}
