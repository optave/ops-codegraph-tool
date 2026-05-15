use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

/// R symbol extractor — ports `src/extractors/r.ts` from the JS engine.
///
/// tree-sitter-r grammar (r-lib/tree-sitter-r) notes:
/// - Assignments: `binary_operator` with `<-`, `=`, or `<<-` operator
/// - Functions: `function_definition` as RHS of assignment
/// - Calls: `call` node with `function`/`arguments` fields
/// - Imports: `library()` / `require()` (packages) and `source()` (files)
/// - S4 classes: `setClass()`, `setRefClass()`, `setGeneric()`, `setMethod()`
pub struct RExtractor;

impl SymbolExtractor for RExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_r_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &R_AST_CONFIG);
        symbols
    }
}

fn match_r_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "binary_operator" => handle_binary_op(node, source, symbols),
        "call" => handle_call(node, source, symbols),
        _ => {}
    }
}

fn handle_binary_op(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // binary_operator children: lhs, operator, rhs
    // We use field accessors for robustness; the grammar exposes
    // `lhs`/`operator`/`rhs` fields explicitly.
    let lhs = match node.child_by_field_name("lhs").or_else(|| node.child(0)) {
        Some(n) => n,
        None => return,
    };
    let op = match node.child_by_field_name("operator").or_else(|| node.child(1)) {
        Some(n) => n,
        None => return,
    };
    let rhs = match node.child_by_field_name("rhs").or_else(|| node.child(2)) {
        Some(n) => n,
        None => return,
    };

    let op_text = node_text(&op, source);
    if op_text != "<-" && op_text != "=" && op_text != "<<-" {
        return;
    }
    if lhs.kind() != "identifier" {
        return;
    }

    let name = node_text(&lhs, source).to_string();

    if rhs.kind() == "function_definition" {
        let params = extract_r_params(&rhs, source);
        symbols.definitions.push(Definition {
            name,
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(&rhs, source, "r"),
            cfg: build_function_cfg(&rhs, "r", source),
            children: opt_children(params),
        });
    } else if is_program_level(node) {
        // Only record top-level variable assignments (matches JS extractor).
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
}

fn is_program_level(node: &Node) -> bool {
    node.parent().map(|p| p.kind() == "program").unwrap_or(false)
}

fn extract_r_params(func_def: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = match func_def.child_by_field_name("parameters") {
        Some(n) => n,
        None => return params,
    };

    for i in 0..params_node.child_count() {
        let Some(child) = params_node.child(i) else { continue };
        match child.kind() {
            "parameter" => {
                // parameter has `name` field, e.g. `x` or `y = 10`.
                // Falls back to first identifier child (or `dots` for `...`).
                if let Some(name_node) = child.child_by_field_name("name") {
                    params.push(child_def(
                        node_text(&name_node, source).to_string(),
                        "parameter",
                        start_line(&child),
                    ));
                } else if let Some(dots) = find_child(&child, "dots") {
                    params.push(child_def(
                        node_text(&dots, source).to_string(),
                        "parameter",
                        start_line(&child),
                    ));
                } else if let Some(ident) = find_child(&child, "identifier") {
                    params.push(child_def(
                        node_text(&ident, source).to_string(),
                        "parameter",
                        start_line(&child),
                    ));
                }
            }
            "identifier" => {
                // Some grammar variants expose bare identifiers at the parameters level.
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

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // call: function field is the callee (identifier or namespace_operator),
    // arguments field is the arguments list.
    let func_node = match node.child_by_field_name("function").or_else(|| node.child(0)) {
        Some(n) => n,
        None => return,
    };

    let func_text = node_text(&func_node, source);

    // Special-case keyword-like callees first; they short-circuit and do NOT
    // produce a generic call edge (matches JS extractor).
    if func_node.kind() == "identifier" {
        match func_text {
            "library" | "require" => {
                handle_library_call(node, source, symbols);
                return;
            }
            "source" => {
                handle_source_call(node, source, symbols);
                return;
            }
            "setClass" | "setRefClass" => {
                handle_set_class(node, source, symbols);
                return;
            }
            "setGeneric" => {
                handle_set_generic(node, source, symbols);
                return;
            }
            "setMethod" => {
                handle_set_method(node, source, symbols);
                return;
            }
            _ => {}
        }
    }

    match func_node.kind() {
        "identifier" => {
            symbols.calls.push(Call {
                name: func_text.to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "namespace_operator" => {
            // `pkg::func` — receiver is the package; name is the function.
            let parts: Vec<&str> = func_text.split("::").collect();
            if parts.len() >= 2 {
                let name = parts[parts.len() - 1].to_string();
                let receiver = parts[..parts.len() - 1].join("::");
                symbols.calls.push(Call {
                    name,
                    line: start_line(node),
                    dynamic: None,
                    receiver: Some(receiver),
                });
            }
        }
        _ => {}
    }
}

/// Extract the first argument value from a call's `arguments` node.
///
/// Returns the inner string literal text (quotes stripped) or the bare
/// identifier text — whichever appears first. Used for `library(pkg)`,
/// `source("file.R")`, `setClass("Foo", ...)`, etc.
///
/// For named arguments like `library(package = dplyr)`, the tree-sitter-r
/// grammar exposes a `value` field on the `argument` node — we prefer that
/// over a positional child scan so we extract `dplyr`, not `package`.
fn first_argument_value(node: &Node, source: &[u8], accept_identifier: bool) -> Option<String> {
    let args = node.child_by_field_name("arguments").or_else(|| find_child(node, "arguments"))?;
    for i in 0..args.child_count() {
        let Some(arg) = args.child(i) else { continue };
        match arg.kind() {
            "argument" => {
                // Prefer the field-named `value` child when present — this
                // correctly handles `library(package = dplyr)` by returning
                // `dplyr` (the value), not `package` (the parameter name).
                if let Some(value) = arg.child_by_field_name("value") {
                    if value.kind() == "string" {
                        return Some(strip_string_quotes(&value, source));
                    }
                    if accept_identifier && value.kind() == "identifier" {
                        return Some(node_text(&value, source).to_string());
                    }
                }
                // Fallback: scan children but skip anything before the `=`
                // operator. The grammar exposes the parameter name via the
                // `name` field, so we use that to know which children are
                // before/after the `=`.
                let name_node = arg.child_by_field_name("name");
                for j in 0..arg.child_count() {
                    let Some(inner) = arg.child(j) else { continue };
                    // Skip the parameter-name identifier itself for named args.
                    if let Some(ref n) = name_node {
                        if inner.id() == n.id() {
                            continue;
                        }
                    }
                    if inner.kind() == "string" {
                        return Some(strip_string_quotes(&inner, source));
                    }
                    if accept_identifier && inner.kind() == "identifier" {
                        return Some(node_text(&inner, source).to_string());
                    }
                }
            }
            "string" => {
                return Some(strip_string_quotes(&arg, source));
            }
            "identifier" if accept_identifier => {
                return Some(node_text(&arg, source).to_string());
            }
            _ => {}
        }
    }
    None
}

/// Strip surrounding `'` or `"` quotes from a `string` node's text.
fn strip_string_quotes(node: &Node, source: &[u8]) -> String {
    // Prefer `string_content` child when available (avoids any escape quirks).
    if let Some(content) = find_child(node, "string_content") {
        return node_text(&content, source).to_string();
    }
    // Fallback: strip exactly one matching quote from each end. We can't use
    // `trim_matches` because it strips *all* matching characters greedily —
    // e.g. for the literal `"'"` (a string containing a single quote) the
    // text is `"`, `'`, `"`, and `trim_matches` would consume all three,
    // returning an empty string. Index-based strip removes only the outer
    // pair, leaving the inner character intact.
    let text = node_text(node, source);
    let bytes = text.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'\'' || first == b'"') && first == last {
            return text[1..bytes.len() - 1].to_string();
        }
    }
    text.to_string()
}

fn handle_library_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(pkg) = first_argument_value(node, source, true) {
        symbols.imports.push(Import::new(
            pkg.clone(),
            vec![pkg],
            start_line(node),
        ));
    }
}

fn handle_source_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // source() only accepts string literals — `source(varname)` is not an import.
    if let Some(path) = first_argument_value(node, source, false) {
        symbols.imports.push(Import::new(
            path,
            vec!["source".to_string()],
            start_line(node),
        ));
    }
}

fn handle_set_class(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name) = first_argument_value(node, source, false) {
        symbols.definitions.push(Definition {
            name,
            kind: "class".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_set_generic(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name) = first_argument_value(node, source, false) {
        symbols.definitions.push(Definition {
            name,
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

// `setMethod("greet", "Person", function(x) ...)` registers an implementation
// of the generic `greet` — it is not a new top-level definition. Emitting a
// definition here produced two `function` nodes with the same name (one from
// setGeneric, one from setMethod) and broke resolution. Emit a call edge to
// the generic instead; the method body's calls are still picked up by the
// recursive walk of the anonymous function argument.
fn handle_set_method(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name) = first_argument_value(node, source, false) {
        symbols.calls.push(Call {
            name,
            line: start_line(node),
            dynamic: None,
            receiver: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_r(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_r::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        RExtractor.extract(&tree, code.as_bytes(), "test.R")
    }

    #[test]
    fn finds_function_assignment() {
        let s = parse_r("greet <- function(name) { print(name) }\n");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "greet");
        assert_eq!(s.definitions[0].kind, "function");
        let children = s.definitions[0].children.as_ref().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "parameter");
    }

    #[test]
    fn finds_function_with_default_and_dots() {
        let s = parse_r("f <- function(x, y = 10, ...) { x }\n");
        let f = s.definitions.iter().find(|d| d.name == "f").unwrap();
        let children = f.children.as_ref().unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"x"));
        assert!(names.contains(&"y"));
        assert!(names.contains(&"..."));
    }

    #[test]
    fn finds_top_level_variable() {
        let s = parse_r("user_store <- list()\n");
        let v = s.definitions.iter().find(|d| d.name == "user_store").unwrap();
        assert_eq!(v.kind, "variable");
    }

    #[test]
    fn skips_nested_variable_assignment() {
        // Inner `user <- ...` is inside the function body — should not be recorded
        // as a top-level definition (it's a local binding).
        let s = parse_r("f <- function() { user <- list(); user }\n");
        let defs: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(defs.contains(&"f"));
        assert!(!defs.contains(&"user"));
    }

    #[test]
    fn extracts_source_imports() {
        let s = parse_r("source(\"service.R\")\nsource('utils.R')\n");
        assert_eq!(s.imports.len(), 2);
        assert_eq!(s.imports[0].source, "service.R");
        assert_eq!(s.imports[0].names, vec!["source".to_string()]);
        assert_eq!(s.imports[1].source, "utils.R");
    }

    #[test]
    fn extracts_library_and_require_imports() {
        let s = parse_r("library(dplyr)\nrequire(\"ggplot2\")\n");
        assert_eq!(s.imports.len(), 2);
        assert_eq!(s.imports[0].source, "dplyr");
        assert_eq!(s.imports[1].source, "ggplot2");
    }

    #[test]
    fn extracts_calls() {
        let s = parse_r("f <- function() { print(1); validate(x) }\n");
        let names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"print"));
        assert!(names.contains(&"validate"));
    }

    #[test]
    fn source_call_is_import_not_call() {
        let s = parse_r("source(\"service.R\")\n");
        assert!(s.calls.iter().all(|c| c.name != "source"),
            "source() should be classified as import, not as a generic call");
    }

    #[test]
    fn namespace_call_splits_receiver() {
        let s = parse_r("f <- function() { dplyr::filter(df) }\n");
        let c = s.calls.iter().find(|c| c.name == "filter").unwrap();
        assert_eq!(c.receiver, Some("dplyr".to_string()));
    }

    #[test]
    fn set_class_creates_class_definition() {
        let s = parse_r("setClass(\"Person\", representation(name = \"character\"))\n");
        let d = s.definitions.iter().find(|d| d.name == "Person").unwrap();
        assert_eq!(d.kind, "class");
    }

    #[test]
    fn set_generic_creates_function_definition() {
        let s = parse_r("setGeneric(\"doIt\", function(x) standardGeneric(\"doIt\"))\n");
        let d = s.definitions.iter().find(|d| d.name == "doIt").unwrap();
        assert_eq!(d.kind, "function");
    }

    #[test]
    fn set_method_does_not_duplicate_generic_definition() {
        // Idiomatic S4: a setGeneric followed by setMethod implementations.
        // Only the setGeneric should emit a definition — setMethod registers
        // an implementation of the generic, which we model as a call edge.
        let code = r#"
setGeneric("greet", function(x) standardGeneric("greet"))
setMethod("greet", "Person", function(x) paste("Hello", x@name))
setMethod("greet", "Animal", function(x) paste("Hi", x@species))
"#;
        let s = parse_r(code);
        let greet_defs: Vec<&Definition> =
            s.definitions.iter().filter(|d| d.name == "greet").collect();
        assert_eq!(
            greet_defs.len(),
            1,
            "expected exactly one `greet` definition, got {greet_defs:#?}",
        );
        assert_eq!(greet_defs[0].kind, "function");
    }

    #[test]
    fn set_method_emits_call_to_generic() {
        // setMethod registers an implementation of the generic. The fix emits
        // a call edge to the generic so the dispatch relationship is visible
        // in the graph.
        let s = parse_r(
            "setMethod(\"greet\", \"Person\", function(x) paste(\"Hello\", x@name))\n",
        );
        let calls: Vec<&Call> = s.calls.iter().filter(|c| c.name == "greet").collect();
        assert_eq!(calls.len(), 1, "expected setMethod to emit one call to `greet`");
    }

    #[test]
    fn set_method_body_calls_are_still_captured() {
        // The recursive walk visits the anonymous function passed to
        // setMethod, so calls inside the method body must still appear.
        let s = parse_r(
            "setMethod(\"greet\", \"Person\", function(x) { helper(x); validate(x) })\n",
        );
        let names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"helper"), "method body call `helper` not captured");
        assert!(names.contains(&"validate"), "method body call `validate` not captured");
    }

    #[test]
    fn function_with_double_arrow_assignment() {
        // `<<-` is super-assignment in R; the JS extractor accepts it too.
        let s = parse_r("g <<- function() { 1 }\n");
        let g = s.definitions.iter().find(|d| d.name == "g").unwrap();
        assert_eq!(g.kind, "function");
    }

    #[test]
    fn library_named_argument_extracts_value_not_name() {
        // `library(package = dplyr)` uses a named argument — the import
        // source must be `dplyr` (the value), not `package` (the name).
        let s = parse_r("library(package = dplyr)\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "dplyr");
        assert_eq!(s.imports[0].names, vec!["dplyr".to_string()]);
    }

    #[test]
    fn library_named_argument_with_string_value() {
        // Same pattern but with a string literal as the value.
        let s = parse_r("library(package = \"dplyr\")\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "dplyr");
    }

    #[test]
    fn source_call_with_mixed_quote_content_preserves_inner_quote() {
        // Edge case for the strip_string_quotes fallback: if a grammar
        // version drops the `string_content` child, the fallback must strip
        // only the outer pair of quotes. `trim_matches` would greedily eat
        // both the outer `"` and the inner `'`, returning an empty path.
        // Index-based strip leaves the inner `'` intact.
        //
        // We exercise the fallback indirectly via `source("a'b.R")` —
        // current grammars expose `string_content`, so this primarily
        // guards against future regressions in the fallback path.
        let s = parse_r("source(\"a'b.R\")\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "a'b.R");
    }

    #[test]
    fn nested_function_assignment_is_recorded() {
        // Matches the JS extractor's documented behavior: function
        // definitions are emitted regardless of nesting depth (only
        // variable assignments are filtered by `is_program_level`).
        // This test pins the behavior so future changes are intentional.
        let s = parse_r("outer <- function() { inner <- function() { 1 }; inner() }\n");
        let defs: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(defs.contains(&"outer"));
        assert!(defs.contains(&"inner"));
    }
}
