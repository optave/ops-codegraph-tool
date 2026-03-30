use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct GoExtractor;

impl SymbolExtractor for GoExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_go_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &GO_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_go_type_map);
        symbols
    }
}

fn match_go_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" => handle_function_decl(node, source, symbols),
        "method_declaration" => handle_method_decl(node, source, symbols),
        "type_declaration" => handle_type_decl(node, source, symbols),
        "const_declaration" => handle_const_decl(node, source, symbols),
        "import_declaration" => handle_import_decl(node, source, symbols),
        "call_expression" => handle_call_expr(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_go_parameters(node, source);
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "go"),
            cfg: build_function_cfg(node, "go", source),
            children: opt_children(children),
        });
    }
}

fn handle_method_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let receiver_type = extract_go_receiver_type(node, source);
    let name = node_text(&name_node, source);
    let full_name = match &receiver_type {
        Some(rt) => format!("{}.{}", rt, name),
        None => name.to_string(),
    };
    let children = extract_go_parameters(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "method".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "go"),
        cfg: build_function_cfg(node, "go", source),
        children: opt_children(children),
    });
}

fn extract_go_receiver_type(node: &Node, source: &[u8]) -> Option<String> {
    let receiver = node.child_by_field_name("receiver")?;
    for i in 0..receiver.child_count() {
        if let Some(param) = receiver.child(i) {
            if let Some(type_node) = param.child_by_field_name("type") {
                return Some(if type_node.kind() == "pointer_type" {
                    node_text(&type_node, source).trim_start_matches('*').to_string()
                } else {
                    node_text(&type_node, source).to_string()
                });
            }
        }
    }
    None
}

fn handle_type_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        let Some(spec) = node.child(i) else { continue };
        if spec.kind() != "type_spec" { continue; }
        let name_node = spec.child_by_field_name("name");
        let type_node = spec.child_by_field_name("type");
        let (Some(name_node), Some(type_node)) = (name_node, type_node) else { continue };
        let name = node_text(&name_node, source).to_string();
        match type_node.kind() {
            "struct_type" => {
                let children = extract_go_struct_fields(&type_node, source);
                symbols.definitions.push(Definition {
                    name,
                    kind: "struct".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: opt_children(children),
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
                    cfg: None,
                    children: None,
                });
                extract_go_interface_methods(&type_node, &name, source, symbols);
            }
            _ => {
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
    }
}

fn extract_go_interface_methods(type_node: &Node, iface_name: &str, source: &[u8], symbols: &mut FileSymbols) {
    for j in 0..type_node.child_count() {
        let Some(member) = type_node.child(j) else { continue };
        if member.kind() != "method_elem" { continue; }
        if let Some(meth_name) = member.child_by_field_name("name") {
            symbols.definitions.push(Definition {
                name: format!("{}.{}", iface_name, node_text(&meth_name, source)),
                kind: "method".to_string(),
                line: start_line(&member),
                end_line: Some(end_line(&member)),
                decorators: None,
                complexity: None,
                cfg: None,
                children: None,
            });
        }
    }
}

fn handle_const_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        let Some(spec) = node.child(i) else { continue };
        if spec.kind() != "const_spec" { continue; }
        if let Some(name_node) = spec.child_by_field_name("name") {
            symbols.definitions.push(Definition {
                name: node_text(&name_node, source).to_string(),
                kind: "constant".to_string(),
                line: start_line(&spec),
                end_line: Some(end_line(&spec)),
                decorators: None,
                complexity: None,
                cfg: None,
                children: None,
            });
        }
    }
}

fn handle_import_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
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

fn handle_call_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else { return };
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

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_go_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "parameter_list"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                if child.kind() == "parameter_declaration" {
                    // Go parameter_declaration can have multiple names before the type
                    for j in 0..child.child_count() {
                        if let Some(inner) = child.child(j) {
                            if inner.kind() == "identifier" {
                                params.push(child_def(
                                    node_text(&inner, source).to_string(),
                                    "parameter",
                                    start_line(&inner),
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_go_struct_fields(struct_type: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let field_list = find_child(struct_type, "field_declaration_list");
    let field_list = field_list.as_ref().unwrap_or(struct_type);
    for i in 0..field_list.child_count() {
        if let Some(child) = field_list.child(i) {
            if child.kind() == "field_declaration" {
                // Field names come before the type
                for j in 0..child.child_count() {
                    if let Some(inner) = child.child(j) {
                        if inner.kind() == "field_identifier" {
                            fields.push(child_def(
                                node_text(&inner, source).to_string(),
                                "property",
                                start_line(&child),
                            ));
                        }
                    }
                }
            }
        }
    }
    fields
}

// ── Existing helpers ────────────────────────────────────────────────────────

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

// ── Type map extraction ─────────────────────────────────────────────────────

fn extract_go_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "type_identifier" | "identifier" | "qualified_type" => Some(node_text(type_node, source)),
        "pointer_type" => {
            // *MyType → MyType
            for i in 0..type_node.child_count() {
                if let Some(child) = type_node.child(i) {
                    if child.kind() == "type_identifier" || child.kind() == "identifier" {
                        return Some(node_text(&child, source));
                    }
                }
            }
            None
        }
        "generic_type" => type_node.child(0).map(|n| node_text(&n, source)),
        _ => None,
    }
}

fn match_go_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "var_spec" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_go_type_name(&type_node, source) {
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            if child.kind() == "identifier" {
                                symbols.type_map.push(TypeMapEntry {
                                    name: node_text(&child, source).to_string(),
                                    type_name: type_name.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
        "parameter_declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(type_name) = extract_go_type_name(&type_node, source) {
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            if child.kind() == "identifier" {
                                symbols.type_map.push(TypeMapEntry {
                                    name: node_text(&child, source).to_string(),
                                    type_name: type_name.to_string(),
                                });
                            }
                        }
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

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_go("package main\nfunc add(a int, b int) int { return a + b }");
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        let children = add.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "a");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "b");
    }

    #[test]
    fn extracts_struct_fields() {
        let s = parse_go("package main\ntype User struct {\n  Name string\n  Age int\n}");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"Name"));
        assert!(names.contains(&"Age"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_const_declarations() {
        let s = parse_go("package main\nconst MaxRetries = 3");
        let c = s.definitions.iter().find(|d| d.name == "MaxRetries").unwrap();
        assert_eq!(c.kind, "constant");
    }
}
