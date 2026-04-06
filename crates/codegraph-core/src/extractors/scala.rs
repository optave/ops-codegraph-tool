use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct ScalaExtractor;

impl SymbolExtractor for ScalaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_scala_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &SCALA_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_scala_type_map);
        symbols
    }
}

// ── Type inference ──────────────────────────────────────────────────────────

fn match_scala_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "val_definition" | "var_definition" => {
            if let Some(type_node) = node.child_by_field_name("type")
                .or_else(|| find_child(node, "type_identifier"))
            {
                if let Some(pat) = node.child_by_field_name("pattern")
                    .or_else(|| find_child(node, "identifier"))
                {
                    symbols.type_map.push(TypeMapEntry {
                        name: node_text(&pat, source).to_string(),
                        type_name: node_text(&type_node, source).to_string(),
                        confidence: 0.9,
                    });
                }
            }
        }
        "parameter" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(name_node) = node.child_by_field_name("name")
                    .or_else(|| find_child(node, "identifier"))
                {
                    symbols.type_map.push(TypeMapEntry {
                        name: node_text(&name_node, source).to_string(),
                        type_name: node_text(&type_node, source).to_string(),
                        confidence: 0.9,
                    });
                }
            }
        }
        _ => {}
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn find_scala_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_definition" | "object_definition" | "trait_definition" => {
                return parent.child_by_field_name("name")
                    .or_else(|| find_child(&parent, "identifier"))
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn extract_scala_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(param_list) = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "parameters"))
    {
        for i in 0..param_list.child_count() {
            if let Some(child) = param_list.child(i) {
                if child.kind() == "parameter" {
                    if let Some(name_node) = child.child_by_field_name("name")
                        .or_else(|| find_child(&child, "identifier"))
                    {
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

fn extract_scala_class_members(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut members = Vec::new();
    if let Some(body) = find_child(node, "template_body") {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                match child.kind() {
                    "val_definition" | "var_definition" => {
                        let name = child.child_by_field_name("pattern")
                            .or_else(|| find_child(&child, "identifier"))
                            .map(|n| node_text(&n, source).to_string());
                        if let Some(name) = name {
                            members.push(child_def(name, "property", start_line(&child)));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    members
}

fn extract_scala_extends(node: &Node, source: &[u8], class_name: &str, symbols: &mut FileSymbols) {
    if let Some(extends) = find_child(node, "extends_clause") {
        // The first type_identifier in the extends clause is the superclass
        let mut found_extends = false;
        for i in 0..extends.child_count() {
            if let Some(child) = extends.child(i) {
                match child.kind() {
                    "type_identifier" | "generic_type" => {
                        let type_name = if child.kind() == "generic_type" {
                            child.child(0).map(|n| node_text(&n, source).to_string())
                        } else {
                            Some(node_text(&child, source).to_string())
                        };
                        if let Some(type_name) = type_name {
                            if !found_extends {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.to_string(),
                                    extends: Some(type_name),
                                    implements: None,
                                    line: start_line(node),
                                });
                                found_extends = true;
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
                    _ => {}
                }
            }
        }
    }
}

/// Extract import path by concatenating alternating identifier and "." children.
fn extract_scala_import_path(node: &Node, source: &[u8]) -> String {
    let mut path = String::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "identifier" | "type_identifier" => {
                    if !path.is_empty() && !path.ends_with('.') {
                        path.push('.');
                    }
                    path.push_str(node_text(&child, source));
                }
                "." => {
                    if !path.is_empty() {
                        path.push('.');
                    }
                }
                "import_selectors" => {
                    // e.g. import scala.collection.mutable.{Map, Set}
                    // Just append the selectors text
                    if !path.is_empty() && !path.ends_with('.') {
                        path.push('.');
                    }
                    path.push_str(node_text(&child, source));
                }
                "wildcard" => {
                    if !path.is_empty() && !path.ends_with('.') {
                        path.push('.');
                    }
                    path.push('_');
                }
                // Skip keywords like "import"
                _ => {}
            }
        }
    }
    path
}

// ── Per-node-kind handlers ──────────────────────────────────────────────────

fn handle_scala_class_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name_node) = name_node {
        let class_name = node_text(&name_node, source).to_string();
        let children = extract_scala_class_members(node, source);
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
        extract_scala_extends(node, source, &class_name, symbols);
    }
}

fn handle_scala_trait_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name_node) = name_node {
        let trait_name = node_text(&name_node, source).to_string();
        symbols.definitions.push(Definition {
            name: trait_name.clone(),
            kind: "interface".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
        extract_scala_extends(node, source, &trait_name, symbols);
    }
}

fn handle_scala_object_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name_node) = name_node {
        let obj_name = node_text(&name_node, source).to_string();
        let children = extract_scala_class_members(node, source);
        symbols.definitions.push(Definition {
            name: obj_name.clone(),
            kind: "class".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
        });
        extract_scala_extends(node, source, &obj_name, symbols);
    }
}

fn handle_scala_function_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name_node) = name_node {
        let parent_class = find_scala_parent_class(node, source);
        let name = node_text(&name_node, source);
        let full_name = match &parent_class {
            Some(cls) => format!("{}.{}", cls, name),
            None => name.to_string(),
        };
        let kind = if parent_class.is_some() { "method" } else { "function" };
        let children = extract_scala_parameters(node, source);
        symbols.definitions.push(Definition {
            name: full_name,
            kind: kind.to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "scala"),
            cfg: build_function_cfg(node, "scala", source),
            children: opt_children(children),
        });
    }
}

