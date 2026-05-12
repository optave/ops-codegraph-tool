use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

/// Groovy extractor — mirrors `extractGroovySymbols` in `src/extractors/groovy.ts`.
///
/// Groovy is a JVM language with Java-like class/interface/enum structures plus
/// closures (`function_definition`) and dynamic typing. The tree-sitter-groovy
/// grammar shares many node kinds with tree-sitter-java (`class_declaration`,
/// `method_declaration`, `method_invocation`, `object_creation_expression`,
/// `import_declaration`).
///
/// The JS source-of-truth extractor handles a superset of node kinds for
/// resilience across grammar variants (`class_definition`, `interface_definition`,
/// `method_definition`, `function_declaration`, `import_statement`, `call_expression`,
/// `method_call`, `function_call`, `member_access`); the Rust port mirrors those
/// arms so engine parity holds even if a future grammar version renames nodes.
///
/// Note: `juxt_function_call` (Groovy command-style calls like `foo bar(x)`)
/// is not dispatched here — the JS extractor also omits it. Tracked in #1108
/// for adding support to both engines.
pub struct GroovyExtractor;

impl SymbolExtractor for GroovyExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_groovy_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &GROOVY_AST_CONFIG);
        symbols
    }
}

const GROOVY_TYPE_KINDS: &[&str] = &[
    "class_declaration",
    "class_definition",
    "enum_declaration",
    "enum_definition",
    "interface_declaration",
    "interface_definition",
];

fn find_groovy_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, GROOVY_TYPE_KINDS, source)
}

fn match_groovy_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "class_declaration" | "class_definition" => handle_class_decl(node, source, symbols),
        "interface_declaration" | "interface_definition" => handle_interface_decl(node, source, symbols),
        "enum_declaration" | "enum_definition" => handle_enum_decl(node, source, symbols),
        "method_declaration" | "method_definition" => handle_method_decl(node, source, symbols),
        "constructor_declaration" | "constructor_definition" => handle_constructor_decl(node, source, symbols),
        "function_definition" | "function_declaration" => handle_function_decl(node, source, symbols),
        "import_declaration" | "import_statement" => handle_import_decl(node, source, symbols),
        "method_invocation" | "method_call" | "call_expression" | "function_call" => {
            handle_call_expr(node, source, symbols)
        }
        "object_creation_expression" => handle_object_creation(node, source, symbols),
        _ => {}
    }
}

// ── Class / interface / enum ────────────────────────────────────────────────

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let class_name = node_text(&name_node, source).to_string();
    let children = extract_class_fields(node, source);
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

    // Superclass: `superclass` field wraps a `_type` child (type_identifier /
    // generic_type / scoped_type_identifier). Walk children to find the first
    // type-like node.
    if let Some(superclass) = node.child_by_field_name("superclass") {
        for i in 0..superclass.child_count() {
            let Some(child) = superclass.child(i) else { continue };
            match child.kind() {
                "type_identifier" | "identifier" | "scoped_type_identifier" => {
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

    // Interfaces: `interfaces` field wraps a `super_interfaces` → `type_list`.
    if let Some(interfaces) = node.child_by_field_name("interfaces") {
        collect_interfaces(&interfaces, &class_name, source, symbols);
    }
}

fn collect_interfaces(
    interfaces: &Node,
    class_name: &str,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..interfaces.child_count() {
        let Some(child) = interfaces.child(i) else { continue };
        match child.kind() {
            "type_identifier" | "identifier" | "scoped_type_identifier" => {
                symbols.classes.push(ClassRelation {
                    name: class_name.to_string(),
                    extends: None,
                    implements: Some(node_text(&child, source).to_string()),
                    line: start_line(interfaces),
                });
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
            "type_list" => collect_interfaces(&child, class_name, source, symbols),
            _ => {}
        }
    }
}

fn handle_interface_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "interface".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_enum_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let enum_name = node_text(&name_node, source).to_string();

    let mut members: Vec<Definition> = Vec::new();
    let body = node.child_by_field_name("body").or_else(|| find_child(node, "enum_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            let Some(child) = body.child(i) else { continue };
            if child.kind() == "enum_constant" || child.kind() == "identifier" {
                let name = child.child_by_field_name("name").unwrap_or(child);
                members.push(child_def(
                    node_text(&name, source).to_string(),
                    "constant",
                    start_line(&child),
                ));
            }
        }
    }

    symbols.definitions.push(Definition {
        name: enum_name,
        kind: "enum".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(members),
    });
}

// ── Methods / constructors / functions ─────────────────────────────────────

fn handle_method_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let parent_class = find_groovy_parent_class(node, source);
    let name = node_text(&name_node, source);
    let full_name = match &parent_class {
        Some(cls) => format!("{}.{}", cls, name),
        None => name.to_string(),
    };
    let params = extract_params(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "method".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "groovy"),
        cfg: build_function_cfg(node, "groovy", source),
        children: opt_children(params),
    });
}

