use tree_sitter::{Node, Tree};
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

/// Lua base-library global function names and standard-library module
/// tables. Mirrors `LUA_BUILTIN_GLOBALS` in `src/extractors/lua.ts` — see
/// `handle_lua_assignment_statement` (this file) and that file's
/// `handleLuaAssignmentStatement` for the full rationale (issue #1776).
const LUA_BUILTIN_GLOBALS: &[&str] = &[
    "assert", "collectgarbage", "dofile", "error", "getfenv", "getmetatable",
    "ipairs", "load", "loadfile", "loadstring", "module", "next", "pairs",
    "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require",
    "select", "setfenv", "setmetatable", "tonumber", "tostring", "type",
    "unpack", "xpcall",
    // Standard-library module tables — wholesale replacement (e.g. sandboxing)
    // is the same "escapes local scope" shape as a single builtin function.
    "string", "table", "math", "io", "os", "coroutine", "debug", "utf8", "bit32",
];

pub struct LuaExtractor;

impl SymbolExtractor for LuaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_lua_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &LUA_AST_CONFIG);
        symbols
    }
}

fn match_lua_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" => handle_lua_function_decl(node, source, symbols),
        "function_call" => handle_lua_function_call(node, source, symbols),
        "assignment_statement" => handle_lua_assignment_statement(node, source, symbols),
        _ => {}
    }
}

fn handle_lua_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    let (name, kind) = match name_node.kind() {
        "method_index_expression" => {
            let table = name_node.child_by_field_name("table");
            let method = name_node.child_by_field_name("method");
            match (table, method) {
                (Some(t), Some(m)) => (
                    format!("{}.{}", node_text(&t, source), node_text(&m, source)),
                    "method",
                ),
                _ => (node_text(&name_node, source).to_string(), "function"),
            }
        }
        "dot_index_expression" => {
            let table = name_node.child_by_field_name("table");
            let field = name_node.child_by_field_name("field");
            match (table, field) {
                (Some(t), Some(f)) => (
                    format!("{}.{}", node_text(&t, source), node_text(&f, source)),
                    "method",
                ),
                _ => (node_text(&name_node, source).to_string(), "function"),
            }
        }
        _ => (node_text(&name_node, source).to_string(), "function"),
    };

    let params = extract_lua_params(node, source);

    symbols.definitions.push(Definition {
        name,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "lua"),
        cfg: build_function_cfg(node, "lua", source),
        children: opt_children(params),
        bodyless: None,
    });
}

