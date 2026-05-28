use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct FSharpExtractor;

impl SymbolExtractor for FSharpExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_fsharp_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &FSHARP_AST_CONFIG);
        symbols
    }
}

fn match_fsharp_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "named_module" => handle_named_module(node, source, symbols),
        "module_defn" => handle_module_defn(node, source, symbols),
        "function_declaration_left" => handle_function_decl(node, source, symbols),
        "type_definition" => handle_type_def(node, source, symbols),
        "import_decl" => handle_import_decl(node, source, symbols),
        "application_expression" => handle_application(node, source, symbols),
        "dot_expression" => handle_dot_expression(node, source, symbols),
        "value_definition" => handle_value_definition(node, source, symbols),
        _ => {}
    }
}

/// Find the enclosing module name, walking up through any number of
/// `module_defn` (nested signature modules) wrappers before reaching the
/// top-level `named_module`. Returns the dotted path, e.g. `Outer.Inner`.
///
/// Source files use `named_module` for the top-level `module M = …` and
/// the signature grammar (cargo 0.3.0) wraps nested signature modules in
/// `module_defn` nodes. The WASM signature grammar currently emits ERROR
/// nodes for nested signature modules so we cannot recover qualification
/// there — tracked under #1161.
fn enclosing_module_name(node: &Node, source: &[u8]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = node.parent();
    while let Some(p) = current {
        match p.kind() {
            "module_defn" => {
                if let Some(id) = find_child(&p, "identifier") {
                    parts.push(node_text(&id, source).to_string());
                }
            }
            "named_module" => {
                if let Some(id) = find_child(&p, "long_identifier") {
                    parts.push(node_text(&id, source).to_string());
                }
                break;
            }
            _ => {}
        }
        current = p.parent();
    }
    if parts.is_empty() {
        return None;
    }
    parts.reverse();
    Some(parts.join("."))
}

fn handle_named_module(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "long_identifier") {
        Some(n) => n,
        None => return,
    };
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

/// Handle nested signature modules (`module Foo = ...`) emitted by the
/// cargo 0.3.0 grammar as `module_defn`. Emits a `module` definition with
/// the dotted parent path (e.g. `Outer.Foo`) and lets the DFS walker
/// continue into child `val` declarations, which pick up the same path via
/// `enclosing_module_name`.
fn handle_module_defn(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };
    let raw = node_text(&name_node, source).to_string();
    // `enclosing_module_name` walks `node.parent()` upward, so calling it on
    // the `module_defn` itself yields the dotted prefix of its enclosing
    // module(s) without including this module's own name.
    let qualified = match enclosing_module_name(node, source) {
        Some(prefix) if !prefix.is_empty() => format!("{}.{}", prefix, raw),
        _ => raw,
    };
    symbols.definitions.push(Definition {
        name: qualified,
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // function_declaration_left: first child is the function name identifier,
    // followed by argument_patterns.
    let name_node = match find_child(node, "identifier") {
        Some(n) => n,
        None => return,
    };
    let raw_name = node_text(&name_node, source).to_string();
    let line = start_line(node);

    // Avoid duplicates — the DFS walk also visits the inner curried
    // `function_declaration_left` of multi-parameter functions
    // (e.g. `let add x y = …`), which would otherwise push the same
    // `(name, line)` definition twice. Mirrors the JS extractor's guard,
    // which compares against the raw (unqualified) identifier text.
    if symbols
        .definitions
        .iter()
        .any(|d| d.name == raw_name && d.line == line)
    {
        return;
    }

    let module_name = enclosing_module_name(node, source);
    let qualified = match module_name {
        Some(m) => format!("{}.{}", m, raw_name),
        None => raw_name,
    };

    let params = extract_fsharp_params(node, source);

    // JS extractor uses the parent's endLine (the function_or_value_defn) for
    // a tighter bound; do the same to preserve parity.
    let end = node.parent().unwrap_or(*node);

    symbols.definitions.push(Definition {
        name: qualified,
        kind: "function".to_string(),
        line,
        end_line: Some(end_line(&end)),
        decorators: None,
        complexity: compute_all_metrics(&end, source, "fsharp"),
        cfg: build_function_cfg(&end, "fsharp", source),
        children: opt_children(params),
    });
}

fn extract_fsharp_params(decl_left: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(arg_patterns) = find_child(decl_left, "argument_patterns") {
        collect_param_identifiers(&arg_patterns, source, &mut params);
    }
    params
}

fn collect_param_identifiers(node: &Node, source: &[u8], params: &mut Vec<Definition>) {
    if node.kind() == "identifier" {
        params.push(child_def(
            node_text(node, source).to_string(),
            "parameter",
            start_line(node),
        ));
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_param_identifiers(&child, source, params);
        }
    }
}

