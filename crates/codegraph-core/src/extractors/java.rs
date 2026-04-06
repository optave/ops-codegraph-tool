use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

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
                                        confidence: 0.9,
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
                            confidence: 0.9,
                        });
                    }
                }
            }
        }
        _ => {}
    }
}

const JAVA_CLASS_KINDS: &[&str] = &["class_declaration", "enum_declaration", "interface_declaration"];

fn find_java_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, JAVA_CLASS_KINDS, source)
}

fn match_java_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_declaration" => handle_class_decl(node, source, symbols),
        "interface_declaration" => handle_interface_decl(node, source, symbols),
        "enum_declaration" => handle_enum_decl(node, source, symbols),
        "method_declaration" => handle_method_decl(node, source, symbols),
        "constructor_declaration" => handle_constructor_decl(node, source, symbols),
        "import_declaration" => handle_import_decl(node, source, symbols),
        "method_invocation" => handle_method_invocation(node, source, symbols),
        "object_creation_expression" => handle_object_creation(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
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
        extract_java_superclass(&superclass, &class_name, node, source, symbols);
    }

    // Interfaces
    if let Some(interfaces) = node.child_by_field_name("interfaces") {
        extract_java_interfaces(&interfaces, &class_name, source, symbols);
    }
}

fn extract_java_superclass(superclass: &Node, class_name: &str, node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..superclass.child_count() {
        let Some(child) = superclass.child(i) else { continue };
        match child.kind() {
            "type_identifier" | "identifier" => {
                symbols.classes.push(ClassRelation {
                    name: class_name.to_string(),
                    extends: Some(node_text(&child, source).to_string()),
                    implements: None,
                    line: start_line(node),
                });
                break;
            }
            "generic_type" => {
                if let Some(first) = child.child(0) {
                    symbols.classes.push(ClassRelation {
                        name: class_name.to_string(),
                        extends: Some(node_text(&first, source).to_string()),
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
                    complexity: compute_all_metrics(&child, source, "java"),
                    cfg: build_function_cfg(&child, "java", source),
                    children: None,
                });
            }
        }
    }
}

fn handle_enum_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_method_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_constructor_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_import_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_method_invocation(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_object_creation(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(type_node) = node.child_by_field_name("type") else { return };
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
        let Some(child) = interfaces.child(i) else { continue };
        match child.kind() {
            "type_identifier" | "identifier" => {
                push_implements(symbols, class_name, node_text(&child, source), interfaces);
            }
            "type_list" => {
                collect_type_list_implements(&child, class_name, source, symbols, interfaces);
            }
            "generic_type" => {
                if let Some(first) = child.child(0) {
                    push_implements(symbols, class_name, node_text(&first, source), interfaces);
                }
            }
            _ => {}
        }
    }
}

fn push_implements(symbols: &mut FileSymbols, class_name: &str, iface_name: &str, line_node: &Node) {
    symbols.classes.push(ClassRelation {
        name: class_name.to_string(),
        extends: None,
        implements: Some(iface_name.to_string()),
        line: start_line(line_node),
    });
}

fn collect_type_list_implements(
    type_list: &Node,
    class_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
    line_node: &Node,
) {
    for j in 0..type_list.child_count() {
        let Some(t) = type_list.child(j) else { continue };
        match t.kind() {
            "type_identifier" | "identifier" => {
                push_implements(symbols, class_name, node_text(&t, source), line_node);
            }
            "generic_type" => {
                if let Some(first) = t.child(0) {
                    push_implements(symbols, class_name, node_text(&first, source), line_node);
                }
            }
            _ => {}
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
