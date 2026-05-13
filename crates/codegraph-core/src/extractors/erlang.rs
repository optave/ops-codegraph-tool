use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct ErlangExtractor;

impl SymbolExtractor for ErlangExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_erlang_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &ERLANG_AST_CONFIG);
        symbols
    }
}

fn match_erlang_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "module_attribute" => handle_module_attr(node, source, symbols),
        "record_decl" => handle_record_decl(node, source, symbols),
        "type_alias" | "opaque" => handle_type_alias(node, source, symbols),
        "fun_decl" => handle_fun_decl(node, source, symbols),
        "function_clause" => {
            // Only handle if not inside fun_decl (fun_decl handles its own clauses)
            if node.parent().map(|p| p.kind()) != Some("fun_decl") {
                handle_function_clause(node, source, symbols);
            }
        }
        "pp_define" => handle_define(node, source, symbols),
        "pp_include" | "pp_include_lib" => handle_include(node, source, symbols),
        "import_attribute" => handle_import_attr(node, source, symbols),
        "call" => handle_call(node, source, symbols),
        _ => {}
    }
}

fn handle_module_attr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // module_attribute: - module ( atom ) .
    // Prefer the named `name` field exposed by tree-sitter-erlang so we don't
    // accidentally pick up the `module` keyword if a future grammar exposes it
    // as a named `atom` child.
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "atom"))
    {
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

fn handle_record_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Mirror the defensive pattern used by `handle_module_attr` and
    // `handle_function_clause`: prefer the named field if the grammar exposes
    // it, otherwise fall back to the first `atom` child.
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "atom"))
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
        if child.kind() == "record_field" || child.kind() == "typed_record_field" {
            if let Some(field_name) = find_child(&child, "atom") {
                children.push(child_def(
                    node_text(&field_name, source).to_string(),
                    "property",
                    start_line(&child),
                ));
            }
        }
    }

    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: "record".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
    });
}

fn handle_type_alias(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // type_alias: -type name(...) :: ty.
    // Name is typically wrapped in a `type_name` node containing an `atom`.
    let name_text = find_child(node, "atom")
        .map(|a| node_text(&a, source).to_string())
        .or_else(|| {
            find_child(node, "type_name")
                .and_then(|tn| find_child(&tn, "atom").map(|a| node_text(&a, source).to_string()))
        });
    let name = match name_text {
        Some(n) => n,
        None => return,
    };

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

fn handle_fun_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // fun_decl contains one or more function_clause children + dots.
    // Extract from the first function_clause.
    let clause = match find_child(node, "function_clause") {
        Some(c) => c,
        None => return,
    };
    handle_function_clause(&clause, source, symbols);
}

fn handle_function_clause(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // function_clause: atom expr_args clause_body
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "atom"))
    {
        Some(n) => n,
        None => return,
    };
    let name = node_text(&name_node, source).to_string();

    let params = extract_params(node, source);
    let arity = params.len();

    // Don't duplicate if we already have this function at the same arity.
    // Erlang overloads by arity, so `foo/1` and `foo/2` are distinct definitions.
    if symbols.definitions.iter().any(|d| {
        d.name == name
            && d.kind == "function"
            && d.children.as_ref().map_or(0, |c| c.len()) == arity
    }) {
        return;
    }

    // End line spans the full fun_decl when this clause is wrapped in one
    let end_node = match node.parent() {
        Some(p) if p.kind() == "fun_decl" => p,
        _ => *node,
    };

    symbols.definitions.push(Definition {
        name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(&end_node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(params),
    });
}

fn extract_params(clause_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let args_node = match clause_node
        .child_by_field_name("args")
        .or_else(|| find_child(clause_node, "expr_args"))
    {
        Some(n) => n,
        None => return params,
    };
    // Iterate named children so every argument pattern counts as one parameter,
    // independent of whether it is a bare `var`/`atom` or a complex destructuring
    // pattern (tuple, list, binary, etc.). Punctuation tokens are anonymous and
    // therefore excluded automatically.
    for i in 0..args_node.named_child_count() {
        let child = match args_node.named_child(i) {
            Some(c) => c,
            None => continue,
        };
        let label = if child.kind() == "var" || child.kind() == "atom" {
            node_text(&child, source).to_string()
        } else {
            // Placeholder for complex patterns so arity is preserved.
            format!("_{}", i)
        };
        params.push(child_def(label, "parameter", start_line(&child)));
    }
    params
}

