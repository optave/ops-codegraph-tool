use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct ElixirExtractor;

impl SymbolExtractor for ElixirExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_elixir_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &ELIXIR_AST_CONFIG);
        symbols
    }
}

fn match_elixir_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    if node.kind() != "call" {
        return;
    }

    let target = match node.child_by_field_name("target").or_else(|| node.child(0)) {
        Some(t) => t,
        None => return,
    };

    if target.kind() == "identifier" {
        let keyword = node_text(&target, source);
        match keyword {
            "defmodule" => handle_defmodule(node, source, symbols),
            "def" | "defp" => handle_def_function(node, source, symbols, keyword),
            "defprotocol" => handle_defprotocol(node, source, symbols),
            "defimpl" => handle_defimpl(node, source, symbols),
            "import" | "use" | "require" | "alias" => handle_elixir_import(node, source, symbols, keyword),
            _ => {
                symbols.calls.push(Call {
                    name: keyword.to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
    } else if target.kind() == "dot" {
        handle_dot_call(node, &target, source, symbols);
    }
}

fn handle_defmodule(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let args = match find_child(node, "arguments") {
        Some(a) => a,
        None => return,
    };
    let alias_node = match find_child(&args, "alias") {
        Some(a) => a,
        None => return,
    };
    let name = node_text(&alias_node, source).to_string();

    // Collect child function definitions from the module's do_block
    let children = collect_module_children(node, source);

    symbols.definitions.push(Definition {
        name,
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
    });
}

fn collect_module_children(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut children = Vec::new();
    let do_block = match find_child(node, "do_block") {
        Some(b) => b,
        None => return children,
    };

    for i in 0..do_block.child_count() {
        let child = match do_block.child(i) {
            Some(c) if c.kind() == "call" => c,
            _ => continue,
        };
        let target = match child.child_by_field_name("target").or_else(|| child.child(0)) {
            Some(t) if t.kind() == "identifier" => t,
            _ => continue,
        };
        let kw = node_text(&target, source);
        if kw != "def" && kw != "defp" {
            continue;
        }
        let args = match find_child(&child, "arguments") {
            Some(a) => a,
            None => continue,
        };
        if let Some(fn_name) = extract_elixir_fn_name(&args, source) {
            children.push(child_def(fn_name, "property", start_line(&child)));
        }
    }
    children
}

fn handle_def_function(node: &Node, source: &[u8], symbols: &mut FileSymbols, _keyword: &str) {
    let args = match find_child(node, "arguments") {
        Some(a) => a,
        None => return,
    };

    // Function name is either in a nested call or a direct identifier
    let fn_name = extract_elixir_fn_name(&args, source);
    let fn_name = match fn_name {
        Some(n) => n,
        None => return,
    };

    // Find parent module
    let parent_module = find_elixir_parent_module(node, source);
    let full_name = match &parent_module {
        Some(m) => format!("{}.{}", m, fn_name),
        None => fn_name,
    };

    let params = extract_elixir_params(&args, source);

    // Note: visibility (public/private) is determined by keyword but the
    // Definition struct does not yet have a visibility field. When it does,
    // wire `keyword == "defp"` → private, else → public.

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "elixir"),
        cfg: build_function_cfg(node, "elixir", source),
        children: opt_children(params),
    });
}

fn extract_elixir_params(args: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    for i in 0..args.child_count() {
        let Some(child) = args.child(i) else { continue };
        if child.kind() != "call" { continue; }
        let Some(inner_args) = find_child(&child, "arguments") else { continue };
        for j in 0..inner_args.child_count() {
            let Some(param) = inner_args.child(j) else { continue };
            collect_elixir_param_identifiers(&param, source, &mut params);
        }
    }
    params
}

/// Walk a parameter pattern and emit each bound identifier as a `parameter`
/// child. Handles bare identifiers, default-value `a \\ default`, list-cons
/// `[head | tail]`, list `[a, b, c]`, tuple `{x, y}`, and map / struct
/// destructuring (`%{k: v}`, `%Foo{k: v}`).
///
/// Implemented as an iterative worklist (rather than recursion + helpers) so
/// the call graph has no function-level cycle: only one function performs the
/// traversal and it invokes only leaf helpers (`push_elixir_sequence_items`,
/// `push_elixir_map_values`, `push_elixir_binary_operator_operands`).
fn collect_elixir_param_identifiers(root: &Node, source: &[u8], out: &mut Vec<Definition>) {
    let mut stack: Vec<Node> = vec![*root];
    while let Some(node) = stack.pop() {
        match node.kind() {
            "identifier" => {
                out.push(child_def(
                    node_text(&node, source).to_string(),
                    "parameter",
                    start_line(&node),
                ));
            }
            "binary_operator" => {
                push_elixir_binary_operator_operands(&node, &mut stack);
            }
            "list" | "tuple" => {
                push_elixir_sequence_items(&node, &mut stack);
            }
            "map" => {
                push_elixir_map_values(&node, &mut stack);
            }
            _ => {}
        }
    }
}