fn handle_constructor_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let parent_class = find_groovy_parent_class(node, source);
    let name = node_text(&name_node, source);
    let full_name = match &parent_class {
        Some(cls) => format!("{}.{}", cls, name),
        None => name.to_string(),
    };
    let params = extract_params(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "method".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "groovy"),
        cfg: build_function_cfg(node, "groovy", source),
        children: opt_children(params),
    });
}

/// Top-level `function_definition` (Groovy script closure-bodied function).
fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let params = extract_params(node, source);
    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "groovy"),
        cfg: build_function_cfg(node, "groovy", source),
        children: opt_children(params),
    });
}

// ── Imports ─────────────────────────────────────────────────────────────────

fn handle_import_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut import_path = String::new();
    let mut has_asterisk = false;
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        match child.kind() {
            "scoped_identifier" | "identifier" | "qualified_name" | "dotted_identifier" => {
                import_path = node_text(&child, source).to_string();
            }
            "asterisk" => has_asterisk = true,
            _ => {}
        }
    }
    if import_path.is_empty() {
        return;
    }
    let names = if has_asterisk {
        vec!["*".to_string()]
    } else {
        let last = import_path.split('.').last().unwrap_or("").to_string();
        vec![last]
    };
    let mut imp = Import::new(import_path, names, start_line(node));
    // Groovy shares Java's import semantics — flag it so the resolver applies
    // Java-style FQN matching (mirrors `javaImport: true` in the JS extractor).
    imp.java_import = Some(true);
    symbols.imports.push(imp);
}

// ── Calls ───────────────────────────────────────────────────────────────────