fn handle_define(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // pp_define: -define(NAME, value).  Name may be in `var`, `atom`, or `macro_lhs`.
    let name = if let Some(v) = find_child(node, "var") {
        node_text(&v, source).to_string()
    } else if let Some(a) = find_child(node, "atom") {
        node_text(&a, source).to_string()
    } else if let Some(lhs) = find_child(node, "macro_lhs") {
        find_child(&lhs, "var")
            .map(|v| node_text(&v, source).to_string())
            .unwrap_or_else(|| node_text(&lhs, source).to_string())
    } else {
        return;
    };

    symbols.definitions.push(Definition {
        name,
        kind: "variable".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_include(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let str_node = match find_child(node, "string") {
        Some(n) => n,
        None => return,
    };

    let raw = node_text(&str_node, source);
    let source_path = raw.trim_matches('"').to_string();
    symbols.imports.push(Import::new(
        source_path,
        vec!["include".to_string()],
        start_line(node),
    ));
}

fn handle_import_attr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let module_node = match find_child(node, "atom") {
        Some(n) => n,
        None => return,
    };

    let mut names: Vec<String> = Vec::new();
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        if child.kind() == "fa" {
            if let Some(fn_name) = find_child(&child, "atom") {
                names.push(node_text(&fn_name, source).to_string());
            }
        }
    }

    let module_text = node_text(&module_node, source).to_string();
    if names.is_empty() {
        names.push(module_text.clone());
    }

    symbols.imports.push(Import::new(
        module_text,
        names,
        start_line(node),
    ));
}

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // call: first named child is function ref (atom for plain, may be wrapped in
    // `remote` in newer grammars). Using `named_child(0)` instead of `child(0)`
    // skips anonymous tokens (punctuation, keywords) so a future grammar revision
    // that inserts a leading anonymous node won't silently drop the call. Mirrors
    // the JS extractor's behavior so both engines emit the same set of calls.
    let func_node = match node.named_child(0) {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "atom" | "identifier" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "remote" => {
            // Legacy grammar shape: `call > remote(atom, atom)`. Newer WhatsApp
            // grammars invert this to `remote > call(atom, expr_args)`, in which
            // case the inner `call` is visited as a plain call above.
            let mut atoms: Vec<String> = Vec::new();
            for i in 0..func_node.child_count() {
                if let Some(child) = func_node.child(i) {
                    if child.kind() == "atom" || child.kind() == "var" {
                        atoms.push(node_text(&child, source).to_string());
                    }
                }
            }
            if atoms.len() >= 2 {
                let name = atoms.last().cloned().unwrap_or_default();
                let receiver = atoms[..atoms.len() - 1].join(":");
                symbols.calls.push(Call {
                    name,
                    line: start_line(node),
                    dynamic: None,
                    receiver: Some(receiver),
                });
            } else if atoms.len() == 1 {
                symbols.calls.push(Call {
                    name: atoms.into_iter().next().unwrap_or_default(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_erlang(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_erlang::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        ErlangExtractor.extract(&tree, code.as_bytes(), "test.erl")
    }

    #[test]
    fn extracts_module_declaration() {
        let s = parse_erlang("-module(mymodule).");
        let m = s
            .definitions
            .iter()
            .find(|d| d.name == "mymodule")
            .expect("module def");
        assert_eq!(m.kind, "module");
    }

    #[test]
    fn extracts_function_definition() {
        let s = parse_erlang("greet(Name) ->\n    io:format(\"Hello ~s~n\", [Name]).\n");
        let f = s
            .definitions
            .iter()
            .find(|d| d.kind == "function")
            .expect("function def");
        assert_eq!(f.name, "greet");
    }

    #[test]
    fn extracts_record_definition() {
        let s = parse_erlang("-record(person, {name, age}).\n");
        let r = s
            .definitions
            .iter()
            .find(|d| d.name == "person")
            .expect("record def");
        assert_eq!(r.kind, "record");
        let children = r.children.as_ref().expect("record fields");
        let field_names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(field_names.contains(&"name"));
        assert!(field_names.contains(&"age"));
    }

    #[test]
    fn extracts_import_attribute() {
        let s = parse_erlang("-import(lists, [map/2, filter/2]).\n");
        assert!(!s.imports.is_empty(), "expected at least one import");
        let imp = &s.imports[0];
        assert_eq!(imp.source, "lists");
        assert!(imp.names.contains(&"map".to_string()));
        assert!(imp.names.contains(&"filter".to_string()));
    }

    #[test]
    fn extracts_function_calls() {
        let s = parse_erlang("start() ->\n    io:format(\"Hello~n\").\n");
        assert!(!s.calls.is_empty(), "expected at least one call");
    }

    #[test]
    fn extracts_include_directive() {
        let s = parse_erlang("-include(\"foo.hrl\").\n");
        assert!(s.imports.iter().any(|i| i.source == "foo.hrl"));
    }

    #[test]
    fn deduplicates_multi_clause_function() {
        // Multiple clauses for the same function produce one definition only.
        let s = parse_erlang(
            "fact(0) -> 1;\nfact(N) when N > 0 -> N * fact(N - 1).\n",
        );
        let fact_defs: Vec<&Definition> = s
            .definitions
            .iter()
            .filter(|d| d.name == "fact" && d.kind == "function")
            .collect();
        assert_eq!(fact_defs.len(), 1, "expected single function def for multi-clause");
    }

    #[test]
    fn keeps_distinct_arities_for_same_name() {
        // Erlang overloads by arity: foo/1 and foo/2 are distinct definitions
        // and must not be collapsed by name-only deduplication.
        let s = parse_erlang(
            "foo(X) -> X.\nfoo(X, Y) -> X + Y.\nfoo(X, Y, Z) -> X + Y + Z.\n",
        );
        let foo_defs: Vec<&Definition> = s
            .definitions
            .iter()
            .filter(|d| d.name == "foo" && d.kind == "function")
            .collect();
        assert_eq!(foo_defs.len(), 3, "expected one def per arity");
        let mut arities: Vec<usize> = foo_defs
            .iter()
            .map(|d| d.children.as_ref().map_or(0, |c| c.len()))
            .collect();
        arities.sort();
        assert_eq!(arities, vec![1, 2, 3]);
    }

    #[test]
    fn counts_complex_pattern_arguments_as_parameters() {
        // Tuple, list and binary pattern arguments must still count toward arity.
        let s = parse_erlang(
            "handle({ok, X}, [H | T]) -> {X, H, T}.\n",
        );
        let f = s
            .definitions
            .iter()
            .find(|d| d.name == "handle" && d.kind == "function")
            .expect("function def");
        let params = f.children.as_ref().expect("params");
        assert_eq!(params.len(), 2, "expected one parameter per pattern");
    }
}
