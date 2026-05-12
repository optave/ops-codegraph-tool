use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

/// Verilog/SystemVerilog symbol extractor.
///
/// Mirrors `src/extractors/verilog.ts` (the WASM-engine source of truth) so
/// both engines produce identical definitions/imports/calls. The
/// tree-sitter-verilog grammar exposes no field names on the relevant nodes,
/// so name extraction works by scanning children for the appropriate
/// `*_identifier` wrapper or a plain `simple_identifier`.
///
/// Definitions captured:
///   - `module_declaration`     → kind `module` (ports collected as children)
///   - `interface_declaration`  → kind `interface`
///   - `package_declaration`    → kind `module`
///   - `class_declaration`      → kind `class` (extends emitted into `classes`)
///   - `function_declaration`   → kind `function` (`<parent>.<name>` when nested)
///   - `task_declaration`       → kind `function` (`<parent>.<name>` when nested)
///
/// Imports captured:
///   - `package_import_declaration`     → `pkg::item` or `pkg::*`
///   - `include_compiler_directive`     → ``include "file.vh"``
///
/// Calls captured:
///   - `module_instantiation` → module-type as call name (Verilog's analogue
///     of a function call — wires one module into another)
pub struct VerilogExtractor;

impl SymbolExtractor for VerilogExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_verilog_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &VERILOG_AST_CONFIG);
        symbols
    }
}

fn match_verilog_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "module_declaration" => handle_module_decl(node, source, symbols),
        "interface_declaration" => handle_interface_decl(node, source, symbols),
        "package_declaration" => handle_package_decl(node, source, symbols),
        "class_declaration" => handle_class_decl(node, source, symbols),
        "function_declaration" => handle_function_decl(node, source, symbols),
        "task_declaration" => handle_task_decl(node, source, symbols),
        "module_instantiation" => handle_module_instantiation(node, source, symbols),
        "package_import_declaration" => handle_package_import(node, source, symbols),
        "include_compiler_directive" => handle_include_directive(node, source, symbols),
        _ => {}
    }
}

// ── Handlers ────────────────────────────────────────────────────────────────

fn handle_module_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name = match find_module_name(node, source) {
        Some(n) => n,
        None => return,
    };
    let ports = extract_ports(node, source);
    symbols.definitions.push(Definition {
        name,
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(ports),
    });
}

fn handle_interface_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name = match find_decl_name(node, source) {
        Some(n) => n,
        None => return,
    };
    symbols.definitions.push(Definition {
        name,
        kind: "interface".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_package_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name = match find_decl_name(node, source) {
        Some(n) => n,
        None => return,
    };
    symbols.definitions.push(Definition {
        name,
        kind: "module".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // ⚠️ CURRENTLY A NO-OP. The JS extractor calls
    // `node.childForFieldName('name')`; tree-sitter-verilog exposes no `name`
    // field on `class_declaration` (and no `superclass` field), so this lookup
    // always returns `None` and the handler exits at the early `return` below.
    // Neither the class `Definition` nor the `extends` relation is ever
    // emitted on the current grammar — matching the WASM engine, which has
    // the same behavior. If a future grammar revision adds the `name` (and
    // `superclass`) fields, this handler will start firing automatically and
    // pick up both class definitions and inheritance relations in one step.
    // Until then, class extraction is intentional dead code kept as a hook
    // so the grammar upgrade doesn't go unnoticed.
    let name = match named_child_text(node, "name", source) {
        Some(n) => n.to_string(),
        None => return,
    };
    symbols.definitions.push(Definition {
        name: name.clone(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });

    if let Some(superclass) = node.child_by_field_name("superclass") {
        symbols.classes.push(ClassRelation {
            name,
            extends: Some(node_text(&superclass, source).to_string()),
            implements: None,
            line: start_line(node),
        });
    }
}

fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name = match find_function_or_task_name(node, source, "function_identifier") {
        Some(n) => n,
        None => return,
    };
    let parent = find_verilog_parent(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, name),
        None => name,
    };
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_task_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name = match find_function_or_task_name(node, source, "task_identifier") {
        Some(n) => n,
        None => return,
    };
    let parent = find_verilog_parent(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, name),
        None => name,
    };
    symbols.definitions.push(Definition {
        name: full_name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_module_instantiation(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Tree-sitter-verilog exposes no field name on `module_instantiation`; the
    // first *named* child holds the module type being instantiated. The JS
    // extractor uses `childForFieldName('type') || child(0)` — the field
    // lookup never hits, so first-named-child fallback is the live path.
    //
    // Using `named_child(0)` (instead of `child(0)`) skips any anonymous
    // grammar tokens (parameter-override punctuation like `#`, keywords)
    // that could otherwise lead the call name. Producing punctuation as a
    // call name would silently corrupt the call graph for any non-ANSI
    // instantiation form.
    let name_node = node
        .child_by_field_name("type")
        .or_else(|| node.named_child(0));
    let name_node = match name_node {
        Some(n) => n,
        None => return,
    };
    let name = node_text(&name_node, source).to_string();
    if name.is_empty() {
        return;
    }
    symbols.calls.push(Call {
        name,
        line: start_line(node),
        dynamic: None,
        receiver: None,
    });
}

fn handle_package_import(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // import pkg::item;  or  import pkg::*;
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "package_import_item" {
                let text = node_text(&child, source);
                let mut parts = text.splitn(2, "::");
                let pkg = parts.next().unwrap_or(text).to_string();
                let item = parts.next().unwrap_or("*").to_string();
                symbols.imports.push(Import::new(
                    pkg,
                    vec![item],
                    start_line(node),
                ));
            }
        }
    }
}

fn handle_include_directive(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // `include "file.vh"
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let kind = child.kind();
            if kind == "string_literal" || kind == "quoted_string" || kind == "double_quoted_string" {
                let raw = node_text(&child, source);
                let source_path = raw
                    .trim_matches(|c: char| c == '"' || c == '\'')
                    .to_string();
                if source_path.is_empty() {
                    return;
                }
                let last = source_path
                    .split('/')
                    .last()
                    .unwrap_or(&source_path)
                    .to_string();
                let mut imp = Import::new(source_path, vec![last], start_line(node));
                imp.c_include = Some(true);
                symbols.imports.push(imp);
                return;
            }
        }
    }
}

