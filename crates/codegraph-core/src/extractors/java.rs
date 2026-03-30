use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct JavaExtractor;

impl SymbolExtractor for JavaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_java_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &JAVA_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_java_type_map);
        symbols
    }
}

// ── Type inference helpers ──────────────────────────────────────────────────

fn extract_java_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if type_node.kind() == "generic_type" {
        type_node.child(0).map(|n| node_text(&n, source))
    } else {
        Some(node_text(type_node, source))
    }
}

fn match_java_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "local_variable_declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_java_type_name(&type_node, source) {
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            if child.kind() == "variable_declarator" {
                                if let Some(name_node) = child.child_by_field_name("name") {
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
        "formal_parameter" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_java_type_name(&type_node, source) {
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
}

fn find_java_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_declaration" | "enum_declaration" | "interface_declaration" => {
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

fn match_java_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                let children = extract_java_class_fields(node, source);
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

                // Superclass
                if let Some(superclass) = node.child_by_field_name("superclass") {
                    for i in 0..superclass.child_count() {
                        if let Some(child) = superclass.child(i) {
                            match child.kind() {
                                "type_identifier" | "identifier" => {
                                    symbols.classes.push(ClassRelation {
                                        name: class_name.clone(),
                                        extends: Some(node_text(&child, source).to_string()),
                                        implements: None,
                                        line: start_line(node),
                                    });
                                    break;
                                }
                                "generic_type" => {
                                    if let Some(first) = child.child(0) {
                                        symbols.classes.push(ClassRelation {
                                            name: class_name.clone(),
                                            extends: Some(
                                                node_text(&first, source).to_string(),
                                            ),
                                            implements: None,
                                            line: start_line(node),
                                        });
                                    }
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }

                // Interfaces
                if let Some(interfaces) = node.child_by_field_name("interfaces") {
                    extract_java_interfaces(&interfaces, &class_name, source, symbols);
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
                                        complexity: compute_all_metrics(&child, source, "java"),
                                        cfg: build_function_cfg(&child, "java", source),
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
                let children = extract_java_enum_constants(node, source);
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
                let parent_class = find_java_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let children = extract_java_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "java"),
                    cfg: build_function_cfg(node, "java", source),
                    children: opt_children(children),
                });
            }
        }

        "constructor_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_class = find_java_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let children = extract_java_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "java"),
                    cfg: build_function_cfg(node, "java", source),
                    children: opt_children(children),
                });
            }
        }

        "import_declaration" => {
            let mut import_path = String::new();
            let mut has_asterisk = false;
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    if child.kind() == "scoped_identifier" || child.kind() == "identifier" {
                        import_path = node_text(&child, source).to_string();
                    }
                    if child.kind() == "asterisk" {
                        has_asterisk = true;
                    }
                }
            }
            if !import_path.is_empty() {
                let names = if has_asterisk {
                    vec!["*".to_string()]
                } else {
                    let last = import_path.split('.').last().unwrap_or("").to_string();
                    vec![last]
                };
                let mut imp = Import::new(import_path, names, start_line(node));
                imp.java_import = Some(true);
                symbols.imports.push(imp);
            }
        }

        "method_invocation" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let receiver = node.child_by_field_name("object")
                    .map(|obj| node_text(&obj, source).to_string());
                symbols.calls.push(Call {
                    name: node_text(&name_node, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                });
            }
        }

        "object_creation_expression" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = if type_node.kind() == "generic_type" {
                    type_node.child(0).map(|n| node_text(&n, source).to_string())
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
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_java_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "formal_parameters"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "formal_parameter" || child.kind() == "spread_parameter" {
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

fn extract_java_class_fields(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let body = node.child_by_field_name("body");
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "field_declaration" {
                    // Field declarators contain the names
                    for j in 0..child.child_count() {
                        if let Some(decl) = child.child(j) {
                            if decl.kind() == "variable_declarator" {
                                if let Some(name_node) = decl.child_by_field_name("name") {
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
    fields
}

fn extract_java_enum_constants(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut constants = Vec::new();
    let body = node.child_by_field_name("body");
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_constant" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        constants.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    constants
}

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_java_interfaces(
    interfaces: &Node,
    class_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..interfaces.child_count() {
        if let Some(child) = interfaces.child(i) {
            match child.kind() {
                "type_identifier" | "identifier" => {
                    symbols.classes.push(ClassRelation {
                        name: class_name.to_string(),
                        extends: None,
                        implements: Some(node_text(&child, source).to_string()),
                        line: start_line(interfaces),
                    });
                }
                "type_list" => {
                    for j in 0..child.child_count() {
                        if let Some(t) = child.child(j) {
                            match t.kind() {
                                "type_identifier" | "identifier" => {
                                    symbols.classes.push(ClassRelation {
                                        name: class_name.to_string(),
                                        extends: None,
                                        implements: Some(node_text(&t, source).to_string()),
                                        line: start_line(interfaces),
                                    });
                                }
                                "generic_type" => {
                                    if let Some(first) = t.child(0) {
                                        symbols.classes.push(ClassRelation {
                                            name: class_name.to_string(),
                                            extends: None,
                                            implements: Some(
                                                node_text(&first, source).to_string(),
                                            ),
                                            line: start_line(interfaces),
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                "generic_type" => {
                    if let Some(first) = child.child(0) {
                        symbols.classes.push(ClassRelation {
                            name: class_name.to_string(),
                            extends: None,
                            implements: Some(node_text(&first, source).to_string()),
                            line: start_line(interfaces),
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_java(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_java::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        JavaExtractor.extract(&tree, code.as_bytes(), "Test.java")
    }

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_method_parameters() {
        let s = parse_java("class Foo { void bar(int x, String y) {} }");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "x");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "y");
    }

    #[test]
    fn extracts_class_fields() {
        let s = parse_java("class User { String name; int age; }");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"name"));
        assert!(names.contains(&"age"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_enum_constants() {
        let s = parse_java("enum Status { ACTIVE, INACTIVE }");
        let status = s.definitions.iter().find(|d| d.name == "Status").unwrap();
        let children = status.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "ACTIVE");
        assert_eq!(children[0].kind, "constant");
        assert_eq!(children[1].name, "INACTIVE");
    }
}
