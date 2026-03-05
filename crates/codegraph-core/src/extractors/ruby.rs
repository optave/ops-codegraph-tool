use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct RubyExtractor;

impl SymbolExtractor for RubyExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &RUBY_AST_CONFIG);
        symbols
    }
}

fn find_ruby_parent_class<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "class" | "module" => {
                return parent
                    .child_by_field_name("name")
                    .map(|n| node_text(&n, source).to_string());
            }
            _ => {}
        }
        current = parent.parent();
    }
    None
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "class" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let class_name = node_text(&name_node, source).to_string();
                let children = extract_ruby_class_children(node, source);
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
                if let Some(superclass) = node.child_by_field_name("superclass") {
                    extract_ruby_superclass(&superclass, &class_name, node, source, symbols);
                }
            }
        }

        "module" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "module".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });
            }
        }

        "method" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_class = find_ruby_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                let children = extract_ruby_parameters(node, source);
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "method".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "ruby"),
                    cfg: build_function_cfg(node, "ruby", source),
                    children: opt_children(children),
                });
            }
        }

        "singleton_method" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let parent_class = find_ruby_parent_class(node, source);
                let name = node_text(&name_node, source);
                let full_name = match &parent_class {
                    Some(cls) => format!("{}.{}", cls, name),
                    None => name.to_string(),
                };
                symbols.definitions.push(Definition {
                    name: full_name,
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "ruby"),
                    cfg: build_function_cfg(node, "ruby", source),
                    children: None,
                });
            }
        }

        "call" => {
            if let Some(method_node) = node.child_by_field_name("method") {
                let method_text = node_text(&method_node, source);

                if method_text == "require" || method_text == "require_relative" {
                    let args = node.child_by_field_name("arguments");
                    if let Some(args) = args {
                        for i in 0..args.child_count() {
                            if let Some(arg) = args.child(i) {
                                let str_content = extract_ruby_string_content(&arg, source);
                                if let Some(content) = str_content {
                                    let last = content.split('/').last().unwrap_or("").to_string();
                                    let mut imp =
                                        Import::new(content, vec![last], start_line(node));
                                    imp.ruby_require = Some(true);
                                    symbols.imports.push(imp);
                                    break;
                                }
                            }
                        }
                    }
                } else if method_text == "include"
                    || method_text == "extend"
                    || method_text == "prepend"
                {
                    let parent_class = find_ruby_parent_class(node, source);
                    if let Some(parent_class) = parent_class {
                        if let Some(args) = node.child_by_field_name("arguments") {
                            for i in 0..args.child_count() {
                                if let Some(arg) = args.child(i) {
                                    if arg.kind() == "constant"
                                        || arg.kind() == "scope_resolution"
                                    {
                                        symbols.classes.push(ClassRelation {
                                            name: parent_class.clone(),
                                            extends: None,
                                            implements: Some(
                                                node_text(&arg, source).to_string(),
                                            ),
                                            line: start_line(node),
                                        });
                                    }
                                }
                            }
                        }
                    }
                } else {
                    let receiver = node.child_by_field_name("receiver")
                        .map(|r| node_text(&r, source).to_string());
                    symbols.calls.push(Call {
                        name: method_text.to_string(),
                        line: start_line(node),
                        dynamic: None,
                        receiver,
                    });
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

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_ruby_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node.child_by_field_name("parameters")
        .or_else(|| find_child(node, "method_parameters"));
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
                    "optional_parameter" => {
                        if let Some(name_node) = child.child_by_field_name("name") {
                            params.push(child_def(
                                node_text(&name_node, source).to_string(),
                                "parameter",
                                start_line(&child),
                            ));
                        }
                    }
                    "splat_parameter" | "hash_splat_parameter" | "block_parameter" => {
                        if let Some(name_node) = child.child_by_field_name("name") {
                            params.push(child_def(
                                node_text(&name_node, source).to_string(),
                                "parameter",
                                start_line(&child),
                            ));
                        }
                    }
                    "keyword_parameter" => {
                        if let Some(name_node) = child.child_by_field_name("name") {
                            params.push(child_def(
                                node_text(&name_node, source).to_string(),
                                "parameter",
                                start_line(&child),
                            ));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    params
}

fn extract_ruby_class_children(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut children = Vec::new();
    // Walk class body looking for instance variable assignments and constants
    let body = node.child_by_field_name("body");
    if let Some(body) = body {
        collect_ruby_class_children(&body, source, &mut children);
    }
    children
}

fn collect_ruby_class_children(node: &Node, source: &[u8], children: &mut Vec<Definition>) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                // Instance variable assignment: @name = ...
                "assignment" => {
                    if let Some(left) = child.child_by_field_name("left") {
                        if left.kind() == "instance_variable" {
                            let name = node_text(&left, source);
                            if !children.iter().any(|c| c.name == name) {
                                children.push(child_def(
                                    name.to_string(),
                                    "property",
                                    start_line(&child),
                                ));
                            }
                        }
                        // UPPER_CASE = value → constant
                        if left.kind() == "constant" {
                            let name = node_text(&left, source);
                            children.push(child_def(
                                name.to_string(),
                                "constant",
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

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_ruby_superclass(
    superclass: &Node,
    class_name: &str,
    class_node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    // Direct check for superclass node type
    if superclass.kind() == "superclass" {
        for i in 0..superclass.child_count() {
            if let Some(child) = superclass.child(i) {
                if child.kind() == "constant" || child.kind() == "scope_resolution" {
                    symbols.classes.push(ClassRelation {
                        name: class_name.to_string(),
                        extends: Some(node_text(&child, source).to_string()),
                        implements: None,
                        line: start_line(class_node),
                    });
                    return;
                }
            }
        }
    }
    // Fallback: check children directly
    for i in 0..superclass.child_count() {
        if let Some(child) = superclass.child(i) {
            if child.kind() == "constant" || child.kind() == "scope_resolution" {
                symbols.classes.push(ClassRelation {
                    name: class_name.to_string(),
                    extends: Some(node_text(&child, source).to_string()),
                    implements: None,
                    line: start_line(class_node),
                });
                return;
            }
        }
    }
}

fn extract_ruby_string_content(node: &Node, source: &[u8]) -> Option<String> {
    if node.kind() == "string" {
        // Look for string_content child
        if let Some(content) = find_child(node, "string_content") {
            return Some(node_text(&content, source).to_string());
        }
        // Fallback: strip quotes from text
        let text = node_text(node, source);
        let stripped = text
            .trim_start_matches(&['\'', '"'][..])
            .trim_end_matches(&['\'', '"'][..]);
        if !stripped.is_empty() {
            return Some(stripped.to_string());
        }
    }
    if node.kind() == "string_content" {
        return Some(node_text(node, source).to_string());
    }
    None
}