// ── Name lookups ────────────────────────────────────────────────────────────

/// Find a module's name: try `name` field, then `module_header > simple_identifier`,
/// then any direct identifier child.
fn find_module_name(node: &Node, source: &[u8]) -> Option<String> {
    if let Some(text) = named_child_text(node, "name", source) {
        return Some(text.to_string());
    }
    if let Some(header) = find_child(node, "module_header") {
        let id = find_child(&header, "simple_identifier")
            .or_else(|| find_child(&header, "identifier"));
        if let Some(id) = id {
            return Some(node_text(&id, source).to_string());
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "simple_identifier" || child.kind() == "identifier" {
                return Some(node_text(&child, source).to_string());
            }
        }
    }
    None
}

/// Generic name lookup: `name` field, else first direct identifier child.
fn find_decl_name(node: &Node, source: &[u8]) -> Option<String> {
    if let Some(text) = named_child_text(node, "name", source) {
        return Some(text.to_string());
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "simple_identifier" || child.kind() == "identifier" {
                return Some(node_text(&child, source).to_string());
            }
        }
    }
    None
}

/// Function/task name lookup. Falls back to a one-level deeper search for the
/// dedicated `*_identifier` wrapper (which itself wraps `simple_identifier`),
/// mirroring `findFunctionOrTaskName` in `verilog.ts`.
fn find_function_or_task_name(node: &Node, source: &[u8], identifier_type: &str) -> Option<String> {
    if let Some(name) = find_decl_name(node, source) {
        return Some(name);
    }
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        if child.kind() == identifier_type {
            return Some(extract_identifier_text(&child, source));
        }
        for j in 0..child.child_count() {
            if let Some(grand) = child.child(j) {
                if grand.kind() == identifier_type {
                    return Some(extract_identifier_text(&grand, source));
                }
            }
        }
    }
    None
}

/// Pull a clean identifier string out of a `*_identifier` wrapper. The grammar
/// nests `function_identifier > function_identifier > simple_identifier`, so
/// using `node_text` on the outer node is safe (yields just the name in
/// well-formed source) but we strip whitespace defensively.
fn extract_identifier_text(node: &Node, source: &[u8]) -> String {
    // Prefer the inner `simple_identifier` when present so we never accidentally
    // pick up trailing punctuation or whitespace from the outer span.
    if let Some(simple) = find_child(node, "simple_identifier") {
        return node_text(&simple, source).trim().to_string();
    }
    if let Some(inner) = find_child(node, node.kind()) {
        return extract_identifier_text(&inner, source);
    }
    node_text(node, source).trim().to_string()
}

/// Walk up to find the enclosing module/interface/package/class and return its
/// name — used to qualify nested function/task definitions like
/// `validators.check_range`.
fn find_verilog_parent(node: &Node, source: &[u8]) -> Option<String> {
    const PARENT_KINDS: &[&str] = &[
        "module_declaration",
        "interface_declaration",
        "package_declaration",
        "class_declaration",
    ];
    let mut current = node.parent();
    while let Some(parent) = current {
        if PARENT_KINDS.contains(&parent.kind()) {
            return find_decl_name(&parent, source)
                .or_else(|| find_module_name(&parent, source));
        }
        current = parent.parent();
    }
    None
}

