//! CUDA extractor.
//!
//! CUDA is a C++ superset. The tree-sitter-cuda grammar extends C++ with
//! `__global__`/`__device__`/`__host__`/`__shared__`/`__constant__`
//! qualifiers and kernel launch syntax (`<<<...>>>`). This mirrors the JS
//! extractor in `src/extractors/cuda.ts`: identical node-handler set to C++
//! plus CUDA-specific qualifier detection emitted as `decorators` on
//! function/method definitions.
//!
//! See `crates/codegraph-core/src/extractors/cpp.rs` for the close cousin
//! whose patterns this file reuses.

use super::helpers::*;
use super::SymbolExtractor;
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct CudaExtractor;

impl SymbolExtractor for CudaExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_cuda_node);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &CUDA_AST_CONFIG,
        );
        // Third pass: populate type_map with variable-to-type bindings so
        // receiver-typed call resolution (e.g. `buf.copy(...)` → `DeviceBuffer.copy`)
        // fires for CUDA files just like it does for C++ files. Mirrors the
        // third walk in `cpp.rs`.
        walk_tree(&tree.root_node(), source, &mut symbols, match_cuda_type_map);
        symbols
    }
}

// ── Type inference ──────────────────────────────────────────────────────────

/// Populate `symbols.type_map` from `declaration` and `parameter_declaration`
/// nodes. Mirrors `match_cpp_type_map` in `cpp.rs` — the CUDA grammar shares
/// these C++ node types, so the same logic works unchanged.
fn match_cuda_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                let type_name = node_text(&type_node, source);
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        if child.kind() == "init_declarator" || child.kind() == "identifier" {
                            let name_node = if child.kind() == "init_declarator" {
                                child.child_by_field_name("declarator")
                            } else {
                                Some(child)
                            };
                            if let Some(name_node) = name_node {
                                let final_name = unwrap_cuda_declarator(&name_node, source);
                                if !final_name.is_empty() {
                                    symbols.type_map.push(TypeMapEntry {
                                        name: final_name,
                                        type_name: type_name.to_string(),
                                        confidence: 0.9,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        "parameter_declaration" => {
            if let Some(type_node) = node.child_by_field_name("type") {
                if let Some(decl) = node.child_by_field_name("declarator") {
                    let name = unwrap_cuda_declarator(&decl, source);
                    if !name.is_empty() {
                        symbols.type_map.push(TypeMapEntry {
                            name,
                            type_name: node_text(&type_node, source).to_string(),
                            confidence: 0.9,
                        });
                    }
                }
            }
        }
        _ => {}
    }
}

// ── CUDA-specific qualifiers ────────────────────────────────────────────────

const CUDA_QUALIFIERS: &[&str] = &[
    "__global__",
    "__device__",
    "__host__",
    "__shared__",
    "__constant__",
];

fn is_cuda_qualifier(text: &str) -> bool {
    CUDA_QUALIFIERS.contains(&text)
}

/// Collect CUDA qualifiers attached to a function_definition.
///
/// Mirrors `extractCudaQualifiers` in `src/extractors/cuda.ts`: scan direct
/// children of the function_definition node, accepting either:
///   - a bare token whose text matches a CUDA qualifier, or
///   - a `storage_class_specifier`/`attribute_specifier` wrapper whose text
///     matches a CUDA qualifier.
///
/// The JS implementation uses `else if` to avoid emitting the same qualifier
/// twice when a wrapper node's text also matches; the match arms here
/// preserve that ordering.
fn extract_cuda_qualifiers(node: &Node, source: &[u8]) -> Vec<String> {
    let mut qualifiers = Vec::new();
    for i in 0..node.child_count() {
        let child = match node.child(i) {
            Some(c) => c,
            None => continue,
        };
        let kind = child.kind();
        let text = node_text(&child, source);
        if kind == "storage_class_specifier" || kind == "attribute_specifier" {
            if is_cuda_qualifier(text) {
                qualifiers.push(text.to_string());
            }
        } else if is_cuda_qualifier(text) {
            qualifiers.push(text.to_string());
        }
    }
    qualifiers
}

// ── Declarator helpers (mirror cpp.rs) ──────────────────────────────────────

fn unwrap_cuda_declarator(node: &Node, source: &[u8]) -> String {
    let mut current = *node;
    loop {
        match current.kind() {
            "pointer_declarator"
            | "reference_declarator"
            | "array_declarator"
            | "parenthesized_declarator" => {
                if let Some(inner) = current.child_by_field_name("declarator") {
                    current = inner;
                } else {
                    break;
                }
            }
            "identifier" | "field_identifier" => {
                return node_text(&current, source).to_string();
            }
            _ => break,
        }
    }
    node_text(&current, source).to_string()
}

fn extract_cuda_function_name(node: &Node, source: &[u8]) -> Option<String> {
    let declarator = node.child_by_field_name("declarator")?;
    extract_cuda_func_name_from_declarator(&declarator, source)
}

fn extract_cuda_func_name_from_declarator(declarator: &Node, source: &[u8]) -> Option<String> {
    match declarator.kind() {
        "function_declarator" => {
            let inner = declarator.child_by_field_name("declarator")?;
            Some(unwrap_cuda_declarator(&inner, source))
        }
        "pointer_declarator" | "reference_declarator" => {
            let inner = find_child(declarator, "function_declarator")?;
            let name_node = inner.child_by_field_name("declarator")?;
            Some(unwrap_cuda_declarator(&name_node, source))
        }
        _ => Some(unwrap_cuda_declarator(declarator, source)),
    }
}

fn extract_cuda_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let declarator = match node.child_by_field_name("declarator") {
        Some(d) => d,
        None => return params,
    };
    let func_decl = if declarator.kind() == "function_declarator" {
        Some(declarator)
    } else {
        find_child(&declarator, "function_declarator")
    };
    if let Some(func_decl) = func_decl {
        if let Some(param_list) = func_decl.child_by_field_name("parameters") {
            for i in 0..param_list.child_count() {
                if let Some(child) = param_list.child(i) {
                    if child.kind() == "parameter_declaration"
                        || child.kind() == "optional_parameter_declaration"
                    {
                        if let Some(decl) = child.child_by_field_name("declarator") {
                            let name = unwrap_cuda_declarator(&decl, source);
                            if !name.is_empty() {
                                params.push(child_def(name, "parameter", start_line(&child)));
                            }
                        }
                    }
                }
            }
        }
    }
    params
}

fn extract_cuda_fields(body: &Node, source: &[u8]) -> Vec<Definition> {
    let mut fields = Vec::new();
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if child.kind() == "field_declaration" {
                if let Some(decl) = child.child_by_field_name("declarator") {
                    let name = unwrap_cuda_declarator(&decl, source);
                    if !name.is_empty() {
                        fields.push(child_def(name, "property", start_line(&child)));
                    }
                }
            }
        }
    }
    fields
}

