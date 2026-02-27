use tree_sitter::{Node, Tree};
use crate::complexity::compute_function_complexity;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct JsExtractor;

impl SymbolExtractor for JsExtractor {
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
                    complexity: Some(compute_function_complexity(node)),
                });
            }
        }

        "class_declaration" => {
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

                // Heritage: extends + implements
                let heritage = node
                    .child_by_field_name("heritage")
                    .or_else(|| find_child(node, "class_heritage"));
                if let Some(heritage) = heritage {
                    if let Some(super_name) = extract_superclass(&heritage, source) {
                        symbols.classes.push(ClassRelation {
                            name: class_name.clone(),
                            extends: Some(super_name),
                            implements: None,
                            line: start_line(node),
                        });
                    }
                    for iface in extract_implements(&heritage, source) {
                        symbols.classes.push(ClassRelation {
                            name: class_name.clone(),
                            extends: None,
                            implements: Some(iface),
                            line: start_line(node),
                        });
                    }
                }
            }
        }

        "method_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let method_name = node_text(&name_node, source);
                let parent_class = find_parent_class(node, source);
                let full_name = match parent_class {
                    Some(cls) => format!("{}.{}", cls, method_name),
                    None => method_name.to_string(),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: Some(compute_function_complexity(node)),
                });
            }
        }

        "interface_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let iface_name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name: iface_name.clone(),
                    kind: "interface".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
                // Extract interface methods
                let body = node
                    .child_by_field_name("body")
                    .or_else(|| find_child(node, "interface_body"))
                    .or_else(|| find_child(node, "object_type"));
                if let Some(body) = body {
                    extract_interface_methods(&body, &iface_name, source, &mut symbols.definitions);
                }
            }
        }

        "type_alias_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "type".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                });
            }
        }

        "lexical_declaration" | "variable_declaration" => {
            for i in 0..node.child_count() {
                if let Some(declarator) = node.child(i) {
                    if declarator.kind() == "variable_declarator" {
                        let name_n = declarator.child_by_field_name("name");
                        let value_n = declarator.child_by_field_name("value");
                        if let (Some(name_n), Some(value_n)) = (name_n, value_n) {
                            let vt = value_n.kind();
                            if vt == "arrow_function"
                                || vt == "function_expression"
                                || vt == "function"
                            {
                                symbols.definitions.push(Definition {
                                    name: node_text(&name_n, source).to_string(),
                                    kind: "function".to_string(),
                                    line: start_line(node),
                                    end_line: Some(end_line(&value_n)),
                                    decorators: None,
                                    complexity: Some(compute_function_complexity(&value_n)),
                                });
                            }
                        }
                    }
                }
            }
        }

        "call_expression" => {
            if let Some(fn_node) = node.child_by_field_name("function") {
                if let Some(call_info) = extract_call_info(&fn_node, node, source) {
                    symbols.calls.push(call_info);
                }
            }
            if let Some(cb_def) = extract_callback_definition(node, source) {
                symbols.definitions.push(cb_def);
            }
        }

        "import_statement" => {
            let text = node_text(node, source);
            let is_type_only = text.starts_with("import type");
            let source_node = node
                .child_by_field_name("source")
                .or_else(|| find_child(node, "string"));
            if let Some(source_node) = source_node {
                let mod_path = node_text(&source_node, source)
                    .replace(&['\'', '"'][..], "");
                let names = extract_import_names(node, source);
                let mut imp = Import::new(mod_path, names, start_line(node));
                if is_type_only {
                    imp.type_only = Some(true);
                }
                symbols.imports.push(imp);
            }
        }

        "export_statement" => {
            let decl = node.child_by_field_name("declaration");
            if let Some(decl) = &decl {
                match decl.kind() {
                    "function_declaration" => {
                        if let Some(n) = decl.child_by_field_name("name") {
                            symbols.exports.push(ExportInfo {
                                name: node_text(&n, source).to_string(),
                                kind: "function".to_string(),
                                line: start_line(node),
                            });
                        }
                    }
                    "class_declaration" => {
                        if let Some(n) = decl.child_by_field_name("name") {
                            symbols.exports.push(ExportInfo {
                                name: node_text(&n, source).to_string(),
                                kind: "class".to_string(),
                                line: start_line(node),
                            });
                        }
                    }
                    "interface_declaration" => {
                        if let Some(n) = decl.child_by_field_name("name") {
                            symbols.exports.push(ExportInfo {
                                name: node_text(&n, source).to_string(),
                                kind: "interface".to_string(),
                                line: start_line(node),
                            });
                        }
                    }
                    "type_alias_declaration" => {
                        if let Some(n) = decl.child_by_field_name("name") {
                            symbols.exports.push(ExportInfo {
                                name: node_text(&n, source).to_string(),
                                kind: "type".to_string(),
                                line: start_line(node),
                            });
                        }
                    }
                    _ => {}
                }
            }
            let source_node = node
                .child_by_field_name("source")
                .or_else(|| find_child(node, "string"));
            if source_node.is_some() && decl.is_none() {
                let source_node = source_node.unwrap();
                let mod_path = node_text(&source_node, source)
                    .replace(&['\'', '"'][..], "");
                let reexport_names = extract_import_names(node, source);
                let text = node_text(node, source);
                let is_wildcard =
                    text.contains("export *") || text.contains("export*");
                let mut imp = Import::new(mod_path, reexport_names.clone(), start_line(node));
                imp.reexport = Some(true);
                if is_wildcard && reexport_names.is_empty() {
                    imp.wildcard_reexport = Some(true);
                }
                symbols.imports.push(imp);
            }
        }

        "expression_statement" => {
            if let Some(expr) = node.child(0) {
                if expr.kind() == "assignment_expression" {
                    let left = expr.child_by_field_name("left");
                    let right = expr.child_by_field_name("right");
                    if let (Some(left), Some(right)) = (left, right) {
                        let left_text = node_text(&left, source);
                        if left_text.starts_with("module.exports") || left_text == "exports" {
                            if right.kind() == "call_expression" {
                                let fn_node = right.child_by_field_name("function");
                                let args = right
                                    .child_by_field_name("arguments")
                                    .or_else(|| find_child(&right, "arguments"));
                                if let (Some(fn_node), Some(args)) = (fn_node, args) {
                                    if node_text(&fn_node, source) == "require" {
                                        if let Some(str_arg) = find_child(&args, "string") {
                                            let mod_path = node_text(&str_arg, source)
                                                .replace(&['\'', '"'][..], "");
                                            let mut imp =
                                                Import::new(mod_path, vec![], start_line(node));
                                            imp.reexport = Some(true);
                                            imp.wildcard_reexport = Some(true);
                                            symbols.imports.push(imp);
                                        }
                                    }
                                }
                            }
                            if right.kind() == "object" {
                                for ci in 0..right.child_count() {
                                    if let Some(child) = right.child(ci) {
                                        if child.kind() == "spread_element" {
                                            let spread_expr = child
                                                .child(1)
                                                .or_else(|| child.child_by_field_name("value"));
                                            if let Some(spread_expr) = spread_expr {
                                                if spread_expr.kind() == "call_expression" {
                                                    let fn2 = spread_expr
                                                        .child_by_field_name("function");
                                                    let args2 = spread_expr
                                                        .child_by_field_name("arguments")
                                                        .or_else(|| {
                                                            find_child(
                                                                &spread_expr,
                                                                "arguments",
                                                            )
                                                        });
                                                    if let (Some(fn2), Some(args2)) =
                                                        (fn2, args2)
                                                    {
                                                        if node_text(&fn2, source) == "require" {
                                                            if let Some(str_arg2) =
                                                                find_child(&args2, "string")
                                                            {
                                                                let mod_path2 =
                                                                    node_text(&str_arg2, source)
                                                                        .replace(
                                                                            &['\'', '"'][..],
                                                                            "",
                                                                        );
                                                                let mut imp = Import::new(
                                                                    mod_path2,
                                                                    vec![],
                                                                    start_line(node),
                                                                );
                                                                imp.reexport = Some(true);
                                                                imp.wildcard_reexport = Some(true);
                                                                symbols.imports.push(imp);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
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

fn extract_interface_methods(
    body: &Node,
    iface_name: &str,
    source: &[u8],
    definitions: &mut Vec<Definition>,
) {
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if child.kind() == "method_signature" || child.kind() == "property_signature" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    definitions.push(Definition {
                        name: format!("{}.{}", iface_name, node_text(&name_node, source)),
                        kind: "method".to_string(),
                        line: start_line(&child),
                        end_line: Some(end_line(&child)),
                        decorators: None,
                        complexity: None,
                    });
                }
            }
        }
    }
}

fn extract_implements(heritage: &Node, source: &[u8]) -> Vec<String> {
    let mut interfaces = Vec::new();
    for i in 0..heritage.child_count() {
        if let Some(child) = heritage.child(i) {
            if node_text(&child, source) == "implements" {
                for j in (i + 1)..heritage.child_count() {
                    if let Some(next) = heritage.child(j) {
                        if next.kind() == "identifier" || next.kind() == "type_identifier" {
                            interfaces.push(node_text(&next, source).to_string());
                        }
                        if next.child_count() > 0 {
                            extract_implements_from_node(&next, source, &mut interfaces);
                        }
                    }
                }
                break;
            }
            if child.kind() == "implements_clause" {
                extract_implements_from_node(&child, source, &mut interfaces);
            }
        }
    }
    interfaces
}

fn extract_implements_from_node(node: &Node, source: &[u8], result: &mut Vec<String>) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" || child.kind() == "type_identifier" {
                result.push(node_text(&child, source).to_string());
            }
            if child.child_count() > 0 {
                extract_implements_from_node(&child, source, result);
            }
        }
    }
}

fn extract_call_info(fn_node: &Node, call_node: &Node, source: &[u8]) -> Option<Call> {
    match fn_node.kind() {
        "identifier" => Some(Call {
            name: node_text(fn_node, source).to_string(),
            line: start_line(call_node),
            dynamic: None,
            receiver: None,
        }),
        "member_expression" => {
            let obj = fn_node.child_by_field_name("object");
            let prop = fn_node.child_by_field_name("property");
            let prop = prop?;
            let prop_text = node_text(&prop, source);

            if prop_text == "call" || prop_text == "apply" || prop_text == "bind" {
                if let Some(obj) = &obj {
                    if obj.kind() == "identifier" {
                        return Some(Call {
                            name: node_text(obj, source).to_string(),
                            line: start_line(call_node),
                            dynamic: Some(true),
                            receiver: None,
                        });
                    }
                    if obj.kind() == "member_expression" {
                        if let Some(inner_prop) = obj.child_by_field_name("property") {
                            return Some(Call {
                                name: node_text(&inner_prop, source).to_string(),
                                line: start_line(call_node),
                                dynamic: Some(true),
                                receiver: None,
                            });
                        }
                    }
                }
            }

            if prop.kind() == "string" || prop.kind() == "string_fragment" {
                let method_name = node_text(&prop, source).replace(&['\'', '"'][..], "");
                if !method_name.is_empty() {
                    let receiver = fn_node.child_by_field_name("object")
                        .map(|obj| node_text(&obj, source).to_string());
                    return Some(Call {
                        name: method_name,
                        line: start_line(call_node),
                        dynamic: Some(true),
                        receiver,
                    });
                }
            }

            let receiver = fn_node.child_by_field_name("object")
                .map(|obj| node_text(&obj, source).to_string());
            Some(Call {
                name: prop_text.to_string(),
                line: start_line(call_node),
                dynamic: None,
                receiver,
            })
        }
        "subscript_expression" => {
            let index = fn_node.child_by_field_name("index");
            if let Some(index) = index {
                if index.kind() == "string" || index.kind() == "template_string" {
                    let method_name = node_text(&index, source)
                        .replace(&['\'', '"', '`'][..], "");
                    if !method_name.is_empty() && !method_name.contains('$') {
                        let receiver = fn_node.child_by_field_name("object")
                            .map(|obj| node_text(&obj, source).to_string());
                        return Some(Call {
                            name: method_name,
                            line: start_line(call_node),
                            dynamic: Some(true),
                            receiver,
                        });
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn find_anonymous_callback<'a>(args_node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..args_node.child_count() {
        if let Some(child) = args_node.child(i) {
            if child.kind() == "arrow_function" || child.kind() == "function_expression" {
                return Some(child);
            }
        }
    }
    None
}

fn find_first_string_arg<'a>(args_node: &Node<'a>, source: &'a [u8]) -> Option<String> {
    for i in 0..args_node.child_count() {
        if let Some(child) = args_node.child(i) {
            if child.kind() == "string" {
                return Some(node_text(&child, source).replace(&['\'', '"'][..], ""));
            }
        }
    }
    None
}

fn walk_call_chain<'a>(start_node: &Node<'a>, method_name: &str, source: &[u8]) -> Option<Node<'a>> {
    let mut current = Some(*start_node);
    while let Some(node) = current {
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                if fn_node.kind() == "member_expression" {
                    if let Some(prop) = fn_node.child_by_field_name("property") {
                        if node_text(&prop, source) == method_name {
                            return Some(node);
                        }
                    }
                }
            }
        }
        current = match node.kind() {
            "member_expression" => node.child_by_field_name("object"),
            "call_expression" => node.child_by_field_name("function"),
            _ => None,
        };
    }
    None
}

fn is_express_method(method: &str) -> bool {
    matches!(
        method,
        "get" | "post" | "put" | "delete" | "patch" | "options" | "head" | "all" | "use"
    )
}

fn is_event_method(method: &str) -> bool {
    matches!(method, "on" | "once" | "addEventListener" | "addListener")
}

fn extract_callback_definition(call_node: &Node, source: &[u8]) -> Option<Definition> {
    let fn_node = call_node.child_by_field_name("function")?;
    if fn_node.kind() != "member_expression" {
        return None;
    }

    let prop = fn_node.child_by_field_name("property")?;
    let method = node_text(&prop, source);

    let args = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"))?;

    // Commander: .action(callback) with .command('name') in chain
    if method == "action" {
        let cb = find_anonymous_callback(&args)?;
        let obj = fn_node.child_by_field_name("object")?;
        let command_call = walk_call_chain(&obj, "command", source)?;
        let cmd_args = command_call
            .child_by_field_name("arguments")
            .or_else(|| find_child(&command_call, "arguments"))?;
        let cmd_name = find_first_string_arg(&cmd_args, source)?;
        let first_word = cmd_name.split_whitespace().next().unwrap_or(&cmd_name);
        return Some(Definition {
            name: format!("command:{}", first_word),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: Some(compute_function_complexity(&cb)),
        });
    }

    // Express: app.get('/path', callback)
    if is_express_method(method) {
        let str_arg = find_first_string_arg(&args, source)?;
        if !str_arg.starts_with('/') {
            return None;
        }
        let cb = find_anonymous_callback(&args)?;
        return Some(Definition {
            name: format!("route:{} {}", method.to_uppercase(), str_arg),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: Some(compute_function_complexity(&cb)),
        });
    }

    // Events: emitter.on('event', callback)
    if is_event_method(method) {
        let event_name = find_first_string_arg(&args, source)?;
        let cb = find_anonymous_callback(&args)?;
        return Some(Definition {
            name: format!("event:{}", event_name),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: Some(compute_function_complexity(&cb)),
        });
    }

    None
}

fn extract_superclass(heritage: &Node, source: &[u8]) -> Option<String> {
    for i in 0..heritage.child_count() {
        if let Some(child) = heritage.child(i) {
            if child.kind() == "identifier" || child.kind() == "member_expression" {
                return Some(node_text(&child, source).to_string());
            }
            if let Some(found) = extract_superclass(&child, source) {
                return Some(found);
            }
        }
    }
    None
}

fn find_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "class_declaration" || parent.kind() == "class" {
            if let Some(name_node) = parent.child_by_field_name("name") {
                return Some(node_text(&name_node, source).to_string());
            }
            return None;
        }
        current = parent.parent();
    }
    None
}

fn extract_import_names(node: &Node, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    scan_import_names(node, source, &mut names);
    names
}

fn scan_import_names(node: &Node, source: &[u8], names: &mut Vec<String>) {
    match node.kind() {
        "import_specifier" | "export_specifier" => {
            let name_node = node
                .child_by_field_name("name")
                .or_else(|| node.child_by_field_name("alias"));
            if let Some(name_node) = name_node {
                names.push(node_text(&name_node, source).to_string());
            } else {
                names.push(node_text(node, source).to_string());
            }
        }
        "identifier" => {
            if let Some(parent) = node.parent() {
                if parent.kind() == "import_clause" {
                    names.push(node_text(node, source).to_string());
                }
            }
        }
        "namespace_import" => {
            names.push(node_text(node, source).to_string());
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            scan_import_names(&child, source, names);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_js(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        JsExtractor.extract(&tree, code.as_bytes(), "test.js")
    }

    #[test]
    fn finds_function_declaration() {
        let s = parse_js("function greet(name) { return name; }");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "greet");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_arrow_function() {
        let s = parse_js("const add = (a, b) => a + b;");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "add");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_class_with_methods() {
        let s = parse_js("class Foo { bar() {} baz() {} }");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
        assert!(names.contains(&"Foo.baz"));
    }

    #[test]
    fn finds_imports() {
        let s = parse_js("import { readFile } from 'fs';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "fs");
        assert_eq!(s.imports[0].names, vec!["readFile"]);
    }

    #[test]
    fn finds_calls() {
        let s = parse_js("function f() { console.log('hi'); foo(); }");
        let call_names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(call_names.contains(&"log"));
        assert!(call_names.contains(&"foo"));
    }

    #[test]
    fn finds_exports() {
        let s = parse_js("export function hello() {} export class World {}");
        assert_eq!(s.exports.len(), 2);
        assert_eq!(s.exports[0].name, "hello");
        assert_eq!(s.exports[1].name, "World");
    }

    #[test]
    fn finds_class_heritage() {
        let s = parse_js("class Dog extends Animal {}");
        assert_eq!(s.classes.len(), 1);
        assert_eq!(s.classes[0].name, "Dog");
        assert_eq!(s.classes[0].extends, Some("Animal".to_string()));
    }

    #[test]
    fn finds_reexports() {
        let s = parse_js("export { foo, bar } from './utils';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].reexport, Some(true));
        assert_eq!(s.imports[0].source, "./utils");
    }

    #[test]
    fn finds_wildcard_reexport() {
        let s = parse_js("export * from './helpers';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].wildcard_reexport, Some(true));
    }

    #[test]
    fn extracts_commander_action_callback() {
        let s = parse_js("program.command('build [dir]').action(async (dir, opts) => { run(); });");
        let def = s.definitions.iter().find(|d| d.name == "command:build");
        assert!(def.is_some(), "should extract command:build definition");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_commander_query_command() {
        let s = parse_js("program.command('query <name>').action(() => { search(); });");
        let def = s.definitions.iter().find(|d| d.name == "command:query");
        assert!(def.is_some(), "should extract command:query definition");
    }

    #[test]
    fn skips_commander_named_handler() {
        let s = parse_js("program.command('test').action(handleTest);");
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("command:")).collect();
        assert!(defs.is_empty(), "should not extract when handler is a named reference");
    }

    #[test]
    fn extracts_express_get_route() {
        let s = parse_js("app.get('/api/users', (req, res) => { res.json([]); });");
        let def = s.definitions.iter().find(|d| d.name == "route:GET /api/users");
        assert!(def.is_some(), "should extract route:GET /api/users");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_express_post_route() {
        let s = parse_js("router.post('/api/items', async (req, res) => { save(); });");
        let def = s.definitions.iter().find(|d| d.name == "route:POST /api/items");
        assert!(def.is_some(), "should extract route:POST /api/items");
    }

    #[test]
    fn skips_map_get_false_positive() {
        let s = parse_js("myMap.get('someKey');");
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("route:")).collect();
        assert!(defs.is_empty(), "should not extract Map.get as a route");
    }

    #[test]
    fn extracts_event_on_callback() {
        let s = parse_js("emitter.on('data', (chunk) => { process(chunk); });");
        let def = s.definitions.iter().find(|d| d.name == "event:data");
        assert!(def.is_some(), "should extract event:data");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_event_once_callback() {
        let s = parse_js("server.once('listening', () => { log(); });");
        let def = s.definitions.iter().find(|d| d.name == "event:listening");
        assert!(def.is_some(), "should extract event:listening");
    }

    #[test]
    fn skips_event_named_handler() {
        let s = parse_js("emitter.on('data', handleData);");
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("event:")).collect();
        assert!(defs.is_empty(), "should not extract when handler is a named reference");
    }
}