// ── Port extraction ─────────────────────────────────────────────────────────

fn extract_ports(module_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut ports = Vec::new();
    collect_ports(module_node, source, &mut ports);
    ports
}

fn collect_ports(node: &Node, source: &[u8], ports: &mut Vec<Definition>) {
    const PORT_KINDS: &[&str] = &[
        "ansi_port_declaration",
        "port_declaration",
        "input_declaration",
        "output_declaration",
        "inout_declaration",
    ];
    const CONTAINER_KINDS: &[&str] = &[
        "list_of_port_declarations",
        "module_header",
        "module_ansi_header",
        "port_declaration_list",
    ];

    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        if PORT_KINDS.contains(&child.kind()) {
            let name_node = child
                .child_by_field_name("name")
                .or_else(|| find_child(&child, "port_identifier"))
                .or_else(|| find_child(&child, "simple_identifier"))
                .or_else(|| find_child(&child, "identifier"));
            if let Some(name_node) = name_node {
                // `port_identifier` wraps a `simple_identifier`; descend to the
                // innermost identifier for a clean, whitespace-free name.
                let inner = find_child(&name_node, "simple_identifier")
                    .or_else(|| find_child(&name_node, "identifier"))
                    .unwrap_or(name_node);
                ports.push(child_def(
                    node_text(&inner, source).to_string(),
                    "property",
                    start_line(&child),
                ));
            }
        }
        if CONTAINER_KINDS.contains(&child.kind()) {
            collect_ports(&child, source, ports);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_verilog::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        VerilogExtractor.extract(&tree, code.as_bytes(), "test.v")
    }

    #[test]
    fn extracts_module() {
        let s = parse("module top(input clk, output reg q); endmodule");
        let top = s.definitions.iter().find(|d| d.name == "top").unwrap();
        assert_eq!(top.kind, "module");
        let children = top.children.as_ref().unwrap();
        // ports: clk, q
        assert_eq!(children.len(), 2);
        assert!(children.iter().any(|c| c.name == "clk"));
        assert!(children.iter().any(|c| c.name == "q"));
    }

    #[test]
    fn extracts_module_instantiation_as_call() {
        // Use multi-line + multiple named port connections so the grammar
        // disambiguates `sub u_sub(...)` as `module_instantiation` rather
        // than `checker_instantiation` (a SystemVerilog assertion form).
        let s = parse(
            "module top(\n\
                 input wire clk\n\
             );\n\
                 wire w;\n\
                 sub u_sub(\n\
                     .clk(clk),\n\
                     .out(w)\n\
                 );\n\
             endmodule\n",
        );
        let calls: Vec<&Call> = s.calls.iter().filter(|c| c.name == "sub").collect();
        assert_eq!(calls.len(), 1, "module instantiation should appear as a call");
    }

    #[test]
    fn extracts_nested_function_with_parent_prefix() {
        let s = parse(
            "module validators(input clk, output reg valid); \
             function automatic check_range; \
               input [7:0] val; \
               check_range = (val >= 0); \
             endfunction \
             endmodule",
        );
        let f = s
            .definitions
            .iter()
            .find(|d| d.name == "validators.check_range")
            .expect("nested function should be qualified by parent module");
        assert_eq!(f.kind, "function");
    }

    #[test]
    fn extracts_task() {
        let s = parse(
            "module m; \
             task automatic do_thing; \
               input x; \
               x = 1; \
             endtask \
             endmodule",
        );
        let t = s
            .definitions
            .iter()
            .find(|d| d.name == "m.do_thing")
            .expect("task should be qualified by parent module");
        assert_eq!(t.kind, "function");
    }

    #[test]
    fn extracts_package_import() {
        let s = parse(
            "package pkg; endpackage \
             module m; \
             import pkg::*; \
             endmodule",
        );
        let import = s.imports.iter().find(|i| i.source == "pkg");
        assert!(import.is_some(), "expected package import 'pkg'");
        let import = import.unwrap();
        assert_eq!(import.names, vec!["*".to_string()]);
    }

    #[test]
    fn extracts_include_directive() {
        let s = parse("`include \"defs.vh\"\nmodule m; endmodule");
        let inc = s
            .imports
            .iter()
            .find(|i| i.source == "defs.vh")
            .expect("expected include for defs.vh");
        assert_eq!(inc.c_include, Some(true));
        assert_eq!(inc.names, vec!["defs.vh".to_string()]);
    }
}
