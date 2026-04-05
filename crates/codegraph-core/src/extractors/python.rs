use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct PythonExtractor;

impl SymbolExtractor for PythonExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_python_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &PYTHON_AST_CONFIG);
        walk_tree(&tree.root_node(), source, &mut symbols, match_python_type_map);
        symbols
    }
}

fn match_python_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => handle_function_def(node, source, symbols),
        "class_definition" => handle_class_def(node, source, symbols),
        "expression_statement" => handle_expr_stmt(node, source, symbols),
        "call" => handle_call(node, source, symbols),
        "import_statement" => handle_import_stmt(node, source, symbols),
        "import_from_statement" => handle_import_from_stmt(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
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
    let children = extract_python_parameters(node, source, parent_class.is_some());
    symbols.definitions.push(Definition {
        name: full_name,
        kind,
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: if decorators.is_empty() { None } else { Some(decorators) },
        complexity: compute_all_metrics(node, source, "python"),
        cfg: build_function_cfg(node, "python", source),
        children: opt_children(children),
    });
}

fn handle_class_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
    let class_name = node_text(&name_node, source).to_string();
    let children = extract_python_class_properties(node, source);
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

fn handle_expr_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if !is_module_level(node) { return; }
    let Some(expr) = node.child(0) else { return };
    if expr.kind() != "assignment" { return; }
    let Some(left) = expr.child_by_field_name("left") else { return };
    if left.kind() != "identifier" { return; }
    let name = node_text(&left, source);
    if !is_upper_snake_case(name) { return; }
    symbols.definitions.push(Definition {
        name: name.to_string(),
        kind: "constant".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else { return };
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

fn handle_import_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut names = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() != "dotted_name" && child.kind() != "aliased_import" { continue; }
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
    if !names.is_empty() {
        let mut imp = Import::new(names[0].clone(), names, start_line(node));
        imp.python_import = Some(true);
        symbols.imports.push(imp);
    }
}

fn handle_import_from_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut source_str = String::new();
    let mut names = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
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
    if !source_str.is_empty() {
        let mut imp = Import::new(source_str, names, start_line(node));
        imp.python_import = Some(true);
        symbols.imports.push(imp);
    }
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_python_parameters(node: &Node, source: &[u8], is_method: bool) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters");
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                let name = match child.kind() {
                    "identifier" => {
                        let text = node_text(&child, source);
                        Some(text.to_string())
                    }
                    "default_parameter" | "typed_default_parameter" => {
                        child.child_by_field_name("name")
                            .map(|n| node_text(&n, source).to_string())
                    }
                    "typed_parameter" => {
                        // typed_parameter: first child is the identifier
                        child.child(0)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| node_text(&c, source).to_string())
                    }
                    "list_splat_pattern" | "dictionary_splat_pattern" => {
                        // *args, **kwargs
                        child.child(0)
                            .filter(|c| c.kind() == "identifier")
                            .map(|c| node_text(&c, source).to_string())
                    }
                    _ => None,
                };
                if let Some(name) = name {
                    // Skip self/cls for methods
                    if is_method && (name == "self" || name == "cls") {
                        continue;
                    }
                    params.push(child_def(name, "parameter", start_line(&child)));
                }
            }
        }
    }
    params
}

fn extract_python_class_properties(class_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = class_node.child_by_field_name("body");
    if let Some(body) = body {
        // Look for __init__ method and scan for self.x = ... assignments
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "function_definition" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if node_text(&name_node, source) == "__init__" {
                            collect_self_assignments(&child, source, &mut props);
                        }
                    }
                }
            }
        }
    }
    props
}

fn collect_self_assignments(node: &Node, source: &[u8], props: &mut Vec<Definition>) {
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() == "expression_statement" {
            try_extract_self_assignment(&child, source, props);
        }
        // Recurse into blocks (if/for/etc inside __init__)
        if child.kind() == "block" || child.kind() == "if_statement"
            || child.kind() == "for_statement" || child.kind() == "while_statement"
        {
            collect_self_assignments(&child, source, props);
        }
    }
}

fn try_extract_self_assignment(stmt: &Node, source: &[u8], props: &mut Vec<Definition>) {
    let Some(expr) = stmt.child(0) else { return };
    if expr.kind() != "assignment" { return; }
    let Some(left) = expr.child_by_field_name("left") else { return };
    if left.kind() != "attribute" { return; }
    let Some(obj) = left.child_by_field_name("object") else { return };
    if node_text(&obj, source) != "self" { return; }
    let Some(attr) = left.child_by_field_name("attribute") else { return };
    let name = node_text(&attr, source);
    if !props.iter().any(|p| p.name == name) {
        props.push(child_def(name.to_string(), "property", start_line(stmt)));
    }
}

fn is_module_level(node: &Node) -> bool {
    if let Some(parent) = node.parent() {
        return parent.kind() == "module";
    }
    false
}

fn is_upper_snake_case(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())
        && s.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
}

// ── Existing helpers ────────────────────────────────────────────────────────

const PYTHON_CLASS_KINDS: &[&str] = &["class_definition"];

fn find_python_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, PYTHON_CLASS_KINDS, source)
}

fn extract_python_type_name<'a>(type_node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    match type_node.kind() {
        "identifier" | "attribute" => Some(node_text(type_node, source)),
        "subscript" => {
            // List[int] → List
            type_node
                .child_by_field_name("value")
                .map(|n| node_text(&n, source))
        }
        _ => None,
    }
}

fn match_python_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "typed_parameter" => {
            // first child is identifier, type field is the type
            if let Some(name_node) = node.child(0) {
                if name_node.kind() == "identifier" {
                    let name = node_text(&name_node, source);
                    if name != "self" && name != "cls" {
                        if let Some(type_node) = node.child_by_field_name("type") {
                            if let Some(type_name) =
                                extract_python_type_name(&type_node, source)
                            {
                                symbols.type_map.push(TypeMapEntry {
                                    name: name.to_string(),
                                    type_name: type_name.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
        "typed_default_parameter" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                if name_node.kind() == "identifier" {
                    if let Some(type_node) = node.child_by_field_name("type") {
                        if let Some(type_name) =
                            extract_python_type_name(&type_node, source)
                        {
                            symbols.type_map.push(TypeMapEntry {
                                name: node_text(&name_node, source).to_string(),
                                type_name: type_name.to_string(),
                            });
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

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_py("def greet(name, age=30):\n  pass");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        let children = greet.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_method_parameters_skips_self() {
        let s = parse_py("class Foo:\n    def bar(self, x, y):\n        pass\n");
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        let children = bar.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "x");
        assert_eq!(children[1].name, "y");
    }

    #[test]
    fn extracts_class_properties_from_init() {
        let s = parse_py("class User:\n  def __init__(self, x, y):\n    self.x = x\n    self.y = y\n");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"x"));
        assert!(names.contains(&"y"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_module_level_constant() {
        let s = parse_py("MAX_RETRIES = 3");
        let c = s.definitions.iter().find(|d| d.name == "MAX_RETRIES").unwrap();
        assert_eq!(c.kind, "constant");
    }
}