fn extract_cuda_enum_constants(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut constants = Vec::new();
    if let Some(body) = node.child_by_field_name("body") {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enumerator" {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        constants.push(child_def(
                            node_text(&name_node, source).to_string(),
                            "constant",
                            start_line(&child),
                        ));
                    }
                }
            }
        }
    }
    constants
}

fn extract_cuda_base_classes(
    node: &Node,
    source: &[u8],
    class_name: &str,
    symbols: &mut FileSymbols,
) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "base_class_clause" {
                for j in 0..child.child_count() {
                    if let Some(base) = child.child(j) {
                        match base.kind() {
                            "type_identifier"
                            | "qualified_identifier"
                            | "scoped_type_identifier" => {
                                symbols.classes.push(ClassRelation {
                                    name: class_name.to_string(),
                                    extends: Some(node_text(&base, source).to_string()),
                                    implements: None,
                                    line: start_line(node),
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

// ── Per-node-kind handlers ──────────────────────────────────────────────────

fn handle_cuda_function_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name) = extract_cuda_function_name(node, source) {
        let parent_class =
            find_enclosing_type_name(node, &["class_specifier", "struct_specifier"], source);
        let full_name = match &parent_class {
            Some(cls) => format!("{}.{}", cls, name),
            None => name,
        };
        let kind = if parent_class.is_some() {
            "method"
        } else {
            "function"
        };
        let children = extract_cuda_parameters(node, source);
        let qualifiers = extract_cuda_qualifiers(node, source);
        let decorators = if qualifiers.is_empty() {
            None
        } else {
            Some(qualifiers)
        };
        // Reuse the "cpp" rule id for complexity/CFG — the CUDA grammar exposes
        // the same C++ control-flow node types, and there is no dedicated "cuda"
        // rule set in `ast-analysis/rules/`.
        symbols.definitions.push(Definition {
            name: full_name,
            kind: kind.to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators,
            complexity: compute_all_metrics(node, source, "cpp"),
            cfg: build_function_cfg(node, "cpp", source),
            children: opt_children(children),
        });
    }
}

fn handle_cuda_class_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let class_name = node_text(&name_node, source).to_string();
        let children = node
            .child_by_field_name("body")
            .map(|body| extract_cuda_fields(&body, source))
            .unwrap_or_default();
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
        extract_cuda_base_classes(node, source, &class_name, symbols);
    }
}

fn handle_cuda_struct_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let struct_name = node_text(&name_node, source).to_string();
        let children = node
            .child_by_field_name("body")
            .map(|body| extract_cuda_fields(&body, source))
            .unwrap_or_default();
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
}

fn handle_cuda_enum_specifier(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_cuda_enum_constants(node, source);
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "enum".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
        });
    }
}