/// Push the binding-relevant operands of a `binary_operator` parameter onto the
/// worklist:
/// - `name \\ default` (default-value) binds the left operand only.
/// - `head | tail`     (list-cons, appears inside a `list` pattern) binds both.
fn push_elixir_binary_operator_operands<'a>(node: &Node<'a>, stack: &mut Vec<Node<'a>>) {
    let Some(op) = node.child(1) else { return };
    match op.kind() {
        "\\\\" => {
            if let Some(left) = node.child(0) {
                stack.push(left);
            }
        }
        "|" => {
            if let Some(right) = node.child(2) {
                stack.push(right);
            }
            if let Some(left) = node.child(0) {
                stack.push(left);
            }
        }
        _ => {}
    }
}

/// Push the binding-relevant elements of a `list` or `tuple` parameter onto
/// the worklist, skipping punctuation tokens.
///
/// Children are pushed in reverse source order so that `stack.pop()` yields
/// them left-to-right (the worklist is a LIFO stack).
fn push_elixir_sequence_items<'a>(node: &Node<'a>, stack: &mut Vec<Node<'a>>) {
    let count = node.child_count();
    for i in (0..count).rev() {
        let Some(c) = node.child(i) else { continue };
        let k = c.kind();
        if PUNCTUATION_TOKENS.contains(&k) { continue; }
        stack.push(c);
    }
}

/// Push the value side of every pair in a `map` or `%Foo{...}` parameter onto
/// the worklist. The struct alias (`Foo`) is a type, not a bound identifier, so
/// the leading `struct` child is intentionally skipped.
///
/// Values are collected in source order and then pushed in reverse so that
/// `stack.pop()` yields them left-to-right (the worklist is a LIFO stack).
fn push_elixir_map_values<'a>(node: &Node<'a>, stack: &mut Vec<Node<'a>>) {
    // Collect values in source order first, then push in reverse so pop() is l-to-r.
    let mut values: Vec<Node<'a>> = Vec::new();
    for i in 0..node.child_count() {
        let Some(content) = node.child(i) else { continue };
        if content.kind() != "map_content" { continue; }
        for j in 0..content.child_count() {
            let Some(kws) = content.child(j) else { continue };
            if kws.kind() != "keywords" { continue; }
            for k in 0..kws.child_count() {
                let Some(pair) = kws.child(k) else { continue };
                if pair.kind() != "pair" { continue; }
                for p in 0..pair.child_count() {
                    let Some(part) = pair.child(p) else { continue };
                    if part.kind() == "keyword" { continue; }
                    values.push(part);
                }
            }
        }
    }
    for v in values.into_iter().rev() {
        stack.push(v);
    }
}

fn extract_elixir_fn_name<'a>(args: &Node<'a>, source: &'a [u8]) -> Option<String> {
    for i in 0..args.child_count() {
        if let Some(child) = args.child(i) {
            if child.kind() == "call" {
                if let Some(target) = child.child_by_field_name("target").or_else(|| child.child(0)) {
                    if target.kind() == "identifier" {
                        return Some(node_text(&target, source).to_string());
                    }
                }
            }
            if child.kind() == "identifier" {
                return Some(node_text(&child, source).to_string());
            }
        }
    }
    None
}

fn find_elixir_parent_module<'a>(node: &Node<'a>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "do_block" {
            if let Some(name) = try_extract_defmodule_name(&parent, source) {
                return Some(name);
            }
        }
        current = parent.parent();
    }
    None
}

fn try_extract_defmodule_name(do_block: &Node, source: &[u8]) -> Option<String> {
    let gp = do_block.parent()?;
    if gp.kind() != "call" { return None; }
    let target = gp.child_by_field_name("target").or_else(|| gp.child(0))?;
    if target.kind() != "identifier" || node_text(&target, source) != "defmodule" {
        return None;
    }
    let args = find_child(&gp, "arguments")?;
    let alias = find_child(&args, "alias")?;
    Some(node_text(&alias, source).to_string())
}

fn handle_defprotocol(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let args = match find_child(node, "arguments") {
        Some(a) => a,
        None => return,
    };
    let alias_node = match find_child(&args, "alias") {
        Some(a) => a,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&alias_node, source).to_string(),
        kind: "interface".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_defimpl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let args = match find_child(node, "arguments") {
        Some(a) => a,
        None => return,
    };
    let alias_node = match find_child(&args, "alias") {
        Some(a) => a,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&alias_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_elixir_import(node: &Node, source: &[u8], symbols: &mut FileSymbols, keyword: &str) {
    let args = match find_child(node, "arguments") {
        Some(a) => a,
        None => return,
    };
    let alias_node = match find_child(&args, "alias") {
        Some(a) => a,
        None => return,
    };

    symbols.imports.push(Import::new(
        node_text(&alias_node, source).to_string(),
        vec![keyword.to_string()],
        start_line(node),
    ));
}

fn handle_dot_call(node: &Node, dot_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let right = find_child(dot_node, "identifier");
    let left = find_child(dot_node, "alias");

    let name = match right {
        Some(r) => node_text(&r, source).to_string(),
        None => return,
    };
    let receiver = left.map(|l| node_text(&l, source).to_string());

    symbols.calls.push(Call {
        name,
        line: start_line(node),
        dynamic: None,
        receiver,
    });
}
