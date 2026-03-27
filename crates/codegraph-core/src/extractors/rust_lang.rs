use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct RustExtractor;

impl SymbolExtractor for RustExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &RUST_AST_CONFIG);
        extract_rust_type_map(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

fn find_current_impl<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "impl_item" {
            return parent
                .child_by_field_name("type")
                .map(|n| node_text(&n, source).to_string());
        }
        current = parent.parent();
    }
    None
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    walk_node_depth(node, source, symbols, 0);
}

fn walk_node_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "function_item" => {
            // Skip default-impl functions inside traits — already emitted by trait_item handler
            if node.parent()
                .and_then(|p| p.parent())
                .map_or(false, |gp| gp.kind() == "trait_item")
            {
                // still recurse into children below
            } else if let Some(name_node) = node.child_by_field_name("name") {
                let name = node_text(&name_node, source);
                let impl_type = find_current_impl(node, source);
                let (full_name, kind) = match &impl_type {
                    Some(t) => (format!("{}.{}", t, name), "method".to_string()),
                    None => (name.to_string(), "function".to_string()),
                };
                let children = extract_rust_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind,
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "rust"),
                    cfg: build_function_cfg(node, "rust", source),
                    children: opt_children(children),
                });
            }
        }

        "struct_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = extract_rust_struct_fields(node, source);
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "struct".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: opt_children(children),
                });
            }
        }

        "enum_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = extract_rust_enum_variants(node, source);
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
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

        "const_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "constant".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
            }
        }

        "trait_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let trait_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: trait_name.clone(),
                    kind: "trait".to_string(),
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
                            if child.kind() == "function_signature_item"
                                || child.kind() == "function_item"
                            {
                                if let Some(meth_name) = child.child_by_field_name("name") {
                                    symbols.definitions.push(Definition {
                                        name: format!(
                                            "{}.{}",
                                            trait_name,
                                            node_text(&meth_name, source)
                                        ),
                                        kind: "method".to_string(),
                                        line: start_line(&child),
                                        end_line: Some(end_line(&child)),
                                        decorators: None,
                                        complexity: compute_all_metrics(&child, source, "rust"),
                                        cfg: build_function_cfg(&child, "rust", source),
                                        children: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        "impl_item" => {
            let type_node = node.child_by_field_name("type");
            let trait_node = node.child_by_field_name("trait");
            if let (Some(type_node), Some(trait_node)) = (type_node, trait_node) {
                symbols.classes.push(ClassRelation {
                    name: node_text(&type_node, source).to_string(),
                    extends: None,
                    implements: Some(node_text(&trait_node, source).to_string()),
                    line: start_line(node),
                });
            }
        }

        "use_declaration" => {
            if let Some(arg_node) = node.child(1) {
                let use_paths = extract_rust_use_path(&arg_node, source);
                for (src, names) in use_paths {
                    let mut imp = Import::new(src, names, start_line(node));
                    imp.rust_use = Some(true);
                    symbols.imports.push(imp);
                }
            }
        }

        "call_expression" => {
            if let Some(fn_node) = node.child_by_field_name("function") {
                match fn_node.kind() {
                    "identifier" => {
                        symbols.calls.push(Call {
                            name: node_text(&fn_node, source).to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                    "field_expression" => {
                        if let Some(field) = fn_node.child_by_field_name("field") {
                            let receiver = fn_node.child_by_field_name("value")
                                .map(|v| node_text(&v, source).to_string());
                            symbols.calls.push(Call {
                                name: node_text(&field, source).to_string(),
                                line: start_line(node),
                                dynamic: None,
                                receiver,
                            });
                        }
                    }
                    "scoped_identifier" => {
                        if let Some(name) = fn_node.child_by_field_name("name") {
                            let receiver = fn_node.child_by_field_name("path")
                                .map(|p| node_text(&p, source).to_string());
                            symbols.calls.push(Call {
                                name: node_text(&name, source).to_string(),
                                line: start_line(node),
                                dynamic: None,
                                receiver,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        "macro_invocation" => {
            if let Some(macro_node) = node.child(0) {
                symbols.calls.push(Call {
                    name: format!("{}!", node_text(&macro_node, source)),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
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

fn extract_rust_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters");
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "parameter" {
                    if let Some(pattern) = child.child_by_field_name("pattern") {
                        let name = node_text(&pattern, source);
                        // Skip self parameters
                        if name == "self" || name == "&self" || name == "&mut self" || name == "mut self" {
                            continue;
                        }
                        params.push(child_def(name.to_string(), "parameter", start_line(&child)));
                    }
                } else if child.kind() == "self_parameter" {
                    // Skip self
                    continue;
                }
            }
        }
    }
    params
}

fn extract_rust_struct_fields(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "field_declaration_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "field_declaration" {
                    if let Some(name_node) = child.child_by_field_name("name") {
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
    fields
}

fn extract_rust_enum_variants(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut variants = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "enum_variant_list"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_variant" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        variants.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    variants
}

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_rust_use_path(node: &Node, source: &[u8]) -> Vec<(String, Vec<String>)> {
    match node.kind() {
        "use_list" => {
            let mut results = Vec::new();
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    results.extend(extract_rust_use_path(&child, source));
                }
            }
            results
        }

        "scoped_use_list" => {
            let path_node = node.child_by_field_name("path");
            let list_node = node.child_by_field_name("list");
            let prefix = path_node
                .map(|p| node_text(&p, source).to_string())
                .unwrap_or_default();
            if let Some(list_node) = list_node {
                let mut names = Vec::new();
                for i in 0..list_node.child_count() {
                    if let Some(child) = list_node.child(i) {
                        match child.kind() {
                            "identifier" | "self" => {
                                names.push(node_text(&child, source).to_string());
                            }
                            "use_as_clause" => {
                                let name = child
                                    .child_by_field_name("alias")
                                    .or_else(|| child.child_by_field_name("name"))
                                    .map(|n| node_text(&n, source).to_string());
                                if let Some(name) = name {
                                    names.push(name);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                vec![(prefix, names)]
            } else {
                vec![(prefix, vec![])]
            }
        }

        "use_as_clause" => {
            let name = node
                .child_by_field_name("alias")
                .or_else(|| node.child_by_field_name("name"))
                .map(|n| node_text(&n, source).to_string());
            vec![(
                node_text(node, source).to_string(),
                name.into_iter().collect(),
            )]
        }

        "use_wildcard" => {
            let path_node = node.child_by_field_name("path");
            let src = path_node
                .map(|p| node_text(&p, source).to_string())
                .unwrap_or_else(|| "*".to_string());
            vec![(src, vec!["*".to_string()])]
        }

        "scoped_identifier" | "identifier" => {
            let text = node_text(node, source).to_string();
            let last_name = text.split("::").last().unwrap_or("").to_string();
            vec![(text, vec![last_name])]
        }

        _ => vec![],
    }
}

fn extract_rust_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "type_identifier" | "identifier" | "scoped_type_identifier" => Some(node_text(type_node, source)),
        "reference_type" => {
            for i in 0..type_node.child_count() {
                if let Some(child) = type_node.child(i) {
                    if child.kind() == "type_identifier" || child.kind() == "scoped_type_identifier" {
                        return Some(node_text(&child, source));
                    }
                }
            }
            None
        }
        "generic_type" => type_node.child(0).map(|n| node_text(&n, source)),
        _ => None,
    }
}

fn extract_rust_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    extract_rust_type_map_depth(node, source, symbols, 0);
}

fn extract_rust_type_map_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "let_declaration" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                if pattern.kind() == "identifier" {
                    if let Some(type_node) = node.child_by_field_name("type") {
                        if let Some(type_name) = extract_rust_type_name(&type_node, source) {
                            symbols.type_map.push(TypeMapEntry {
                                name: node_text(&pattern, source).to_string(),
                                type_name: type_name.to_string(),
                            });
                        }
                    }
                }
            }
        }
        "parameter" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                if pattern.kind() == "identifier" {
                    let name = node_text(&pattern, source);
                    if name != "self" && name != "&self" && name != "&mut self" && name != "mut self" {
                        if let Some(type_node) = node.child_by_field_name("type") {
                            if let Some(type_name) = extract_rust_type_name(&type_node, source) {
                                symbols.type_map.push(TypeMapEntry {
                                    name: name.to_string(),
                                    type_name: type_name.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_rust_type_map_depth(&child, source, symbols, depth + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_rust(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        RustExtractor.extract(&tree, code.as_bytes(), "test.rs")
    }

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_rust("fn add(a: i32, b: i32) -> i32 { a + b }");
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        let children = add.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "a");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "b");
    }

    #[test]
    fn extracts_struct_fields() {
        let s = parse_rust("struct User { name: String, age: u32 }");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "property");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_const_item() {
        let s = parse_rust("const MAX: i32 = 100;");
        let c = s.definitions.iter().find(|d| d.name == "MAX").unwrap();
        assert_eq!(c.kind, "constant");
    }

    #[test]
    fn extracts_enum_variants() {
        let s = parse_rust("enum Color { Red, Green, Blue }");
        let color = s.definitions.iter().find(|d| d.name == "Color").unwrap();
        let children = color.children.as_ref().unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0].name, "Red");
        assert_eq!(children[0].kind, "constant");
        assert_eq!(children[1].name, "Green");
        assert_eq!(children[2].name, "Blue");
    }

    #[test]
    fn skips_self_parameter() {
        let s = parse_rust("struct Foo {}\nimpl Foo {\n  fn bar(&self, x: i32) {}\n}");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "x");
    }
}
