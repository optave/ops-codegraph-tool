use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct PythonExtractor;

impl SymbolExtractor for PythonExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "function_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name_text = node_text(&name_node, source);
                let mut decorators = Vec::new();
                if let Some(prev) = node.prev_sibling() {
                    if prev.kind() == "decorator" {
                        decorators.push(node_text(&prev, source).to_string());
                    }
                }
                let parent_class = find_python_parent_class(node, source);
                let (full_name, kind) = match &parent_class {
                    Some(cls) => (format!("{}.{}", cls, name_text), "method".to_string()),
                    None => (name_text.to_string(), "function".to_string()),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind,
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: if decorators.is_empty() {
                        None
                    } else {
                        Some(decorators)
                    },
                    complexity: None,
                });
            }
        }

        "class_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: class_name.clone(),
                    kind: "class".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
                let superclasses = node
                    .child_by_field_name("superclasses")
                    .or_else(|| find_child(node, "argument_list"));
                if let Some(superclasses) = superclasses {
                    for i in 0..superclasses.child_count() {
                        if let Some(child) = superclasses.child(i) {
                            if child.kind() == "identifier" {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.clone(),
                                    extends: Some(node_text(&child, source).to_string()),
                                    implements: None,
                                    line: start_line(node),
                                });
                            }
                        }
                    }
                }
            }
        }

        "decorated_definition" => {
            // Walk children directly to handle decorated functions/classes
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk_node(&child, source, symbols);
                }
            }
            return;
        }

        "call" => {
            if let Some(fn_node) = node.child_by_field_name("function") {
                let (call_name, receiver) = match fn_node.kind() {
                    "identifier" => (Some(node_text(&fn_node, source).to_string()), None),
                    "attribute" => {
                        let name = fn_node
                            .child_by_field_name("attribute")
                            .map(|a| node_text(&a, source).to_string());
                        let recv = fn_node.child_by_field_name("object")
                            .map(|obj| node_text(&obj, source).to_string());
                        (name, recv)
                    }
                    _ => (None, None),
                };
                if let Some(name) = call_name {
                    symbols.calls.push(Call {
                        name,
                        line: start_line(node),
                        dynamic: None,
                        receiver,
                    });
                }
            }
        }

        "import_statement" => {
            let mut names = Vec::new();
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    if child.kind() == "dotted_name" || child.kind() == "aliased_import" {
                        let name = if child.kind() == "aliased_import" {
                            child
                                .child_by_field_name("alias")
                                .or_else(|| child.child_by_field_name("name"))
                                .map(|n| node_text(&n, source).to_string())
                        } else {
                            Some(node_text(&child, source).to_string())
                        };
                        if let Some(name) = name {
                            names.push(name);
                        }
                    }
                }
            }
            if !names.is_empty() {
                let mut imp = Import::new(names[0].clone(), names, start_line(node));
                imp.python_import = Some(true);
                symbols.imports.push(imp);
            }
        }

        "import_from_statement" => {
            let mut source_str = String::new();
            let mut names = Vec::new();
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    match child.kind() {
                        "dotted_name" | "relative_import" => {
                            if source_str.is_empty() {
                                source_str = node_text(&child, source).to_string();
                            } else {
                                names.push(node_text(&child, source).to_string());
                            }
                        }
                        "aliased_import" => {
                            let n = child
                                .child_by_field_name("name")
                                .or_else(|| child.child(0));
                            if let Some(n) = n {
                                names.push(node_text(&n, source).to_string());
                            }
                        }
                        "wildcard_import" => {
                            names.push("*".to_string());
                        }
                        _ => {}
                    }
                }
            }
            if !source_str.is_empty() {
                let mut imp = Import::new(source_str, names, start_line(node));
                imp.python_import = Some(true);
                symbols.imports.push(imp);
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

fn find_python_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "class_definition" {
            return parent
                .child_by_field_name("name")
                .map(|n| node_text(&n, source).to_string());
        }
        current = parent.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_py(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        PythonExtractor.extract(&tree, code.as_bytes(), "test.py")
    }

    #[test]
    fn finds_function() {
        let s = parse_py("def greet(name):\n    return name\n");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "greet");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_class_and_method() {
        let s = parse_py("class Foo:\n    def bar(self):\n        pass\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
    }

    #[test]
    fn finds_imports() {
        let s = parse_py("from os.path import join, exists\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "os.path");
        assert!(s.imports[0].names.contains(&"join".to_string()));
    }

    #[test]
    fn finds_calls() {
        let s = parse_py("print('hello')\nos.path.join('a', 'b')\n");
        let call_names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(call_names.contains(&"print"));
        assert!(call_names.contains(&"join"));
    }

    #[test]
    fn finds_inheritance() {
        let s = parse_py("class Dog(Animal):\n    pass\n");
        assert_eq!(s.classes.len(), 1);
        assert_eq!(s.classes[0].name, "Dog");
        assert_eq!(s.classes[0].extends, Some("Animal".to_string()));
    }
}
