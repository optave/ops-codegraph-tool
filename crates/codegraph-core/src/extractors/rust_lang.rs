use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct RustExtractor;

impl SymbolExtractor for RustExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
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
    match node.kind() {
        "function_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = node_text(&name_node, source);
                let impl_type = find_current_impl(node, source);
                let (full_name, kind) = match &impl_type {
                    Some(t) => (format!("{}.{}", t, name), "method".to_string()),
                    None => (name.to_string(), "function".to_string()),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind,
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
            }
        }

        "struct_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "struct".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
            }
        }

        "enum_item" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "enum".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
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
            walk_node(&child, source, symbols);
        }
    }
}

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
