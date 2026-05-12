use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct JuliaExtractor;

impl SymbolExtractor for JuliaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_julia(&tree.root_node(), source, &mut symbols, None);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &JULIA_AST_CONFIG);
        symbols
    }
}

/// Walk Julia tree threading the current enclosing module name. The JS
/// extractor (`src/extractors/julia.ts`) tracks `currentModule` so that
/// definitions inside `module Foo ... end` are prefixed `Foo.bar`. The
/// generic `walk_tree` helper cannot pass extra state, so we open-code a
/// recursive walker here.
fn walk_julia(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_module: Option<&str>,
) {
    let mut next_module = current_module.map(|s| s.to_string());

    match node.kind() {
        "module_definition" => {
            if let Some(name) = handle_module_def(node, source, symbols) {
                next_module = Some(name);
            }
        }
        "function_definition" => handle_function_def(node, source, symbols, current_module),
        "assignment" => handle_assignment(node, source, symbols, current_module),
        "struct_definition" => handle_struct_def(node, source, symbols),
        "abstract_definition" => handle_abstract_def(node, source, symbols),
        "macro_definition" => handle_macro_def(node, source, symbols, current_module),
        "import_statement" | "using_statement" => handle_import(node, source, symbols),
        "call_expression" => handle_call(node, source, symbols),
        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_julia(&child, source, symbols, next_module.as_deref());
        }
    }
}

fn handle_module_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) -> Option<String> {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))?;
    let name = node_text(&name_node, source).to_string();

    symbols.definitions.push(Definition {
        name: name.clone(),
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });

    Some(name)
}

/// Extract the function-name identifier from a `signature` (or call_expression
/// directly) node. tree-sitter-julia wraps the call signature of a
/// `function_definition` / `macro_definition` in a `signature` node whose
/// first child is the `call_expression` — `find_child` only inspects direct
/// children, so we unwrap one level explicitly.
fn signature_call<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    if let Some(sig) = find_child(node, "signature") {
        return find_child(&sig, "call_expression");
    }
    find_child(node, "call_expression")
}

fn handle_function_def(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_module: Option<&str>,
) {
    if let Some(call_sig) = signature_call(node) {
        if let Some(func_name_node) = call_sig.child(0) {
            let base = node_text(&func_name_node, source);
            let name = match current_module {
                Some(m) => format!("{}.{}", m, base),
                None => base.to_string(),
            };
            let params = extract_julia_params(&call_sig, source);
            symbols.definitions.push(Definition {
                name,
                kind: "function".to_string(),
                line: start_line(node),
                end_line: Some(end_line(node)),
                decorators: None,
                complexity: compute_all_metrics(node, source, "julia"),
                cfg: build_function_cfg(node, "julia", source),
                children: opt_children(params),
            });
            return;
        }
    }

    // Fallback: look for identifier directly
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))
    {
        Some(n) => n,
        None => return,
    };
    let base = node_text(&name_node, source);
    let name = match current_module {
        Some(m) => format!("{}.{}", m, base),
        None => base.to_string(),
    };
    symbols.definitions.push(Definition {
        name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "julia"),
        cfg: build_function_cfg(node, "julia", source),
        children: None,
    });
}

fn handle_assignment(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_module: Option<&str>,
) {
    // Short function form: `add(x, y) = x + y` → LHS is a call_expression.
    let lhs = match node.child(0) {
        Some(c) => c,
        None => return,
    };
    if lhs.kind() != "call_expression" {
        return;
    }
    let func_name_node = match lhs.child(0) {
        Some(c) => c,
        None => return,
    };
    let base = node_text(&func_name_node, source);
    let name = match current_module {
        Some(m) => format!("{}.{}", m, base),
        None => base.to_string(),
    };
    let params = extract_julia_params(&lhs, source);

    symbols.definitions.push(Definition {
        name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: compute_all_metrics(node, source, "julia"),
        cfg: build_function_cfg(node, "julia", source),
        children: opt_children(params),
    });
}

