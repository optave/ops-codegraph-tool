use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::constants::MAX_WALK_DEPTH;
use crate::types::*;
use tree_sitter::{Node, Tree};

/// Extract symbols from Clojure files.
///
/// Clojure tree-sitter grammar (orchard fork of sogaiu/tree-sitter-clojure) notes:
/// - The grammar is minimal: everything is a list/vector/map/symbol
/// - Definitions are detected by the first symbol in a `list_lit`: defn, def,
///   defprotocol, etc.
/// - Namespace: `(ns name ...)` — establishes a module
/// - Imports: `(:require ...)` inside `ns`, or top-level `(require ...)` / `(use ...)` / `(import ...)`
///
/// Mirrors `extractClojureSymbols` in `src/extractors/clojure.ts` — the JS engine
/// is the source of truth for behavior parity.
pub struct ClojureExtractor;

impl SymbolExtractor for ClojureExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_clojure(&tree.root_node(), source, &mut symbols, None, 0);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &CLOJURE_AST_CONFIG,
        );
        symbols
    }
}

/// Walk the tree, dispatching on `list_lit` forms and threading the current
/// namespace through children (matches the `currentNs` parameter in the JS
/// `walkClojureNode`). Note: the JS implementation only propagates `nextNs`
/// to *children* of the form that established it — siblings in the source root
/// do not inherit it. This Rust port preserves that behavior so top-level
/// `defn` forms produce unqualified names (matching the fixture's
/// `expected-edges.json`).
fn walk_clojure(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_ns: Option<&str>,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }

    let mut next_ns_owned: Option<String> = None;
    let next_ns: Option<&str> = if node.kind() == "list_lit" {
        match handle_list_form(node, source, symbols, current_ns) {
            Some(ns) => {
                next_ns_owned = Some(ns);
                next_ns_owned.as_deref()
            }
            None => current_ns,
        }
    } else {
        current_ns
    };

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_clojure(&child, source, symbols, next_ns, depth + 1);
        }
    }
}

/// Dispatch on the first symbol in a list form. Returns `Some(ns_name)` if
/// this form is an `ns` declaration so the namespace can be threaded into
/// its children.
fn handle_list_form(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_ns: Option<&str>,
) -> Option<String> {
    let first_sym = find_first_symbol(node)?;
    let name = node_text(&first_sym, source);

    match name {
        "ns" => return handle_ns_form(node, source, symbols),
        "def" | "defonce" => {
            handle_def_form(node, source, symbols, current_ns, "variable");
        }
        "defn" => handle_defn_form(node, source, symbols, current_ns),
        "defn-" => handle_defn_form(node, source, symbols, current_ns),
        "defmacro" => handle_defn_form(node, source, symbols, current_ns),
        "defprotocol" => handle_defprotocol(node, source, symbols),
        "defrecord" => handle_defrecord(node, source, symbols, "record"),
        "deftype" => handle_defrecord(node, source, symbols, "type"),
        "defmulti" => {
            handle_def_form(node, source, symbols, current_ns, "function");
        }
        "defmethod" => handle_defn_form(node, source, symbols, current_ns),
        "require" | "use" | "import" => {
            handle_import_form(node, source, symbols, name);
        }
        _ => {
            // Regular function call — only push if not a keyword (`:foo`) or
            // accidental delimiter capture (`(`).
            if !name.starts_with(':') && !name.starts_with('(') {
                symbols.calls.push(Call {
                    name: name.to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
    }

    None
}

/// Find the first `sym_lit` or `kwd_lit` child, skipping delimiters and metadata.
/// Mirrors `findFirstSymbol` in the JS extractor.
///
/// A missing child at index `i < child_count()` is treated as "skip and continue"
/// to match the JS counterpart (`if (!child) continue;`), rather than aborting
/// the search via `?`.
fn find_first_symbol<'a>(list_node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..list_node.child_count() {
        let child = match list_node.child(i) {
            Some(c) => c,
            None => continue,
        };
        if is_delimiter_or_meta(child.kind()) {
            continue;
        }
        if child.kind() == "sym_lit" || child.kind() == "kwd_lit" {
            return Some(child);
        }
        break;
    }
    None
}

/// Find the second `sym_lit` or `kwd_lit` child. Used to extract the bound
/// name from forms like `(defn foo [...] ...)`.
///
/// Like `find_first_symbol`, a missing child is skipped (not propagated via `?`)
/// to preserve parity with the JS extractor.
fn find_second_symbol<'a>(list_node: &Node<'a>) -> Option<Node<'a>> {
    let mut count = 0;
    for i in 0..list_node.child_count() {
        let child = match list_node.child(i) {
            Some(c) => c,
            None => continue,
        };
        if is_delimiter_or_meta(child.kind()) {
            continue;
        }
        if child.kind() == "sym_lit" || child.kind() == "kwd_lit" {
            count += 1;
            if count == 2 {
                return Some(child);
            }
        }
    }
    None
}

