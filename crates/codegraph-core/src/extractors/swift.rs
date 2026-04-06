use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct SwiftExtractor;

impl SymbolExtractor for SwiftExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_swift_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &SWIFT_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_swift_type_map);
        symbols
    }
}

// ── Type inference ──────────────────────────────────────────────────────────

fn match_swift_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    if node.kind() == "property_declaration" {
        if let Some(type_ann) = node.child_by_field_name("type")
            .or_else(|| find_child(node, "type_annotation"))
        {
            // type_annotation contains the actual type as a child
            let type_name = if type_ann.kind() == "type_annotation" {
                type_ann.child(type_ann.child_count().saturating_sub(1))
                    .map(|n| node_text(&n, source))
                    .unwrap_or("")
            } else {
                node_text(&type_ann, source)
            };
            if let Some(pat) = find_child(node, "pattern") {
                let name = node_text(&pat, source);
                if !name.is_empty() && !type_name.is_empty() {
                    symbols.type_map.push(TypeMapEntry {
                        name: name.to_string(),
                        type_name: type_name.to_string(),
                        confidence: 0.9,
                    });
                }
            }
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Determine the kind of a `class_declaration` by checking keyword children.
/// Swift uses `class_declaration` for class, struct, and enum.
fn swift_class_kind(node: &Node, source: &[u8]) -> &'static str {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let text = node_text(&child, source);
            match text {
                "struct" => return "struct",
                "enum" => return "enum",
                "class" => return "class",
                _ => {}
            }
        }
    }
    "class"
}