fn handle_struct_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // struct_definition: `struct` type_head <fields> `end`
    // type_head is either a bare `identifier` (no supertype) or a
    // `binary_expression` of the form `Name <: Super`.
    let type_head = match find_child(node, "type_head") {
        Some(th) => th,
        None => return,
    };

    let (name_node, supertype): (Node, Option<Node>) = if let Some(bin) =
        find_child(&type_head, "binary_expression")
    {
        // First identifier is the struct name, last identifier (after `<:`) is the supertype.
        let mut name_id: Option<Node> = None;
        let mut super_id: Option<Node> = None;
        for i in 0..bin.child_count() {
            if let Some(c) = bin.child(i) {
                if c.kind() == "identifier" {
                    if name_id.is_none() {
                        name_id = Some(c);
                    } else {
                        super_id = Some(c);
                    }
                }
            }
        }
        match name_id {
            Some(n) => (n, super_id),
            None => return,
        }
    } else if let Some(id) = find_child(&type_head, "identifier") {
        (id, None)
    } else {
        return;
    };

    let struct_name = node_text(&name_node, source).to_string();

    let mut children: Vec<Definition> = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() == "typed_expression" {
            if let Some(field_name) = find_child(&child, "identifier") {
                children.push(child_def(
                    node_text(&field_name, source).to_string(),
                    "property",
                    start_line(&child),
                ));
            }
        } else if child.kind() == "identifier" {
            // Plain identifier fields (no type annotation) appear as direct
            // identifier children of struct_definition. The type_head is a
            // separate node so there is nothing to filter out here.
            children.push(child_def(
                node_text(&child, source).to_string(),
                "property",
                start_line(&child),
            ));
        }
    }

    if let Some(sup) = supertype {
        symbols.classes.push(ClassRelation {
            name: struct_name.clone(),
            extends: Some(node_text(&sup, source).to_string()),
            implements: None,
            line: start_line(node),
        });
    }

    symbols.definitions.push(Definition {
        name: struct_name,
        kind: "struct".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
    });
}

fn handle_abstract_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // abstract_definition: `abstract type` type_head `end`
    // type_head wraps the name identifier — possibly nested in a
    // `Name <: Super` binary_expression or a `Name{T,...}` parametrized form
    // (`parameterized_identifier` / `type_parameter_list`).
    let name_node = match node
        .child_by_field_name("name")
        .or_else(|| find_child(node, "identifier"))
    {
        Some(n) => n,
        None => match find_child(node, "type_head") {
            Some(th) => match find_abstract_name(&th) {
                Some(n) => n,
                // Mirror the TS extractor: skip rather than emit a garbled
                // definition name (e.g. raw `Name{T} <: Super{T,1}` text).
                None => return,
            },
            None => return,
        },
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

/// Locate the base-name identifier within a `type_head` node.
///
/// Handles plain identifiers, `Name <: Super` binary expressions, and
/// parameterized forms like `Name{T}` / `Name{T} <: Super{T,1}` by recursing
/// into common wrapper kinds (binary expressions, parametrized identifiers,
/// type-parameter lists). Returns `None` when no identifier can be located —
/// callers should skip emitting a definition in that case.
fn find_abstract_name<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    // Direct identifier child wins.
    if let Some(id) = find_child(node, "identifier") {
        return Some(id);
    }
    // Otherwise recurse through wrapper shapes that may contain the
    // base-name identifier (parameterized or supertyped forms).
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        match child.kind() {
            "binary_expression"
            | "parametrized_type_expression"
            | "parameterized_identifier"
            | "type_parameter_list"
            | "type_argument_list" => {
                if let Some(found) = find_abstract_name(&child) {
                    return Some(found);
                }
            }
            _ => {}
        }
    }
    None
}

