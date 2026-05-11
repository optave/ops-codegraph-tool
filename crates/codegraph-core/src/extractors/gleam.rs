use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct GleamExtractor;

impl SymbolExtractor for GleamExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_gleam_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &GLEAM_AST_CONFIG);
        symbols
    }
}

fn match_gleam_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function" => handle_function(node, source, symbols),
        "external_function" => handle_external_function(node, source, symbols),
        "type_definition" => handle_type_definition(node, source, symbols),
        "type_alias" => handle_type_alias(node, source, symbols),
        "constant" => handle_constant(node, source, symbols),
        "import" => handle_import(node, source, symbols),
        "function_call" => handle_call(node, source, symbols),
        _ => {}
    }
}

fn handle_function(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))
    {
        Some(n) => n,
        None => return,
    };

    let params = extract_params(node, source);

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "gleam"),
        cfg: build_function_cfg(node, "gleam", source),
        children: opt_children(params),
    });
}

fn handle_external_function(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))
    {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_type_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // type_definition wraps a type_name child (which itself has a `name` field).
    // Mirror the JS extractor: prefer a `name` field on the node, fall back to
    // taking the text of the `type_name` child so we get e.g. `MyType(a, b)`.
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "type_name"))
    {
        Some(n) => n,
        None => return,
    };

    let mut children: Vec<Definition> = Vec::new();
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        match child.kind() {
            "data_constructor" | "type_constructor" => {
                if let Some(ctor_name) = child
                    .child_by_field_name("name")
                    .or_else(|| find_child(&child, "constructor_name"))
                {
                    children.push(child_def(
                        node_text(&ctor_name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
            "data_constructors" | "type_constructors" => {
                for j in 0..child.child_count() {
                    let ctor = match child.child(j) {
                        Some(c) => c,
                        None => continue,
                    };
                    if ctor.kind() == "data_constructor" || ctor.kind() == "type_constructor" {
                        if let Some(ctor_name) = ctor
                            .child_by_field_name("name")
                            .or_else(|| find_child(&ctor, "constructor_name"))
                        {
                            children.push(child_def(
                                node_text(&ctor_name, source).to_string(),
                                "property",
                                start_line(&ctor),
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "type".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
    });
}

fn handle_type_alias(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "type_name"))
    {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "type".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_constant(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))
    {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "variable".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // `module` field holds the module path (e.g. `gleam/io` or `repository`).
    let module_node = match node
        .child_by_field_name("module")
        .or_else(|| find_child(node, "module"))
        .or_else(|| find_child(node, "string"))
    {
        Some(n) => n,
        None => return,
    };

    let raw = node_text(&module_node, source);
    let source_path = raw
        .trim_matches(|c| c == '\'' || c == '"')
        .to_string();
    let mut names: Vec<String> = Vec::new();

    // Unqualified imports: `import gleam/io.{println, print}`
    if let Some(unqualified) = find_child(node, "unqualified_imports") {
        for i in 0..unqualified.child_count() {
            let item = match unqualified.child(i) {
                Some(c) => c,
                None => continue,
            };
            if item.kind() == "unqualified_import" {
                let name_node = item.child_by_field_name("name");
                if let Some(nn) = name_node {
                    names.push(node_text(&nn, source).to_string());
                }
            } else if item.kind() == "identifier" {
                names.push(node_text(&item, source).to_string());
            }
        }
    }

    // Alias: `import gleam/io as my_io`
    if let Some(alias) = node.child_by_field_name("alias") {
        let alias_text = node_text(&alias, source).to_string();
        if alias_text != source_path {
            names.push(alias_text);
        }
    }

    if names.is_empty() {
        // Default to the last path segment, mirroring the JS extractor.
        let default_name = source_path
            .rsplit('/')
            .next()
            .unwrap_or(&source_path)
            .to_string();
        names.push(default_name);
    }

    symbols
        .imports
        .push(Import::new(source_path, names, start_line(node)));
}

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child_by_field_name("function").or_else(|| node.child(0)) {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "identifier" | "variable" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "field_access" | "module_select" => {
            // Qualified call: `module.func(args)` parses as field_access
            // with `record` (module identifier) and `field` (label) fields.
            let field = func_node
                .child_by_field_name("field")
                .or_else(|| func_node.child_by_field_name("label"));
            let record = func_node
                .child_by_field_name("record")
                .or_else(|| func_node.child(0));
            if let Some(f) = field {
                let receiver = record.and_then(|r| {
                    // Don't use the field itself as the receiver.
                    if Some(r.id()) == field.map(|n| n.id()) {
                        None
                    } else {
                        Some(node_text(&r, source).to_string())
                    }
                });
                symbols.calls.push(Call {
                    name: node_text(&f, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                });
            }
        }
        _ => {}
    }
}

fn extract_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = match func_node
        .child_by_field_name("parameters")
        .or_else(|| find_child(func_node, "function_parameters"))
    {
        Some(n) => n,
        None => return params,
    };

    for i in 0..params_node.child_count() {
        let param = match params_node.child(i) {
            Some(c) => c,
            None => continue,
        };
        match param.kind() {
            "function_parameter" | "parameter" => {
                if let Some(name_node) = param
                    .child_by_field_name("name")
                    .or_else(|| find_child(&param, "identifier"))
                {
                    params.push(child_def(
                        node_text(&name_node, source).to_string(),
                        "parameter",
                        start_line(&param),
                    ));
                }
            }
            "identifier" => {
                params.push(child_def(
                    node_text(&param, source).to_string(),
                    "parameter",
                    start_line(&param),
                ));
            }
            _ => {}
        }
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_gleam(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_gleam::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        GleamExtractor.extract(&tree, code.as_bytes(), "test.gleam")
    }

    #[test]
    fn extracts_public_function() {
        let s = parse_gleam("pub fn greet(name) {\n  name\n}\n");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
        let children = greet.children.as_ref().expect("expected children");
        assert!(children.iter().any(|c| c.name == "name" && c.kind == "parameter"));
    }

    #[test]
    fn extracts_private_function() {
        let s = parse_gleam("fn helper() {\n  1\n}\n");
        assert!(s.definitions.iter().any(|d| d.name == "helper"));
    }

    #[test]
    fn extracts_qualified_call_as_receiver_name() {
        let code = "import repository\n\npub fn main() {\n  repository.new_repo()\n}\n";
        let s = parse_gleam(code);
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "new_repo")
            .expect("expected qualified call to new_repo");
        assert_eq!(call.receiver.as_deref(), Some("repository"));
    }

    #[test]
    fn extracts_same_file_call() {
        let code = "pub fn outer() {\n  inner()\n}\n\nfn inner() {\n  1\n}\n";
        let s = parse_gleam(code);
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "inner")
            .expect("expected unqualified call to inner");
        assert!(call.receiver.is_none());
    }

    #[test]
    fn extracts_import_module() {
        let s = parse_gleam("import gleam/io\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "gleam/io");
        assert_eq!(s.imports[0].names, vec!["io".to_string()]);
    }

    #[test]
    fn extracts_unqualified_imports() {
        let s = parse_gleam("import gleam/io.{println, print}\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "gleam/io");
        assert!(s.imports[0].names.contains(&"println".to_string()));
        assert!(s.imports[0].names.contains(&"print".to_string()));
    }

    #[test]
    fn extracts_type_definition_with_constructors() {
        let code = "pub type Color {\n  Red\n  Green\n  Blue\n}\n";
        let s = parse_gleam(code);
        let color = s
            .definitions
            .iter()
            .find(|d| d.kind == "type")
            .expect("expected type definition");
        let children = color.children.as_ref().expect("expected constructors");
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Red"));
        assert!(names.contains(&"Green"));
        assert!(names.contains(&"Blue"));
    }

    #[test]
    fn extracts_type_alias() {
        let s = parse_gleam("pub type UserId = Int\n");
        assert!(s.definitions.iter().any(|d| d.kind == "type"));
    }

    #[test]
    fn extracts_constant() {
        let s = parse_gleam("pub const max_users = 100\n");
        let c = s
            .definitions
            .iter()
            .find(|d| d.name == "max_users")
            .expect("expected constant");
        assert_eq!(c.kind, "variable");
    }
}
