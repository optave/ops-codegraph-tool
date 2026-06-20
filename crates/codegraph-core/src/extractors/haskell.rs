use tree_sitter::{Node, Tree};
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct HaskellExtractor;

impl SymbolExtractor for HaskellExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_haskell_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &HASKELL_AST_CONFIG);
        symbols
    }
}

fn match_haskell_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function" => handle_haskell_function(node, source, symbols),
        "bind" => handle_haskell_bind(node, source, symbols),
        "data_type" => handle_haskell_data_type(node, source, symbols),
        "newtype" => handle_haskell_newtype(node, source, symbols),
        "type_synomym" => handle_haskell_type_synonym(node, source, symbols),
        "class" => handle_haskell_class(node, source, symbols),
        "instance" => handle_haskell_instance(node, source, symbols),
        "import" => handle_haskell_import(node, source, symbols),
        "apply" => handle_haskell_apply(node, source, symbols),
        _ => {}
    }
}

fn handle_haskell_function(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    let params = extract_haskell_params(node, source);

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "haskell"),
        cfg: build_function_cfg(node, "haskell", source),
        children: opt_children(params),
    });
}

fn extract_haskell_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    for i in 0..func_node.child_count() {
        let Some(child) = func_node.child(i) else { continue };
        match child.kind() {
            "patterns" | "parameter" => {
                for j in 0..child.child_count() {
                    if let Some(pat) = child.child(j) {
                        collect_haskell_pattern_bindings(&pat, source, &mut params);
                    }
                }
            }
            "variable" if i > 0 => {
                // Pattern parameter after the function name (no enclosing `patterns` node)
                params.push(child_def(
                    node_text(&child, source).to_string(),
                    "parameter",
                    start_line(&child),
                ));
            }
            _ => {}
        }
    }
    params
}

// Walk a pattern node and emit each bound variable (and `_` for wildcards) as a parameter.
// Container patterns — parens, constructor application, infix (cons), tuple, list, as, strict,
// irrefutable, qualified — are transparent: descend into their children. `record` is special:
// only the right-hand-side of each `field_pattern` is bound (the field name is not).
// Literals, bare constructors, and operators do not bind.
fn collect_haskell_pattern_bindings(node: &Node, source: &[u8], out: &mut Vec<Definition>) {
    match node.kind() {
        "variable" | "identifier" => {
            out.push(child_def(
                node_text(node, source).to_string(),
                "parameter",
                start_line(node),
            ));
        }
        "wildcard" => {
            out.push(child_def("_".to_string(), "parameter", start_line(node)));
        }
        "parens" | "apply" | "infix" | "tuple" | "list" | "strict" | "irrefutable" | "as"
        | "qualified" => {
            for i in 0..node.child_count() {
                if let Some(c) = node.child(i) {
                    collect_haskell_pattern_bindings(&c, source, out);
                }
            }
        }
        "record" => {
            for i in 0..node.child_count() {
                let Some(fp) = node.child(i) else { continue };
                if fp.kind() != "field_pattern" {
                    continue;
                }
                for j in 0..fp.child_count() {
                    if let Some(g) = fp.child(j) {
                        if g.kind() != "field_name" {
                            collect_haskell_pattern_bindings(&g, source, out);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn handle_haskell_bind(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
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

fn handle_haskell_data_type(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };
    let name = node_text(&name_node, source).to_string();

    let mut children = Vec::new();
    if let Some(constructors) = node.child_by_field_name("constructors") {
        for i in 0..constructors.child_count() {
            if let Some(ctor) = constructors.child(i) {
                if ctor.kind() == "data_constructor" || ctor.kind() == "gadt_constructor" {
                    let ctor_name = find_child(&ctor, "constructor")
                        .or_else(|| find_child(&ctor, "constructor_operator"));
                    if let Some(cn) = ctor_name {
                        children.push(child_def(
                            node_text(&cn, source).to_string(),
                            "property",
                            start_line(&ctor),
                        ));
                    }
                }
            }
        }
    }

    symbols.definitions.push(Definition {
        name,
        kind: "type".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
    });
}

fn handle_haskell_newtype(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
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

fn handle_haskell_type_synonym(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
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

fn handle_haskell_class(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_haskell_instance(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_haskell_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let module_node = match node.child_by_field_name("module") {
        Some(n) => n,
        None => return,
    };

    let source_name = node_text(&module_node, source).to_string();
    let mut names = Vec::new();

    if let Some(alias) = node.child_by_field_name("alias") {
        names.push(node_text(&alias, source).to_string());
    }

    if let Some(import_list) = node.child_by_field_name("names") {
        for i in 0..import_list.child_count() {
            if let Some(item) = import_list.child(i) {
                match item.kind() {
                    "variable" | "constructor" | "type" => {
                        names.push(node_text(&item, source).to_string());
                    }
                    _ => {}
                }
            }
        }
    }

    if names.is_empty() {
        let last = source_name.split('.').last().unwrap_or(&source_name).to_string();
        names.push(last);
    }

    symbols.imports.push(Import::new(source_name, names, start_line(node)));
}

fn handle_haskell_apply(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child_by_field_name("function") {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "variable" | "constructor" | "identifier" | "qualified_variable" | "qualified_constructor" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
                ..Default::default()
            });
        }
        _ => {}
    }
}