fn extract_lua_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    if let Some(param_list) = func_node.child_by_field_name("parameters") {
        for i in 0..param_list.child_count() {
            if let Some(child) = param_list.child(i) {
                if child.kind() == "identifier" {
                    params.push(child_def(
                        node_text(&child, source).to_string(),
                        "parameter",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    params
}

/// Detect `<builtin> = <identifier>` assignments — a locally declared
/// function bound to a Lua global/builtin identifier (e.g.
/// `require = traced_require`), the monkey-patch pattern from issue #1776.
/// Mirrors `handleLuaAssignmentStatement` in `src/extractors/lua.ts` — see
/// that function's doc comment for the full rationale.
///
/// Emits a dynamic `value-ref` call for the RHS identifier, restricted to
/// plain `identifier = identifier` pairs where the LHS matches
/// `LUA_BUILTIN_GLOBALS`. `value-ref` is resolved downstream
/// (build_edges.rs) against function/method-kind targets only, so a
/// builtin reassigned to a non-function value is silently dropped rather
/// than fabricating a nonsensical edge.
///
/// Multi-assignment (`a, b = f, g`) is handled positionally: each side is
/// indexed independently by position (not pre-filtered to identifiers
/// first), so mixed variable kinds (`t.b, a = f, g`) do not shift the
/// pairing.
fn handle_lua_assignment_statement(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(variable_list) = find_child(node, "variable_list") else { return };
    let Some(expression_list) = find_child(node, "expression_list") else { return };

    let pair_count = variable_list
        .named_child_count()
        .min(expression_list.named_child_count());

    for i in 0..pair_count {
        let Some(lhs) = variable_list.named_child(i) else { continue };
        let Some(rhs) = expression_list.named_child(i) else { continue };
        if lhs.kind() != "identifier" || rhs.kind() != "identifier" {
            continue;
        }
        let lhs_text = node_text(&lhs, source);
        let rhs_text = node_text(&rhs, source);
        if !LUA_BUILTIN_GLOBALS.contains(&lhs_text) || LUA_BUILTIN_GLOBALS.contains(&rhs_text) {
            continue;
        }
        symbols.calls.push(Call {
            name: rhs_text.to_string(),
            line: start_line(&rhs),
            dynamic: Some(true),
            dynamic_kind: Some("value-ref".to_string()),
            ..Default::default()
        });
    }
}

fn handle_lua_function_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = match node.child_by_field_name("name") {
        Some(n) => n,
        None => return,
    };

    // load(chunk) / loadstring(chunk) / loadfile(...) / dofile — dynamic code
    // execution; always undecidable
    if name_node.kind() == "identifier" {
        let ident = node_text(&name_node, source);
        if matches!(ident, "load" | "loadstring" | "loadfile" | "dofile") {
            symbols.calls.push(Call {
                name: "<dynamic:eval>".to_string(),
                line: start_line(node),
                dynamic: Some(true),
                dynamic_kind: Some("eval".to_string()),
                ..Default::default()
            });
            return;
        }
    }

    // Check for require() as import
    if name_node.kind() == "identifier" && node_text(&name_node, source) == "require" {
        if let Some(args) = node.child_by_field_name("arguments") {
            if let Some(str_arg) = find_child(&args, "string") {
                let raw = node_text(&str_arg, source);
                let source_path = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
                symbols.imports.push(Import::new(
                    source_path,
                    vec!["require".to_string()],
                    start_line(node),
                ));
                return;
            }
        }
    }

    match name_node.kind() {
        "method_index_expression" => {
            let method = name_node.child_by_field_name("method");
            let table = name_node.child_by_field_name("table");
            if let Some(m) = method {
                symbols.calls.push(Call {
                    name: node_text(&m, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: table.map(|t| node_text(&t, source).to_string()),
                    ..Default::default()
                });
            }
        }
        "dot_index_expression" => {
            let field = name_node.child_by_field_name("field");
            let table = name_node.child_by_field_name("table");
            if let Some(f) = field {
                symbols.calls.push(Call {
                    name: node_text(&f, source).to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: table.map(|t| node_text(&t, source).to_string()),
                    ..Default::default()
                });
            }
        }
        "bracket_index_expression" => {
            // t[k]() — bracket-index call; key may be variable.
            let table = name_node.child_by_field_name("table");
            let table_id = table.as_ref().map(|n| n.id());
            let mut key: Option<Node> = None;
            for i in 0..name_node.child_count() {
                let Some(ch) = name_node.child(i) else { continue };
                if matches!(ch.kind(), "[" | "]") { continue; }
                if table_id == Some(ch.id()) { continue; }
                key = Some(ch);
                break;
            }
            if let Some(k) = key {
                if k.kind() == "string" || k.kind() == "string_literal" {
                    let raw = node_text(&k, source);
                    let call_name = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
                    symbols.calls.push(Call {
                        name: call_name,
                        line: start_line(node),
                        receiver: table.map(|t| node_text(&t, source).to_string()),
                        ..Default::default()
                    });
                } else {
                    let key_expr = node_text(&k, source).to_string();
                    symbols.calls.push(Call {
                        name: "<dynamic:computed-key>".to_string(),
                        line: start_line(node),
                        dynamic: Some(true),
                        dynamic_kind: Some("computed-key".to_string()),
                        key_expr: Some(key_expr),
                        receiver: table.map(|t| node_text(&t, source).to_string()),
                        ..Default::default()
                    });
                }
            }
        }
        _ => {
            symbols.calls.push(Call {
                name: node_text(&name_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
                ..Default::default()
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_lua(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_lua::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        LuaExtractor.extract(&tree, code.as_bytes(), "test.lua")
    }

    // ── #1776: builtin/global reassignment value-ref extraction ─────────────

    #[test]
    fn extracts_value_ref_call_for_function_assigned_to_builtin_global() {
        let s = parse_lua(
            "local function traced_require(modname)\n  return modname\nend\nrequire = traced_require",
        );
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "traced_require"));
        assert!(value_refs.iter().all(|c| c.dynamic == Some(true)));
    }

    #[test]
    fn extracts_value_ref_call_for_local_shadow_of_builtin() {
        let s = parse_lua(
            "local function traced_require(modname)\n  return modname\nend\nlocal require = traced_require",
        );
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "traced_require" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_when_lhs_is_not_a_recognized_builtin() {
        let s = parse_lua("local function helper() end\nmyCustomGlobal = helper");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_when_rhs_is_itself_a_builtin() {
        let s = parse_lua("print = tostring");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_local_non_builtin_alias() {
        let s = parse_lua("local function helper() end\nlocal orig_helper = helper");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_when_rhs_is_a_call_expression() {
        let s = parse_lua("require = wrapRequire(require)");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_when_rhs_is_a_member_expression() {
        let s = parse_lua("require = mymodule.customRequire");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn pairs_multi_assignment_positionally() {
        // `t.b` occupies position 0 (a dot_index_expression, not a plain
        // identifier) — pairing must not shift, or `require` (position 1)
        // would incorrectly pair with `helperA` (position 0).
        let s = parse_lua(
            "local function helperA() end\nlocal function helperB() end\nt.b, require = helperA, helperB",
        );
        let value_refs: Vec<&str> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .map(|c| c.name.as_str())
            .collect();
        assert!(value_refs.contains(&"helperB"));
        assert!(!value_refs.contains(&"helperA"));
    }

    #[test]
    fn extracts_value_ref_call_for_stdlib_module_table_reassignment() {
        let s = parse_lua("local function fakeOs() end\nos = fakeOs");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "fakeOs" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    // ── #1909: eval/computed-key dynamic-call detection ──────────────────────

    #[test]
    fn classifies_load_call_as_dynamic_eval() {
        let s = parse_lua("load(chunk)()");
        assert!(s.calls.iter().any(|c| c.name == "<dynamic:eval>"
            && c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("eval")));
    }

    #[test]
    fn classifies_loadstring_call_as_dynamic_eval() {
        let s = parse_lua("loadstring(code)()");
        assert!(s.calls.iter().any(|c| c.name == "<dynamic:eval>"
            && c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("eval")));
    }

    #[test]
    fn classifies_dofile_call_as_dynamic_eval() {
        let s = parse_lua("dofile(\"script.lua\")");
        assert!(s.calls.iter().any(|c| c.name == "<dynamic:eval>"
            && c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("eval")));
    }

    #[test]
    fn classifies_loadfile_call_as_dynamic_eval() {
        let s = parse_lua("loadfile(\"script.lua\")()");
        assert!(s.calls.iter().any(|c| c.name == "<dynamic:eval>"
            && c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("eval")));
    }

    #[test]
    fn resolves_bracket_index_call_with_string_literal_key_directly() {
        let s = parse_lua("t[\"handler\"]()");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "handler" && c.receiver.as_deref() == Some("t") && c.dynamic.is_none()));
    }

    #[test]
    fn resolves_bracket_index_call_with_single_quoted_string_literal_key_directly() {
        let s = parse_lua("t['handler']()");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "handler" && c.receiver.as_deref() == Some("t")));
    }

    #[test]
    fn classifies_bracket_index_call_with_variable_key_as_computed_key() {
        let s = parse_lua("t[k]()");
        assert!(s.calls.iter().any(|c| c.name == "<dynamic:computed-key>"
            && c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("computed-key")
            && c.key_expr.as_deref() == Some("k")
            && c.receiver.as_deref() == Some("t")));
    }

    #[test]
    fn classifies_bracket_index_call_with_expression_key_as_computed_key() {
        let s = parse_lua("handlers[eventName .. \"Handler\"]()");
        assert!(s.calls.iter().any(|c| c.dynamic == Some(true)
            && c.dynamic_kind.as_deref() == Some("computed-key")
            && c.receiver.as_deref() == Some("handlers")));
    }
}
