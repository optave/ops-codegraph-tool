use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct JsExtractor;

impl SymbolExtractor for JsExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        walk_ast_nodes(&tree.root_node(), source, &mut symbols.ast_nodes);
        symbols
    }
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    walk_node_depth(node, source, symbols, 0);
}

fn walk_node_depth(node: &Node, source: &[u8], symbols: &mut FileSymbols, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "function_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let children = extract_js_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "javascript"),
                    cfg: build_function_cfg(node, "javascript", source),
                    children: opt_children(children),
                });
            }
        }

        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                let children = extract_js_class_properties(node, source);
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
                let children = extract_js_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "javascript"),
                    cfg: build_function_cfg(node, "javascript", source),
                    children: opt_children(children),
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
                    cfg: None,
                    children: None,
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
                    cfg: None,
                    children: None,
                });
            }
        }

        "enum_declaration" => {
            // TypeScript enum
            if let Some(name_node) = node.child_by_field_name("name") {
                let enum_name = node_text(&name_node, source).to_string();
                let children = extract_ts_enum_members(node, source);
                symbols.definitions.push(Definition {
                    name: enum_name,
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

        "lexical_declaration" | "variable_declaration" => {
            let is_const = node.child(0)
                .map(|c| node_text(&c, source) == "const")
                .unwrap_or(false);
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
                                let children = extract_js_parameters(&value_n, source);
                                symbols.definitions.push(Definition {
                                    name: node_text(&name_n, source).to_string(),
                                    kind: "function".to_string(),
                                    line: start_line(node),
                                    end_line: Some(end_line(&value_n)),
                                    decorators: None,
                                    complexity: compute_all_metrics(&value_n, source, "javascript"),
                                    cfg: build_function_cfg(&value_n, "javascript", source),
                                    children: opt_children(children),
                                });
                            } else if is_const && is_js_literal(&value_n)
                                && find_parent_of_types(node, &[
                                    "function_declaration", "arrow_function",
                                    "function_expression", "method_definition",
                                ]).is_none()
                            {
                                symbols.definitions.push(Definition {
                                    name: node_text(&name_n, source).to_string(),
                                    kind: "constant".to_string(),
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
            }
        }

        "call_expression" => {
            if let Some(fn_node) = node.child_by_field_name("function") {
                // Detect dynamic import() expressions
                if fn_node.kind() == "import" {
                    if let Some(args) = node.child_by_field_name("arguments")
                        .or_else(|| find_child(node, "arguments"))
                    {
                        if let Some(str_node) = find_child(&args, "string")
                            .or_else(|| find_child(&args, "template_string"))
                        {
                            let mod_path = node_text(&str_node, source)
                                .replace(&['\'', '"', '`'][..], "");
                            let names = extract_dynamic_import_names(node, source);
                            let mut imp = Import::new(mod_path, names, start_line(node));
                            imp.dynamic_import = Some(true);
                            symbols.imports.push(imp);
                        }
                    }
                } else if let Some(call_info) = extract_call_info(&fn_node, node, source) {
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
            walk_node_depth(&child, source, symbols, depth + 1);
        }
    }
}

// ── AST node extraction (new / throw / await / string / regex) ──────────────

const TEXT_MAX: usize = 200;

/// Walk the tree collecting new/throw/await/string/regex AST nodes.
/// Mirrors `walkAst()` in `ast.js:216-276`.
fn walk_ast_nodes(node: &Node, source: &[u8], ast_nodes: &mut Vec<AstNode>) {
    walk_ast_nodes_depth(node, source, ast_nodes, 0);
}

fn walk_ast_nodes_depth(node: &Node, source: &[u8], ast_nodes: &mut Vec<AstNode>, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "new_expression" => {
            let name = extract_new_name(node, source);
            let text = truncate(node_text(node, source), TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "new".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Don't recurse — we already captured this node
            return;
        }
        "throw_statement" => {
            let name = extract_throw_name(node, source);
            let text = extract_expression_text(node, source);
            ast_nodes.push(AstNode {
                kind: "throw".to_string(),
                name,
                line: start_line(node),
                text,
                receiver: None,
            });
            // Don't recurse — prevents double-counting `throw new Error`
            return;
        }
        "await_expression" => {
            let name = extract_await_name(node, source);
            let text = extract_expression_text(node, source);
            ast_nodes.push(AstNode {
                kind: "await".to_string(),
                name,
                line: start_line(node),
                text,
                receiver: None,
            });
            // Don't recurse
            return;
        }
        "string" | "template_string" => {
            let raw = node_text(node, source);
            // Strip quotes to get content
            let content = raw
                .trim_start_matches(|c| c == '\'' || c == '"' || c == '`')
                .trim_end_matches(|c| c == '\'' || c == '"' || c == '`');
            if content.len() < 2 {
                // Still recurse children (template_string may have nested expressions)
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk_ast_nodes_depth(&child, source, ast_nodes, depth + 1);
                    }
                }
                return;
            }
            let name = truncate(content, 100);
            let text = truncate(raw, TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "string".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Do recurse children for strings
        }
        "regex" => {
            let raw = node_text(node, source);
            let name = if raw.is_empty() { "?".to_string() } else { raw.to_string() };
            let text = truncate(raw, TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "regex".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Do recurse children for regex
        }
        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_ast_nodes_depth(&child, source, ast_nodes, depth + 1);
        }
    }
}

/// Extract constructor name from a `new_expression` node.
/// Handles `new Foo()`, `new a.Foo()`, `new Foo.Bar()`.
fn extract_new_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" {
                return node_text(&child, source).to_string();
            }
            if child.kind() == "member_expression" {
                return node_text(&child, source).to_string();
            }
        }
    }
    // Fallback: text before '(' minus 'new '
    let raw = node_text(node, source);
    raw.split('(')
        .next()
        .unwrap_or(raw)
        .replace("new ", "")
        .trim()
        .to_string()
}