fn find_swift_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_declaration" | "protocol_declaration" => {
                return find_child(&parent, "simple_identifier")
                    .or_else(|| parent.child_by_field_name("name"))
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn extract_swift_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    // Look for parameter clauses
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "function_value_parameters"
                || child.kind() == "parameter_clause"
                || child.kind() == "lambda_function_type_parameters"
            {
                for j in 0..child.child_count() {
                    if let Some(param) = child.child(j) {
                        if param.kind() == "parameter" {
                            // Swift params have external and internal names
                            // The internal name (or only name) is what we want
                            let name = param.child_by_field_name("internal_name")
                                .or_else(|| param.child_by_field_name("name"))
                                .or_else(|| find_child(&param, "simple_identifier"))
                                .map(|n| node_text(&n, source).to_string());
                            if let Some(name) = name {
                                params.push(child_def(name, "parameter", start_line(&param)));
                            }
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_swift_class_properties(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = find_child(node, "class_body")
        .or_else(|| find_child(node, "enum_class_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "property_declaration" {
                    if let Some(pat) = find_child(&child, "pattern") {
                        props.push(child_def(
                            node_text(&pat, source).to_string(),
                            "property",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    props
}

fn extract_swift_enum_cases(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut cases = Vec::new();
    let body = find_child(node, "enum_class_body")
        .or_else(|| find_child(node, "class_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_entry" {
                    if let Some(name_node) = find_child(&child, "simple_identifier") {
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

fn extract_swift_inheritance(node: &Node, source: &[u8], class_name: &str, symbols: &mut FileSymbols) {
    let mut first = true;
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "inheritance_specifier" {
                // inheritance_specifier contains user_type > type_identifier
                if let Some(user_type) = find_child(&child, "user_type") {
                    if let Some(type_id) = find_child(&user_type, "type_identifier") {
                        let type_name = node_text(&type_id, source).to_string();
                        if first {
                            // First inheritance specifier is typically extends
                            symbols.classes.push(ClassRelation {
                                name: class_name.to_string(),
                                extends: Some(type_name),
                                implements: None,
                                line: start_line(node),
                            });
                            first = false;
                        } else {
                            symbols.classes.push(ClassRelation {
                                name: class_name.to_string(),
                                extends: None,
                                implements: Some(type_name),
                                line: start_line(node),
                            });
                        }
                    }
                }
            }
        }
    }
}

fn match_swift_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_declaration" => {
            let name_node = find_child(node, "simple_identifier")
                .or_else(|| node.child_by_field_name("name"));
            if let Some(name_node) = name_node {
                let class_name = node_text(&name_node, source).to_string();
                let kind = swift_class_kind(node, source);

                match kind {
                    "enum" => {
                        let children = extract_swift_enum_cases(node, source);
                        symbols.definitions.push(Definition {
                            name: class_name.clone(),
                            kind: "enum".to_string(),
                            line: start_line(node),
                            end_line: Some(end_line(node)),
                            decorators: None,
                            complexity: None,
                            cfg: None,
                            children: opt_children(children),
                        });
                    }
                    _ => {
                        let children = extract_swift_class_properties(node, source);
                        symbols.definitions.push(Definition {
                            name: class_name.clone(),
                            kind: kind.to_string(),
                            line: start_line(node),
                            end_line: Some(end_line(node)),
                            decorators: None,
                            complexity: None,
                            cfg: None,
                            children: opt_children(children),
                        });
                    }
                }

                extract_swift_inheritance(node, source, &class_name, symbols);
            }
        }

        "protocol_declaration" => {
            let name_node = find_child(node, "simple_identifier")
                .or_else(|| node.child_by_field_name("name"));
            if let Some(name_node) = name_node {
                let proto_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: proto_name.clone(),
                    kind: "interface".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
                // Protocol can also have inheritance
                extract_swift_inheritance(node, source, &proto_name, symbols);
            }
        }

        "function_declaration" => {
            let name_node = find_child(node, "simple_identifier")
                .or_else(|| node.child_by_field_name("name"));
            if let Some(name_node) = name_node {
                let parent_class = find_swift_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let kind = if parent_class.is_some() { "method" } else { "function" };
                let children = extract_swift_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: kind.to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "swift"),
                    cfg: build_function_cfg(node, "swift", source),
                    children: opt_children(children),
                });
            }
        }

        "import_declaration" => {
            if let Some(id_node) = find_child(node, "identifier") {
                let path = node_text(&id_node, source).to_string();
                let last = path.split('.').last().unwrap_or(&path).to_string();
                let mut imp = Import::new(path, vec![last], start_line(node));
                imp.swift_import = Some(true);
                symbols.imports.push(imp);
            }
        }

        "call_expression" => {
            if let Some(fn_node) = node.child(0) {
                match fn_node.kind() {
                    "simple_identifier" => {
                        symbols.calls.push(Call {
                            name: node_text(&fn_node, source).to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                    "navigation_expression" => {
                        let last = fn_node.child(fn_node.child_count().saturating_sub(1));
                        let name = last
                            .map(|n| node_text(&n, source).to_string())
                            .unwrap_or_else(|| node_text(&fn_node, source).to_string());
                        let receiver = fn_node.child(0)
                            .map(|n| node_text(&n, source).to_string());
                        symbols.calls.push(Call {
                            name,
                            line: start_line(node),
                            dynamic: None,
                            receiver,
                        });
                    }
                    _ => {
                        symbols.calls.push(Call {
                            name: node_text(&fn_node, source).to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                }
            }
        }

        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_swift(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_swift::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        SwiftExtractor.extract(&tree, code.as_bytes(), "Test.swift")
    }

    #[test]
    fn extracts_class() {
        let s = parse_swift("class Foo { var x: Int = 0 }");
        let foo = s.definitions.iter().find(|d| d.name == "Foo").unwrap();
        assert_eq!(foo.kind, "class");
    }

    #[test]
    fn extracts_struct() {
        let s = parse_swift("struct Point { var x: Int; var y: Int }");
        let point = s.definitions.iter().find(|d| d.name == "Point").unwrap();
        assert_eq!(point.kind, "struct");
    }

    #[test]
    fn extracts_protocol() {
        let s = parse_swift("protocol Drawable { func draw() }");
        let proto = s.definitions.iter().find(|d| d.name == "Drawable").unwrap();
        assert_eq!(proto.kind, "interface");
    }

    #[test]
    fn extracts_function() {
        let s = parse_swift("func greet(name: String) -> String { return name }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
    }

    #[test]
    fn extracts_import() {
        let s = parse_swift("import Foundation");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].path, "Foundation");
        assert!(s.imports[0].swift_import.unwrap());
    }
}
