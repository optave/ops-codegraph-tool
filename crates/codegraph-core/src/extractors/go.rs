use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct GoExtractor;

impl SymbolExtractor for GoExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "function_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
            }
        }

        "method_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let receiver = node.child_by_field_name("receiver");
                let mut receiver_type: Option<String> = None;
                if let Some(receiver) = receiver {
                    for i in 0..receiver.child_count() {
                        if let Some(param) = receiver.child(i) {
                            if let Some(type_node) = param.child_by_field_name("type") {
                                receiver_type = Some(if type_node.kind() == "pointer_type" {
                                    node_text(&type_node, source)
                                        .trim_start_matches('*')
                                        .to_string()
                                } else {
                                    node_text(&type_node, source).to_string()
                                });
                                break;
                            }
                        }
                    }
                }
                let name = node_text(&name_node, source);
                let full_name = match &receiver_type {
                    Some(rt) => format!("{}.{}", rt, name),
                    None => name.to_string(),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
            }
        }

        "type_declaration" => {
            for i in 0..node.child_count() {
                if let Some(spec) = node.child(i) {
                    if spec.kind() != "type_spec" {
                        continue;
                    }
                    let name_node = spec.child_by_field_name("name");
                    let type_node = spec.child_by_field_name("type");
                    if let (Some(name_node), Some(type_node)) = (name_node, type_node) {
                        let name = node_text(&name_node, source).to_string();
                        match type_node.kind() {
                            "struct_type" => {
                                symbols.definitions.push(Definition {
                                    name,
                                    kind: "struct".to_string(),
                                    line: start_line(node),
                                    end_line: Some(end_line(node)),
                                    decorators: None,
                                    complexity: None,
                                });
                            }
                            "interface_type" => {
                                symbols.definitions.push(Definition {
                                    name: name.clone(),
                                    kind: "interface".to_string(),
                                    line: start_line(node),
                                    end_line: Some(end_line(node)),
                                    decorators: None,
                                    complexity: None,
                                });
                                // Extract interface methods
                                for j in 0..type_node.child_count() {
                                    if let Some(member) = type_node.child(j) {
                                        if member.kind() == "method_elem" {
                                            if let Some(meth_name) =
                                                member.child_by_field_name("name")
                                            {
                                                symbols.definitions.push(Definition {
                                                    name: format!(
                                                        "{}.{}",
                                                        name,
                                                        node_text(&meth_name, source)
                                                    ),
                                                    kind: "method".to_string(),
                                                    line: start_line(&member),
                                                    end_line: Some(end_line(&member)),
                                                    decorators: None,
                                    complexity: None,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {
                                symbols.definitions.push(Definition {
                                    name,
                                    kind: "type".to_string(),
                                    line: start_line(node),
                                    end_line: Some(end_line(node)),
                                    decorators: None,
                                    complexity: None,
                                });
                            }
                        }
                    }
                }
            }
        }

        "import_declaration" => {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    match child.kind() {
                        "import_spec" => {
                            extract_go_import_spec(&child, source, symbols);
                        }
                        "import_spec_list" => {
                            for j in 0..child.child_count() {
                                if let Some(spec) = child.child(j) {
                                    if spec.kind() == "import_spec" {
                                        extract_go_import_spec(&spec, source, symbols);
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
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
                    "selector_expression" => {
                        if let Some(field) = fn_node.child_by_field_name("field") {
                            let receiver = fn_node.child_by_field_name("operand")
                                .map(|op| node_text(&op, source).to_string());
                            symbols.calls.push(Call {
                                name: node_text(&field, source).to_string(),
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

        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_node(&child, source, symbols);
        }
    }
}

fn extract_go_import_spec(spec: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(path_node) = spec.child_by_field_name("path") {
        let import_path = node_text(&path_node, source).replace('"', "");
        let name_node = spec.child_by_field_name("name");
        let alias = match name_node {
            Some(n) => node_text(&n, source).to_string(),
            None => import_path.split('/').last().unwrap_or("").to_string(),
        };
        let mut imp = Import::new(import_path, vec![alias], start_line(spec));
        imp.go_import = Some(true);
        symbols.imports.push(imp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_go(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_go::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        GoExtractor.extract(&tree, code.as_bytes(), "test.go")
    }

    #[test]
    fn finds_function() {
        let s = parse_go("package main\nfunc hello() {}\n");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "hello");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_struct_and_method() {
        let s = parse_go("package main\ntype Server struct{}\nfunc (s *Server) Start() {}\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Server"));
        assert!(names.contains(&"Server.Start"));
    }

    #[test]
    fn finds_interface() {
        let s = parse_go("package main\ntype Reader interface {\n\tRead() error\n}\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Reader"));
        assert!(names.contains(&"Reader.Read"));
    }

    #[test]
    fn finds_imports() {
        let s = parse_go("package main\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n");
        assert_eq!(s.imports.len(), 2);
        assert_eq!(s.imports[0].source, "fmt");
        assert_eq!(s.imports[1].source, "os");
    }
}
