use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct KotlinExtractor;

impl SymbolExtractor for KotlinExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_kotlin_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &KOTLIN_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_kotlin_type_map);
        symbols
    }
}

// ── Type inference ──────────────────────────────────────────────────────────

fn match_kotlin_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "property_declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = node_text(&type_node, source);
                // Name can be in a pattern child or directly via field
                let name = node.child_by_field_name("name")
                    .or_else(|| find_child(node, "simple_identifier"))
                    .map(|n| node_text(&n, source).to_string());
                if let Some(name) = name {
                    symbols.type_map.push(TypeMapEntry {
                        name,
                        type_name: type_name.to_string(),
                    });
                }
            }
        }
        "parameter" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(name_node) = node.child_by_field_name("name")
                    .or_else(|| find_child(node, "simple_identifier"))
                {
                    symbols.type_map.push(TypeMapEntry {
                        name: node_text(&name_node, source).to_string(),
                        type_name: node_text(&type_node, source).to_string(),
                    });
                }
            }
        }
        _ => {}
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Check if a class_declaration has an "interface" keyword child.
fn is_kotlin_interface(node: &Node) -> bool {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "interface" {
                return true;
            }
        }
    }
    false
}

/// Check if a class_declaration has "enum" in its modifiers.
fn is_kotlin_enum(node: &Node) -> bool {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "modifiers" {
                for j in 0..child.child_count() {
                    if let Some(mod_child) = child.child(j) {
                        if mod_child.kind() == "enum" {
                            return true;
                        }
                    }
                }
            }
            // Also check direct "enum" keyword child
            if child.kind() == "enum" {
                return true;
            }
        }
    }
    false
}

fn find_kotlin_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_declaration" | "object_declaration" => {
                return find_child(&parent, "type_identifier")
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn extract_kotlin_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(param_list) = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "function_value_parameters"))
    {
        for i in 0..param_list.child_count() {
            if let Some(child) = param_list.child(i) {
                if child.kind() == "parameter" {
                    if let Some(name_node) = child.child_by_field_name("name")
                        .or_else(|| find_child(&child, "simple_identifier"))
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

fn extract_kotlin_class_properties(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    if let Some(body) = find_child(node, "class_body") {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "property_declaration" {
                    let name = child.child_by_field_name("name")
                        .or_else(|| find_child(&child, "simple_identifier"))
                        .map(|n| node_text(&n, source).to_string());
                    if let Some(name) = name {
                        props.push(child_def(name, "property", start_line(&child)));
                    }
                }
            }
        }
    }
    props
}

fn extract_kotlin_enum_entries(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut entries = Vec::new();
    if let Some(body) = find_child(node, "class_body") {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_entry" {
                    if let Some(name_node) = find_child(&child, "simple_identifier") {
                        entries.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    entries
}

fn extract_kotlin_delegation_specifiers(node: &Node, source: &[u8], class_name: &str, symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "delegation_specifier" {
                // constructor_invocation > user_type > type_identifier => extends
                if let Some(ctor) = find_child(&child, "constructor_invocation") {
                    if let Some(user_type) = find_child(&ctor, "user_type") {
                        if let Some(type_id) = find_child(&user_type, "type_identifier") {
                            symbols.classes.push(ClassRelation {
                                name: class_name.to_string(),
                                extends: Some(node_text(&type_id, source).to_string()),
                                implements: None,
                                line: start_line(node),
                            });
                        }
                    }
                }
                // user_type > type_identifier => implements (interface)
                else if let Some(user_type) = find_child(&child, "user_type") {
                    if let Some(type_id) = find_child(&user_type, "type_identifier") {
                        symbols.classes.push(ClassRelation {
                            name: class_name.to_string(),
                            extends: None,
                            implements: Some(node_text(&type_id, source).to_string()),
                            line: start_line(node),
                        });
                    }
                }
            }
        }
    }
}

fn match_kotlin_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_declaration" => {
            let name_node = find_child(node, "type_identifier");
            if let Some(name_node) = name_node {
                let class_name = node_text(&name_node, source).to_string();

                if is_kotlin_interface(node) {
                    symbols.definitions.push(Definition {
                        name: class_name.clone(),
                        kind: "interface".to_string(),
                        line: start_line(node),
                        end_line: Some(end_line(node)),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: None,
                    });
                } else if is_kotlin_enum(node) {
                    let children = extract_kotlin_enum_entries(node, source);
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
                } else {
                    let children = extract_kotlin_class_properties(node, source);
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
                }

                extract_kotlin_delegation_specifiers(node, source, &class_name, symbols);
            }
        }

        "object_declaration" => {
            if let Some(name_node) = find_child(node, "type_identifier") {
                let obj_name = node_text(&name_node, source).to_string();
                let children = extract_kotlin_class_properties(node, source);
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
                extract_kotlin_delegation_specifiers(node, source, &obj_name, symbols);
            }
        }

        "function_declaration" => {
            if let Some(name_node) = find_child(node, "simple_identifier") {
                let parent_class = find_kotlin_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let kind = if parent_class.is_some() { "method" } else { "function" };
                let children = extract_kotlin_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: kind.to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "kotlin"),
                    cfg: build_function_cfg(node, "kotlin", source),
                    children: opt_children(children),
                });
            }
        }

        "import_header" => {
            if let Some(id_node) = find_child(node, "identifier") {
                let path = node_text(&id_node, source).to_string();
                let last = path.split('.').last().unwrap_or("").to_string();
                let mut imp = Import::new(path, vec![last], start_line(node));
                imp.kotlin_import = Some(true);
                symbols.imports.push(imp);
            }
        }

        "call_expression" => {
            // function child is the callee
            if let Some(fn_node) = node.child_by_field_name("function")
                .or_else(|| node.child(0))
            {
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
                        // obj.method()
                        let name = fn_node.child_by_field_name("member")
                            .or_else(|| {
                                let count = fn_node.child_count();
                                if count > 0 { fn_node.child(count - 1) } else { None }
                            })
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

    fn parse_kotlin(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_kotlin::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        KotlinExtractor.extract(&tree, code.as_bytes(), "Test.kt")
    }

    #[test]
    fn extracts_class() {
        let s = parse_kotlin("class Foo { val x: Int = 1 }");
        let foo = s.definitions.iter().find(|d| d.name == "Foo").unwrap();
        assert_eq!(foo.kind, "class");
    }

    #[test]
    fn extracts_interface() {
        let s = parse_kotlin("interface Baz { fun doIt() }");
        let baz = s.definitions.iter().find(|d| d.name == "Baz").unwrap();
        assert_eq!(baz.kind, "interface");
    }

    #[test]
    fn extracts_function() {
        let s = parse_kotlin("fun greet(name: String): String { return name }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
    }

    #[test]
    fn extracts_import() {
        let s = parse_kotlin("import com.example.Foo");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].path, "com.example.Foo");
        assert!(s.imports[0].kotlin_import.unwrap());
    }

    #[test]
    fn extracts_object() {
        let s = parse_kotlin("object Singleton { val x = 1 }");
        let obj = s.definitions.iter().find(|d| d.name == "Singleton").unwrap();
        assert_eq!(obj.kind, "class");
    }
}
