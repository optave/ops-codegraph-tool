use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct DartExtractor;

impl SymbolExtractor for DartExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_dart_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &DART_AST_CONFIG);
        symbols
    }
}

fn match_dart_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        // tree-sitter-dart 0.0.4 uses `class_definition`; 0.2 renamed it to
        // `class_declaration`. Accept both so the extractor works across crate
        // versions and during any transition period.
        "class_definition" | "class_declaration" => handle_dart_class(node, source, symbols),
        "enum_declaration" => handle_dart_enum(node, source, symbols),
        "mixin_declaration" => handle_dart_mixin(node, source, symbols),
        "extension_declaration" => handle_dart_extension(node, source, symbols),
        "function_signature" => {
            if !is_inside_class(node) {
                handle_dart_function_sig(node, source, symbols);
            }
        }
        "library_import" => handle_dart_import(node, source, symbols),
        "constructor_invocation" | "new_expression" => handle_dart_constructor_call(node, source, symbols),
        "type_alias" => handle_dart_type_alias(node, source, symbols),
        _ => {}
    }
}

fn handle_dart_class(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };
    let class_name = node_text(&name_node, source).to_string();

    // Extract methods
    if let Some(body) = node.child_by_field_name("body").or_else(|| find_child(node, "class_body")) {
        extract_dart_class_methods(&body, &class_name, source, symbols);
    }

    // Extract inheritance
    if let Some(superclass) = node.child_by_field_name("superclass") {
        if let Some(type_name) = find_child(&superclass, "type_identifier")
            .or_else(|| find_child(&superclass, "identifier"))
        {
            symbols.classes.push(ClassRelation {
                name: class_name.clone(),
                extends: Some(node_text(&type_name, source).to_string()),
                implements: None,
                line: start_line(node),
            });
        }
    }
    if let Some(interfaces) = node.child_by_field_name("interfaces") {
        for i in 0..interfaces.child_count() {
            if let Some(child) = interfaces.child(i) {
                let type_name = if child.kind() == "type_identifier" {
                    Some(child)
                } else {
                    find_child(&child, "type_identifier").or_else(|| find_child(&child, "identifier"))
                };
                if let Some(tn) = type_name {
                    symbols.classes.push(ClassRelation {
                        name: class_name.clone(),
                        extends: None,
                        implements: Some(node_text(&tn, source).to_string()),
                        line: start_line(node),
                    });
                }
            }
        }
    }

    symbols.definitions.push(Definition {
        name: class_name,
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn extract_dart_class_methods(body: &Node, class_name: &str, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..body.child_count() {
        if let Some(member) = body.child(i) {
            // Resolve the signature node from the various wrapper layers that
            // different tree-sitter-dart crate versions produce:
            //
            // 0.0.4 — class_body → class_member_definition → method_signature
            // 0.2   — class_body → class_member → method_declaration
            //                                     (field "signature" → method_signature)
            //
            // In all cases we ultimately want the `method_signature` /
            // `function_signature` node to extract the function name and
            // build CFG/complexity metrics.
            let sig = match member.kind() {
                "class_member_definition" => {
                    // 0.0.4 path: member wraps the signature directly
                    match find_dart_signature_child(&member) {
                        Some(s) => s,
                        None => continue,
                    }
                }
                "class_member" => {
                    // 0.2 path: member → method_declaration (field "signature")
                    // or member → declaration (variable/field — skip those)
                    let method_decl = find_child(&member, "method_declaration");
                    match method_decl {
                        Some(md) => {
                            // method_declaration has field "signature" → method_signature
                            match md.child_by_field_name("signature")
                                .or_else(|| find_dart_signature_child(&md))
                            {
                                Some(s) => s,
                                None => continue,
                            }
                        }
                        None => continue,
                    }
                }
                // Direct signatures at the top of the class body (some grammar versions)
                _ => member,
            };
            match sig.kind() {
                "method_signature" | "function_signature" => {
                    if let Some(fn_name) = extract_dart_fn_name(&sig, source) {
                        symbols.definitions.push(Definition {
                            name: format!("{}.{}", class_name, fn_name),
                            kind: "method".to_string(),
                            line: start_line(&sig),
                            end_line: Some(end_line(&sig)),
                            decorators: None,
                            complexity: compute_all_metrics(&sig, source, "dart"),
                            cfg: build_function_cfg(&sig, "dart", source),
                            children: None,
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

fn find_dart_signature_child<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if matches!(child.kind(), "method_signature" | "function_signature") {
                return Some(child);
            }
        }
    }
    None
}

fn extract_dart_fn_name(node: &Node, source: &[u8]) -> Option<String> {
    if let Some(name) = node.child_by_field_name("name") {
        return Some(node_text(&name, source).to_string());
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "function_signature" | "getter_signature" | "setter_signature" | "constructor_signature" => {
                    if let Some(name) = child.child_by_field_name("name") {
                        return Some(node_text(&name, source).to_string());
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn handle_dart_enum(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "enum".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_dart_mixin(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_dart_extension(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_dart_function_sig(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "dart"),
        cfg: build_function_cfg(node, "dart", source),
        children: None,
    });
}

fn handle_dart_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let spec = match find_child(node, "import_specification") {
        Some(s) => s,
        None => return,
    };

    let uri = find_child(&spec, "configurable_uri")
        .or_else(|| find_child(&spec, "uri"));
    if let Some(uri) = uri {
        let raw = node_text(&uri, source);
        let source_path = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
        symbols.imports.push(Import::new(
            source_path,
            vec![],
            start_line(node),
        ));
    }
}

fn handle_dart_constructor_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "type_identifier")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name) = name_node {
        symbols.calls.push(Call {
            name: node_text(&name, source).to_string(),
            line: start_line(node),
            dynamic: None,
            receiver: None,
        });
    }
}

fn handle_dart_type_alias(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = find_child(node, "type_identifier")
        .or_else(|| find_child(node, "identifier"));
    if let Some(name) = name_node {
        symbols.definitions.push(Definition {
            name: node_text(&name, source).to_string(),
            kind: "type".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn is_inside_class(node: &Node) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            // Accept both 0.0.4 (`class_definition`) and 0.2 (`class_declaration`)
            // node names to guard function_signature extraction from top-level scope.
            "class_body" | "class_definition" | "class_declaration"
            | "enum_body" | "mixin_declaration" => return true,
            _ => {}
        }
        current = parent.parent();
    }
    false
}