/// Extract name from a `throw_statement`.
/// `throw new Error(...)` → "Error"; `throw x` → "x"
fn extract_throw_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "new_expression" => return extract_new_name(&child, source),
                "call_expression" => {
                    if let Some(fn_node) = child.child_by_field_name("function") {
                        return node_text(&fn_node, source).to_string();
                    }
                    let text = node_text(&child, source);
                    return text.split('(').next().unwrap_or("?").to_string();
                }
                "identifier" => return node_text(&child, source).to_string(),
                _ => {}
            }
        }
    }
    truncate(node_text(node, source), TEXT_MAX)
}

/// Extract name from an `await_expression`.
/// `await fetch(...)` → "fetch"; `await this.foo()` → "this.foo"
fn extract_await_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "call_expression" => {
                    if let Some(fn_node) = child.child_by_field_name("function") {
                        return node_text(&fn_node, source).to_string();
                    }
                    let text = node_text(&child, source);
                    return text.split('(').next().unwrap_or("?").to_string();
                }
                "identifier" | "member_expression" => {
                    return node_text(&child, source).to_string();
                }
                _ => {}
            }
        }
    }
    truncate(node_text(node, source), TEXT_MAX)
}

/// Extract expression text from throw/await — skip the keyword child.
fn extract_expression_text(node: &Node, source: &[u8]) -> Option<String> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            // Skip the keyword token itself
            if child.kind() != "throw" && child.kind() != "await" {
                return Some(truncate(node_text(&child, source), TEXT_MAX));
            }
        }
    }
    Some(truncate(node_text(node, source), TEXT_MAX))
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_js_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "formal_parameters"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                match child.kind() {
                    "identifier" => {
                        params.push(child_def(
                            node_text(&child, source).to_string(),
                            "parameter",
                            start_line(&child),
                        ));
                    }
                    "required_parameter" | "optional_parameter" => {
                        // TS parameters: pattern field holds the identifier;
                        // fall back to left field or first child for edge cases
                        let name_node = child.child_by_field_name("pattern")
                            .or_else(|| child.child_by_field_name("left"))
                            .or_else(|| child.child(0));
                        if let Some(name_node) = name_node {
                            if name_node.kind() == "identifier"
                                || name_node.kind() == "shorthand_property_identifier_pattern"
                            {
                                params.push(child_def(
                                    node_text(&name_node, source).to_string(),
                                    "parameter",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    "assignment_pattern" => {
                        if let Some(left) = child.child_by_field_name("left") {
                            if left.kind() == "identifier" {
                                params.push(child_def(
                                    node_text(&left, source).to_string(),
                                    "parameter",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    "rest_pattern" | "rest_element" => {
                        for j in 0..child.child_count() {
                            if let Some(inner) = child.child(j) {
                                if inner.kind() == "identifier" {
                                    params.push(child_def(
                                        node_text(&inner, source).to_string(),
                                        "parameter",
                                        start_line(&child),
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    params
}

fn extract_js_class_properties(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "class_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                match child.kind() {
                    "field_definition" | "public_field_definition" | "property_definition" => {
                        let prop = child.child_by_field_name("property")
                            .or_else(|| child.child_by_field_name("name"))
                            .or_else(|| find_child(&child, "property_identifier"));
                        if let Some(prop) = prop {
                            let kind = prop.kind();
                            if kind == "property_identifier" || kind == "identifier"
                                || kind == "private_property_identifier"
                            {
                                props.push(child_def(
                                    node_text(&prop, source).to_string(),
                                    "property",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    props
}

fn extract_ts_enum_members(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut members = Vec::new();
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "enum_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_assignment" || child.kind() == "property_identifier" {
                    let name = child.child_by_field_name("name")
                        .unwrap_or(child);
                    members.push(child_def(
                        node_text(&name, source).to_string(),
                        "constant",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    members
}

fn is_js_literal(node: &Node) -> bool {
    matches!(node.kind(),
        "number" | "string" | "true" | "false" | "null" | "undefined"
        | "template_string" | "regex" | "array" | "object"
        | "unary_expression" | "binary_expression" | "new_expression"
    )
}

// ── Existing helpers ────────────────────────────────────────────────────────

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
                        cfg: None,
                        children: None,
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
    extract_implements_depth(node, source, result, 0);
}

fn extract_implements_depth(node: &Node, source: &[u8], result: &mut Vec<String>, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" || child.kind() == "type_identifier" {
                result.push(node_text(&child, source).to_string());
            }
            if child.child_count() > 0 {
                extract_implements_depth(&child, source, result, depth + 1);
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
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
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
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
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
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
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

/// Extract named bindings from a dynamic `import()` call expression.
/// Handles: `const { a, b } = await import(...)` and `const mod = await import(...)`
fn extract_dynamic_import_names(call_node: &Node, source: &[u8]) -> Vec<String> {
    // Walk up: call_expression → await_expression? → variable_declarator
    let mut current = call_node.parent();
    if let Some(parent) = current {
        if parent.kind() == "await_expression" {
            current = parent.parent();
        }
    }
    let declarator = match current {
        Some(n) if n.kind() == "variable_declarator" => n,
        _ => return Vec::new(),
    };
    let name_node = match declarator.child_by_field_name("name") {
        Some(n) => n,
        None => return Vec::new(),
    };
    match name_node.kind() {
        // const { a, b } = await import(...)
        "object_pattern" => {
            let mut names = Vec::new();
            for i in 0..name_node.child_count() {
                if let Some(child) = name_node.child(i) {
                    if child.kind() == "shorthand_property_identifier_pattern"
                        || child.kind() == "shorthand_property_identifier"
                    {
                        names.push(node_text(&child, source).to_string());
                    } else if child.kind() == "pair_pattern" || child.kind() == "pair" {
                        if let Some(val) = child.child_by_field_name("value") {
                            // Handle `{ foo: bar = 'default' }` — extract the left-hand binding
                            let binding = if val.kind() == "assignment_pattern" {
                                val.child_by_field_name("left").unwrap_or(val)
                            } else if val.kind() == "identifier" {
                                val
                            } else {
                                // Nested pattern (e.g. `{ foo: { bar } }`) — skip;
                                // full nested support requires recursive extraction.
                                continue;
                            };
                            names.push(node_text(&binding, source).to_string());
                        } else if let Some(key) = child.child_by_field_name("key") {
                            names.push(node_text(&key, source).to_string());
                        }
                    } else if child.kind() == "object_assignment_pattern" {
                        // Handle `{ a = 'default' }` — extract the left-hand binding
                        if let Some(left) = child.child_by_field_name("left") {
                            names.push(node_text(&left, source).to_string());
                        }
                    } else if child.kind() == "rest_pattern" || child.kind() == "rest_element" {
                        // Handle `{ a, ...rest }` — extract the identifier inside the spread
                        if let Some(inner) = child.child(0) {
                            if inner.kind() == "identifier" {
                                names.push(node_text(&inner, source).to_string());
                            }
                        }
                    }
                }
            }
            names
        }
        // const mod = await import(...)
        "identifier" => vec![node_text(&name_node, source).to_string()],
        // const [first, second] = await import(...)
        "array_pattern" => {
            let mut names = Vec::new();
            for i in 0..name_node.child_count() {
                if let Some(child) = name_node.child(i) {
                    if child.kind() == "identifier" {
                        names.push(node_text(&child, source).to_string());
                    } else if child.kind() == "assignment_pattern" {
                        if let Some(left) = child.child_by_field_name("left") {
                            names.push(node_text(&left, source).to_string());
                        }
                    } else if child.kind() == "rest_pattern" || child.kind() == "rest_element" {
                        // Handle `[a, ...rest]` — extract the identifier inside the spread
                        if let Some(inner) = child.child(0) {
                            if inner.kind() == "identifier" {
                                names.push(node_text(&inner, source).to_string());
                            }
                        }
                    }
                }
            }
            names
        }
        _ => Vec::new(),
    }
}

fn extract_import_names(node: &Node, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    scan_import_names(node, source, &mut names);
    names
}

fn scan_import_names(node: &Node, source: &[u8], names: &mut Vec<String>) {
    scan_import_names_depth(node, source, names, 0);
}

fn scan_import_names_depth(node: &Node, source: &[u8], names: &mut Vec<String>, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
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
            scan_import_names_depth(&child, source, names, depth + 1);
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

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_js("function greet(name, age) { }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        let children = greet.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_arrow_function_parameters() {
        let s = parse_js("const add = (a, b) => a + b;");
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        let children = add.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "a");
        assert_eq!(children[1].name, "b");
    }

    #[test]
    fn extracts_class_properties() {
        let s = parse_js("class User { name; age; greet() {} }");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let prop_names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(prop_names.contains(&"name"));
        assert!(prop_names.contains(&"age"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_const_literal_as_constant() {
        let s = parse_js("const MAX = 100;");
        let max = s.definitions.iter().find(|d| d.name == "MAX").unwrap();
        assert_eq!(max.kind, "constant");
    }

    #[test]
    fn skips_const_function_as_constant() {
        let s = parse_js("const fn = () => {};");
        let f = s.definitions.iter().find(|d| d.name == "fn").unwrap();
        assert_eq!(f.kind, "function");
    }

    #[test]
    fn skips_local_const_inside_function() {
        let s = parse_js("function main() { const x = 42; const y = new Foo(); }");
        // Only `main` should be extracted — local constants are not top-level symbols
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "main");
    }

    // ── AST node extraction tests ────────────────────────────────────────────

    #[test]
    fn ast_extracts_new_expression() {
        let s = parse_js("function f() { const m = new Map(); const s = new Set(); }");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        assert_eq!(new_nodes.len(), 2);
        let names: Vec<&str> = new_nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Map"));
        assert!(names.contains(&"Set"));
    }

    #[test]
    fn ast_extracts_new_member_expression() {
        let s = parse_js("const e = new errors.NotFoundError();");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        assert_eq!(new_nodes.len(), 1);
        assert_eq!(new_nodes[0].name, "errors.NotFoundError");
    }

    #[test]
    fn ast_extracts_throw_statement() {
        let s = parse_js("function f() { throw new Error('bad'); }");
        let throw_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "throw").collect();
        assert_eq!(throw_nodes.len(), 1);
        assert_eq!(throw_nodes[0].name, "Error");
    }

    #[test]
    fn ast_throw_no_double_count_new() {
        // `throw new Error(...)` should produce one throw node, NOT also a new node
        let s = parse_js("function f() { throw new Error('fail'); }");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        let throw_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "throw").collect();
        assert_eq!(throw_nodes.len(), 1);
        assert_eq!(new_nodes.len(), 0, "throw new Error should not also emit a new node");
    }

    #[test]
    fn ast_extracts_await_expression() {
        let s = parse_js("async function f() { const d = await fetch('/api'); }");
        let await_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "await").collect();
        assert_eq!(await_nodes.len(), 1);
        assert_eq!(await_nodes[0].name, "fetch");
    }

    #[test]
    fn ast_extracts_await_member_expression() {
        let s = parse_js("async function f() { await this.load(); }");
        let await_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "await").collect();
        assert_eq!(await_nodes.len(), 1);
        assert_eq!(await_nodes[0].name, "this.load");
    }

    #[test]
    fn ast_extracts_string_literals() {
        let s = parse_js("const x = 'hello world'; const y = \"foo bar\";");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        assert_eq!(str_nodes.len(), 2);
        let names: Vec<&str> = str_nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello world"));
        assert!(names.contains(&"foo bar"));
    }

    #[test]
    fn ast_skips_trivial_strings() {
        // Single char or empty strings should be skipped
        let s = parse_js("const a = ''; const b = 'x'; const c = 'ok';");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        // Only "ok" has content length >= 2
        assert_eq!(str_nodes.len(), 1);
        assert_eq!(str_nodes[0].name, "ok");
    }

    #[test]
    fn ast_extracts_regex() {
        let s = parse_js("const re = /^[a-z]+$/i;");
        let regex_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "regex").collect();
        assert_eq!(regex_nodes.len(), 1);
        assert!(regex_nodes[0].name.contains("[a-z]"));
    }

    #[test]
    fn ast_extracts_template_string() {
        let s = parse_js("const msg = `hello template`;");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        assert_eq!(str_nodes.len(), 1);
        assert!(str_nodes[0].name.contains("hello template"));
    }

    #[test]
    fn finds_dynamic_import() {
        let s = parse_js("const mod = import('./foo.js');");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./foo.js");
    }

    #[test]
    fn finds_dynamic_import_with_destructuring() {
        let s = parse_js("const { a, b } = await import('./bar.js');");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./bar.js");
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }
}