fn handle_call_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // method_invocation has `name` (identifier) and optional `object` (receiver).
    if let Some(name_node) = node.child_by_field_name("name") {
        let receiver = node
            .child_by_field_name("object")
            .map(|n| node_text(&n, source).to_string());
        symbols.calls.push(Call {
            name: node_text(&name_node, source).to_string(),
            line: start_line(node),
            dynamic: None,
            receiver,
        });
        return;
    }

    // Fallback: `function` field (some grammar variants use this shape).
    let func_node = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("method"));
    if let Some(func_node) = func_node {
        match func_node.kind() {
            "field_expression" | "member_access" | "field_access" => {
                let field = func_node
                    .child_by_field_name("field")
                    .or_else(|| func_node.child_by_field_name("property"));
                let obj = func_node
                    .child_by_field_name("object")
                    .or_else(|| func_node.child_by_field_name("argument"));
                if let Some(field) = field {
                    symbols.calls.push(Call {
                        name: node_text(&field, source).to_string(),
                        line: start_line(node),
                        dynamic: None,
                        receiver: obj.map(|n| node_text(&n, source).to_string()),
                    });
                }
            }
            _ => {
                symbols.calls.push(Call {
                    name: node_text(&func_node, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
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

// ── Sub-declaration helpers ─────────────────────────────────────────────────

fn extract_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = func_node
        .child_by_field_name("parameters")
        .or_else(|| find_child(func_node, "formal_parameters"));
    let Some(params_node) = params_node else { return params };
    for i in 0..params_node.child_count() {
        let Some(child) = params_node.child(i) else { continue };
        if child.kind() == "formal_parameter"
            || child.kind() == "parameter"
            || child.kind() == "spread_parameter"
        {
            if let Some(name_node) = child.child_by_field_name("name") {
                params.push(child_def(
                    node_text(&name_node, source).to_string(),
                    "parameter",
                    start_line(&child),
                ));
            }
        }
    }
    params
}

fn extract_class_fields(class_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    let body = class_node
        .child_by_field_name("body")
        .or_else(|| find_child(class_node, "class_body"));
    let Some(body) = body else { return fields };
    for i in 0..body.child_count() {
        let Some(child) = body.child(i) else { continue };
        if child.kind() != "field_declaration" {
            continue;
        }
        for j in 0..child.child_count() {
            let Some(var_decl) = child.child(j) else { continue };
            if var_decl.kind() == "variable_declarator" {
                if let Some(name_node) = var_decl.child_by_field_name("name") {
                    fields.push(child_def(
                        node_text(&name_node, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_groovy(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_groovy::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        GroovyExtractor.extract(&tree, code.as_bytes(), "Test.groovy")
    }

    #[test]
    fn extracts_class_and_methods() {
        let s = parse_groovy(
            "class Foo {\n  void bar(String x) { x.length() }\n  int baz() { 1 }\n}",
        );
        assert!(s.definitions.iter().any(|d| d.name == "Foo" && d.kind == "class"));
        assert!(s.definitions.iter().any(|d| d.name == "Foo.bar" && d.kind == "method"));
        assert!(s.definitions.iter().any(|d| d.name == "Foo.baz" && d.kind == "method"));
    }

    #[test]
    fn extracts_method_parameters() {
        let s = parse_groovy("class Foo {\n  void bar(int x, String y) {}\n}");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "x");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "y");
    }

    #[test]
    fn extracts_class_fields() {
        let s = parse_groovy("class User {\n  String name\n  int age\n}");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"name"));
        assert!(names.contains(&"age"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_imports() {
        let s = parse_groovy("import foo.bar.Baz\nimport com.example.*");
        assert_eq!(s.imports.len(), 2);
        assert_eq!(s.imports[0].source, "foo.bar.Baz");
        assert_eq!(s.imports[0].names, vec!["Baz".to_string()]);
        assert_eq!(s.imports[0].java_import, Some(true));
        assert_eq!(s.imports[1].source, "com.example");
        assert_eq!(s.imports[1].names, vec!["*".to_string()]);
    }

    #[test]
    fn extracts_method_calls_and_object_creation() {
        let s = parse_groovy(
            "class M {\n  void run() {\n    def svc = new Service()\n    svc.go()\n  }\n}",
        );
        // method call svc.go() — name "go", receiver "svc"
        let go_call = s.calls.iter().find(|c| c.name == "go").expect("go() call");
        assert_eq!(go_call.receiver.as_deref(), Some("svc"));
        // object creation: new Service() — emitted as a call to "Service"
        assert!(s.calls.iter().any(|c| c.name == "Service"));
    }

    #[test]
    fn extracts_interface_and_enum() {
        let s = parse_groovy("interface Worker { void work() }\nenum Color { RED, GREEN }");
        assert!(s.definitions.iter().any(|d| d.name == "Worker" && d.kind == "interface"));
        let color = s.definitions.iter().find(|d| d.name == "Color" && d.kind == "enum").unwrap();
        let children = color.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"RED"));
        assert!(names.contains(&"GREEN"));
    }

    #[test]
    fn extracts_superclass_and_interfaces() {
        let s = parse_groovy("class Sub extends Base implements I1, I2 {}");
        let rels: Vec<_> = s.classes.iter().filter(|c| c.name == "Sub").collect();
        assert!(rels.iter().any(|c| c.extends.as_deref() == Some("Base")));
        assert!(rels.iter().any(|c| c.implements.as_deref() == Some("I1")));
        assert!(rels.iter().any(|c| c.implements.as_deref() == Some("I2")));
    }
}