fn handle_cuda_namespace_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "namespace".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
        });
    }
}

fn handle_cuda_type_definition(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Match JS: scan children right-to-left and take the first type-like node
    // as the alias name. Mirrors `handleCudaTypedef` in
    // `src/extractors/cuda.ts`.
    let mut alias_name = None;
    for i in (0..node.child_count()).rev() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "type_identifier" | "identifier" | "primitive_type" => {
                    alias_name = Some(node_text(&child, source).to_string());
                    break;
                }
                _ => {}
            }
        }
    }
    if let Some(name) = alias_name {
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
}

fn handle_cuda_preproc_include(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Strip quote/angle delimiters and expose the basename minus header
    // extension as the import name, matching the native C++ extractor so
    // `cInclude` resolution links CUDA includes consistently with C/C++.
    // CUDA-specific `.cuh` headers are stripped in addition to `.h`/`.hpp`.
    // Tagged with `cInclude` so resolution treats it like a C/C++ header.
    if let Some(path_node) = node.child_by_field_name("path") {
        let raw = node_text(&path_node, source);
        let path = raw.trim_matches(|c| c == '"' || c == '<' || c == '>');
        if !path.is_empty() {
            let last = path.rsplit('/').next().unwrap_or(path);
            let name = last
                .strip_suffix(".cuh")
                .or_else(|| last.strip_suffix(".hpp"))
                .or_else(|| last.strip_suffix(".h"))
                .unwrap_or(last);
            let mut imp = Import::new(
                path.to_string(),
                vec![name.to_string()],
                start_line(node),
            );
            imp.c_include = Some(true);
            symbols.imports.push(imp);
        }
    }
}

fn handle_cuda_call_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(fn_node) = node.child_by_field_name("function") {
        if fn_node.kind() == "field_expression" {
            let name = named_child_text(&fn_node, "field", source)
                .map(|s| s.to_string())
                .unwrap_or_default();
            let receiver = named_child_text(&fn_node, "argument", source).map(|s| s.to_string());
            if !name.is_empty() {
                symbols.calls.push(Call {
                    name,
                    line: start_line(node),
                    dynamic: None,
                    receiver,
                });
            }
        } else {
            let name = node_text(&fn_node, source).to_string();
            if !name.is_empty() {
                symbols.calls.push(Call {
                    name,
                    line: start_line(node),
                    dynamic: None,
                    receiver: None,
                });
            }
        }
    }
}