/// `true` for delimiter tokens (`(`, `)`, `[`, `]`, `{`, `}`, `#`) and the
/// `meta_lit` node kind, matching the JS check `'()[]{}#'.includes(child.type)`.
fn is_delimiter_or_meta(kind: &str) -> bool {
    matches!(kind, "(" | ")" | "[" | "]" | "{" | "}" | "#" | "meta_lit")
}

fn handle_ns_form(node: &Node, source: &[u8], symbols: &mut FileSymbols) -> Option<String> {
    let name_node = find_second_symbol(node)?;
    let ns_name = node_text(&name_node, source).to_string();

    symbols.definitions.push(Definition {
        name: ns_name.clone(),
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });

    // Scan for nested `(:require ...)`, `(:import ...)`, `(:use ...)` forms.
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) if c.kind() == "list_lit" => c,
            _ => continue,
        };
        let kw = match find_first_symbol(&child) {
            Some(k) => k,
            None => continue,
        };
        let kw_text = node_text(&kw, source);
        if kw_text == ":require" || kw_text == ":import" || kw_text == ":use" {
            extract_ns_requires(&child, source, symbols);
        }
    }

    Some(ns_name)
}

fn extract_ns_requires(require_form: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..require_form.child_count() {
        let child = match require_form.child(i) {
            Some(c) => c,
            None => continue,
        };

        // Vector form: `[some.ns :as alias]`
        if child.kind() == "vec_lit" {
            if let Some(sym) = find_first_symbol(&child) {
                let text = node_text(&sym, source);
                let last = text.rsplit('.').next().unwrap_or(text).to_string();
                symbols
                    .imports
                    .push(Import::new(text.to_string(), vec![last], start_line(&child)));
            }
        }

        // Bare-symbol form: `some.ns` (only after the leading `:require` keyword,
        // so guard against picking up the `:require` itself).
        if child.kind() == "sym_lit" && i > 0 {
            let text = node_text(&child, source);
            if !text.starts_with(':') {
                let last = text.rsplit('.').next().unwrap_or(text).to_string();
                symbols
                    .imports
                    .push(Import::new(text.to_string(), vec![last], start_line(&child)));
            }
        }
    }
}

fn handle_def_form(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_ns: Option<&str>,
    kind: &str,
) {
    let name_node = match find_second_symbol(node) {
        Some(n) => n,
        None => return,
    };
    let raw_name = node_text(&name_node, source);
    let full_name = match current_ns {
        Some(ns) => format!("{}/{}", ns, raw_name),
        None => raw_name.to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_defn_form(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_ns: Option<&str>,
) {
    let name_node = match find_second_symbol(node) {
        Some(n) => n,
        None => return,
    };
    let raw_name = node_text(&name_node, source);
    let full_name = match current_ns {
        Some(ns) => format!("{}/{}", ns, raw_name),
        None => raw_name.to_string(),
    };

    let params = extract_clojure_params(node, source);

    // Note: visibility (defn vs defn-) would distinguish public/private,
    // but the `Definition` struct does not yet expose a visibility field.
    // When it does, wire `keyword == "defn-"` → private.
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "clojure"),
        cfg: build_function_cfg(node, "clojure", source),
        children: opt_children(params),
    });
}

fn extract_clojure_params(defn_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    // First `vec_lit` child is the parameter vector `[x y z]`.
    //
    // Known limitation (parity with JS extractor): for `defmethod` forms like
    // `(defmethod foo [:a :b] [x] body)`, the dispatch vector `[:a :b]` is the
    // first `vec_lit` and the actual parameter vector `[x]` is silently
    // skipped because of the `break` below. The dispatch vector contributes
    // no `sym_lit` entries (its elements are `kwd_lit`), so `params` ends up
    // empty rather than wrong. Tracked as a future enhancement once
    // visibility/metadata fields land in `Definition`.
    for i in 0..defn_node.child_count() {
        let child = match defn_node.child(i) {
            Some(c) if c.kind() == "vec_lit" => c,
            _ => continue,
        };
        for j in 0..child.child_count() {
            if let Some(param) = child.child(j) {
                if param.kind() == "sym_lit" {
                    params.push(child_def(
                        node_text(&param, source).to_string(),
                        "parameter",
                        start_line(&param),
                    ));
                }
            }
        }
        break; // Only the first vector is the params
    }
    params
}

