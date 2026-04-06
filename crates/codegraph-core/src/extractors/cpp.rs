use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct CppExtractor;

impl SymbolExtractor for CppExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_cpp_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &CPP_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_cpp_type_map);
        symbols
    }
}

// ── Type inference ──────────────────────────────────────────────────────────

fn match_cpp_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
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
                                let final_name = unwrap_cpp_declarator(&name_node, source);
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
                    let name = unwrap_cpp_declarator(&decl, source);
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

fn unwrap_cpp_declarator(node: &Node, source: &[u8]) -> String {
    let mut current = *node;
    loop {
        match current.kind() {
            "pointer_declarator" | "reference_declarator" | "array_declarator"
            | "parenthesized_declarator" => {
                if let Some(inner) = current.child_by_field_name("declarator") {
                    current = inner;
                } else {
                    break;
                }
            }
            "identifier" | "field_identifier" => return node_text(&current, source).to_string(),
            _ => break,
        }
    }
    node_text(&current, source).to_string()
}

fn extract_cpp_function_name(node: &Node, source: &[u8]) -> Option<String> {
    let declarator = node.child_by_field_name("declarator")?;
    extract_cpp_func_name_from_declarator(&declarator, source)
}

fn extract_cpp_func_name_from_declarator(declarator: &Node, source: &[u8]) -> Option<String> {
    match declarator.kind() {
        "function_declarator" => {
            let inner = declarator.child_by_field_name("declarator")?;
            Some(unwrap_cpp_declarator(&inner, source))
        }
        "pointer_declarator" | "reference_declarator" => {
            let inner = find_child(declarator, "function_declarator")?;
            let name_node = inner.child_by_field_name("declarator")?;
            Some(unwrap_cpp_declarator(&name_node, source))
        }
        _ => Some(unwrap_cpp_declarator(declarator, source)),
    }
}

