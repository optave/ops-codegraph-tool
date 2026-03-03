use tree_sitter::{Node, Tree};
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct JavaExtractor;

impl SymbolExtractor for JavaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
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

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: class_name.clone(),
                    kind: "class".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: None,
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
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "enum".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    children: None,
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
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "java"),
                    children: None,
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
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "java"),
                    children: None,
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

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_node(&child, source, symbols);
        }
    }
}

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