fn handle_defprotocol(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match find_second_symbol(node) {
        Some(n) => n,
        None => return,
    };
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

fn handle_defrecord(node: &Node, source: &[u8], symbols: &mut FileSymbols, kind: &str) {
    let name_node = match find_second_symbol(node) {
        Some(n) => n,
        None => return,
    };
    symbols.definitions.push(Definition {
        name: node_text(&name_node, source).to_string(),
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

/// Handle a top-level `(require ...)`, `(use ...)`, or `(import ...)` form.
///
/// Known limitation (parity with JS extractor): in real Clojure code these
/// top-level forms almost always use a quoted symbol (`(require 'some.ns)`
/// → `quoting_lit`) or a quoted vector (`(require '[some.ns :as s])`).
/// `find_second_symbol` only matches `sym_lit` / `kwd_lit`, so those shapes
/// return `None` and the import is silently dropped here. Imports inside
/// `(ns ...)` declarations are still extracted correctly by
/// `extract_ns_requires` — that path is the recommended one and covers
/// real-world Clojure code, while this top-level fallback only handles the
/// degenerate unquoted shape.
fn handle_import_form(node: &Node, source: &[u8], symbols: &mut FileSymbols, keyword: &str) {
    let name_node = match find_second_symbol(node) {
        Some(n) => n,
        None => return,
    };
    symbols.imports.push(Import::new(
        node_text(&name_node, source).to_string(),
        vec![keyword.to_string()],
        start_line(node),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_clj(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_clojure_orchard::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        ClojureExtractor.extract(&tree, code.as_bytes(), "test.clj")
    }

    #[test]
    fn extracts_defn() {
        let s = parse_clj("(defn greet [name] (println name))");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
        let params = greet.children.as_ref().expect("params");
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].name, "name");
        assert_eq!(params[0].kind, "parameter");
    }

    #[test]
    fn extracts_private_defn() {
        let s = parse_clj("(defn- helper [x] x)");
        let helper = s.definitions.iter().find(|d| d.name == "helper").unwrap();
        assert_eq!(helper.kind, "function");
    }

    #[test]
    fn extracts_ns_and_requires() {
        let s = parse_clj(
            "(ns app.main\n  (:require [app.service :as service]\n            [app.repository :as repository]))",
        );
        let ns = s.definitions.iter().find(|d| d.name == "app.main").unwrap();
        assert_eq!(ns.kind, "module");
        assert_eq!(s.imports.len(), 2);
        let sources: Vec<&str> = s.imports.iter().map(|i| i.source.as_str()).collect();
        assert!(sources.contains(&"app.service"));
        assert!(sources.contains(&"app.repository"));
    }

    #[test]
    fn extracts_qualified_call() {
        let s = parse_clj("(defn run [] (service/create-user))");
        assert!(s.calls.iter().any(|c| c.name == "service/create-user"));
    }

    #[test]
    fn extracts_defprotocol_as_interface() {
        let s = parse_clj("(defprotocol Greeter (greet [this]))");
        let proto = s.definitions.iter().find(|d| d.name == "Greeter").unwrap();
        assert_eq!(proto.kind, "interface");
    }

    #[test]
    fn extracts_defrecord_as_record() {
        let s = parse_clj("(defrecord Point [x y])");
        let rec = s.definitions.iter().find(|d| d.name == "Point").unwrap();
        assert_eq!(rec.kind, "record");
    }

    #[test]
    fn extracts_deftype_as_type() {
        let s = parse_clj("(deftype Box [v])");
        let t = s.definitions.iter().find(|d| d.name == "Box").unwrap();
        assert_eq!(t.kind, "type");
    }

    #[test]
    fn extracts_def_as_variable() {
        let s = parse_clj("(def pi 3.14)");
        let pi = s.definitions.iter().find(|d| d.name == "pi").unwrap();
        assert_eq!(pi.kind, "variable");
    }

    #[test]
    fn skips_keyword_first_symbol_as_call() {
        // `:require` is a keyword, not a callable — must not produce a call.
        let s = parse_clj("(:require [x])");
        assert!(!s.calls.iter().any(|c| c.name.starts_with(':')));
    }
}