fn extract_cpp_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let declarator = match node.child_by_field_name("declarator") {
        Some(d) => d,
        None => return params,
    };
    let func_decl = if declarator.kind() == "function_declarator" {
        Some(declarator)
    } else {
        find_child(&declarator, "function_declarator")
    };
    if let Some(func_decl) = func_decl {
        if let Some(param_list) = func_decl.child_by_field_name("parameters") {
            for i in 0..param_list.child_count() {
                if let Some(child) = param_list.child(i) {
                    if child.kind() == "parameter_declaration" || child.kind() == "optional_parameter_declaration" {
                        if let Some(decl) = child.child_by_field_name("declarator") {
                            let name = unwrap_cpp_declarator(&decl, source);
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

fn extract_cpp_fields(body: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if child.kind() == "field_declaration" {
                if let Some(decl) = child.child_by_field_name("declarator") {
                    let name = unwrap_cpp_declarator(&decl, source);
                    if !name.is_empty() {
                        fields.push(child_def(name, "property", start_line(&child)));
                    }
                }
            }
        }
    }
    fields
}

fn extract_cpp_enum_constants(node: &Node, source: &[u8]) -> Vec<Definition> {
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

fn find_cpp_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class_specifier" | "struct_specifier" => {
                return parent.child_by_field_name("name")
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn extract_cpp_base_classes(node: &Node, source: &[u8], class_name: &str, symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "base_class_clause" {
                for j in 0..child.child_count() {
                    if let Some(base) = child.child(j) {
                        match base.kind() {
                            "type_identifier" | "qualified_identifier" | "scoped_type_identifier" => {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.to_string(),
                                    extends: Some(node_text(&base, source).to_string()),
                                    implements: None,
                                    line: start_line(node),
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

// ── Per-node-kind handlers ──────────────────────────────────────────────────

fn handle_cpp_function_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name) = extract_cpp_function_name(node, source) {
        let parent_class = find_cpp_parent_class(node, source);
        let full_name = match &parent_class {
            Some(cls) => format!("{}.{}", cls, name),
            None => name,
        };
        let kind = if parent_class.is_some() { "method" } else { "function" };
        let children = extract_cpp_parameters(node, source);
        symbols.definitions.push(Definition {
            name: full_name,
            kind: kind.to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "cpp"),
            cfg: build_function_cfg(node, "cpp", source),
            children: opt_children(children),
        });
    }
}

fn handle_cpp_class_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let class_name = node_text(&name_node, source).to_string();
        let children = node.child_by_field_name("body")
            .map(|body| extract_cpp_fields(&body, source))
            .unwrap_or_default();
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
        extract_cpp_base_classes(node, source, &class_name, symbols);
    }
}

fn handle_cpp_struct_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let struct_name = node_text(&name_node, source).to_string();
        let children = node.child_by_field_name("body")
            .map(|body| extract_cpp_fields(&body, source))
            .unwrap_or_default();
        symbols.definitions.push(Definition {
            name: struct_name.clone(),
            kind: "struct".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
        });
        extract_cpp_base_classes(node, source, &struct_name, symbols);
    }
}

fn handle_cpp_enum_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_cpp_enum_constants(node, source);
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

fn handle_cpp_namespace_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "namespace".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_cpp_type_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
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

fn handle_cpp_preproc_include(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(path_node) = node.child_by_field_name("path") {
        let raw = node_text(&path_node, source);
        let path = raw.trim_matches(|c| c == '"' || c == '<' || c == '>');
        if !path.is_empty() {
            let last = path.split('/').last().unwrap_or(path);
            let name = last.strip_suffix(".h")
                .or_else(|| last.strip_suffix(".hpp"))
                .unwrap_or(last);
            let mut imp = Import::new(path.to_string(), vec![name.to_string()], start_line(node));
            imp.c_include = Some(true);
            symbols.imports.push(imp);
        }
    }
}

fn handle_cpp_call_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(fn_node) = node.child_by_field_name("function") {
        match fn_node.kind() {
            "identifier" | "qualified_identifier" | "scoped_identifier" => {
                symbols.calls.push(Call {
                    name: node_text(&fn_node, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
            "field_expression" => {
                let name = fn_node.child_by_field_name("field")
                    .map(|n| node_text(&n, source).to_string())
                    .unwrap_or_else(|| node_text(&fn_node, source).to_string());
                let receiver = fn_node.child_by_field_name("argument")
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

fn match_cpp_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => handle_cpp_function_definition(node, source, symbols),
        "class_specifier" => handle_cpp_class_specifier(node, source, symbols),
        "struct_specifier" => handle_cpp_struct_specifier(node, source, symbols),
        "enum_specifier" => handle_cpp_enum_specifier(node, source, symbols),
        "namespace_definition" => handle_cpp_namespace_definition(node, source, symbols),
        "type_definition" => handle_cpp_type_definition(node, source, symbols),
        "preproc_include" => handle_cpp_preproc_include(node, source, symbols),
        "call_expression" => handle_cpp_call_expression(node, source, symbols),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_cpp(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_cpp::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        CppExtractor.extract(&tree, code.as_bytes(), "test.cpp")
    }

    #[test]
    fn extracts_function() {
        let s = parse_cpp("int main(int argc) { return 0; }");
        let main = s.definitions.iter().find(|d| d.name == "main").unwrap();
        assert_eq!(main.kind, "function");
    }

    #[test]
    fn extracts_class_with_method() {
        let s = parse_cpp("class Foo { public: void bar() {} };");
        let foo = s.definitions.iter().find(|d| d.name == "Foo").unwrap();
        assert_eq!(foo.kind, "class");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        assert_eq!(bar.kind, "method");
    }

    #[test]
    fn extracts_namespace() {
        let s = parse_cpp("namespace myns { int x; }");
        let ns = s.definitions.iter().find(|d| d.name == "myns").unwrap();
        assert_eq!(ns.kind, "namespace");
    }

    #[test]
    fn extracts_inheritance() {
        let s = parse_cpp("class Base {}; class Derived : public Base {};");
        let rel = s.classes.iter().find(|c| c.name == "Derived").unwrap();
        assert_eq!(rel.extends.as_deref(), Some("Base"));
    }

    #[test]
    fn extracts_include() {
        let s = parse_cpp("#include <iostream>\n#include \"mylib.hpp\"");
        assert_eq!(s.imports.len(), 2);
        assert!(s.imports[0].c_include.unwrap());
    }
}