fn handle_type_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // type_definition contains union_type_defn, record_type_defn, etc.
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        let kind = child.kind();
        if !matches!(
            kind,
            "union_type_defn"
                | "record_type_defn"
                | "type_abbreviation_defn"
                | "class_type_defn"
                | "interface_type_defn"
                | "type_defn"
        ) {
            continue;
        }

        let name = match find_child(&child, "type_name") {
            Some(type_name) => find_child(&type_name, "identifier")
                .map(|n| node_text(&n, source).to_string())
                .unwrap_or_else(|| node_text(&type_name, source).to_string()),
            None => match find_child(&child, "identifier") {
                Some(id) => node_text(&id, source).to_string(),
                None => continue,
            },
        };

        let mut children: Vec<Definition> = Vec::new();
        extract_type_members(&child, source, &mut children);

        symbols.definitions.push(Definition {
            name,
            kind: determine_type_kind(kind).to_string(),
            line: start_line(&child),
            end_line: Some(end_line(&child)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
        });
    }
}

fn determine_type_kind(node_kind: &str) -> &'static str {
    match node_kind {
        "union_type_defn" => "enum",
        "record_type_defn" => "record",
        "class_type_defn" => "class",
        "interface_type_defn" => "interface",
        _ => "type",
    }
}

fn extract_type_members(type_defn: &Node, source: &[u8], children: &mut Vec<Definition>) {
    for i in 0..type_defn.child_count() {
        let child = match type_defn.child(i) {
            Some(c) => c,
            None => continue,
        };

        match child.kind() {
            "union_type_case" => {
                if let Some(name) = find_child(&child, "identifier") {
                    children.push(child_def(
                        node_text(&name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
            "record_field" => {
                let name_node = child
                    .child_by_field_name("name")
                    .or_else(|| find_child(&child, "identifier"));
                if let Some(name) = name_node {
                    children.push(child_def(
                        node_text(&name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
            // Recurse into container nodes that hold cases/fields.
            "union_type_cases" | "record_fields" => {
                extract_type_members(&child, source, children);
            }
            _ => {}
        }
    }
}

fn handle_import_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let module_node = match find_child(node, "long_identifier") {
        Some(n) => n,
        None => return,
    };

    let source_name = node_text(&module_node, source).to_string();
    let last = source_name
        .split('.')
        .last()
        .unwrap_or(&source_name)
        .to_string();

    symbols
        .imports
        .push(Import::new(source_name, vec![last], start_line(node)));
}

fn handle_application(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = match node.child(0) {
        Some(n) => n,
        None => return,
    };

    // Mirrors the JS extractor's `handleApplication`: the full dotted name
    // (e.g. `Service.createUser`) is stored in `name`. Splitting `name` into
    // `(receiver, method)` would diverge from the JS engine's output and
    // change which resolution rules fire downstream.
    match func_node.kind() {
        "identifier" | "long_identifier" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "long_identifier_or_op" => {
            // Inner child is either `identifier` (bare, e.g. `validateUser`) or
            // `long_identifier` (qualified, e.g. `Repository.save`). Order
            // matches the JS extractor (`identifier` first). Operator forms
            // like `( + )` have neither child; we emit nothing in that case,
            // mirroring the JS extractor's silent skip.
            if let Some(inner) =
                find_first_child_of_types(&func_node, &["identifier", "long_identifier"])
            {
                symbols.calls.push(Call {
                    name: node_text(&inner, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
        _ => {}
    }
}

fn handle_dot_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Mirrors the JS extractor's `handleDotExpression`: collect identifier
    // segments and emit `name = last`, `receiver = everything-before`.
    let mut parts: Vec<String> = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "identifier" | "long_identifier" => {
                    parts.push(node_text(&child, source).to_string());
                }
                _ => {}
            }
        }
    }
    if parts.len() >= 2 {
        let method = parts.last().cloned().unwrap_or_default();
        let receiver = parts[..parts.len() - 1].join(".");
        symbols.calls.push(Call {
            name: method,
            line: start_line(node),
            dynamic: None,
            receiver: Some(receiver),
        });
    }
}

/// Handle `val name : type` declarations in `.fsi` signature files.
///
/// The signature grammar reuses the `value_definition` node kind for `val`
/// declarations, distinguished from the source grammar's `let` bindings by
/// the first child being the literal `val` keyword. Source-file
/// `value_definition` nodes (which start with `let`) are intentionally
/// ignored here to preserve `.fs` extractor parity.
fn handle_value_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let first = match node.child(0) {
        Some(c) => c,
        None => return,
    };
    if first.kind() != "val" {
        return;
    }

    let decl_left = match find_child(node, "value_declaration_left") {
        Some(n) => n,
        None => return,
    };
    let name = match extract_value_name(&decl_left, source) {
        Some(n) => n,
        None => return,
    };

    let kind = if has_function_type(node) { "function" } else { "variable" };
    let module_name = enclosing_module_name(node, source);
    let qualified = match module_name {
        Some(m) => format!("{}.{}", m, name),
        None => name,
    };

    symbols.definitions.push(Definition {
        name: qualified,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn extract_value_name(decl_left: &Node, source: &[u8]) -> Option<String> {
    let pattern = find_child(decl_left, "identifier_pattern")?;
    let ident = find_child(&pattern, "long_identifier_or_op")
        .and_then(|n| find_child(&n, "identifier"))
        .or_else(|| find_child(&pattern, "identifier"))?;
    Some(node_text(&ident, source).to_string())
}

fn has_function_type(node: &Node) -> bool {
    // The grammar wraps every type signature in `curried_spec`. A function type
    // (e.g. `val add : int -> int -> int`) contains one or more `arguments_spec`
    // children; a plain value (e.g. `val pi : float`) wraps a single `simple_type`.
    let Some(curried) = find_child(node, "curried_spec") else { return false };
    for i in 0..curried.child_count() {
        if let Some(child) = curried.child(i) {
            if child.kind() == "arguments_spec" {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extractors::SymbolExtractor;
    use tree_sitter::Parser;

    fn parse_source(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_fsharp::LANGUAGE_FSHARP.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        FSharpExtractor.extract(&tree, code.as_bytes(), "test.fs")
    }

    fn parse_signature(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_fsharp::LANGUAGE_SIGNATURE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        FSharpExtractor.extract(&tree, code.as_bytes(), "test.fsi")
    }

    #[test]
    fn signature_extracts_val_declarations() {
        let s = parse_signature("namespace MyApp.Domain\n\nval add : int -> int -> int\nval pi : float\n");
        let add = s
            .definitions
            .iter()
            .find(|d| d.name == "add")
            .expect("val add should be extracted");
        assert_eq!(add.kind, "function");
        let pi = s
            .definitions
            .iter()
            .find(|d| d.name == "pi")
            .expect("val pi should be extracted");
        assert_eq!(pi.kind, "variable");
    }

    #[test]
    fn signature_extracts_bare_val_declarations() {
        let s = parse_signature("val negate : int -> int\nval count : int\n");
        assert!(s
            .definitions
            .iter()
            .any(|d| d.name == "negate" && d.kind == "function"));
        assert!(s
            .definitions
            .iter()
            .any(|d| d.name == "count" && d.kind == "variable"));
    }

    #[test]
    fn source_grammar_does_not_extract_let_bindings_as_val() {
        // `let x = 5` is a value_definition in the source grammar but its
        // first child is `let`, not `val`. Our handler must not extract it
        // (preserves prior `.fs` extraction parity — only function_declaration_left
        // produces definitions in source files).
        let s = parse_source("module M\n\nlet x = 5\n");
        assert!(
            s.definitions.iter().all(|d| d.name != "x"),
            "let bindings in .fs files must not be extracted as val definitions"
        );
    }

    #[test]
    fn signature_qualifies_val_inside_nested_module_defn() {
        // The cargo 0.3.0 signature grammar wraps `module Foo = ...` as a
        // `module_defn` node (the WASM 0.1.0 grammar emits ERROR for this
        // construct — tracked under #1161). The `val` declarations inside
        // must be qualified with the module path.
        let s = parse_signature("namespace X\n\nmodule Foo =\n  val add : int -> int\n");
        assert!(
            s.definitions.iter().any(|d| d.name == "Foo.add" && d.kind == "function"),
            "val add nested under `module Foo =` must be indexed as `Foo.add`, got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>(),
        );
        assert!(
            s.definitions.iter().any(|d| d.name == "Foo" && d.kind == "module"),
            "module Foo must be indexed as a module definition"
        );
    }

    #[test]
    fn source_grammar_does_not_extract_val_mutable_class_fields() {
        // `val mutable count: int = 0` inside a class is parsed as a `member_defn`
        // node in the source grammar — NOT a `value_definition` — so our
        // `value_definition`/`val`-first-child handler does not see it.
        // This regression guard makes that empirical fact explicit.
        let s = parse_source(
            "module M\n\ntype C() =\n    val mutable count: int = 0\n",
        );
        assert!(
            s.definitions.iter().all(|d| d.name != "count"),
            "val mutable class fields must not be extracted by the signature value_definition handler"
        );
    }
}
