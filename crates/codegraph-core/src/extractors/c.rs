use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct CExtractor;

impl SymbolExtractor for CExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_c_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &C_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_c_type_map);
        symbols
    }
}

// ── Type inference helpers ──────────────────────────────────────────────────

fn match_c_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = node_text(&type_node, source);
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        if child.kind() == "init_declarator" || child.kind() == "identifier" {
                            let name_node = if child.kind() == "init_declarator" {
                                child.child_by_field_name("declarator")
                            } else {
                                Some(child)
                            };
                            if let Some(name_node) = name_node {
                                // Unwrap pointer_declarator chains
                                let final_name = unwrap_declarator(&name_node, source);
                                if !final_name.is_empty() {
                                    symbols.type_map.push(TypeMapEntry {
                                        name: final_name,
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
        "parameter_declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(decl) = node.child_by_field_name("declarator") {
                    let name = unwrap_declarator(&decl, source);
                    if !name.is_empty() {
                        symbols.type_map.push(TypeMapEntry {
                            name,
                            type_name: node_text(&type_node, source).to_string(),
                            confidence: 0.9,
                        });
                    }
                }
            }
        }
        _ => {}
    }
}

/// Walk pointer_declarator / array_declarator chains to reach the identifier.
fn unwrap_declarator(node: &Node, source: &[u8]) -> String {
    let mut current = *node;
    loop {
        match current.kind() {
            "pointer_declarator" | "array_declarator" | "parenthesized_declarator" => {
                if let Some(inner) = current.child_by_field_name("declarator") {
                    current = inner;
                } else {
                    break;
                }
            }
            "identifier" => return node_text(&current, source).to_string(),
            _ => break,
        }
    }
    node_text(&current, source).to_string()
}

/// Extract function name from a C function_definition declarator chain.
fn extract_c_function_name(node: &Node, source: &[u8]) -> Option<String> {
    let declarator = node.child_by_field_name("declarator")?;
    // declarator is typically function_declarator
    let inner = if declarator.kind() == "function_declarator" {
        declarator.child_by_field_name("declarator")
    } else if declarator.kind() == "pointer_declarator" {
        // e.g. `int *func()`
        let fd = find_child(&declarator, "function_declarator")?;
        fd.child_by_field_name("declarator")
    } else {
        Some(declarator)
    };
    inner.map(|n| unwrap_declarator(&n, source))
}

/// Extract parameters from a function_definition.
fn extract_c_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let declarator = match node.child_by_field_name("declarator") {
        Some(d) => d,
        None => return params,
    };
    // Find the function_declarator (may be nested under pointer_declarator)
    let func_decl = if declarator.kind() == "function_declarator" {
        Some(declarator)
    } else {
        find_child(&declarator, "function_declarator")
    };
    if let Some(func_decl) = func_decl {
        if let Some(param_list) = func_decl.child_by_field_name("parameters") {
            for i in 0..param_list.child_count() {
                if let Some(child) = param_list.child(i) {
                    if child.kind() == "parameter_declaration" {
                        if let Some(decl) = child.child_by_field_name("declarator") {
                            let name = unwrap_declarator(&decl, source);
                            if !name.is_empty() {
                                params.push(child_def(name, "parameter", start_line(&child)));
                            }
                        }
                    }
                }
            }
        }
    }
    params
}

/// Extract struct/union fields.
fn extract_c_fields(body: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if child.kind() == "field_declaration" {
                if let Some(decl) = child.child_by_field_name("declarator") {
                    let name = unwrap_declarator(&decl, source);
                    if !name.is_empty() {
                        fields.push(child_def(name, "property", start_line(&child)));
                    }
                }
            }
        }
    }
    fields
}

/// Extract enum constants from enumerator_list.
fn extract_c_enum_constants(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut constants = Vec::new();
    if let Some(body) = node.child_by_field_name("body") {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enumerator" {
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

fn match_c_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => {
            if let Some(name) = extract_c_function_name(node, source) {
                let children = extract_c_parameters(node, source);
                symbols.definitions.push(Definition {
                    name,
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "c"),
                    cfg: build_function_cfg(node, "c", source),
                    children: opt_children(children),
                });
            }
        }

        "struct_specifier" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let struct_name = node_text(&name_node, source).to_string();
                let children = node.child_by_field_name("body")
                    .map(|body| extract_c_fields(&body, source))
                    .unwrap_or_default();
                symbols.definitions.push(Definition {
                    name: struct_name,
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

        "union_specifier" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = node.child_by_field_name("body")
                    .map(|body| extract_c_fields(&body, source))
                    .unwrap_or_default();
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

        "enum_specifier" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = extract_c_enum_constants(node, source);
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

        "type_definition" => {
            // typedef — the last type_identifier or identifier child is the alias name
            let mut alias_name = None;
            for i in (0..node.child_count()).rev() {
                if let Some(child) = node.child(i) {
                    match child.kind() {
                        "type_identifier" | "identifier" | "primitive_type" => {
                            alias_name = Some(node_text(&child, source).to_string());
                            break;
                        }
                        _ => {}
                    }
                }
            }
            if let Some(name) = alias_name {
                symbols.definitions.push(Definition {
                    name,
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

        "preproc_include" => {
            if let Some(path_node) = node.child_by_field_name("path") {
                let raw = node_text(&path_node, source);
                let path = raw.trim_matches(|c| c == '"' || c == '<' || c == '>');
                if !path.is_empty() {
                    let last = path.split('/').last().unwrap_or(path);
                    let name = last.strip_suffix(".h").unwrap_or(last);
                    let mut imp = Import::new(path.to_string(), vec![name.to_string()], start_line(node));
                    imp.c_include = Some(true);
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
                        let name = named_child_text(&fn_node, "field", source)
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| node_text(&fn_node, source).to_string());
                        let receiver = named_child_text(&fn_node, "argument", source)
                            .map(|s| s.to_string());
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

    fn parse_c(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        CExtractor.extract(&tree, code.as_bytes(), "test.c")
    }

    #[test]
    fn extracts_function() {
        let s = parse_c("int main(int argc, char *argv[]) { return 0; }");
        let main = s.definitions.iter().find(|d| d.name == "main").unwrap();
        assert_eq!(main.kind, "function");
        let children = main.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "argc");
    }

    #[test]
    fn extracts_struct() {
        let s = parse_c("struct Point { int x; int y; };");
        let point = s.definitions.iter().find(|d| d.name == "Point").unwrap();
        assert_eq!(point.kind, "struct");
        let children = point.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
    }

    #[test]
    fn extracts_enum() {
        let s = parse_c("enum Color { RED, GREEN, BLUE };");
        let e = s.definitions.iter().find(|d| d.name == "Color").unwrap();
        assert_eq!(e.kind, "enum");
        let children = e.children.as_ref().unwrap();
        assert_eq!(children.len(), 3);
        assert_eq!(children[0].name, "RED");
    }

    #[test]
    fn extracts_include() {
        let s = parse_c("#include <stdio.h>\n#include \"mylib.h\"");
        assert_eq!(s.imports.len(), 2);
        assert_eq!(s.imports[0].source, "stdio.h");
        assert!(s.imports[0].c_include.unwrap());
    }

    #[test]
    fn extracts_call() {
        let s = parse_c("void f() { printf(\"hello\"); }");
        let call = s.calls.iter().find(|c| c.name == "printf").unwrap();
        assert_eq!(call.name, "printf");
    }
}