fn handle_scala_import_declaration(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let path = extract_scala_import_path(node, source);
    if !path.is_empty() {
        let last = path.split('.').last().unwrap_or("").to_string();
        let mut imp = Import::new(path, vec![last], start_line(node));
        imp.scala_import = Some(true);
        symbols.imports.push(imp);
    }
}

fn handle_scala_call_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(fn_node) = node.child_by_field_name("function")
        .or_else(|| node.child(0))
    {
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
                let name = fn_node.child_by_field_name("field")
                    .or_else(|| fn_node.child_by_field_name("member"))
                    .map(|n| node_text(&n, source).to_string())
                    .unwrap_or_else(|| node_text(&fn_node, source).to_string());
                let receiver = fn_node.child_by_field_name("value")
                    .or_else(|| fn_node.child(0))
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

fn match_scala_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_definition" => handle_scala_class_definition(node, source, symbols),
        "trait_definition" => handle_scala_trait_definition(node, source, symbols),
        "object_definition" => handle_scala_object_definition(node, source, symbols),
        "function_definition" => handle_scala_function_definition(node, source, symbols),
        "import_declaration" => handle_scala_import_declaration(node, source, symbols),
        "call_expression" => handle_scala_call_expression(node, source, symbols),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_scala(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_scala::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        ScalaExtractor.extract(&tree, code.as_bytes(), "Test.scala")
    }

    #[test]
    fn extracts_class() {
        let s = parse_scala("class Foo { val x: Int = 1 }");
        let foo = s.definitions.iter().find(|d| d.name == "Foo").unwrap();
        assert_eq!(foo.kind, "class");
    }

    #[test]
    fn extracts_trait() {
        let s = parse_scala("trait Drawable { def draw(): Unit }");
        let t = s.definitions.iter().find(|d| d.name == "Drawable").unwrap();
        assert_eq!(t.kind, "interface");
    }

    #[test]
    fn extracts_object() {
        let s = parse_scala("object Singleton { val x = 1 }");
        let obj = s.definitions.iter().find(|d| d.name == "Singleton").unwrap();
        assert_eq!(obj.kind, "class");
    }

    #[test]
    fn extracts_function() {
        let s = parse_scala("def greet(name: String): String = name");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
    }

    #[test]
    fn extracts_import() {
        let s = parse_scala("import scala.collection.mutable.Map");
        assert_eq!(s.imports.len(), 1);
        assert!(s.imports[0].scala_import.unwrap());
    }
}