fn handle_macro_def(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    current_module: Option<&str>,
) {
    // macro_definition: `macro` signature/call_expression body `end`.
    // The name lives in the same shape as a function signature.
    let name_node = if let Some(call_sig) = signature_call(node) {
        call_sig.child(0)
    } else {
        node.child_by_field_name("name")
            .or_else(|| find_child(node, "identifier"))
    };
    let name_node = match name_node {
        Some(n) => n,
        None => return,
    };
    let base = node_text(&name_node, source);
    let name = match current_module {
        Some(m) => format!("{}.@{}", m, base),
        None => format!("@{}", base),
    };
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

fn handle_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // tree-sitter-julia shapes:
    //   `using LinearAlgebra`     → using_statement [ using, identifier ]
    //   `using ..Repository`      → using_statement [ using, import_path[..] ]
    //   `import Foo.Bar`          → import_statement [ import, scoped_identifier ]
    //   `import .X`               → import_statement [ import, import_path[.] ]
    //   `import Base: show`       → import_statement [ import, selected_import[Base, show] ]
    //
    // We collect every meaningful sub-node and derive `source` from the first.
    let mut names: Vec<String> = Vec::new();
    let mut source_str = String::new();

    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        match child.kind() {
            "identifier" | "scoped_identifier" => {
                let txt = node_text(&child, source);
                if source_str.is_empty() {
                    source_str = txt.to_string();
                }
                let last = txt.rsplit('.').next().unwrap_or(txt);
                names.push(last.to_string());
            }
            "import_path" => {
                // Use the trailing identifier as the module reference.
                let txt = node_text(&child, source);
                let stripped = txt.trim_start_matches('.');
                if source_str.is_empty() {
                    source_str = stripped.to_string();
                }
                let last = stripped.rsplit('.').next().unwrap_or(stripped);
                if !last.is_empty() {
                    names.push(last.to_string());
                }
            }
            "selected_import" => {
                // First identifier is the source module; the rest are imported names.
                let mut first = true;
                for j in 0..child.child_count() {
                    let Some(part) = child.child(j) else { continue };
                    if part.kind() == "identifier" {
                        let txt = node_text(&part, source).to_string();
                        if first {
                            if source_str.is_empty() {
                                source_str = txt.clone();
                            }
                            first = false;
                        } else {
                            names.push(txt);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if !source_str.is_empty() {
        let names = if names.is_empty() { vec![source_str.clone()] } else { names };
        symbols
            .imports
            .push(Import::new(source_str, names, start_line(node)));
    }
}

fn handle_call(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Skip when this call is the LHS of an assignment (it's a short-form
    // function definition signature).
    if let Some(parent) = node.parent() {
        if parent.kind() == "assignment" {
            if let Some(first) = parent.child(0) {
                if first.id() == node.id() {
                    return;
                }
            }
        }
        // Skip when this call is the signature of a function/macro definition.
        // In tree-sitter-julia the signature lives inside a `signature` node
        // whose parent is `function_definition` or `macro_definition`. Body
        // calls (e.g. `println(name)` inside `function greet ... end`) appear
        // as direct children of `function_definition` and MUST be recorded —
        // do not blanket-skip on that parent kind.
        if parent.kind() == "signature" {
            if let Some(grand) = parent.parent() {
                if matches!(grand.kind(), "function_definition" | "macro_definition") {
                    return;
                }
            }
        }
    }

    let func_node = match node.child(0) {
        Some(n) => n,
        None => return,
    };

    match func_node.kind() {
        "identifier" => {
            symbols.calls.push(Call {
                name: node_text(&func_node, source).to_string(),
                line: start_line(node),
                dynamic: None,
                receiver: None,
            });
        }
        "field_expression" | "scoped_identifier" => {
            let raw = node_text(&func_node, source);
            let parts: Vec<&str> = raw.split('.').collect();
            if parts.len() >= 2 {
                let last = parts.last().copied().unwrap_or("");
                let receiver = parts[..parts.len() - 1].join(".");
                symbols.calls.push(Call {
                    name: last.to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: Some(receiver),
                });
            } else {
                symbols.calls.push(Call {
                    name: raw.to_string(),
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
        _ => {}
    }
}

fn extract_julia_params(call_expr: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params: Vec<Definition> = Vec::new();
    let arg_list = match find_child(call_expr, "argument_list")
        .or_else(|| find_child(call_expr, "tuple_expression"))
    {
        Some(a) => a,
        None => return params,
    };

    for i in 0..arg_list.child_count() {
        let Some(child) = arg_list.child(i) else { continue };
        match child.kind() {
            "identifier" => {
                params.push(child_def(
                    node_text(&child, source).to_string(),
                    "parameter",
                    start_line(&child),
                ));
            }
            "typed_parameter" | "typed_expression" | "optional_parameter" | "default_parameter" => {
                if let Some(name_node) = find_child(&child, "identifier") {
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
    params
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_jl(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_julia::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        JuliaExtractor.extract(&tree, code.as_bytes(), "test.jl")
    }

    #[test]
    fn finds_function() {
        let s = parse_jl("function greet(name)\n    println(name)\nend\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"greet"));
        let g = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(g.kind, "function");
    }

    #[test]
    fn finds_short_form_function() {
        let s = parse_jl("add(x, y) = x + y\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"add"));
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        assert_eq!(add.kind, "function");
        let params: Vec<&str> = add
            .children
            .as_ref()
            .map(|c| c.iter().map(|p| p.name.as_str()).collect())
            .unwrap_or_default();
        assert!(params.contains(&"x"));
        assert!(params.contains(&"y"));
    }

    #[test]
    fn module_prefixes_inner_functions() {
        let s = parse_jl("module Foo\n    function bar()\n    end\nend\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
    }

    #[test]
    fn extracts_struct_with_fields_and_supertype() {
        let s = parse_jl("struct Point <: AbstractPoint\n    x::Int\n    y::Int\nend\n");
        let point = s
            .definitions
            .iter()
            .find(|d| d.name == "Point")
            .expect("struct should be found");
        assert_eq!(point.kind, "struct");
        let fields: Vec<&str> = point
            .children
            .as_ref()
            .map(|c| c.iter().map(|p| p.name.as_str()).collect())
            .unwrap_or_default();
        assert!(fields.contains(&"x"));
        assert!(fields.contains(&"y"));
        assert_eq!(s.classes.len(), 1);
        assert_eq!(s.classes[0].name, "Point");
        assert_eq!(s.classes[0].extends, Some("AbstractPoint".to_string()));
    }

    #[test]
    fn extracts_struct_without_supertype() {
        let s = parse_jl("struct Point\n    x::Float64\n    y::Float64\nend\n");
        let point = s
            .definitions
            .iter()
            .find(|d| d.name == "Point")
            .expect("struct should be found");
        assert_eq!(point.kind, "struct");
        assert!(s.classes.is_empty());
    }

    #[test]
    fn extracts_abstract_type() {
        let s = parse_jl("abstract type AbstractShape end\n");
        let t = s
            .definitions
            .iter()
            .find(|d| d.name == "AbstractShape")
            .expect("abstract should be found");
        assert_eq!(t.kind, "type");
    }

    #[test]
    fn extracts_parameterized_abstract_type_base_name() {
        // Parameterized generics with a supertype must record only the base
        // identifier — never the raw `Name{T} <: Super{T,1}` text.
        let s = parse_jl("abstract type AbstractVector{T} <: AbstractArray{T,1} end\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"AbstractVector"),
            "expected base name `AbstractVector`, got {names:?}"
        );
        // Guard against the previous garbled-name regression.
        assert!(
            !names.iter().any(|n| n.contains('{') || n.contains('<')),
            "definition name leaked raw type-head text: {names:?}"
        );
    }

    #[test]
    fn extracts_macro_def() {
        let s = parse_jl("macro mymac(x)\n    x\nend\n");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"@mymac"));
    }

    #[test]
    fn extracts_qualified_calls() {
        let s = parse_jl("function main()\n    Repository.save(repo, 1)\n    println(\"x\")\nend\n");
        let calls: Vec<(&str, Option<&str>)> = s
            .calls
            .iter()
            .map(|c| (c.name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(calls.iter().any(|(n, r)| *n == "save" && *r == Some("Repository")));
        assert!(calls.iter().any(|(n, r)| *n == "println" && r.is_none()));
    }

    #[test]
    fn handles_using_import() {
        let s = parse_jl("using ..Repository\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "Repository");
    }

    #[test]
    fn handles_selected_import() {
        let s = parse_jl("import Base: show\n");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "Base");
        assert!(s.imports[0].names.contains(&"show".to_string()));
    }

    #[test]
    fn does_not_record_function_signature_as_call() {
        let s = parse_jl("function greet(name)\n    println(name)\nend\n");
        // `greet` itself must not appear as a call — only println.
        let call_names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(!call_names.contains(&"greet"));
        assert!(call_names.contains(&"println"));
    }
}