fn match_cuda_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => handle_cuda_function_definition(node, source, symbols),
        "class_specifier" => handle_cuda_class_specifier(node, source, symbols),
        "struct_specifier" => handle_cuda_struct_specifier(node, source, symbols),
        "enum_specifier" => handle_cuda_enum_specifier(node, source, symbols),
        "namespace_definition" => handle_cuda_namespace_definition(node, source, symbols),
        "type_definition" => handle_cuda_type_definition(node, source, symbols),
        "preproc_include" => handle_cuda_preproc_include(node, source, symbols),
        "call_expression" => handle_cuda_call_expression(node, source, symbols),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_cuda(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_cuda::LANGUAGE.into())
            .expect("loads CUDA grammar");
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        CudaExtractor.extract(&tree, code.as_bytes(), "test.cu")
    }

    #[test]
    fn extracts_host_function() {
        let s = parse_cuda("void hostFunction(int n) { return; }");
        let f = s
            .definitions
            .iter()
            .find(|d| d.name == "hostFunction")
            .expect("hostFunction extracted");
        assert_eq!(f.kind, "function");
    }

    #[test]
    fn extracts_struct_with_fields() {
        let s = parse_cuda("struct Vec3 { float x; float y; float z; };");
        let v = s
            .definitions
            .iter()
            .find(|d| d.name == "Vec3")
            .expect("Vec3 extracted");
        assert_eq!(v.kind, "struct");
    }

    #[test]
    fn extracts_class_with_method() {
        let s = parse_cuda("class Foo { public: void bar() {} };");
        let foo = s
            .definitions
            .iter()
            .find(|d| d.name == "Foo")
            .expect("class Foo extracted");
        assert_eq!(foo.kind, "class");
        let bar = s
            .definitions
            .iter()
            .find(|d| d.name == "Foo.bar")
            .expect("method Foo.bar extracted");
        assert_eq!(bar.kind, "method");
    }

    #[test]
    fn extracts_namespace() {
        let s = parse_cuda("namespace myns { int x; }");
        let n = s
            .definitions
            .iter()
            .find(|d| d.name == "myns")
            .expect("namespace extracted");
        assert_eq!(n.kind, "namespace");
    }

    #[test]
    fn extracts_inheritance() {
        let s = parse_cuda("class Base {}; class Derived : public Base {};");
        let rel = s
            .classes
            .iter()
            .find(|c| c.name == "Derived")
            .expect("Derived base class recorded");
        assert_eq!(rel.extends.as_deref(), Some("Base"));
    }

    #[test]
    fn extracts_include_with_c_include_flag() {
        let s = parse_cuda("#include <cuda_runtime.h>\n#include \"mylib.cuh\"");
        assert_eq!(s.imports.len(), 2);
        assert!(s.imports[0].c_include.unwrap_or(false));
        assert_eq!(s.imports[0].source, "cuda_runtime.h");
        // Header extensions are stripped from import names so `cInclude`
        // resolution matches C/C++ behavior in the native layer.
        assert_eq!(s.imports[0].names, vec!["cuda_runtime".to_string()]);
        assert_eq!(s.imports[1].source, "mylib.cuh");
        assert_eq!(s.imports[1].names, vec!["mylib".to_string()]);
    }

    #[test]
    fn populates_type_map_from_declarations() {
        let s = parse_cuda(
            "void run() { DeviceBuffer buf; buf.copy(src, n); }",
        );
        // `DeviceBuffer buf;` should be recorded so receiver-typed call
        // resolution can map `buf.copy` to `DeviceBuffer.copy`.
        let entry = s
            .type_map
            .iter()
            .find(|e| e.name == "buf")
            .expect("buf type binding present in type_map");
        assert_eq!(entry.type_name, "DeviceBuffer");
    }

    #[test]
    fn populates_type_map_from_parameters() {
        let s = parse_cuda("void run(DeviceBuffer buf) { buf.copy(); }");
        let entry = s
            .type_map
            .iter()
            .find(|e| e.name == "buf")
            .expect("buf parameter type binding present in type_map");
        assert_eq!(entry.type_name, "DeviceBuffer");
    }

    #[test]
    fn extracts_call_expression() {
        let s = parse_cuda("void foo() { cudaMalloc(&ptr, size); }");
        assert!(s.calls.iter().any(|c| c.name == "cudaMalloc"));
    }

    #[test]
    fn extracts_method_call_with_receiver() {
        let s = parse_cuda(
            "void run() { UserService svc; svc.createUser(\"1\", \"a\", \"a@b\"); }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "createUser")
            .expect("createUser call recorded");
        assert_eq!(call.receiver.as_deref(), Some("svc"));
    }

    #[test]
    fn captures_cuda_qualifier_decorators() {
        let s = parse_cuda("__global__ void kernel(int *data, int n) { }");
        let k = s
            .definitions
            .iter()
            .find(|d| d.name == "kernel")
            .expect("kernel extracted");
        let decorators = k.decorators.as_ref().expect("decorators present");
        assert!(decorators.iter().any(|d| d == "__global__"));
    }

    #[test]
    fn extracts_typedef_alias() {
        let s = parse_cuda("typedef unsigned int uint32_t;");
        assert!(s.definitions.iter().any(|d| d.name == "uint32_t" && d.kind == "type"));
    }
}
