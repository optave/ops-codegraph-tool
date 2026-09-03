use super::helpers::*;
use super::SymbolExtractor;
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::domain::graph::builder::stages::build_edges::PROPAGATION_HOP_PENALTY;
use crate::types::*;
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Tree};

/// Well-known JS globals that must not be recorded as pts targets.
/// Mirrors the `BUILTIN_GLOBALS` set in `src/extractors/javascript.ts`
/// and must be identical to the set tested in `is_js_builtin_global`.
const JS_BUILTIN_GLOBALS: &[&str] = &[
    "Math",
    "JSON",
    "Promise",
    "Array",
    "Object",
    "Date",
    "Error",
    "Symbol",
    "Map",
    "Set",
    "RegExp",
    "Number",
    "String",
    "Boolean",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "Proxy",
    "Reflect",
    "Intl",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "DataView",
    "Atomics",
    "BigInt",
    "Float32Array",
    "Float64Array",
    "Int8Array",
    "Int16Array",
    "Int32Array",
    "Uint8Array",
    "Uint16Array",
    "Uint32Array",
    "Uint8ClampedArray",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "AbortController",
    "AbortSignal",
    "Headers",
    "Request",
    "Response",
    "FormData",
    "Blob",
    "File",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    // Browser/runtime globals — must match is_js_builtin_global below
    "console",
    "process",
    "window",
    "document",
    "globalThis",
    // Node.js built-ins
    "Buffer",
    "EventEmitter",
    "Stream",
];

/// Mirrors JS `name[0] !== name[0].toLowerCase()` exactly — the check TS's
/// factory-method heuristic (`handleCallExprTypeMap`) uses to decide whether
/// an identifier "starts with an uppercase letter". Two JS-specific quirks
/// this must replicate precisely, not approximate, or the two engines
/// silently diverge on this parity-sensitive heuristic (#2396):
///
/// - JS string indexing operates on UTF-16 code units, not full Unicode
///   scalars: for an astral-plane leading character (code point > U+FFFF,
///   e.g. a Deseret capital letter), `name[0]` is a lone UTF-16 surrogate,
///   which doesn't case-fold and so is never treated as uppercase in JS.
/// - The condition is "does lowercasing change this character", not "is
///   this character in Unicode's Uppercase category" — those differ for
///   titlecase letters (Unicode category Lt, e.g. `ǅ`), which lowercase to
///   a different character but are neither uppercase nor lowercase per
///   `char::is_uppercase()`/`is_lowercase()`. JS's `.toLowerCase()`-based
///   check treats them as "uppercase-like"; Rust's `is_uppercase()` does not.
fn starts_with_uppercase_like_js(name: &str) -> bool {
    let Some(unit) = name.encode_utf16().next() else {
        return false;
    };
    if (0xD800..=0xDFFF).contains(&unit) {
        return false;
    }
    let Some(c) = char::from_u32(unit as u32) else {
        return false;
    };
    c.to_lowercase().ne(std::iter::once(c))
}

pub struct JsExtractor;

impl SymbolExtractor for JsExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        // Issue #1845: collected once up front so identifier-argument calls to
        // same-file user-defined higher-order functions can be recognized
        // during the single forward walk below, regardless of declaration order.
        let callback_param_shapes = collect_callback_param_shapes(&tree.root_node(), source);
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            |node, source, symbols, depth| {
                match_js_node(node, source, symbols, depth, &callback_param_shapes)
            },
        );
        walk_ast_nodes(&tree.root_node(), source, &mut symbols.ast_nodes);
        // #2033: return_type_map must be fully populated before match_js_type_map
        // runs — its variable_declarator handler now reads the *complete* per-file
        // return_type_map for same-file inter-procedural propagation (mirrors TS
        // extractReturnTypeMapWalk running before runContextCollectorWalk for the
        // identical reason, per that function's doc comment).
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_js_return_type_map,
        );
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_type_map);
        // Pre-ES6 prototype methods: `Foo.prototype.bar = fn` and `Foo.prototype = { bar: fn }`
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_js_prototype_methods,
        );
        // call_assignments runs after type_map is populated (needs receiver types)
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_js_call_assignments,
        );
        // Phase 8.3c–8.3f: points-to bindings (params, this-rebinding, arrays,
        // spread, for-of, object rest/props) for the pts constraint solver.
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            match_js_pts_bindings,
        );
        // Collapse duplicate keys accumulated during the tree walks (O(n)).
        dedup_type_map(&mut symbols.type_map);
        dedup_type_map(&mut symbols.return_type_map);
        // #1893: same-file get/set accessor property reads/writes → calls edges.
        // Runs after `dedup_type_map` (needs the *arbitrated* highest-confidence
        // receiver type for the `varName.prop` case) and after handle_method_def
        // has run (the registry re-derives accessor names directly from the AST,
        // so source order relative to match_js_node doesn't matter for
        // correctness). `type_map` is a raw append-only Vec until dedup_type_map
        // runs (see set_type_map_entry's doc comment) — reading it beforehand, as
        // match_js_call_assignments above does, risks picking a lower-confidence,
        // stale entry for a name that got pushed more than once. The TS mirror
        // doesn't have this hazard: `typeMap` is a `Map` arbitrated on every write
        // via `setTypeMapEntry`, so `.get()` is always already resolved — ordering
        // this walk after dedup keeps both engines reading the same resolved view.
        let local_accessors = collect_local_accessors(&tree.root_node(), source);
        walk_tree(
            &tree.root_node(),
            source,
            &mut symbols,
            |node, source, symbols, _depth| {
                handle_accessor_property_read(node, source, symbols, &local_accessors)
            },
        );
        finalize_object_literal_sites(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

// ── Type inference helpers ──────────────────────────────────────────────────

/// Generic type wrappers that transform their argument into an unrelated
/// opaque type (`ReturnType<typeof fn>`, `InstanceType<typeof Ctor>`, …) —
/// their own name is never a legitimate receiver type, so `extract_simple_type_name`
/// must return `None` rather than the wrapper's own name (#2235).
const OPAQUE_TYPE_TRANSFORM_WRAPPERS: [&str; 4] = [
    "ReturnType",
    "InstanceType",
    "Parameters",
    "ConstructorParameters",
];

/// Extract simple type name from a type_annotation node.
/// Returns the type name for simple types and generics, None for unions/intersections/arrays.
fn extract_simple_type_name<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "type_identifier" | "identifier" => return Some(node_text(&child, source)),
                "generic_type" => {
                    let base = child.child(0).map(|n| node_text(&n, source));
                    return base.filter(|b| !OPAQUE_TYPE_TRANSFORM_WRAPPERS.contains(b));
                }
                "parenthesized_type" => return extract_simple_type_name(&child, source),
                _ => {}
            }
        }
    }
    None
}

/// Extract the target type name from an `as_expression` (`value as Type`),
/// mirroring TS `extractAsExpressionTypeName`.
///
/// `as_expression` has no named fields in tree-sitter-typescript's grammar —
/// its two named children (the expression and the type) are distinguished
/// only by kind, not a field name. Scanning from the END and matching on
/// `type_identifier`/`generic_type`/`parenthesized_type` (never plain
/// `identifier`, unlike `extract_simple_type_name`) is safe because the
/// expression side can never produce those node kinds — TS's grammar keeps
/// "type" and "expression" as disjoint node-kind namespaces — so there is no
/// risk of matching the cast's INPUT instead of its target type, even when
/// that input is itself a bare identifier.
///
/// `X as unknown as Y` parses as nested as_expressions, `(X as unknown) as
/// Y` — called on the outermost node, this naturally extracts `Y` (the
/// final, intended type) without needing to special-case the `unknown` hop;
/// called on a bare `X as unknown`, it correctly finds no nameable type
/// (`unknown` is a `predefined_type`, not handled here) and returns `None`.
fn extract_as_expression_type_name<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    for i in (0..node.child_count()).rev() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "type_identifier" => return Some(node_text(&child, source)),
                "generic_type" => {
                    let base = child.child(0).map(|n| node_text(&n, source));
                    return base.filter(|b| !OPAQUE_TYPE_TRANSFORM_WRAPPERS.contains(b));
                }
                "parenthesized_type" => return extract_simple_type_name(&child, source),
                _ => {}
            }
        }
    }
    None
}

/// Extract constructor type name from a new_expression node.
fn extract_new_expr_type_name<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if node.kind() != "new_expression" {
        return None;
    }
    let ctor = node
        .child_by_field_name("constructor")
        .or_else(|| node.child(1))?;
    match ctor.kind() {
        "identifier" => Some(node_text(&ctor, source)),
        "member_expression" => named_child_text(&ctor, "property", source),
        _ => None,
    }
}

/// Nearest enclosing class context for class-scoped typeMap keys.
///
/// Mirrors the TS walk's `childTypeMapClass` propagation: a `class_declaration`
/// (or `abstract_class_declaration`) provides its name; a `class` *expression*
/// resets the context to None because the expression-internal name is never
/// visible to the resolver, preserving the `this.prop` key fallback.
fn enclosing_type_map_class<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    let mut cur = node.parent();
    while let Some(n) = cur {
        match n.kind() {
            "class_declaration" | "abstract_class_declaration" => {
                return n
                    .child_by_field_name("name")
                    .map(|name| node_text(&name, source));
            }
            "class" => return None,
            _ => {}
        }
        cur = n.parent();
    }
    None
}

fn match_js_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "variable_declarator" => handle_var_declarator_type_map(node, source, symbols),
        // Phase 8.3e: Object.defineProperty / defineProperties → composite pts key
        "call_expression" => seed_define_property_entries(node, source, symbols),
        "required_parameter" | "optional_parameter" => handle_param_type_map(node, source, symbols),
        // Phase 8.3d: property-write pts tracking.
        // Mirrors handlePropWriteTypeMap in src/extractors/javascript.ts.
        "assignment_expression" => handle_assignment_type_map(node, source, symbols),
        // TypeScript class field declarations.
        // Mirrors handleFieldDefTypeMap in src/extractors/javascript.ts.
        "public_field_definition" | "field_definition" => {
            handle_field_def_type_map(node, source, symbols)
        }
        // #2033: seed composite typeMap keys for object literals returned from a
        // factory function's body, mirroring the const/let/var declarator branch
        // above. Mirrors TS handleReturnStmtObjectLiteral's typeMap half.
        "return_statement" => handle_return_stmt_type_map(node, source, symbols),
        _ => {}
    }
}

/// Handle `variable_declarator` nodes in the type-map walk.
///
/// Seeds type-map entries from:
/// - type annotations (`confidence = 0.9`)
/// - constructor calls (`confidence = 1.0`)
/// - Object.create({ key: fn }) composite pts keys (Phase 8.3e)
/// - object-literal declarations at non-function scope (Phase 8.3f parity)
fn handle_var_declarator_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_n) = node.child_by_field_name("name") else {
        return;
    };
    if name_n.kind() != "identifier" {
        return;
    }
    let var_name = node_text(&name_n, source);
    // Also seed a function-scoped key alongside the bare one (#2235) — two
    // different functions in this file each declaring their own
    // differently-typed local of this same name would otherwise silently
    // collide under the bare key. Mirrors TS handleVarDeclaratorTypeMap.
    let enclosing_qualifier = find_enclosing_function_qualifier(node, source);
    let value_n = node.child_by_field_name("value");

    // Constructor and `as`-cast both win over a same-declaration type
    // annotation (checked first, before the annotation push below) — mirrors
    // TS handleVarDeclaratorTypeMap's early-return priority exactly. This
    // isn't just style: dedup_type_map is first-write-wins on confidence
    // TIES, and the cast is pushed at the SAME 0.9 tier as the annotation
    // (#2397 — `const db = new Database(...) as unknown as BetterSqlite3Database`
    // must resolve to BetterSqlite3Database, not whatever an unrelated
    // annotation on the same declarator might say), so simply pushing both
    // and relying on confidence comparison — as the constructor branch's
    // unambiguous 1.0-vs-0.9 gap already could — would silently let the
    // annotation win the tie instead of the cast.
    let mut explicit_initializer_seeded = false;
    if let Some(v) = &value_n {
        if v.kind() == "new_expression" {
            // Constructor: confidence 1.0 (overrides annotation in edge builder)
            if let Some(type_name) = extract_new_expr_type_name(v, source) {
                push_scoped_type_map_entry(
                    symbols,
                    enclosing_qualifier.as_deref(),
                    var_name,
                    type_name.to_string(),
                    1.0,
                );
                explicit_initializer_seeded = true;
            }
        } else if v.kind() == "as_expression" {
            if let Some(type_name) = extract_as_expression_type_name(v, source) {
                push_scoped_type_map_entry(
                    symbols,
                    enclosing_qualifier.as_deref(),
                    var_name,
                    type_name.to_string(),
                    0.9,
                );
                explicit_initializer_seeded = true;
            }
        }
    }
    // Type annotation: confidence 0.9 — only when neither of the above
    // already seeded a more authoritative entry from the initializer itself.
    if !explicit_initializer_seeded {
        if let Some(type_anno) = find_child(node, "type_annotation") {
            if let Some(type_name) = extract_simple_type_name(&type_anno, source) {
                push_scoped_type_map_entry(
                    symbols,
                    enclosing_qualifier.as_deref(),
                    var_name,
                    type_name.to_string(),
                    0.9,
                );
            }
        }
    }
    let Some(value_n) = value_n else {
        return;
    };
    // Phase 8.3e: Object.create({ key: fn }) → composite pts key per property
    if value_n.kind() == "call_expression" {
        seed_object_create_entries(var_name, &value_n, source, symbols);
        // Phase 8.2 (same-file): inter-procedural return-type propagation —
        // `const p = makePartition(42)` resolves `p`'s type from this file's OWN
        // return_type_map (already fully populated by match_js_return_type_map,
        // which runs before this walk) so a directly-returned self-typed object
        // literal (#2033's find_return_object_literal_self_type) — or any other
        // same-file annotated/inferred return type — lets `p.method()` resolve
        // through the qualified definition. Mirrors TS handleCallExprTypeMap's
        // resolveCallExprReturnType(depth=0) identifier branch. Cross-file
        // propagation (imported callees) is handled separately by
        // propagate_return_types_across_files in pipeline.rs, which only sees
        // imported names and therefore cannot cover this same-file case.
        if let Some(fn_n) = value_n.child_by_field_name("function") {
            if fn_n.kind() == "identifier" {
                let callee_name = node_text(&fn_n, source);
                let same_file_entry = symbols
                    .return_type_map
                    .iter()
                    .find(|e| e.name == callee_name)
                    .map(|e| (e.type_name.clone(), e.confidence));
                if let Some((type_name, confidence)) = same_file_entry {
                    let propagated = confidence - PROPAGATION_HOP_PENALTY;
                    if propagated > 0.0 {
                        push_scoped_type_map_entry(
                            symbols,
                            enclosing_qualifier.as_deref(),
                            var_name,
                            type_name,
                            propagated,
                        );
                    }
                }
            } else if fn_n.kind() == "member_expression" {
                // Factory method heuristic: `const x = Foo.create()` → type Foo,
                // confidence 0.7 (#2396). Mirrors TS handleCallExprTypeMap's
                // identical fallback. No explicit exclusion of Object.create is
                // needed here — "Object" is itself in JS_BUILTIN_GLOBALS, and this
                // branch is mutually exclusive with the identifier-callee
                // return-type-propagation branch above (a call's `function` field
                // is one node, never both kinds).
                if let Some(obj_n) = fn_n.child_by_field_name("object") {
                    if obj_n.kind() == "identifier" {
                        let obj_name = node_text(&obj_n, source);
                        if starts_with_uppercase_like_js(obj_name)
                            && !JS_BUILTIN_GLOBALS.contains(&obj_name)
                        {
                            push_scoped_type_map_entry(
                                symbols,
                                enclosing_qualifier.as_deref(),
                                var_name,
                                obj_name.to_string(),
                                0.7,
                            );
                        }
                    }
                }
            }
        }
    }
    // Phase 8.3f parity: seed composite typeMap keys for ALL object-literal
    // declarations (`const`, `let`, `var`) when at non-function scope.
    // Mirrors WASM handleVarDeclaratorTypeMap (no isConst guard there).
    // For `const`, extract_object_literal_functions already seeds these entries;
    // dedup_type_map collapses any duplicates at equal confidence.
    if value_n.kind() == "object"
        && find_parent_of_types(
            node,
            &[
                "function_declaration",
                "arrow_function",
                "function_expression",
                "method_definition",
                "generator_function_declaration",
                "generator_function",
            ],
        )
        .is_none()
    {
        seed_objlit_type_map_entries(var_name, &value_n, source, symbols);
    }
}

/// Handle `required_parameter` / `optional_parameter` nodes in the type-map walk.
///
/// Seeds a type-map entry when the parameter carries a TypeScript type annotation.
///
/// A plain typed parameter (`worker: IWorker`) seeds a direct entry keyed on
/// its own name. An object-rest-destructured parameter with a type
/// annotation (`{ ...rest }: IWorker`) has no single "name" — `name_node` is
/// an `object_pattern`, not an `identifier` — but the rest binding itself
/// (`rest`) is exactly what later property-access dispatch resolves
/// against, so it gets the SAME direct type-annotation seed (#2080), keyed
/// on the rest binding's own name. Mirrors `handleParamTypeMap` in
/// `src/extractors/javascript.ts`.
fn handle_param_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Also seed a function-scoped key alongside the bare one (#2235) — see
    // handle_var_declarator_type_map's identical rationale for local
    // variables, which applies equally to two different functions' own
    // same-named typed parameters.
    let enclosing_qualifier = find_enclosing_function_qualifier(node, source);
    let name_node = node
        .child_by_field_name("pattern")
        .or_else(|| node.child_by_field_name("left"))
        .or_else(|| node.child(0));
    let Some(name_node) = name_node else { return };
    if name_node.kind() == "identifier" {
        let Some(type_anno) = find_child(node, "type_annotation") else {
            return;
        };
        if let Some(type_name) = extract_simple_type_name(&type_anno, source) {
            push_scoped_type_map_entry(
                symbols,
                enclosing_qualifier.as_deref(),
                node_text(&name_node, source),
                type_name.to_string(),
                0.9,
            );
        }
        return;
    }
    if name_node.kind() != "object_pattern" {
        return;
    };
    // Only seed when the rest element is the pattern's ONLY member (`{
    // ...rest }: IWorker`) — if a named property sits alongside it (`{
    // doWork, ...rest }: IWorker`), TypeScript's own structural typing
    // excludes that property from `rest`'s real type (effectively
    // `Omit<IWorker, 'doWork'>`), so assigning the full `IWorker` type to
    // `rest` would let a call like `rest.doWork()` — invalid, since
    // `doWork` was destructured away — resolve a false edge via CHA
    // dispatch (#2080 review).
    for i in 0..name_node.child_count() {
        let Some(sibling) = name_node.child(i) else {
            continue;
        };
        let st = sibling.kind();
        if st == "{" || st == "}" || st == "," {
            continue;
        }
        if st != "rest_pattern" && st != "rest_element" {
            return;
        }
    }
    let Some(type_anno) = find_child(node, "type_annotation") else {
        return;
    };
    let Some(type_name) = extract_simple_type_name(&type_anno, source) else {
        return;
    };
    for i in 0..name_node.child_count() {
        let Some(inner) = name_node.child(i) else {
            continue;
        };
        if inner.kind() == "rest_pattern" || inner.kind() == "rest_element" {
            // rest_pattern/rest_element node: `...identifier` — the identifier
            // is at child index 1 (mirrors collect_object_rest_params).
            let rest_id = inner.child(1).or_else(|| inner.child_by_field_name("name"));
            if let Some(rest_id) = rest_id {
                if rest_id.kind() == "identifier" {
                    push_scoped_type_map_entry(
                        symbols,
                        enclosing_qualifier.as_deref(),
                        node_text(&rest_id, source),
                        type_name.to_string(),
                        0.9,
                    );
                }
            }
        }
    }
}

/// Handle `assignment_expression` nodes in the type-map walk.
///
/// Seeds two kinds of entries:
/// - `this.prop = new Ctor()` → class-scoped key `ClassName.prop` (confidence 1.0)
/// - `obj.prop = identifier` → composite key `obj.prop` (confidence 0.85)
///
/// Mirrors `handlePropWriteTypeMap` in `src/extractors/javascript.ts`.
fn handle_assignment_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let lhs = node.child_by_field_name("left");
    let rhs = node.child_by_field_name("right");
    let (Some(lhs), Some(rhs)) = (lhs, rhs) else {
        return;
    };
    if lhs.kind() != "member_expression" {
        return;
    }
    let obj = lhs.child_by_field_name("object");
    let prop = lhs.child_by_field_name("property");
    let (Some(obj), Some(prop)) = (obj, prop) else {
        return;
    };
    // Guard: only static property access, not computed subscripts.
    let prop_kind = prop.kind();
    if prop_kind != "property_identifier" && prop_kind != "identifier" {
        return;
    }
    if obj.kind() == "this" && rhs.kind() == "new_expression" {
        if let Some(ctor_type) = extract_new_expr_type_name(&rhs, source) {
            let key = match enclosing_type_map_class(node, source) {
                Some(class_name) => format!("{}.{}", class_name, node_text(&prop, source)),
                None => format!("this.{}", node_text(&prop, source)),
            };
            symbols.type_map.push(TypeMapEntry {
                name: key,
                type_name: ctor_type.to_string(),
                confidence: 1.0,
            });
        }
    } else if obj.kind() == "identifier" && rhs.kind() == "identifier" {
        let obj_name = node_text(&obj, source);
        if !is_js_builtin_global(obj_name) {
            let key = format!("{}.{}", obj_name, node_text(&prop, source));
            let rhs_name = node_text(&rhs, source).to_string();
            symbols.type_map.push(TypeMapEntry {
                name: key,
                type_name: rhs_name,
                confidence: 0.85,
            });
        }
    }
}

/// Handle `public_field_definition` / `field_definition` nodes in the type-map walk.
///
/// Seeds a class-scoped key `ClassName.field` (confidence 0.9) as the primary entry
/// so that two classes with identically-named fields don't overwrite each other's
/// typeMap entry (issue #1458). The resolver's `CallerClass.X` fallback looks up
/// exactly this key. Bare `field` and `this.field` keys are kept at lower confidence
/// (0.6) as fallbacks for single-class files where the resolver may lack callerClass.
///
/// Mirrors `handleFieldDefTypeMap` in `src/extractors/javascript.ts`.
fn handle_field_def_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"))
        .or_else(|| find_child(node, "property_identifier"));
    let Some(name_node) = name_node else { return };
    let kind = name_node.kind();
    if kind != "property_identifier"
        && kind != "identifier"
        && kind != "private_property_identifier"
    {
        return;
    }
    let field_name = node_text(&name_node, source).to_string();
    let Some(type_anno) = find_child(node, "type_annotation") else {
        return;
    };
    let Some(type_name) = extract_simple_type_name(&type_anno, source) else {
        return;
    };
    match enclosing_type_map_class(node, source) {
        Some(class_name) => {
            // Primary: class-scoped key prevents cross-class collision.
            set_type_map_entry(
                symbols,
                format!("{}.{}", class_name, field_name),
                type_name.to_string(),
                0.9,
            );
            // Fallback bare keys at lower confidence.
            set_type_map_entry(symbols, field_name.clone(), type_name.to_string(), 0.6);
            set_type_map_entry(
                symbols,
                format!("this.{}", field_name),
                type_name.to_string(),
                0.6,
            );
        }
        None => {
            // No enclosing class declaration (e.g. class expression)
            // — use bare keys only at full confidence.
            set_type_map_entry(symbols, field_name.clone(), type_name.to_string(), 0.9);
            set_type_map_entry(
                symbols,
                format!("this.{}", field_name),
                type_name.to_string(),
                0.9,
            );
        }
    }
}

/// Returns true for JS built-in global objects whose property writes should not be tracked.
/// Mirrors the TypeScript `BUILTIN_GLOBALS` set in `src/extractors/javascript.ts`.
fn is_js_builtin_global(name: &str) -> bool {
    matches!(
        name,
        "Math" | "JSON" | "Promise" | "Array" | "Object" | "Date" | "Error"
        | "Symbol" | "Map" | "Set" | "RegExp" | "Number" | "String" | "Boolean"
        | "WeakMap" | "WeakSet" | "WeakRef" | "Proxy" | "Reflect" | "Intl"
        // Binary/typed data
        | "ArrayBuffer" | "SharedArrayBuffer" | "DataView" | "Atomics" | "BigInt"
        | "Float32Array" | "Float64Array"
        | "Int8Array" | "Int16Array" | "Int32Array"
        | "Uint8Array" | "Uint16Array" | "Uint32Array" | "Uint8ClampedArray"
        // Web platform globals
        | "URL" | "URLSearchParams"
        | "TextEncoder" | "TextDecoder"
        | "AbortController" | "AbortSignal"
        | "Headers" | "Request" | "Response"
        | "FormData" | "Blob" | "File"
        | "ReadableStream" | "WritableStream" | "TransformStream"
        // Browser/runtime globals
        | "console" | "process" | "window" | "document" | "globalThis"
        // Node.js built-ins
        | "Buffer" | "EventEmitter" | "Stream"
    )
}

// ── Phase 8.3e: Object.defineProperty / defineProperties / create ────────────

/// Seed composite pts keys for `Object.defineProperty(obj, "key", { value: fn })`
/// and `Object.defineProperties(obj, { "key": { value: fn }, ... })`.
fn seed_define_property_entries(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(callee) = node.child_by_field_name("function") else {
        return;
    };
    if callee.kind() != "member_expression" {
        return;
    }
    let Some(callee_obj) = callee.child_by_field_name("object") else {
        return;
    };
    if node_text(&callee_obj, source) != "Object" {
        return;
    }
    let Some(callee_prop) = callee.child_by_field_name("property") else {
        return;
    };
    let method = node_text(&callee_prop, source);
    if method != "defineProperty" && method != "defineProperties" {
        return;
    }

    let args_node = node
        .child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args_node) = args_node else { return };

    // Collect non-punctuation argument nodes in order
    let mut args: Vec<Node> = Vec::new();
    for i in 0..args_node.child_count() {
        let Some(child) = args_node.child(i) else {
            continue;
        };
        if !matches!(child.kind(), "(" | ")" | ",") {
            args.push(child);
        }
    }

    if method == "defineProperty" {
        // Object.defineProperty(obj, "key", { value: fn }) or { get: getter }
        if args.len() < 3 {
            return;
        }
        if args[0].kind() != "identifier" {
            return;
        }
        let obj_name = node_text(&args[0], source);
        let Some(key) = extract_string_fragment(&args[1], source) else {
            return;
        };
        // Phase 8.3e: { value: fn } → obj.key pts to fn
        if let Some(target) = find_descriptor_value(&args[2], source) {
            symbols.type_map.push(TypeMapEntry {
                name: format!("{}.{}", obj_name, key),
                type_name: target.to_string(),
                confidence: 0.85,
            });
        }
        // Phase 8.3f: { get: getter } and/or { set: setter } → this inside each accessor === obj
        for accessor in find_descriptor_accessors(&args[2], source) {
            symbols.type_map.push(TypeMapEntry {
                name: format!("{}:this", accessor),
                type_name: obj_name.to_string(),
                confidence: 0.85,
            });
        }
    } else {
        // Object.defineProperties(obj, { "key": { value: fn }, ... })
        if args.len() < 2 {
            return;
        }
        if args[0].kind() != "identifier" {
            return;
        }
        let obj_name = node_text(&args[0], source).to_string();
        if args[1].kind() != "object" {
            return;
        }
        seed_descriptor_object(&obj_name, &args[1], source, symbols);
    }
}

/// Seed composite pts keys from `const obj = Object.create({ f1, f2 })`.
fn seed_object_create_entries(
    var_name: &str,
    call_node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    let Some(callee) = call_node.child_by_field_name("function") else {
        return;
    };
    if callee.kind() != "member_expression" {
        return;
    }
    let Some(callee_obj) = callee.child_by_field_name("object") else {
        return;
    };
    if node_text(&callee_obj, source) != "Object" {
        return;
    }
    let Some(callee_prop) = callee.child_by_field_name("property") else {
        return;
    };
    if node_text(&callee_prop, source) != "create" {
        return;
    }

    let args_node = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"));
    let Some(args_node) = args_node else { return };

    // First non-punctuation argument = prototype object
    let proto = (0..args_node.child_count())
        .filter_map(|i| args_node.child(i))
        .find(|n| !matches!(n.kind(), "(" | ")" | ","));
    let Some(proto) = proto else { return };
    if proto.kind() != "object" {
        return;
    };

    for i in 0..proto.child_count() {
        let Some(child) = proto.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier" => {
                // { f1 } shorthand — property name equals value name
                let name = node_text(&child, source);
                symbols.type_map.push(TypeMapEntry {
                    name: format!("{}.{}", var_name, name),
                    type_name: name.to_string(),
                    confidence: 0.85,
                });
            }
            "pair" => {
                let Some(key_n) = child.child_by_field_name("key") else {
                    continue;
                };
                let Some(val_n) = child.child_by_field_name("value") else {
                    continue;
                };
                if val_n.kind() != "identifier" {
                    continue;
                }
                let Some(key) = resolve_pair_key_name(&key_n, source) else {
                    continue;
                };
                symbols.type_map.push(TypeMapEntry {
                    name: format!("{}.{}", var_name, key),
                    type_name: node_text(&val_n, source).to_string(),
                    confidence: 0.85,
                });
            }
            _ => {}
        }
    }
}

/// Iterate over the properties of a `defineProperties` descriptor object and seed the type_map.
fn seed_descriptor_object(
    obj_name: &str,
    obj_node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        if child.kind() != "pair" {
            continue;
        }
        let Some(key_n) = child.child_by_field_name("key") else {
            continue;
        };
        let Some(val_n) = child.child_by_field_name("value") else {
            continue;
        };
        let Some(key) = resolve_pair_key_name(&key_n, source) else {
            continue;
        };
        let Some(target) = find_descriptor_value(&val_n, source) else {
            continue;
        };
        symbols.type_map.push(TypeMapEntry {
            name: format!("{}.{}", obj_name, key),
            type_name: target.to_string(),
            confidence: 0.85,
        });
    }
}

/// Extract the text of the `string_fragment` child of a string node, i.e. content without quotes.
fn extract_string_fragment<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if node.kind() != "string" {
        return None;
    }
    find_child(node, "string_fragment").map(|n| node_text(&n, source))
}

/// Find the `value` identifier in a property descriptor object `{ value: fn }`.
fn find_descriptor_value<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if node.kind() != "object" {
        return None;
    }
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() != "pair" {
            continue;
        }
        let Some(key) = child.child_by_field_name("key") else {
            continue;
        };
        if node_text(&key, source) != "value" {
            continue;
        }
        let Some(val) = child.child_by_field_name("value") else {
            continue;
        };
        if val.kind() == "identifier" {
            return Some(node_text(&val, source));
        }
    }
    None
}

/// Phase 8.3f: return the identifier texts of all `get` and `set` accessors in a property
/// descriptor. `{ get: getter, set: setter }` → ["getter", "setter"].
/// Returns all accessors so that each one gets a `callerName:this = obj` typeMap entry.
fn find_descriptor_accessors<'a>(node: &Node<'a>, source: &'a [u8]) -> Vec<&'a str> {
    if node.kind() != "object" {
        return Vec::new();
    }
    let mut result = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() != "pair" {
            continue;
        }
        let Some(key) = child.child_by_field_name("key") else {
            continue;
        };
        let key_text = node_text(&key, source);
        if key_text != "get" && key_text != "set" {
            continue;
        }
        let Some(val) = child.child_by_field_name("value") else {
            continue;
        };
        if val.kind() == "identifier" {
            result.push(node_text(&val, source));
        }
    }
    result
}

/// True when `declarator` is the shape `extract_object_literal_functions` qualifies: a plain
/// identifier name, outside any function scope. Mirrors TS `isEligibleObjectLiteralDeclarator`.
fn is_eligible_object_literal_declarator(declarator: &Node) -> bool {
    if declarator.kind() != "variable_declarator" {
        return false;
    }
    let Some(name_n) = declarator.child_by_field_name("name") else {
        return false;
    };
    if name_n.kind() != "identifier" {
        return false;
    }
    find_parent_of_types(declarator, &VAR_DECL_FN_SCOPE_TYPES).is_none()
}

/// True when `method_node` (a method_definition) is a shorthand method whose enclosing object
/// literal is the direct value of an eligible variable declarator (see
/// `is_eligible_object_literal_declarator`) AND has no enclosing class — the common shape
/// `extract_object_literal_functions` already emits both the qualified (`varName.method`) and
/// bare (`method`) definitions for, together, in source position order relative to the
/// declaration itself. `handle_method_def` skips these nodes to avoid pushing a second,
/// differently-positioned bare entry that makes native and WASM disagree on `definitions`
/// array order (#1818). Mirrors TS `isObjectLiteralDeclaratorMethod`.
///
/// The enclosing-class check excludes a rarer, unrelated nested shape — e.g. a const declared
/// inside a class `static { }` block (not itself function-scoped) — where `handle_method_def`
/// already produces a *class*-qualified entry (`ClassName.method`, via `find_parent_class`)
/// rather than a bare one; that entry must be left alone, not duplicated by a spurious bare push.
fn is_object_literal_declarator_method(method_node: &Node, source: &[u8]) -> bool {
    let Some(obj) = method_node.parent() else {
        return false;
    };
    if obj.kind() != "object" {
        return false;
    }
    let Some(declarator) = obj.parent() else {
        return false;
    };
    if !is_eligible_object_literal_declarator(&declarator) {
        return false;
    }
    find_parent_class(method_node, source).is_none()
}

/// Phase 8.3f: extract function/arrow properties from an object literal as standalone definitions
/// and seed composite typeMap keys so that `this.method()` inside Object.defineProperty accessors
/// can resolve them.
///
/// Definitions are emitted under qualified names (`obj.baz`) to avoid polluting the global
/// definition index with common property names like `init`, `run`, or `render`. The typeMap
/// value for function/arrow properties also uses the qualified name so the resolver calls
/// `lookup.byName("obj.baz")` rather than `lookup.byName("baz")`.
///
/// `const obj = { baz: () => {} }` → Definition { name: "obj.baz", kind: "function" }
///                                  + TypeMapEntry { name: "obj.baz", type_name: "obj.baz" }
/// `const obj = { baz }` (shorthand) → TypeMapEntry { name: "obj.baz", type_name: "baz" }
///
/// Called for ALL declaration kinds (`const`, `let`, `var`) — see `handle_var_decl`'s two call
/// sites. For `method_definition` children (shorthand methods), also emits the bare, unqualified
/// `Definition { name: "baz", kind: "method" }` that `handle_method_def` would otherwise produce
/// on its own — see `is_object_literal_declarator_method`, which it skips for exactly these
/// nodes so both entries are always emitted here together, in a fixed relative order (bare
/// first, matching the `findCaller` equal-span tie-break WASM relies on). Keeping them adjacent
/// (rather than one inline and one from a separate deferred pass) is what keeps native and WASM
/// agreeing on `definitions` array order (#1818).
fn extract_object_literal_functions(
    obj_node: &Node,
    source: &[u8],
    var_name: &str,
    symbols: &mut FileSymbols,
) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier" => {
                let prop_name = node_text(&child, source);
                symbols.type_map.push(TypeMapEntry {
                    name: format!("{}.{}", var_name, prop_name),
                    type_name: prop_name.to_string(),
                    confidence: 0.85,
                });
            }
            "pair" => {
                let Some(key_n) = child.child_by_field_name("key") else {
                    continue;
                };
                let Some(val_n) = child.child_by_field_name("value") else {
                    continue;
                };
                // Use resolve_pair_key_name to strip brackets from computed string keys
                // (e.g. ['foo'] → "foo") and skip non-string computed keys ([Symbol.iterator]),
                // mirroring resolve_method_def_name below.
                let Some(key) = resolve_pair_key_name(&key_n, source) else {
                    continue;
                };
                let qualified = format!("{}.{}", var_name, key);
                match val_n.kind() {
                    "arrow_function" | "function_expression" | "function" => {
                        // Use qualified name for the definition so it doesn't collide with
                        // unrelated top-level functions sharing the same property name.
                        symbols.definitions.push(Definition {
                            name: qualified.clone(),
                            kind: "function".to_string(),
                            line: start_line(&child),
                            end_line: Some(end_line(&val_n)),
                            decorators: None,
                            complexity: compute_all_metrics(&val_n, source, "javascript"),
                            cfg: build_function_cfg(&val_n, "javascript", source),
                            children: None,
                            bodyless: None,
                            content_hash: None,
                            accessor_kind: None,
                        });
                        // Store qualified name as value so resolver looks up the qualified def.
                        symbols.type_map.push(TypeMapEntry {
                            name: qualified.clone(),
                            type_name: qualified,
                            confidence: 0.85,
                        });
                    }
                    "identifier" => {
                        let target = node_text(&val_n, source);
                        symbols.type_map.push(TypeMapEntry {
                            name: qualified,
                            type_name: target.to_string(),
                            confidence: 0.85,
                        });
                    }
                    _ => {}
                }
            }
            "method_definition" => {
                // Use resolve_method_def_name to strip brackets from computed string keys
                // (e.g. ['foo'] → "foo") and skip non-string computed keys ([Symbol.iterator]).
                let Some(method_name) = resolve_method_def_name(&child, source) else {
                    continue;
                };
                let qualified = format!("{}.{}", var_name, method_name);
                // typeMap['obj.baz'] = 'baz' — points to the bare-name definition so
                // the two-step accessor dispatch resolves via the bare node.
                symbols.type_map.push(TypeMapEntry {
                    name: qualified.clone(),
                    type_name: method_name.clone(),
                    confidence: 0.85,
                });
                // Bare entry (when handle_method_def would have produced one — see
                // is_object_literal_declarator_method) then the qualified entry, adjacent —
                // matches WASM's extractObjectLiteralFunctions and keeps native/WASM
                // `definitions` array order aligned (#1818). When there's an enclosing class,
                // handle_method_def already pushes a class-qualified entry on its own.
                if is_object_literal_declarator_method(&child, source) {
                    let children = extract_js_parameters(&child, source);
                    symbols.definitions.push(Definition {
                        name: method_name,
                        kind: "method".to_string(),
                        line: start_line(&child),
                        end_line: Some(end_line(&child)),
                        decorators: None,
                        complexity: compute_all_metrics(&child, source, "javascript"),
                        cfg: build_function_cfg(&child, "javascript", source),
                        children: opt_children(children),
                        bodyless: None,
                        content_hash: None,
                        accessor_kind: None,
                    });
                }
                let body = child.child_by_field_name("body");
                symbols.definitions.push(Definition {
                    name: qualified,
                    kind: "function".to_string(),
                    line: start_line(&child),
                    end_line: Some(end_line(&child)),
                    decorators: None,
                    complexity: body.and_then(|b| compute_all_metrics(&b, source, "javascript")),
                    cfg: body.and_then(|b| build_function_cfg(&b, "javascript", source)),
                    children: None,
                    bodyless: None,
                    content_hash: None,
                    accessor_kind: None,
                });
            }
            _ => {}
        }
    }
}

/// Seed composite typeMap keys from an object literal for ALL declaration kinds
/// (`const`, `let`, `var`) at non-function scope.
///
/// Mirrors WASM `handleVarDeclaratorTypeMap`'s object-literal branch (no `isConst` guard).
/// Called from `match_js_type_map` so that `let obj = { f() {} }` and
/// `var routes = { get: handler }` resolve correctly just like `const` variants.
///
/// For `const` declarations this produces the same entries as `extract_object_literal_functions`,
/// but `dedup_type_map` collapses duplicates at equal confidence.
fn seed_objlit_type_map_entries(
    var_name: &str,
    obj_node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier" => {
                let prop_name = node_text(&child, source);
                symbols.type_map.push(TypeMapEntry {
                    name: format!("{}.{}", var_name, prop_name),
                    type_name: prop_name.to_string(),
                    confidence: 0.85,
                });
            }
            "pair" => {
                let Some(key_n) = child.child_by_field_name("key") else {
                    continue;
                };
                let Some(val_n) = child.child_by_field_name("value") else {
                    continue;
                };
                let Some(key) = resolve_pair_key_name(&key_n, source) else {
                    continue;
                };
                let qualified = format!("{}.{}", var_name, key);
                match val_n.kind() {
                    "arrow_function" | "function_expression" | "function" => {
                        // Store qualified name as value so the resolver finds the qualified def.
                        // Mirrors WASM: setTypeMapEntry(typeMap, qualifiedKey, qualifiedKey, 0.85).
                        // `extract_object_literal_functions` creates the matching definition
                        // inline for all declaration kinds (`const`, `let`, `var`) — see
                        // `handle_var_decl`'s two call sites.
                        symbols.type_map.push(TypeMapEntry {
                            name: qualified.clone(),
                            type_name: qualified,
                            confidence: 0.85,
                        });
                    }
                    "identifier" => {
                        let target = node_text(&val_n, source);
                        symbols.type_map.push(TypeMapEntry {
                            name: qualified,
                            type_name: target.to_string(),
                            confidence: 0.85,
                        });
                    }
                    _ => {}
                }
            }
            "method_definition" => {
                // Method shorthand: `let obj = { baz() {} }` → typeMap['obj.baz'] = 'baz'
                // Points to the bare-name definition so the two-step accessor dispatch resolves
                // via the bare node. `extract_object_literal_functions` creates both the bare
                // and qualified definitions inline for all declaration kinds (const/let/var) —
                // see `handle_var_decl`'s two call sites. Using the bare name here keeps
                // resolution consistent across all declaration kinds.
                let Some(method_name) = resolve_method_def_name(&child, source) else {
                    continue;
                };
                let qualified = format!("{}.{}", var_name, method_name);
                symbols.type_map.push(TypeMapEntry {
                    name: qualified,
                    type_name: method_name.to_string(),
                    confidence: 0.85,
                });
            }
            _ => {}
        }
    }
}

/// Return the qualifier name for the nearest enclosing function scope of `node` —
/// walks up `VAR_DECL_FN_SCOPE_TYPES` ancestors and names the match the same way
/// `extract_object_literal_functions`'s const/let/var declarator call sites name
/// their `var_name` qualifier (#2033). Used to extend that qualified-definition
/// mechanism to object literals `return`ed from a factory function's body, e.g.
/// `function makePartition(seed) { return { deltaCPM: (v) => computeDeltaCPM(s, v) } }`
/// qualifies the property as `makePartition.deltaCPM`. Mirrors TS
/// `findEnclosingFunctionQualifier`.
///
/// Returns `None` when the enclosing scope has no resolvable name — an anonymous
/// function expression/arrow that isn't directly assigned to a variable (e.g. an
/// inline callback argument, an IIFE) — callers skip the qualified extraction in
/// that case and fall back to the pre-existing generic caller-attribution behavior.
fn find_enclosing_function_qualifier(node: &Node, source: &[u8]) -> Option<String> {
    let fn_node = find_parent_of_types(node, &VAR_DECL_FN_SCOPE_TYPES)?;
    qualifier_for_function_scope_node(&fn_node, source)
}

/// Derive the qualifier name for a single function-scope node — see
/// `find_enclosing_function_qualifier`. Mirrors TS `qualifierForFunctionScopeNode`
/// (and the naming convention `handle_method_def`/`handle_var_decl`'s arrow-value
/// branch already use for the same node shapes).
fn qualifier_for_function_scope_node(fn_node: &Node, source: &[u8]) -> Option<String> {
    match fn_node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            let name_n = fn_node.child_by_field_name("name")?;
            if name_n.kind() != "identifier" {
                return None;
            }
            Some(node_text(&name_n, source).to_string())
        }
        "method_definition" => {
            let method_name = resolve_method_def_name(fn_node, source)?;
            Some(match find_parent_class(fn_node, source) {
                Some(cls) => format!("{}.{}", cls, method_name),
                None => method_name,
            })
        }
        _ => {
            // function_expression / generator_function / arrow_function: prefer a
            // named function expression's own name field, then fall back to the
            // variable it's directly assigned to (`const foo = () => {...}`) —
            // mirroring the arrow-value branch of `handle_var_decl`. Anonymous,
            // non-assigned closures (inline callbacks, IIFEs) have no resolvable
            // qualifier.
            if let Some(name_n) = fn_node.child_by_field_name("name") {
                if name_n.kind() == "identifier" {
                    return Some(node_text(&name_n, source).to_string());
                }
            }
            let parent = fn_node.parent()?;
            if parent.kind() == "variable_declarator" {
                let value_n = parent.child_by_field_name("value")?;
                if value_n.id() == fn_node.id() {
                    let name_n = parent.child_by_field_name("name")?;
                    if name_n.kind() == "identifier" {
                        return Some(node_text(&name_n, source).to_string());
                    }
                }
            }
            None
        }
    }
}

/// Return the object-literal expression of a `return { ... };` statement, or
/// `None` when the statement doesn't return a bare object literal (#2033).
/// Mirrors TS `findReturnedObjectLiteral` — no parenthesized-wrapper unwrapping,
/// matching that function's existing scope.
fn find_returned_object_literal<'a>(return_node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..return_node.child_count() {
        let Some(child) = return_node.child(i) else {
            continue;
        };
        if child.kind() == "object" {
            return Some(child);
        }
    }
    None
}

/// Qualify a `return { ... }` statement's object-literal properties against its
/// enclosing named function (#2033) — Rust mirror of the definitions half of TS
/// `handleReturnStmtObjectLiteral`. See that function's doc comment (in
/// `src/extractors/javascript.ts`) for the full rationale: this extends
/// `extract_object_literal_functions`'s qualified-definition mechanism
/// (previously only reachable via a `const x = {...}` variable declarator) to
/// object literals returned directly from a factory function's body, so
/// `findCaller`/its Rust equivalent attribute calls inside the property's
/// closure to the qualified property definition rather than the factory itself.
fn handle_return_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(obj_node) = find_returned_object_literal(node) else {
        return;
    };
    let Some(qualifier) = find_enclosing_function_qualifier(node, source) else {
        return;
    };
    extract_object_literal_functions(&obj_node, source, &qualifier, symbols);
}

/// Type-map half of `handle_return_stmt` — mirrors TS
/// `handleReturnStmtObjectLiteral`'s `handleObjectLiteralTypeMap` call, so
/// `const p = makePartition(42); p.deltaModularity(1)` resolves through the
/// qualified definition too, once `store_return_type`'s sibling self-type
/// inference (see `find_return_object_literal_self_type`) types `p` as
/// `makePartition`.
fn handle_return_stmt_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(obj_node) = find_returned_object_literal(node) else {
        return;
    };
    let Some(qualifier) = find_enclosing_function_qualifier(node, source) else {
        return;
    };
    seed_objlit_type_map_entries(&qualifier, &obj_node, source, symbols);
}

// ── Return-type map extraction (Phase 8.2 parity) ───────────────────────────

/// Walk the AST collecting function/method return types into `symbols.return_type_map`.
/// Mirrors `extractReturnTypeMapWalk` in src/extractors/javascript.ts.
fn match_js_return_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            let Some(name_n) = node.child_by_field_name("name") else {
                return;
            };
            let fn_name = node_text(&name_n, source);
            if fn_name == "constructor" {
                return;
            }
            // Use the boundary-aware variant: nested function declarations inside
            // method bodies must not inherit the class prefix (matches WASM behaviour).
            let key = match find_parent_class_no_fn_boundary(node, source) {
                Some(cls) => format!("{}.{}", cls, fn_name),
                None => fn_name.to_string(),
            };
            store_return_type(node, &key, source, symbols);
        }
        "method_definition" => {
            let Some(name_n) = node.child_by_field_name("name") else {
                return;
            };
            let method_name = node_text(&name_n, source);
            if method_name == "constructor" {
                return;
            }
            // method_definition is always a direct child of class_body — plain
            // find_parent_class is correct here.
            let key = match find_parent_class(node, source) {
                Some(cls) => format!("{}.{}", cls, method_name),
                None => method_name.to_string(),
            };
            store_return_type(node, &key, source, symbols);
        }
        "variable_declarator" => {
            let Some(name_n) = node.child_by_field_name("name") else {
                return;
            };
            if name_n.kind() != "identifier" {
                return;
            }
            let Some(value_n) = node.child_by_field_name("value") else {
                return;
            };
            // Only arrow_function, function_expression and generator_function match the TS reference;
            // "function" is not a valid tree-sitter value-expression kind here.
            if !matches!(
                value_n.kind(),
                "arrow_function" | "function_expression" | "generator_function"
            ) {
                return;
            }
            let var_name = node_text(&name_n, source);
            // Use the boundary-aware variant for the same reason as function_declaration.
            let key = match find_parent_class_no_fn_boundary(node, source) {
                Some(cls) => format!("{}.{}", cls, var_name),
                None => var_name.to_string(),
            };
            store_return_type(&value_n, &key, source, symbols);
        }
        _ => {}
    }
}

/// Extract the return type of `fn_node` and push it into `symbols.return_type_map`.
/// Prefers explicit return type annotation (confidence 1.0) over inferred `return new X()`
/// (confidence 0.85). Higher confidence wins on conflict.
fn store_return_type(fn_node: &Node, fn_name: &str, source: &[u8], symbols: &mut FileSymbols) {
    // Explicit return type annotation
    if let Some(ret_type_node) = fn_node.child_by_field_name("return_type") {
        if let Some(type_name) = extract_simple_type_name(&ret_type_node, source) {
            push_return_type_entry(symbols, fn_name, type_name, 1.0);
            return;
        }
    }
    // Infer from first `return new Constructor()` in body, then from a
    // directly-returned object literal with callable properties (#2033). Skipped
    // for async/generator functions: their runtime return value is a Promise/
    // Generator wrapper around the returned expression, not the expression
    // itself, so `const p = asyncMakeThing(); p.method()` would otherwise
    // wrongly resolve through a definition that only exists once the wrapper is
    // unwrapped (`await`ed or iterated) — neither inference is valid without
    // that unwrap. Mirrors TS storeReturnType's guard.
    if !is_async_function_node(fn_node) && !is_generator_function_node(fn_node) {
        if let Some(body) = fn_node.child_by_field_name("body") {
            if let Some(type_name) = find_return_new_expr_type(&body, source) {
                push_return_type_entry(symbols, fn_name, type_name, 0.85);
            } else if find_return_object_literal_self_type(&body) {
                push_return_type_entry(symbols, fn_name, fn_name, 0.85);
            }
        }
    }
}

/// True when a function/method node carries an `async` modifier — tree-sitter
/// represents `async` (like `get`/`set`/`static`) as a literal unnamed token
/// child, not a dedicated field. Scans all direct children since only the
/// modifier keyword itself ever has `kind() == "async"` (an identifier/
/// parameter/statement named "async" has kind `identifier`, not `async`).
/// Mirrors TS `isAsyncFunctionNode`.
fn is_async_function_node(fn_node: &Node) -> bool {
    for i in 0..fn_node.child_count() {
        if fn_node.child(i).map(|c| c.kind()) == Some("async") {
            return true;
        }
    }
    false
}

/// True when a function/method node is a generator — `function_declaration`/
/// `function_expression` distinguish this via a dedicated node kind
/// (`generator_function_declaration`/`generator_function`), but
/// `method_definition` (ES6 shorthand `*method() {}`) has no such distinct kind
/// and instead carries a literal `*` token child, mirroring
/// `is_async_function_node`'s modifier-token scan. Mirrors TS
/// `isGeneratorFunctionNode`.
fn is_generator_function_node(fn_node: &Node) -> bool {
    if matches!(
        fn_node.kind(),
        "generator_function_declaration" | "generator_function"
    ) {
        return true;
    }
    for i in 0..fn_node.child_count() {
        if fn_node.child(i).map(|c| c.kind()) == Some("*") {
            return true;
        }
    }
    false
}

/// Scan direct children of `body` for the first `return new X()` and return the constructor name.
fn find_return_new_expr_type<'a>(body: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    for i in 0..body.child_count() {
        let Some(child) = body.child(i) else { continue };
        if child.kind() != "return_statement" {
            continue;
        }
        for j in 0..child.child_count() {
            let Some(expr) = child.child(j) else { continue };
            if expr.kind() == "new_expression" {
                return extract_new_expr_type_name(&expr, source);
            }
        }
    }
    None
}

/// #2033: self-referential return-type inference for a factory function whose body
/// directly returns an object literal with at least one callable property (function/
/// arrow/method value) — paired with `handle_return_stmt`'s qualified `fn_name.prop_name`
/// definitions so `const p = fn_name(...); p.prop_name()` resolves: Phase 8.2's
/// inter-procedural propagation types `p` as `fn_name`, and the resolver's
/// prototype-alias step then finds the qualified definition via the typeMap entry
/// `handle_return_stmt_type_map` seeds for it. Mirrors TS `findReturnObjectLiteralSelfType`.
///
/// Only top-level return statements are checked, mirroring `find_return_new_expr_type`.
fn find_return_object_literal_self_type(body: &Node) -> bool {
    for i in 0..body.child_count() {
        let Some(child) = body.child(i) else { continue };
        if child.kind() != "return_statement" {
            continue;
        }
        if let Some(obj_node) = find_returned_object_literal(&child) {
            if object_literal_has_callable_property(&obj_node) {
                return true;
            }
        }
    }
    false
}

/// True when `obj_node` (an object literal) has at least one function/arrow/method
/// property — mirrors `extract_object_literal_functions`' own shape detection so
/// `find_return_object_literal_self_type` only self-types functions that actually
/// get a qualified definition. Mirrors TS `objectLiteralHasCallableProperty`.
fn object_literal_has_callable_property(obj_node: &Node) -> bool {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        match child.kind() {
            "method_definition" => return true,
            "pair" => {
                if let Some(value_n) = child.child_by_field_name("value") {
                    if matches!(
                        value_n.kind(),
                        "arrow_function" | "function_expression" | "function"
                    ) {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// Append a `(fn_name → type_name)` entry to `return_type_map`.
/// Deduplication (highest-confidence-wins) is handled in bulk by
/// [`dedup_type_map`] at the end of `extract()`.
fn push_return_type_entry(
    symbols: &mut FileSymbols,
    fn_name: &str,
    type_name: &str,
    confidence: f64,
) {
    symbols.return_type_map.push(TypeMapEntry {
        name: fn_name.to_string(),
        type_name: type_name.to_string(),
        confidence,
    });
}

// ── Prototype-method extraction ─────────────────────────────────────────────

/// Walk the AST collecting pre-ES6 prototype assignments.
///
/// Mirrors `extractPrototypeMethodsWalk` in `src/extractors/javascript.ts`.
///
/// Three patterns are handled:
///   1. `Foo.prototype.bar = function(){}`  → emits `Foo.bar` as a method definition
///   2. `Foo.prototype.bar = identifier`    → seeds `typeMap['Foo.bar'] = identifier`
///   3. `Foo.prototype = { bar: fn, ... }`  → same rules applied per property
fn match_js_prototype_methods(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    _depth: usize,
) {
    if node.kind() != "expression_statement" {
        return;
    }
    let Some(expr) = node.child(0) else { return };
    if expr.kind() != "assignment_expression" {
        return;
    }
    let lhs = expr.child_by_field_name("left");
    let rhs = expr.child_by_field_name("right");
    if let (Some(lhs), Some(rhs)) = (lhs, rhs) {
        handle_js_prototype_assignment(&lhs, &rhs, source, symbols);
    }
}

fn handle_js_prototype_assignment(
    lhs: &Node,
    rhs: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    if lhs.kind() != "member_expression" {
        return;
    }
    let Some(lhs_obj) = lhs.child_by_field_name("object") else {
        return;
    };
    let Some(lhs_prop) = lhs.child_by_field_name("property") else {
        return;
    };

    // Pattern 1: `Foo.prototype.bar = rhs`
    // lhs.object is `Foo.prototype` (member_expression), lhs.property is `bar`
    if lhs_obj.kind() == "member_expression"
        && matches!(lhs_prop.kind(), "property_identifier" | "identifier")
    {
        let proto_obj = lhs_obj.child_by_field_name("object");
        let proto_prop = lhs_obj.child_by_field_name("property");
        if let (Some(proto_obj), Some(proto_prop)) = (proto_obj, proto_prop) {
            if proto_obj.kind() == "identifier"
                && node_text(&proto_prop, source) == "prototype"
                && !is_js_builtin_global(node_text(&proto_obj, source))
            {
                emit_js_prototype_method(
                    node_text(&proto_obj, source),
                    node_text(&lhs_prop, source),
                    rhs,
                    source,
                    symbols,
                );
            }
        }
        return;
    }

    // Pattern 2: `Foo.prototype = { bar: fn, ... }`
    // lhs.object is `Foo` (identifier), lhs.property is `prototype`, rhs is object literal
    if lhs_obj.kind() == "identifier"
        && node_text(&lhs_prop, source) == "prototype"
        && !is_js_builtin_global(node_text(&lhs_obj, source))
        && rhs.kind() == "object"
    {
        extract_js_prototype_object_literal(node_text(&lhs_obj, source), rhs, source, symbols);
        return;
    }

    // Pattern 3: `fn.method = function(){}` / `fn.method = () => {}` — function-as-
    // object-property method definitions (#1432). Mirrors `handleFuncPropAssignment`
    // in src/extractors/javascript.ts: bare-identifier receiver that is not a builtin
    // global, property other than `prototype`, RHS a function or arrow. Emitting these
    // natively lets the Rust edge builder resolve `obj.method()` call sites in-build
    // (via the direct qualified lookup) and removes the WASM re-parse post-pass that
    // previously backfilled them on every native build.
    if lhs_obj.kind() == "identifier"
        && matches!(lhs_prop.kind(), "property_identifier" | "identifier")
        && node_text(&lhs_prop, source) != "prototype"
        && !is_js_builtin_global(node_text(&lhs_obj, source))
        && matches!(rhs.kind(), "function_expression" | "arrow_function")
    {
        let children = extract_js_parameters(rhs, source);
        symbols.definitions.push(Definition {
            name: format!(
                "{}.{}",
                node_text(&lhs_obj, source),
                node_text(&lhs_prop, source)
            ),
            kind: "method".to_string(),
            line: start_line(rhs),
            end_line: Some(end_line(rhs)),
            decorators: None,
            complexity: compute_all_metrics(rhs, source, "javascript"),
            cfg: build_function_cfg(rhs, "javascript", source),
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

/// Emit one prototype method definition or typeMap alias for `ClassName.methodName = rhs`.
///
/// Mirrors `emitPrototypeMethod` in `src/extractors/javascript.ts`.
fn emit_js_prototype_method(
    class_name: &str,
    method_name: &str,
    rhs: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    let full_name = format!("{}.{}", class_name, method_name);
    match rhs.kind() {
        "function_expression" | "arrow_function" => {
            let children = extract_js_parameters(rhs, source);
            symbols.definitions.push(Definition {
                name: full_name,
                kind: "method".to_string(),
                line: start_line(rhs),
                end_line: Some(end_line(rhs)),
                decorators: None,
                complexity: compute_all_metrics(rhs, source, "javascript"),
                cfg: build_function_cfg(rhs, "javascript", source),
                children: opt_children(children),
                bodyless: None,
                content_hash: None,
                accessor_kind: None,
            });
        }
        "identifier" => {
            let rhs_name = node_text(rhs, source);
            if !is_js_builtin_global(rhs_name) {
                push_type_map_entry(symbols, full_name, rhs_name.to_string());
            }
        }
        _ => {}
    }
}

/// Iterate over an object literal assigned to `Foo.prototype` and emit definitions/aliases.
///
/// Mirrors `extractPrototypeObjectLiteral` in `src/extractors/javascript.ts`.
fn extract_js_prototype_object_literal(
    class_name: &str,
    obj_node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        match child.kind() {
            "method_definition" => {
                let Some(method_name) = resolve_method_def_name(&child, source) else {
                    continue;
                };
                let children = extract_js_parameters(&child, source);
                symbols.definitions.push(Definition {
                    name: format!("{}.{}", class_name, method_name),
                    kind: "method".to_string(),
                    line: start_line(&child),
                    end_line: Some(end_line(&child)),
                    decorators: None,
                    complexity: compute_all_metrics(&child, source, "javascript"),
                    cfg: build_function_cfg(&child, "javascript", source),
                    children: opt_children(children),
                    bodyless: None,
                    content_hash: None,
                    accessor_kind: None,
                });
            }
            "shorthand_property_identifier" => {
                let prop_name = node_text(&child, source);
                if !is_js_builtin_global(prop_name) {
                    push_type_map_entry(
                        symbols,
                        format!("{}.{}", class_name, prop_name),
                        prop_name.to_string(),
                    );
                }
            }
            "pair" => {
                let key_node = child.child_by_field_name("key");
                let value_node = child.child_by_field_name("value");
                if let (Some(key_node), Some(value_node)) = (key_node, value_node) {
                    let Some(method_name) = resolve_pair_key_name(&key_node, source) else {
                        continue;
                    };
                    if method_name.is_empty() {
                        continue;
                    }
                    emit_js_prototype_method(
                        class_name,
                        &method_name,
                        &value_node,
                        source,
                        symbols,
                    );
                }
            }
            _ => {}
        }
    }
}

// ── Call-assignment extraction (Phase 8.2 parity) ───────────────────────────

/// Walk the AST recording variable assignments from call expressions into
/// `symbols.call_assignments` for cross-file return-type propagation.
/// Mirrors `recordCallAssignment` in src/extractors/javascript.ts.
fn match_js_call_assignments(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    if node.kind() != "variable_declarator" {
        return;
    }
    let Some(name_n) = node.child_by_field_name("name") else {
        return;
    };
    if name_n.kind() != "identifier" {
        return;
    }
    let Some(value_n) = node.child_by_field_name("value") else {
        return;
    };
    if value_n.kind() != "call_expression" {
        return;
    }

    let var_name = node_text(&name_n, source).to_string();
    let Some(fn_node) = value_n.child_by_field_name("function") else {
        return;
    };

    match fn_node.kind() {
        "identifier" => {
            symbols.call_assignments.push(NativeCallAssignment {
                var_name,
                callee_name: node_text(&fn_node, source).to_string(),
                receiver_type_name: None,
                receiver_var_name: None,
                unwrap_depth: 0,
            });
        }
        "member_expression" => {
            let Some(obj) = fn_node.child_by_field_name("object") else {
                return;
            };
            let Some(prop) = fn_node.child_by_field_name("property") else {
                return;
            };
            if obj.kind() != "identifier" {
                return;
            }
            let receiver_type = symbols
                .type_map
                .iter()
                .find(|e| e.name == node_text(&obj, source))
                .map(|e| e.type_name.clone());
            symbols.call_assignments.push(NativeCallAssignment {
                var_name,
                callee_name: node_text(&prop, source).to_string(),
                receiver_type_name: receiver_type,
                receiver_var_name: None,
                unwrap_depth: 0,
            });
        }
        _ => {}
    }
}

fn match_js_node(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    _depth: usize,
    callback_param_shapes: &CallbackParamShapes,
) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => handle_function_decl(node, source, symbols),
        "class_declaration" | "abstract_class_declaration"
        // class expressions: `return class Foo extends Bar { ... }` or `const X = class Foo { ... }`
        | "class" => {
            handle_class_decl(node, source, symbols)
        }
        "class_static_block" => handle_static_block(node, source, symbols),
        "method_definition" => handle_method_def(node, source, symbols),
        "field_definition" | "public_field_definition" => handle_field_def(node, source, symbols),
        "interface_declaration" => handle_interface_decl(node, source, symbols),
        "type_alias_declaration" => handle_type_alias(node, source, symbols),
        "enum_declaration" => handle_enum_decl(node, source, symbols),
        "lexical_declaration" | "variable_declaration" => handle_var_decl(node, source, symbols),
        "call_expression" => handle_call_expr(node, source, symbols, callback_param_shapes),
        "jsx_opening_element" | "jsx_self_closing_element" => {
            handle_jsx_element_ref(node, source, &mut symbols.calls)
        }
        "new_expression" => handle_new_expr(node, source, symbols),
        "decorator" => handle_decorator(node, source, symbols),
        "import_statement" => handle_import_stmt(node, source, symbols),
        "export_statement" => handle_export_stmt(node, source, symbols),
        "expression_statement" => handle_expr_stmt(node, source, symbols),
        // #1771: dispatch-table-style object-literal property values
        // (`{ resolve: someFunction }` / shorthand `{ someFunction }`).
        "pair" => handle_object_literal_pair_value_ref(node, source, symbols),
        "shorthand_property_identifier" => {
            handle_object_literal_shorthand_value_ref(node, source, symbols)
        }
        // #1784: `instanceof ClassName` checks, e.g. `err instanceof CodegraphError`.
        "binary_expression" => handle_instanceof_value_ref(node, source, &mut symbols.calls),
        // #2033: qualify object literals returned from a factory function's body
        // against that function's name, so calls inside a returned property's
        // closure attribute to the property (`makePartition.deltaCPM`), not the
        // factory itself.
        "return_statement" => handle_return_stmt(node, source, symbols),
        _ => {}
    }
}

// ── Per-node-kind handlers for walk_node_depth ───────────────────────────────

fn handle_function_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let children = extract_js_parameters(node, source);
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "function".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "javascript"),
            cfg: build_function_cfg(node, "javascript", source),
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let class_name = node_text(&name_node, source).to_string();
    let children = extract_js_class_properties(node, source);
    symbols.definitions.push(Definition {
        name: class_name.clone(),
        kind: "class".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(children),
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });

    // Heritage: extends + implements
    let heritage = node
        .child_by_field_name("heritage")
        .or_else(|| find_child(node, "class_heritage"));
    if let Some(heritage) = heritage {
        if let Some(super_name) = extract_superclass(&heritage, source) {
            symbols.classes.push(ClassRelation {
                name: class_name.clone(),
                extends: Some(super_name),
                implements: None,
                line: start_line(node),
            });
        }
        for iface in extract_implements(&heritage, source) {
            symbols.classes.push(ClassRelation {
                name: class_name.clone(),
                extends: None,
                implements: Some(iface),
                line: start_line(node),
            });
        }
    }
}

/// Unwrap a `computed_property_name` node (e.g. `['foo']`) to its inner string-literal text
/// with quotes stripped, or `None` when the computed key isn't a plain string literal (e.g.
/// `[Symbol.iterator]`, `[x]`) — there's no statically resolvable name in that case.
fn resolve_computed_key_name(computed_node: &Node, source: &[u8]) -> Option<String> {
    // child(0)='[', child(1)=inner expression, child(2)=']'
    let inner = computed_node.child(1)?;
    match inner.kind() {
        "string" => {
            let s = extract_string_fragment(&inner, source).unwrap_or("");
            if s.is_empty() {
                return None;
            }
            Some(s.to_string())
        }
        "string_fragment" => {
            let s = node_text(&inner, source);
            if s.is_empty() {
                return None;
            }
            Some(s.to_string())
        }
        _ => None, // non-string computed key — skip
    }
}

/// Extract the plain method name from a `method_definition` node.
///
/// For computed property names (`['methodName']`), strips brackets and quotes from
/// string-literal keys so the stored name matches the plain identifier used at call
/// sites (`obj.methodName()`). Non-string computed keys like `[Symbol.iterator]`
/// cannot be resolved at dot-notation call sites — returns `None` for those. Plain
/// quoted keys (`'methodName'() {}`, kind `"string"`) also have their quotes
/// stripped, mirroring `resolve_pair_key_name`'s handling of the same case.
fn resolve_method_def_name(node: &Node, source: &[u8]) -> Option<String> {
    let name_node = node.child_by_field_name("name")?;
    match name_node.kind() {
        "string" => extract_string_fragment(&name_node, source).map(|s| s.to_string()),
        "computed_property_name" => resolve_computed_key_name(&name_node, source),
        _ => Some(node_text(&name_node, source).to_string()),
    }
}

/// Resolve an object-literal `pair` node's key field to its plain string form.
///
/// Mirrors `resolve_method_def_name`'s computed-key handling so `{ ['foo']: () => {} }` and
/// `{ ['foo']() {} }` resolve identically: quoted string keys have their quotes stripped,
/// computed string-literal keys (`['foo']`) are unwrapped, and non-string computed keys
/// (e.g. `[Symbol.iterator]`) return `None` (no resolvable name — caller skips the pair)
/// rather than falling back to the raw bracket/quote source text.
fn resolve_pair_key_name(key_n: &Node, source: &[u8]) -> Option<String> {
    match key_n.kind() {
        "string" => extract_string_fragment(key_n, source).map(|s| s.to_string()),
        "computed_property_name" => resolve_computed_key_name(key_n, source),
        _ => Some(node_text(key_n, source).to_string()),
    }
}

fn handle_method_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(method_name) = resolve_method_def_name(node, source) {
        // extract_object_literal_functions already emits this node's bare + qualified
        // definitions together (#1818) — skip here to avoid a duplicate, differently-
        // positioned bare entry.
        if is_object_literal_declarator_method(node, source) {
            return;
        }
        let method_name = method_name.as_str();
        let parent_class = find_parent_class(node, source);
        let full_name = match parent_class {
            Some(cls) => format!("{}.{}", cls, method_name),
            None => method_name.to_string(),
        };
        let children = extract_js_parameters(node, source);
        // #2030: persist which ES6 accessor kind (if any) this method is, so
        // a global (whole-build) accessor registry can confirm cross-file
        // property reads at resolution time — see
        // handle_accessor_property_read below.
        let accessor_kind = get_method_accessor_kind(node).map(|k| k.to_string());
        symbols.definitions.push(Definition {
            name: full_name,
            kind: "method".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "javascript"),
            cfg: build_function_cfg(node, "javascript", source),
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind,
        });
    }
}

// ── ES6 getter/setter property-read call attribution (#1893, #2030) ────────
//
// A bare (non-call) property read/write on an ES6 `get`/`set` class accessor
// (`obj.isReady`, no call parens) invokes the accessor function just as surely
// as `obj.isReady()` would if written explicitly — but call-site extraction
// only ever looked at `member_expression` nodes used as a call_expression's
// callee, so accessor reads/writes never produced a `calls` edge at all.
// Mirrors `collectAccessorPropertyRead` in `src/extractors/javascript.ts`.
//
// Two confirmation tiers — see `handle_accessor_property_read`'s doc comment:
//   1. Same-file (#1893): `this.prop`, or `varName.prop` where `varName`'s
//      type is a class also declared in this file — confirmed directly via
//      this file's own `local_accessors` registry below.
//   2. Cross-file (#2030): `varName.prop` where the type isn't declared in
//      this file — emitted as a tagged candidate for the resolver's global
//      accessor-kind filter to confirm once every file's accessors are known.

/// Per-property record of which accessor kinds a same-file class declares —
/// instance and static accessors tracked separately (#2086). `this` inside
/// an instance method never refers to the class/constructor object (where
/// `static` members live) — only `this` inside a static method does — so a
/// bare `this.prop` read must only ever match the bucket corresponding to
/// its own calling context, never the other one.
#[derive(Default, Clone, Copy)]
struct LocalAccessorInfo {
    get: bool,
    set: bool,
    static_get: bool,
    static_set: bool,
}

/// `ClassName.propName` → which accessor kinds are declared, for this file only.
type LocalAccessorRegistry = HashMap<String, LocalAccessorInfo>;

/// True when `meth_node` (a method_definition) carries a `get` or `set`
/// accessor modifier — an unnamed token child preceding the `name` field
/// (tree-sitter represents `get`/`set`/`static`/`async` as literal unnamed
/// children, not a dedicated field). Returns `None` for a plain method.
fn get_method_accessor_kind(meth_node: &Node) -> Option<&'static str> {
    let name_node = meth_node.child_by_field_name("name");
    for i in 0..meth_node.child_count() {
        let Some(child) = meth_node.child(i) else {
            continue;
        };
        if Some(child.id()) == name_node.map(|n| n.id()) {
            break;
        }
        match child.kind() {
            "get" => return Some("get"),
            "set" => return Some("set"),
            _ => {}
        }
    }
    None
}

/// True when `meth_node` (a method_definition) carries a `static` modifier —
/// same unnamed-token-child shape `get_method_accessor_kind` scans for (#2086).
fn is_static_method_definition(meth_node: &Node) -> bool {
    let name_node = meth_node.child_by_field_name("name");
    for i in 0..meth_node.child_count() {
        let Some(child) = meth_node.child(i) else {
            continue;
        };
        if Some(child.id()) == name_node.map(|n| n.id()) {
            break;
        }
        if child.kind() == "static" {
            return true;
        }
    }
    false
}

/// Walk up from `node` to the nearest enclosing `method_definition` and
/// report whether it is static — determines whether a `this.prop` read's
/// calling context refers to the class object (static) or an instance
/// (#2086). Only meaningful once the caller has already confirmed (via
/// `find_parent_class_for_this_binding`) that no this-rebinding boundary
/// (#2085) sits between `node` and its enclosing class — an arrow function
/// is transparent to both walks, so the nearest `method_definition` found
/// here is the same function whose `this` binding actually governs `node`.
///
/// Returns false (instance) when `node` isn't inside any method_definition
/// at all — e.g. a class field initializer or `static { }` block — which
/// can misclassify a static field initializer's `this` as instance-context;
/// not handled here (see #2085/#2086 follow-up discussion).
fn is_enclosing_method_static(node: &Node) -> bool {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "method_definition" {
            return is_static_method_definition(&parent);
        }
        current = parent.parent();
    }
    false
}

/// Pre-scan pass: collect every ES6 get/set class-accessor declared in this
/// file, keyed by its qualified `ClassName.propName` name — the same
/// qualification `handle_method_def` already gives the accessor's own
/// Definition entry. Must run before the property-read pass so the registry
/// is complete regardless of source order.
fn collect_local_accessors(root: &Node, source: &[u8]) -> LocalAccessorRegistry {
    let mut registry = LocalAccessorRegistry::new();

    fn walk(node: &Node, source: &[u8], registry: &mut LocalAccessorRegistry, depth: usize) {
        if depth >= MAX_WALK_DEPTH {
            return;
        }
        if node.kind() == "method_definition" {
            if let Some(kind) = get_method_accessor_kind(node) {
                if let (Some(class_name), Some(prop_name)) = (
                    find_parent_class(node, source),
                    resolve_method_def_name(node, source),
                ) {
                    let key = format!("{}.{}", class_name, prop_name);
                    let entry = registry.entry(key).or_default();
                    let is_static = is_static_method_definition(node);
                    match (kind, is_static) {
                        ("get", true) => entry.static_get = true,
                        ("set", true) => entry.static_set = true,
                        ("get", false) => entry.get = true,
                        (_, false) => entry.set = true,
                        _ => {}
                    }
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(&child, source, registry, depth + 1);
            }
        }
    }

    walk(root, source, &mut registry, 0);
    registry
}

/// #2030: within the truthy branch of `if (var_name instanceof ClassName) { ... }`
/// (including `&&`-chained conditions), `var_name`'s narrowed runtime type is
/// `ClassName` for the rest of that branch — more specific than whatever this
/// file's type_map otherwise knows about `var_name` (e.g. a base-class
/// parameter annotation). Lets a cross-file accessor declared only on the
/// narrowed (concrete) subclass, not the wider declared type, still be
/// recognized as the property read's target. Mirrors
/// `findNarrowedInstanceofType` in `src/extractors/javascript.ts` — see that
/// function's doc comment for the full rationale and scope limits.
fn find_narrowed_instanceof_type(node: &Node, var_name: &str, source: &[u8]) -> Option<String> {
    let mut current = *node;
    let mut depth = 0;
    while depth < MAX_WALK_DEPTH {
        let parent = current.parent()?;
        if parent.kind() == "if_statement" {
            if let Some(consequence) = parent.child_by_field_name("consequence") {
                if consequence.id() == current.id() {
                    if let Some(condition) = parent.child_by_field_name("condition") {
                        if let Some(narrowed) =
                            find_instanceof_operand(&condition, var_name, source, 0)
                        {
                            return Some(narrowed);
                        }
                    }
                }
            }
        }
        current = parent;
        depth += 1;
    }
    None
}

/// Search `node` (an `if_statement`'s condition) for an `instanceof` check on
/// `var_name`, recursing through `&&` chains only — any other operator
/// (`||`, `===`, ...) does not guarantee the instanceof check held, so
/// narrowing stops there rather than risk a false positive. Mirrors
/// `findInstanceofOperand` in `src/extractors/javascript.ts`.
fn find_instanceof_operand(
    node: &Node,
    var_name: &str,
    source: &[u8],
    depth: usize,
) -> Option<String> {
    if depth >= MAX_WALK_DEPTH {
        return None;
    }
    if node.kind() == "parenthesized_expression" {
        let inner = node.named_child(0)?;
        return find_instanceof_operand(&inner, var_name, source, depth + 1);
    }
    if node.kind() != "binary_expression" {
        return None;
    }
    let operator_n = node.child_by_field_name("operator")?;
    let operator = node_text(&operator_n, source);
    let left = node.child_by_field_name("left");
    let right = node.child_by_field_name("right");
    if operator == "instanceof" {
        let (Some(left), Some(right)) = (&left, &right) else {
            return None;
        };
        if left.kind() == "identifier"
            && node_text(left, source) == var_name
            && right.kind() == "identifier"
        {
            return Some(node_text(right, source).to_string());
        }
        return None;
    }
    if operator == "&&" {
        if let Some(left) = &left {
            if let Some(found) = find_instanceof_operand(left, var_name, source, depth + 1) {
                return Some(found);
            }
        }
        if let Some(right) = &right {
            if let Some(found) = find_instanceof_operand(right, var_name, source, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// Detect a bare (non-call) `this.prop` / `varName.prop` member-expression
/// that reads or writes an ES6 accessor property, and record it as an
/// ordinary `Call` — indistinguishable from a real
/// `this.prop()`/`varName.prop()` call site, so it flows through the existing
/// (unchanged) call-resolution cascade.
///
/// A plain assignment (`obj.prop = value`) invokes the setter; every other
/// bare usage (reads, compound-assignment targets, etc.) invokes the getter.
///
/// Two confirmation tiers — mirrors `collectAccessorPropertyRead` in
/// `src/extractors/javascript.ts`:
///   1. Same-file (#1893): `class_name` is declared in this file, so
///      `local_accessors` can confirm (or rule out) the accessor directly.
///      A property declaring *both* a getter and a setter is skipped
///      entirely here (mirrors the "ambiguous → drop rather than fan out"
///      precedent used elsewhere in call resolution).
///   2. Cross-file (#2030): `class_name` isn't declared in this file (a
///      `this` receiver's class always is, so this tier only ever applies to
///      a `var_name.prop` identifier receiver) — emitted anyway, tagged with
///      `accessor_read`, deferring confirmation to the resolver's global
///      accessor-kind filter. `receiver` carries the *resolved class name*
///      here (not the read site's variable text) for the same reason given
///      in the TS mirror: resolution must look up the qualified
///      `class_name.prop_name` directly, since re-deriving the type from
///      type_map would only recover the wider declared type for a narrowed
///      variable, never the narrowed one.
fn handle_accessor_property_read(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    local_accessors: &LocalAccessorRegistry,
) {
    if node.kind() != "member_expression" {
        return;
    }
    // obj.method() — already a real call, handled by the regular call path
    // regardless of whether `method` also happens to be an accessor.
    if let Some(parent) = node.parent() {
        if parent.kind() == "call_expression"
            && parent.child_by_field_name("function").map(|f| f.id()) == Some(node.id())
        {
            return;
        }
    }

    let Some(obj) = node.child_by_field_name("object") else {
        return;
    };
    let Some(prop_node) = node.child_by_field_name("property") else {
        return;
    };
    if prop_node.kind() != "property_identifier" {
        return;
    }
    let prop_name = node_text(&prop_node, source);

    let is_plain_assign_target = node
        .parent()
        .filter(|p| p.kind() == "assignment_expression")
        .and_then(|p| p.child_by_field_name("left"))
        .map(|l| l.id())
        == Some(node.id());
    let needed_get = !is_plain_assign_target;

    if obj.kind() == "this" {
        // `this`'s enclosing class is always declared in this same file —
        // the #1893 same-file registry is authoritative, so keep its exact
        // semantics (including the ambiguous get+set skip) unchanged. Uses
        // the this-binding-boundary-respecting lookup (#2085): an
        // intervening plain function between this read and its lexically
        // enclosing class means `this` is not that class's instance.
        let Some(class_name) = find_parent_class_for_this_binding(node, source) else {
            return;
        };
        let key = format!("{}.{}", class_name, prop_name);
        let Some(accessor_info) = local_accessors.get(&key) else {
            return;
        };
        // #2086: `this` only reaches the class/constructor object (where
        // static members live) from inside a static method — match only the
        // bucket corresponding to the read site's own calling context.
        let is_static_context = is_enclosing_method_static(node);
        let relevant_get = if is_static_context {
            accessor_info.static_get
        } else {
            accessor_info.get
        };
        let relevant_set = if is_static_context {
            accessor_info.static_set
        } else {
            accessor_info.set
        };
        if relevant_get && relevant_set {
            return;
        }
        if needed_get && !relevant_get {
            return;
        }
        if !needed_get && !relevant_set {
            return;
        }
        symbols.calls.push(Call {
            name: prop_name.to_string(),
            line: start_line(node),
            receiver: Some("this".to_string()),
            ..Default::default()
        });
        return;
    }

    if obj.kind() != "identifier" {
        return;
    }
    let receiver = node_text(&obj, source).to_string();
    let narrowed_type = find_narrowed_instanceof_type(node, &receiver, source);
    let class_name = narrowed_type.or_else(|| {
        symbols
            .type_map
            .iter()
            .find(|e| e.name == receiver)
            .map(|e| e.type_name.clone())
    });
    let Some(class_name) = class_name else { return };

    let key = format!("{}.{}", class_name, prop_name);
    if let Some(accessor_info) = local_accessors.get(&key) {
        // #1893: same-file confirmation available — unchanged semantics.
        if accessor_info.get && accessor_info.set {
            return;
        }
        if needed_get && !accessor_info.get {
            return;
        }
        if !needed_get && !accessor_info.set {
            return;
        }
        symbols.calls.push(Call {
            name: prop_name.to_string(),
            line: start_line(node),
            receiver: Some(receiver),
            ..Default::default()
        });
        return;
    }

    // #2030: `class_name` isn't declared in this file — nothing to confirm
    // against locally. Emit a tagged candidate for the resolver's global
    // accessor-kind filter to confirm or discard.
    symbols.calls.push(Call {
        name: prop_name.to_string(),
        line: start_line(node),
        receiver: Some(class_name),
        accessor_read: Some(if needed_get {
            "get".to_string()
        } else {
            "set".to_string()
        }),
        ..Default::default()
    });
}

/// Create a synthetic `ClassName.<static:L:C>` definition for a class static block
/// so that calls inside the block are attributed to a method-kind node and
/// `super.method()` dispatch can walk up to the parent class.
///
/// The start line and column are appended to the name to ensure uniqueness when a
/// class has multiple `static { }` blocks (each has a distinct start position even
/// if on the same line).
fn handle_static_block(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(class_name) = find_parent_class(node, source) else {
        return;
    };
    let line = start_line(node);
    let col = node.start_position().column;
    symbols.definitions.push(Definition {
        name: format!("{}.<static:{}:{}>", class_name, line, col),
        kind: "method".to_string(),
        line,
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

/// Emit a `ClassName.fieldName` synthetic definition for each `class { field = ... }` node.
/// Only fired when a value node is present (skips bare `x;` declarations), mirroring the WASM
/// `handleFieldDef` guard.  The synthetic definition has `kind = "method"` so that the SQL
/// call-edge filter (`kind IN ('function','method')`) accepts edges rooted here.
fn handle_field_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"))
        .or_else(|| find_child(node, "property_identifier"));
    let Some(name_node) = name_node else { return };
    // Skip computed property names (`class C { [expr] = ... }`).
    // Allow property_identifier (regular names), identifier, private_property_identifier (#foo),
    // and string (e.g. `"method" = () => {}`) to match the TypeScript path which only denies
    // computed_property_name.
    if !matches!(
        name_node.kind(),
        "property_identifier" | "identifier" | "private_property_identifier" | "string"
    ) {
        return;
    }
    // Skip uninitialised fields (`class C { x; }`) — must have a value node.
    let Some(value_node) = node.child_by_field_name("value") else {
        return;
    };
    // Only emit a callable definition when the initializer is a function/arrow expression.
    // Scalar fields like `static x = 42` should not appear as method-kind nodes.
    if !matches!(
        value_node.kind(),
        "arrow_function" | "function_expression" | "generator_function"
    ) {
        return;
    }
    let field_name = node_text(&name_node, source);
    if field_name.is_empty() {
        return;
    }
    let Some(class_name) = find_parent_class(node, source) else {
        return;
    };
    symbols.definitions.push(Definition {
        name: format!("{}.{}", class_name, field_name),
        kind: "method".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
}

fn handle_interface_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let iface_name = node_text(&name_node, source).to_string();
    symbols.definitions.push(Definition {
        name: iface_name.clone(),
        kind: "interface".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
        bodyless: None,
        content_hash: None,
        accessor_kind: None,
    });
    // Extract interface methods
    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "interface_body"))
        .or_else(|| find_child(node, "object_type"));
    if let Some(body) = body {
        extract_interface_methods(&body, &iface_name, source, &mut symbols.definitions);
    }
}

fn handle_type_alias(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        symbols.definitions.push(Definition {
            name: node_text(&name_node, source).to_string(),
            kind: "type".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: None,
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

fn handle_enum_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let enum_name = node_text(&name_node, source).to_string();
        let children = extract_ts_enum_members(node, source);
        symbols.definitions.push(Definition {
            name: enum_name,
            kind: "enum".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: None,
            cfg: None,
            children: opt_children(children),
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }
}

/// Node types marking a function-body scope; declarations inside these are skipped by
/// the top-level-constant/destructuring branches below (parity with TS `FUNCTION_SCOPE_TYPES`).
const VAR_DECL_FN_SCOPE_TYPES: [&str; 6] = [
    "function_declaration",
    "arrow_function",
    "function_expression",
    "method_definition",
    "generator_function_declaration",
    "generator_function",
];

/// Detect `<destructured pattern> = require('./path')` and, if so, push a
/// CJS-require `Import` so the receiver-edge resolver treats the destructured
/// names as import artifacts, not local definitions (mirrors the WASM
/// `cjsRequireBindings` mechanism, #1678). `names` is the pattern's
/// already-collected bound names — `collect_object_pattern_names` for
/// `const { a, b } = require(...)`, `collect_array_pattern_names` for
/// `const [a, b] = require(...)` (issue #2268 added the array-pattern case;
/// it was never recorded at all before, only the object-pattern shape was).
fn record_cjs_require_import(
    value_n: &Node,
    source: &[u8],
    names: Vec<String>,
    node_line: u32,
    imports: &mut Vec<Import>,
) {
    if names.is_empty() || value_n.kind() != "call_expression" {
        return;
    }
    let Some(fn_node) = value_n.child_by_field_name("function") else {
        return;
    };
    if node_text(&fn_node, source) != "require" {
        return;
    }
    let args = value_n
        .child_by_field_name("arguments")
        .or_else(|| find_child(value_n, "arguments"));
    let Some(args) = args else {
        return;
    };
    let Some(str_arg) = find_child(&args, "string") else {
        return;
    };
    let mod_path = node_text(&str_arg, source).replace(&['\'', '"'][..], "");
    // CJS require bindings never populate renamed_imports — resolve_call_targets
    // deliberately ignores the original name for these (empty target_file forces
    // a same-file fallback match, matching WASM's importedNamesMap exclusion,
    // #1678) — so any rename pairs the caller collected are discarded before
    // reaching here (see the object-pattern call site's own comment).
    let mut imp = Import::new(mod_path, names, node_line);
    imp.cjs_require = Some(true);
    imports.push(imp);
}

fn handle_var_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let is_const = node
        .child(0)
        .map(|c| node_text(&c, source) == "const")
        .unwrap_or(false);
    let in_function_scope = find_parent_of_types(node, &VAR_DECL_FN_SCOPE_TYPES).is_some();
    for i in 0..node.child_count() {
        let Some(declarator) = node.child(i) else {
            continue;
        };
        if declarator.kind() != "variable_declarator" {
            continue;
        }
        // #2257: logical-or/nullish-coalescing/ternary default assigned to a
        // named variable, e.g. `const fetchFn = options._fetchLatest || fetchLatestVersion`.
        handle_logical_or_ternary_value_ref(&declarator, source, &mut symbols.calls);
        // #2260: computed dispatch-table access assigned to a named variable,
        // e.g. `const handler = TABLE[node.type]; ...; handler(...)`.
        handle_computed_dispatch_table_evidence(
            &declarator,
            source,
            &mut symbols.computed_dispatch_table_evidence,
        );

        let name_n = declarator.child_by_field_name("name");
        let value_n = declarator.child_by_field_name("value");
        let (Some(name_n), Some(value_n)) = (name_n, value_n) else {
            continue;
        };
        let vt = value_n.kind();

        if vt == "arrow_function"
            || vt == "function_expression"
            || vt == "function"
            || vt == "generator_function"
        {
            let children = extract_js_parameters(&value_n, source);
            symbols.definitions.push(Definition {
                name: node_text(&name_n, source).to_string(),
                kind: "function".to_string(),
                // #2265: the function VALUE's own start line, not the
                // enclosing statement's — `node` spans the whole
                // `const a = fn1, b = fn2;` declaration, so every declarator
                // in a multi-binding statement previously got the identical
                // (wrong, for every declarator but the first) line.
                line: start_line(&value_n),
                end_line: Some(end_line(&value_n)),
                decorators: None,
                complexity: compute_all_metrics(&value_n, source, "javascript"),
                cfg: build_function_cfg(&value_n, "javascript", source),
                children: opt_children(children),
                bodyless: None,
                content_hash: None,
                accessor_kind: None,
            });
        } else if is_const && name_n.kind() == "object_pattern" && !in_function_scope {
            // Parity with TS query path (extractDestructuredBindingsWalk):
            // skip destructured const bindings inside function scopes so the
            // Rust walk path matches FUNCTION_SCOPE_TYPES behaviour.
            extract_destructured_bindings(
                &name_n,
                source,
                start_line(node),
                end_line(node),
                &mut symbols.definitions,
            );
            // If the RHS is a CJS require() call, also add to imports so the
            // receiver-edge resolver treats the names as import artifacts, not
            // local definitions — mirroring the WASM cjsRequireBindings fix (#1678).
            let names = collect_object_pattern_names(&name_n, source, &mut Vec::new());
            record_cjs_require_import(
                &value_n,
                source,
                names,
                start_line(node),
                &mut symbols.imports,
            );
        } else if is_const && name_n.kind() == "identifier" && !in_function_scope {
            // Any other initializer shape becomes a "constant" Definition, regardless of
            // complexity (call/member/parenthesized expressions, etc.) — mirroring how
            // function declarations are captured regardless of body complexity, and the
            // WASM/TS extractor's unconditional identifier branch (#1819).
            symbols.definitions.push(Definition {
                name: node_text(&name_n, source).to_string(),
                kind: "constant".to_string(),
                line: start_line(node),
                end_line: Some(end_line(node)),
                decorators: None,
                complexity: None,
                cfg: None,
                children: None,
                bodyless: None,
                content_hash: None,
                accessor_kind: None,
            });
            // Phase 8.3f: extract function/arrow properties from object literals and seed
            // typeMap composite keys so that this.method() inside Object.defineProperty
            // accessor functions can resolve them.
            if value_n.kind() == "object" {
                let var_name = node_text(&name_n, source);
                extract_object_literal_functions(&value_n, source, var_name, symbols);
            }
        } else if is_const && name_n.kind() == "array_pattern" && !in_function_scope {
            // Array destructuring: `const [x, y] = ...` — one constant Definition per
            // bound identifier (#1901). Scope guard mirrors the object_pattern branch above.
            extract_array_pattern_bindings(
                &name_n,
                source,
                start_line(node),
                end_line(node),
                &mut symbols.definitions,
            );
            // Mirrors the object_pattern branch above: `const [a, b] = require('./mod')`
            // never got recorded as a CJS-require import artifact by either engine (#2268).
            let names = collect_array_pattern_names(&name_n, source);
            record_cjs_require_import(
                &value_n,
                source,
                names,
                start_line(node),
                &mut symbols.imports,
            );
        } else if !is_const
            && value_n.kind() == "object"
            && is_eligible_object_literal_declarator(&declarator)
        {
            // `let`/`var` object literals get no "constant" definition of their own (mirrors
            // WASM extractLetVarObjLiteralDeclarators) but still need their function/method
            // properties extracted — inline here, like the `const` branch above, so native and
            // WASM agree on `definitions` array order (#1818). Previously deferred to a
            // separate post-walk pass that ran after the whole file, which put these qualified
            // definitions in the wrong relative position.
            let var_name = node_text(&name_n, source);
            extract_object_literal_functions(&value_n, source, var_name, symbols);
        }

        // pts fn_ref_binding tracking runs independently of the Definition-shape branching
        // above (mirrors WASM's collectFnRefBindings, which always runs before any
        // Definition-related early return) so `const alias = handler` still seeds a pts
        // alias even though `alias` now also gets its own "constant" Definition (#1819).
        if name_n.kind() == "identifier" && value_n.kind() == "identifier" {
            // Phase 8.3: `const alias = handler` — record for pts analysis.
            // Mirror the JS BUILTIN_GLOBALS guard: skip well-known JS globals so
            // they are never seeded as pts targets (e.g. `const a = Array`).
            let rhs_text = node_text(&value_n, source);
            if !JS_BUILTIN_GLOBALS.contains(&rhs_text) {
                symbols.fn_ref_bindings.push(FnRefBinding {
                    lhs: node_text(&name_n, source).to_string(),
                    rhs: rhs_text.to_string(),
                    rhs_receiver: None,
                });
            }
        } else if name_n.kind() == "identifier" && value_n.kind() == "member_expression" {
            // Phase 8.3: `const alias = obj.method` — record for pts analysis.
            // Mirror the JS BUILTIN_GLOBALS guard: skip bindings where the
            // receiver object is a well-known JS global (e.g. `const fn = Math.random`).
            // Guards mirror the TS extractor: only static property access on a plain
            // identifier receiver — chained `a.b.method` and computed subscripts are
            // skipped because they can never match pts keys.
            if let (Some(obj), Some(prop)) = (
                value_n.child_by_field_name("object"),
                value_n.child_by_field_name("property"),
            ) {
                let prop_kind = prop.kind();
                if (prop_kind == "property_identifier" || prop_kind == "identifier")
                    && obj.kind() == "identifier"
                {
                    let obj_text = node_text(&obj, source);
                    if !JS_BUILTIN_GLOBALS.contains(&obj_text) {
                        symbols.fn_ref_bindings.push(FnRefBinding {
                            lhs: node_text(&name_n, source).to_string(),
                            rhs: node_text(&prop, source).to_string(),
                            rhs_receiver: Some(obj_text.to_string()),
                        });
                    }
                }
            }
        } else if name_n.kind() == "identifier" && value_n.kind() == "call_expression" {
            // Phase 8.3: `const f = fn.bind(ctx)` — bind returns a bound copy of fn;
            // track f → fn so pts(f) ⊇ pts(fn) and subsequent `f(args)` calls resolve
            // to fn. Only flat-identifier binds (fn.bind) are tracked, mirroring the
            // TS extractor; method-receiver binds like `obj.method.bind(ctx)` are not.
            if let Some(call_fn) = value_n.child_by_field_name("function") {
                if call_fn.kind() == "member_expression" {
                    let is_bind = call_fn
                        .child_by_field_name("property")
                        .map(|p| node_text(&p, source) == "bind")
                        .unwrap_or(false);
                    if is_bind {
                        if let Some(bound_fn) = call_fn.child_by_field_name("object") {
                            if bound_fn.kind() == "identifier" {
                                let bound_name = node_text(&bound_fn, source);
                                if !JS_BUILTIN_GLOBALS.contains(&bound_name) {
                                    symbols.fn_ref_bindings.push(FnRefBinding {
                                        lhs: node_text(&name_n, source).to_string(),
                                        rhs: bound_name.to_string(),
                                        rhs_receiver: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// RES-2: Inline object-literal dispatch table — `({a:fnA,b:fnB})[key]()`.
///
/// Mirrors `extractSubscriptCallInfo` in `src/extractors/javascript.ts` (lines 3196–3233).
/// When the subscript object is an object literal (or parenthesized object literal) and
/// the index is an identifier, collect each value identifier as an array-elem binding
/// under a synthetic `<dt_line_col>` name, then return a `<dt_line_col>[*]` call so
/// the PTS solver can resolve the wildcard to each concrete target function.
///
/// Returns `None` if the pattern does not match (caller falls through to `extract_call_info`).
fn extract_dispatch_table_call(
    fn_node: &Node,
    call_node: &Node,
    source: &[u8],
    array_elem_bindings: &mut Vec<ArrayElemBinding>,
) -> Option<Call> {
    let index = fn_node.child_by_field_name("index")?;
    if index.kind() != "identifier" {
        return None;
    }
    let obj = fn_node.child_by_field_name("object")?;
    // Unwrap parenthesized_expression: ({a:fn})[key]()
    let obj_node = if obj.kind() == "parenthesized_expression" {
        // child(1) skips the opening paren; field "expression" is not always available
        obj.child_by_field_name("expression")
            .or_else(|| obj.child(1))
            .unwrap_or(obj)
    } else {
        obj
    };
    if obj_node.kind() != "object" {
        return None;
    }
    let line = start_line(call_node);
    let col = call_node.start_position().column;
    let table_name = format!("<dt_{}_{}>", line, col);
    let mut idx: u32 = 0;
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier" => {
                let text = node_text(&child, source);
                if !JS_BUILTIN_GLOBALS.contains(&text) {
                    array_elem_bindings.push(ArrayElemBinding {
                        array_name: table_name.clone(),
                        index: idx,
                        elem_name: text.to_string(),
                    });
                    idx += 1;
                }
            }
            "pair" => {
                if let Some(val) = child.child_by_field_name("value") {
                    if val.kind() == "identifier" {
                        let text = node_text(&val, source);
                        if !JS_BUILTIN_GLOBALS.contains(&text) {
                            array_elem_bindings.push(ArrayElemBinding {
                                array_name: table_name.clone(),
                                index: idx,
                                elem_name: text.to_string(),
                            });
                            idx += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if idx == 0 {
        return None;
    }
    Some(Call {
        name: format!("{}[*]", table_name),
        line,
        dynamic: Some(true),
        dynamic_kind: Some("dispatch-table".to_string()),
        key_expr: Some(node_text(&index, source).to_string()),
        ..Default::default()
    })
}

fn handle_call_expr(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    callback_param_shapes: &CallbackParamShapes,
) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    if fn_node.kind() == "import" {
        handle_dynamic_import(node, &fn_node, source, symbols);
        return;
    }
    // `this(args)` — the callee is `this` used as a function, not a named
    // identifier.  The `this` call record is emitted by
    // collect_this_call_and_bindings (called from match_js_pts_bindings).
    // Callback-reference-call extraction is skipped for the arguments, because
    // those arguments are values passed *to* the rebound function — not
    // callbacks of the enclosing scope.  Without this guard, an identifier
    // argument like `b` in `this(b)` becomes a spurious dynamic call that the
    // pts resolver resolves to a globally-defined function with the same name
    // in another file, producing a false cross-file call edge.
    if fn_node.kind() == "this" {
        return;
    }
    // Bare `super(args)` — invokes the parent class's constructor. Modeled as
    // a `constructor` call with receiver `super` (mirrors the `super` branch
    // in extractCallInfo, src/extractors/javascript.ts) so it flows through
    // the same this/super hierarchy dispatch that already resolves
    // `super.method()` to the parent class (#1929). Callback-reference-call
    // extraction on the arguments is skipped for the same reason as
    // `this(args)` above.
    if fn_node.kind() == "super" {
        if let Some(call_info) = extract_call_info(&fn_node, node, source) {
            symbols.calls.push(call_info);
        }
        return;
    }
    // RES-2: {a:fnA,b:fnB}[k]() — inline object literal dispatch table.
    // Mirrors extractSubscriptCallInfo in src/extractors/javascript.ts (lines 3196–3233).
    // When the callee is a subscript_expression whose object is an object literal
    // (possibly wrapped in parentheses) and whose index is an identifier, collect
    // the values as array-elem bindings under a synthetic `<dt_line_col>` name and
    // emit a `<dt_line_col>[*]` call so the PTS solver can resolve each target.
    if fn_node.kind() == "subscript_expression" {
        if let Some(call) =
            extract_dispatch_table_call(&fn_node, node, source, &mut symbols.array_elem_bindings)
        {
            symbols.calls.push(call);
            if let Some(cb_def) = extract_callback_definition(node, source) {
                symbols.definitions.push(cb_def);
            }
            extract_callback_reference_calls(
                node,
                source,
                callback_param_shapes,
                &mut symbols.calls,
            );
            symbols
                .calls
                .extend(extract_call_argument_identifier_refs(node, source));
            return;
        }
    }
    if let Some(call_info) = extract_call_info(&fn_node, node, source) {
        symbols.calls.push(call_info);
    }
    if let Some(cb_def) = extract_callback_definition(node, source) {
        symbols.definitions.push(cb_def);
    }
    extract_callback_reference_calls(node, source, callback_param_shapes, &mut symbols.calls);
    symbols
        .calls
        .extend(extract_call_argument_identifier_refs(node, source));
}

fn handle_new_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // RTA instantiation evidence (issue #2346): record every constructor type
    // name that appears in a `new X()` expression, regardless of whether the
    // result is ever assigned to anything — mirrors the WASM engine's
    // unconditional `newExpressions` collection in `src/extractors/javascript.ts`,
    // and gives `collect_cha_instantiated_types` (build_edges.rs) coverage for
    // instantiation shapes (e.g. object-literal property values, bare
    // non-`this.` assignments) that never produce a confidence>=0.9 typeMap
    // entry.
    if let Some(type_name) = extract_new_expr_type_name(node, source) {
        symbols.new_expressions.push(type_name.to_string());
    }
    let ctor = node
        .child_by_field_name("constructor")
        .or_else(|| node.child(1));
    let Some(ctor) = ctor else { return };
    match ctor.kind() {
        "identifier" => {
            let name = node_text(&ctor, source);
            if name == "Function" {
                // new Function(body) — dynamic code execution; always flagged
                symbols.calls.push(Call {
                    name: "<dynamic:eval>".to_string(),
                    line: start_line(node),
                    dynamic: Some(true),
                    dynamic_kind: Some("eval".to_string()),
                    ..Default::default()
                });
            } else {
                push_simple_call(symbols, node, name.to_string());
            }
        }
        "member_expression" => {
            if let Some(call_info) = extract_call_info(&ctor, node, source) {
                symbols.calls.push(call_info);
            }
        }
        _ => {}
    }
}

/// Handle a TypeScript/JS decorator node.
///
/// Only handles bare-identifier and bare-member-expression decorators
/// (`@Foo`, `@Foo.bar`) — call expression decorators (`@Foo()`) are
/// handled automatically when the recursive walker visits the inner
/// call_expression child.
fn handle_decorator(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        match child.kind() {
            "@" => continue,
            "identifier" => {
                symbols.calls.push(Call {
                    name: node_text(&child, source).to_string(),
                    line: start_line(node),
                    dynamic: Some(true),
                    dynamic_kind: Some("reflection".to_string()),
                    ..Default::default()
                });
                break;
            }
            "member_expression" => {
                if let Some(mut call_info) = extract_call_info(&child, node, source) {
                    call_info.dynamic = Some(true);
                    call_info.dynamic_kind = Some("reflection".to_string());
                    symbols.calls.push(call_info);
                }
                break;
            }
            // call_expression and other types handled by recursive walk
            _ => break,
        }
    }
}

fn handle_dynamic_import(node: &Node, _fn_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let args = node
        .child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args) = args else { return };
    let str_node = find_child(&args, "string").or_else(|| find_child(&args, "template_string"));
    if let Some(str_node) = str_node {
        let mod_path = node_text(&str_node, source).replace(&['\'', '"', '`'][..], "");
        let mut renamed_imports = Vec::new();
        let names = extract_dynamic_import_names(node, source, &mut renamed_imports);
        let mut imp = Import::new(mod_path, names, start_line(node));
        imp.dynamic_import = Some(true);
        if !renamed_imports.is_empty() {
            imp.renamed_imports = Some(renamed_imports);
        }
        symbols.imports.push(imp);
    }
}

fn handle_import_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let text = node_text(node, source);
    let is_type_only = text.starts_with("import type");
    let source_node = node
        .child_by_field_name("source")
        .or_else(|| find_child(node, "string"));
    if let Some(source_node) = source_node {
        let mod_path = node_text(&source_node, source).replace(&['\'', '"'][..], "");
        let mut renamed_imports = Vec::new();
        let mut type_only_names = Vec::new();
        let names = extract_import_names_with_renames(
            node,
            source,
            &mut renamed_imports,
            &mut type_only_names,
        );
        let mut imp = Import::new(mod_path, names, start_line(node));
        if is_type_only {
            imp.type_only = Some(true);
        }
        if !renamed_imports.is_empty() {
            imp.renamed_imports = Some(renamed_imports);
        }
        if !type_only_names.is_empty() {
            imp.type_only_names = Some(type_only_names);
        }
        symbols.imports.push(imp);
    }
}

fn handle_export_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let decl = node.child_by_field_name("declaration");
    if let Some(decl) = &decl {
        handle_export_declaration(decl, source, symbols);
    }
    let source_node = node
        .child_by_field_name("source")
        .or_else(|| find_child(node, "string"));
    match &source_node {
        Some(source_node) if decl.is_none() => {
            handle_reexport(node, source_node, source, symbols);
        }
        _ => {}
    }
}

fn handle_export_declaration(decl: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let (kind_str, field) = match decl.kind() {
        "function_declaration" | "generator_function_declaration" => ("function", "name"),
        "class_declaration" | "abstract_class_declaration" => ("class", "name"),
        "interface_declaration" => ("interface", "name"),
        "type_alias_declaration" => ("type", "name"),
        "enum_declaration" => ("enum", "name"),
        "lexical_declaration" | "variable_declaration" => {
            collect_exported_var_declarations(decl, source, symbols);
            return;
        }
        _ => return,
    };
    if let Some(n) = decl.child_by_field_name(field) {
        symbols.exports.push(ExportInfo {
            name: node_text(&n, source).to_string(),
            kind: kind_str.to_string(),
            // #2293: the declaration's own line, not the wrapping
            // `export_statement`'s — a leading-comment or multi-line export
            // clause otherwise pushed every export onto the `export` keyword's
            // line instead of the declared symbol's own line.
            line: start_line(decl),
        });
    }
}

/// Push `ExportInfo` entries for `export const/let/var …`, one per declarator.
///
/// Named function/class/interface/type declarations carry their own `name`
/// field (handled above); a lexical/variable declaration doesn't, so each
/// declarator's value is classified the same way `handle_var_decl` classifies
/// it when creating the matching `Definition`: function-valued declarators
/// become kind "function"; any other `const` declarator becomes kind "constant",
/// regardless of initializer complexity (#1819).
/// Mirrors the WASM/TS extractor's `collectExportedDeclarations`.
///
/// This predicate must stay identical to `handle_var_decl`'s: `insert_nodes.rs`
/// marks `exported = 1` by matching (name, kind, file, line) against
/// already-inserted definition rows, so a mismatched kind here silently
/// no-ops the UPDATE instead of marking the symbol exported (#1728).
///
/// `export const { a, b } = value` / `export const [a, b] = value` have no
/// `identifier` name field either — the name is an `object_pattern`/
/// `array_pattern` — so they walk `collect_object_pattern_names`/
/// `collect_array_pattern_names`, the same name-collection `handle_var_decl`
/// uses to build the matching Definitions, and push one "constant" ExportInfo
/// per bound name. Restricted to `const` for the same reason the Definition
/// side is (#2070).
fn collect_exported_var_declarations(decl: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let is_const = decl
        .child(0)
        .map(|c| node_text(&c, source) == "const")
        .unwrap_or(false);
    for i in 0..decl.child_count() {
        let Some(declarator) = decl.child(i) else {
            continue;
        };
        if declarator.kind() != "variable_declarator" {
            continue;
        }
        let name_n = declarator.child_by_field_name("name");
        let value_n = declarator.child_by_field_name("value");
        let (Some(name_n), Some(value_n)) = (name_n, value_n) else {
            continue;
        };
        match name_n.kind() {
            "identifier" => {
                let vt = value_n.kind();
                if vt == "arrow_function"
                    || vt == "function_expression"
                    || vt == "function"
                    || vt == "generator_function"
                {
                    symbols.exports.push(ExportInfo {
                        name: node_text(&name_n, source).to_string(),
                        kind: "function".to_string(),
                        // #2293: matches handle_var_decl's own Definition line
                        // for this shape (#2265) — the function VALUE's start
                        // line, not the declaration's.
                        line: start_line(&value_n),
                    });
                } else if is_const {
                    symbols.exports.push(ExportInfo {
                        name: node_text(&name_n, source).to_string(),
                        kind: "constant".to_string(),
                        line: start_line(decl),
                    });
                }
            }
            "object_pattern" if is_const => {
                for name in collect_object_pattern_names(&name_n, source, &mut Vec::new()) {
                    symbols.exports.push(ExportInfo {
                        name,
                        kind: "constant".to_string(),
                        line: start_line(decl),
                    });
                }
            }
            "array_pattern" if is_const => {
                for name in collect_array_pattern_names(&name_n, source) {
                    symbols.exports.push(ExportInfo {
                        name,
                        kind: "constant".to_string(),
                        line: start_line(decl),
                    });
                }
            }
            _ => {}
        }
    }
}

fn handle_reexport(node: &Node, source_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mod_path = node_text(source_node, source).replace(&['\'', '"'][..], "");
    let mut reexport_renames = Vec::new();
    let mut type_only_names = Vec::new();
    let reexport_names = extract_import_names_with_renames(
        node,
        source,
        &mut reexport_renames,
        &mut type_only_names,
    );
    let text = node_text(node, source);
    let is_wildcard = text.contains("export *") || text.contains("export*");
    let mut imp = Import::new(mod_path, reexport_names.clone(), start_line(node));
    imp.reexport = Some(true);
    if is_wildcard && reexport_names.is_empty() {
        imp.wildcard_reexport = Some(true);
    }
    if !reexport_renames.is_empty() {
        imp.renamed_imports = Some(reexport_renames);
    }
    symbols.imports.push(imp);
}

/// Recover the export relationship tree-sitter-javascript/typescript drops
/// for a bare `export` keyword followed by a newline before certain
/// declarations (#2459). Mirrors `recoverBareExportMisparse` in
/// `src/extractors/javascript.ts` — see that function's doc comment for the
/// full ECMAScript-grammar rationale and the reserved-word argument for why
/// this can't misfire on a legitimate identifier reference. Reuses
/// `handle_export_declaration`, the same function a correctly-parsed
/// `export_statement`'s declaration goes through, so the recovered symbol is
/// classified identically to a real export (and inherits that function's own
/// gaps, e.g. `enum_declaration` isn't tracked either way — see #2560 —
/// rather than this fix silently papering over a different bug).
///
/// Restricted to direct children of `program`: `export` is not valid syntax
/// anywhere else a bare single-identifier expression statement could appear.
/// Comment nodes between the bare `export` and the declaration are skipped
/// when walking forward, since comments are ordinary siblings in this
/// grammar, not children of either statement.
fn recover_bare_export_misparse(bare_export_stmt: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(parent) = bare_export_stmt.parent() else {
        return;
    };
    if parent.kind() != "program" {
        return;
    }
    let mut sib = bare_export_stmt.next_sibling();
    while let Some(s) = sib {
        if s.kind() != "comment" {
            handle_export_declaration(&s, source, symbols);
            return;
        }
        sib = s.next_sibling();
    }
}

fn handle_expr_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(expr) = node.child(0) else { return };
    if expr.kind() == "identifier" && node_text(&expr, source) == "export" {
        recover_bare_export_misparse(node, source, symbols);
        return;
    }
    if expr.kind() != "assignment_expression" {
        return;
    }
    let left = expr.child_by_field_name("left");
    let right = expr.child_by_field_name("right");
    let (Some(left), Some(right)) = (left, right) else {
        return;
    };
    let left_text = node_text(&left, source);
    if !left_text.starts_with("module.exports") && left_text != "exports" {
        return;
    }
    if right.kind() == "call_expression" {
        handle_require_reexport(&right, node, source, symbols);
    }
    if right.kind() == "object" {
        handle_spread_require_reexports(&right, node, source, symbols);
    }
}

fn handle_require_reexport(right: &Node, node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let fn_node = right.child_by_field_name("function");
    let args = right
        .child_by_field_name("arguments")
        .or_else(|| find_child(right, "arguments"));
    if let (Some(fn_node), Some(args)) = (fn_node, args) {
        if node_text(&fn_node, source) == "require" {
            if let Some(str_arg) = find_child(&args, "string") {
                let mod_path = node_text(&str_arg, source).replace(&['\'', '"'][..], "");
                let mut imp = Import::new(mod_path, vec![], start_line(node));
                imp.reexport = Some(true);
                imp.wildcard_reexport = Some(true);
                symbols.imports.push(imp);
            }
        }
    }
}

fn handle_spread_require_reexports(
    right: &Node,
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    for ci in 0..right.child_count() {
        let Some(child) = right.child(ci) else {
            continue;
        };
        if child.kind() != "spread_element" {
            continue;
        }
        let spread_expr = child
            .child(1)
            .or_else(|| child.child_by_field_name("value"));
        let Some(spread_expr) = spread_expr else {
            continue;
        };
        if spread_expr.kind() != "call_expression" {
            continue;
        }
        let fn2 = spread_expr.child_by_field_name("function");
        let args2 = spread_expr
            .child_by_field_name("arguments")
            .or_else(|| find_child(&spread_expr, "arguments"));
        let (Some(fn2), Some(args2)) = (fn2, args2) else {
            continue;
        };
        if node_text(&fn2, source) != "require" {
            continue;
        }
        if let Some(str_arg2) = find_child(&args2, "string") {
            let mod_path2 = node_text(&str_arg2, source).replace(&['\'', '"'][..], "");
            let mut imp = Import::new(mod_path2, vec![], start_line(node));
            imp.reexport = Some(true);
            imp.wildcard_reexport = Some(true);
            symbols.imports.push(imp);
        }
    }
}

// ── AST node extraction (new / throw / await / string / regex) ──────────────

const TEXT_MAX: usize = 200;

/// Walk the tree collecting new/throw/await/string/regex AST nodes.
fn walk_ast_nodes(node: &Node, source: &[u8], ast_nodes: &mut Vec<AstNode>) {
    walk_ast_nodes_depth(node, source, ast_nodes, 0);
}

fn walk_ast_nodes_depth(node: &Node, source: &[u8], ast_nodes: &mut Vec<AstNode>, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "new_expression" => {
            let name = extract_new_name(node, source);
            let text = truncate(node_text(node, source), TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "new".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Don't recurse — we already captured this node
            return;
        }
        "throw_statement" => {
            let name = extract_throw_name(node, source);
            let text = extract_expression_text(node, source);
            ast_nodes.push(AstNode {
                kind: "throw".to_string(),
                name,
                line: start_line(node),
                text,
                receiver: None,
            });
            // Don't recurse — prevents double-counting `throw new Error`
            return;
        }
        "await_expression" => {
            let name = extract_await_name(node, source);
            let text = extract_expression_text(node, source);
            ast_nodes.push(AstNode {
                kind: "await".to_string(),
                name,
                line: start_line(node),
                text,
                receiver: None,
            });
            // Recurse into children to capture nested calls (e.g. await fetch(url))
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk_ast_nodes_depth(&child, source, ast_nodes, depth + 1);
                }
            }
            return;
        }
        // Guard on `is_named()`: tree-sitter-typescript's `predefined_type`
        // production (the `string`/`number`/`boolean`/... primitive type
        // keywords) lexes its keyword as an anonymous token whose `kind()`
        // string is identical to the *named* `string` literal node type.
        // Without this guard, `name: string` type annotations are
        // misclassified as string-literal ast_nodes (#1729). Mirrors the
        // WASM-side guard in `ast-store-visitor.ts::resolveAstKind`.
        "string" | "template_string" if node.is_named() => {
            let raw = node_text(node, source);
            // Strip quotes to get content
            let content = raw
                .trim_start_matches(['\'', '"', '`'])
                .trim_end_matches(['\'', '"', '`']);
            // Count Unicode code points, not UTF-8 bytes, so the filter matches
            // helpers.rs `build_string_node` and the WASM visitor — a single non-
            // ASCII glyph like `─` (3 bytes / 1 code point) must be treated as one
            // character, otherwise we emit "excess" string nodes the WASM engine
            // skips (see parity issue #1010).
            if content.chars().count() < 2 {
                // Still recurse children (template_string may have nested expressions)
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk_ast_nodes_depth(&child, source, ast_nodes, depth + 1);
                    }
                }
                return;
            }
            let name = truncate(content, 100);
            let text = truncate(raw, TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "string".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Do recurse children for strings
        }
        "regex" => {
            let raw = node_text(node, source);
            let name = if raw.is_empty() {
                "?".to_string()
            } else {
                raw.to_string()
            };
            let text = truncate(raw, TEXT_MAX);
            ast_nodes.push(AstNode {
                kind: "regex".to_string(),
                name,
                line: start_line(node),
                text: Some(text),
                receiver: None,
            });
            // Do recurse children for regex
        }
        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_ast_nodes_depth(&child, source, ast_nodes, depth + 1);
        }
    }
}

/// Extract constructor name from a `new_expression` node.
/// Handles `new Foo()`, `new a.Foo()`, `new Foo.Bar()`.
fn extract_new_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" {
                return node_text(&child, source).to_string();
            }
            if child.kind() == "member_expression" {
                return node_text(&child, source).to_string();
            }
        }
    }
    // Fallback: text before '(' minus 'new '
    let raw = node_text(node, source);
    raw.split('(')
        .next()
        .unwrap_or(raw)
        .replace("new ", "")
        .trim()
        .to_string()
}

/// Extract name from a `throw_statement`.
/// `throw new Error(...)` → "Error"; `throw x` → "x"
fn extract_throw_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "new_expression" => return extract_new_name(&child, source),
                "call_expression" => {
                    if let Some(fn_node) = child.child_by_field_name("function") {
                        return node_text(&fn_node, source).to_string();
                    }
                    let text = node_text(&child, source);
                    return text.split('(').next().unwrap_or("?").to_string();
                }
                "identifier" => return node_text(&child, source).to_string(),
                _ => {}
            }
        }
    }
    truncate(node_text(node, source), TEXT_MAX)
}

/// Extract name from an `await_expression`.
/// `await fetch(...)` → "fetch"; `await this.foo()` → "this.foo"
fn extract_await_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "call_expression" => {
                    if let Some(fn_node) = child.child_by_field_name("function") {
                        return node_text(&fn_node, source).to_string();
                    }
                    let text = node_text(&child, source);
                    return text.split('(').next().unwrap_or("?").to_string();
                }
                "identifier" | "member_expression" => {
                    return node_text(&child, source).to_string();
                }
                _ => {}
            }
        }
    }
    truncate(node_text(node, source), TEXT_MAX)
}

/// Extract expression text from throw/await — skip the keyword child.
fn extract_expression_text(node: &Node, source: &[u8]) -> Option<String> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            // Skip the keyword token itself
            if child.kind() != "throw" && child.kind() != "await" {
                return Some(truncate(node_text(&child, source), TEXT_MAX));
            }
        }
    }
    Some(truncate(node_text(node, source), TEXT_MAX))
}

// ── Extended kinds helpers ──────────────────────────────────────────────────

fn extract_js_parameters(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let params_node = node
        .child_by_field_name("parameters")
        .or_else(|| find_child(node, "formal_parameters"));
    if let Some(params_node) = params_node {
        for i in 0..params_node.child_count() {
            if let Some(child) = params_node.child(i) {
                match child.kind() {
                    "identifier" => {
                        params.push(child_def(
                            node_text(&child, source).to_string(),
                            "parameter",
                            start_line(&child),
                        ));
                    }
                    "required_parameter" | "optional_parameter" => {
                        // TS parameters: pattern field holds the identifier;
                        // fall back to left field or first child for edge cases
                        let name_node = child
                            .child_by_field_name("pattern")
                            .or_else(|| child.child_by_field_name("left"))
                            .or_else(|| child.child(0));
                        if let Some(name_node) = name_node {
                            if name_node.kind() == "identifier"
                                || name_node.kind() == "shorthand_property_identifier_pattern"
                            {
                                params.push(child_def(
                                    node_text(&name_node, source).to_string(),
                                    "parameter",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    "assignment_pattern" => {
                        if let Some(left) = child.child_by_field_name("left") {
                            if left.kind() == "identifier" {
                                params.push(child_def(
                                    node_text(&left, source).to_string(),
                                    "parameter",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    "rest_pattern" | "rest_element" => {
                        for j in 0..child.child_count() {
                            if let Some(inner) = child.child(j) {
                                if inner.kind() == "identifier" {
                                    params.push(child_def(
                                        node_text(&inner, source).to_string(),
                                        "parameter",
                                        start_line(&child),
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    params
}

fn extract_js_class_properties(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut props = Vec::new();
    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "class_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                match child.kind() {
                    "field_definition" | "public_field_definition" | "property_definition" => {
                        let prop = child
                            .child_by_field_name("property")
                            .or_else(|| child.child_by_field_name("name"))
                            .or_else(|| find_child(&child, "property_identifier"));
                        if let Some(prop) = prop {
                            let kind = prop.kind();
                            if kind == "property_identifier"
                                || kind == "identifier"
                                || kind == "private_property_identifier"
                            {
                                props.push(child_def(
                                    node_text(&prop, source).to_string(),
                                    "property",
                                    start_line(&child),
                                ));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    props
}

fn extract_ts_enum_members(node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut members = Vec::new();
    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "enum_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_assignment" || child.kind() == "property_identifier" {
                    let name = child.child_by_field_name("name").unwrap_or(child);
                    members.push(child_def(
                        node_text(&name, source).to_string(),
                        "constant",
                        start_line(&child),
                    ));
                }
            }
        }
    }
    members
}

// ── Existing helpers ────────────────────────────────────────────────────────

fn extract_interface_methods(
    body: &Node,
    iface_name: &str,
    source: &[u8],
    definitions: &mut Vec<Definition>,
) {
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if child.kind() == "method_signature" || child.kind() == "property_signature" {
                if let Some(name_node) = child.child_by_field_name("name") {
                    let kind = if child.kind() == "method_signature" {
                        "method"
                    } else {
                        "property"
                    };
                    definitions.push(Definition {
                        name: format!("{}.{}", iface_name, node_text(&name_node, source)),
                        kind: kind.to_string(),
                        line: start_line(&child),
                        end_line: Some(end_line(&child)),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: None,
                        bodyless: Some(child.child_by_field_name("body").is_none()),
                        content_hash: None,
                        accessor_kind: None,
                    });
                }
            }
        }
    }
}

fn extract_implements(heritage: &Node, source: &[u8]) -> Vec<String> {
    let mut interfaces = Vec::new();
    for i in 0..heritage.child_count() {
        if let Some(child) = heritage.child(i) {
            if node_text(&child, source) == "implements" {
                for j in (i + 1)..heritage.child_count() {
                    if let Some(next) = heritage.child(j) {
                        if next.kind() == "identifier" || next.kind() == "type_identifier" {
                            interfaces.push(node_text(&next, source).to_string());
                        }
                        if next.child_count() > 0 {
                            extract_implements_from_node(&next, source, &mut interfaces);
                        }
                    }
                }
                break;
            }
            if child.kind() == "implements_clause" {
                extract_implements_from_node(&child, source, &mut interfaces);
            }
        }
    }
    interfaces
}

fn extract_implements_from_node(node: &Node, source: &[u8], result: &mut Vec<String>) {
    extract_implements_depth(node, source, result, 0);
}

fn extract_implements_depth(node: &Node, source: &[u8], result: &mut Vec<String>, depth: usize) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "identifier" || child.kind() == "type_identifier" {
                result.push(node_text(&child, source).to_string());
            }
            if child.child_count() > 0 {
                extract_implements_depth(&child, source, result, depth + 1);
            }
        }
    }
}

/// Callee names that idiomatically accept callback references. Both identifier
/// (e.g. `handleToken`) and member-expression (e.g. `auth.validate`) args are
/// only emitted as dynamic callback calls when the callee is in this set;
/// otherwise plain values passed as data (`store.set(user.id, user)`,
/// `findMergeCandidates(communities)`) would emit spurious calls — e.g. `id`
/// with receiver `user`, or a fabricated edge to an unrelated same-named
/// function (issue #1741).
///
/// Arbitrary user-defined higher-order functions (e.g. `processEach(users,
/// fn: UserProcessor)`) are neither name-allowlisted nor position-mapped (see
/// `positional_callback_arg_index`) — those are instead recognized via
/// `CallbackParamShapes`, which looks at the callee's own parameter type
/// (issue #1845), same-file only.
///
/// Mirrors `CALLBACK_ACCEPTING_CALLEES` in `src/extractors/javascript.ts`.
const CALLBACK_ACCEPTING_CALLEES: &[&str] = &[
    // Express / router / middleware
    "use",
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "all",
    // Promises
    "then",
    "catch",
    "finally",
    // Array iteration / reduction
    "map",
    "filter",
    "forEach",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "reduce",
    "reduceRight",
    "flatMap",
    "sort",
    // Event emitters / DOM
    "on",
    "once",
    "off",
    "addListener",
    "removeListener",
    "addEventListener",
    "removeEventListener",
    "subscribe",
    "unsubscribe",
    // Scheduling / plain function callbacks
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
    "requestAnimationFrame",
    "requestIdleCallback",
    "nextTick",
    // Commander / yargs / hooks
    "action",
    "command",
];

/// HTTP-verb callees that double as Map/cache/repository method names.
/// Express/router invocations always take a string-literal route path as the
/// first argument (`app.get('/path', handler)`), whereas Map-like APIs pass
/// values/keys (`cache.get(user.id)`). Requiring a string-literal first arg
/// for these callees keeps real route handlers covered while dropping the
/// Map/cache false-positive surface. `use` is intentionally excluded here —
/// it stays in the general allowlist as a legitimate middleware registration
/// without a required path.
///
/// Mirrors `HTTP_VERB_CALLEES` in `src/extractors/javascript.ts`.
const HTTP_VERB_CALLEES: &[&str] = &[
    "get", "post", "put", "delete", "patch", "options", "head", "all",
];

/// Callees whose callback argument sits at one specific positional index
/// rather than "any position" (the assumption behind `CALLBACK_ACCEPTING_CALLEES`,
/// needed for variadic Express/Router middleware chains like
/// `app.get(path, mw1, mw2, handler)`).
///
/// `Array.from(arrayLike, mapFn, thisArg)` (also every TypedArray constructor,
/// e.g. `Uint8Array.from`) is the motivating case: `arrayLike` (index 0) is
/// plain data — treating it as a callback candidate would reintroduce the
/// exact name-collision false-positive class issue #1741 fixes — while
/// `mapFn` (index 1) is a genuine callback reference that should still
/// resolve. A callee listed here is implicitly callback-accepting (no
/// separate `CALLBACK_ACCEPTING_CALLEES` entry needed); only the arg at its
/// listed index is eligible.
///
/// Invariant: this map and `CALLBACK_ACCEPTING_CALLEES` must stay disjoint.
/// A callee name present in both would have its any-position intent silently
/// narrowed to the single listed index (positional wins — see the gate in
/// `extract_callback_reference_calls`), with no error or warning.
///
/// Name-based, not receiver-typed, so it can't distinguish `Array.from(x,
/// mapFn)` from an unrelated `.from(x, y)` shaped differently (e.g.
/// `Buffer.from(data, encoding)`) — that residual risk is far narrower than
/// the unconditional-emission bug this gate fixes, so it's accepted rather
/// than adding receiver-type tracking.
///
/// Mirrors `POSITIONAL_CALLBACK_ARG_INDEX` in `src/extractors/javascript.ts`.
fn positional_callback_arg_index(callee_name: &str) -> Option<usize> {
    match callee_name {
        "from" => Some(1),
        _ => None,
    }
}

/// Extract the callee's final name (function identifier or member expression
/// property) for callback-eligibility filtering. Returns `None` if the callee
/// shape is not analyzable (e.g. computed subscripts, IIFEs).
fn extract_callee_name<'a>(call_node: &Node, source: &'a [u8]) -> Option<&'a str> {
    let fn_node = call_node.child_by_field_name("function")?;
    match fn_node.kind() {
        "identifier" => Some(node_text(&fn_node, source)),
        "member_expression" => {
            let prop = fn_node.child_by_field_name("property")?;
            Some(node_text(&prop, source))
        }
        _ => None,
    }
}

/// True iff the first argument of an `arguments` node is a string literal —
/// used to distinguish Express/router route handlers (`app.get('/path', h)`)
/// from Map/cache APIs that reuse the same verb names (`cache.get(user.id)`).
fn first_arg_is_string_literal(args_node: &Node) -> bool {
    // Skip grammar punctuation; the first non-punctuation child is the first arg.
    if let Some(child) = iter_children(args_node, PUNCTUATION_TOKENS).next() {
        let kind = child.kind();
        return kind == "string" || kind == "template_string";
    }
    false
}

/// Maps a function/method's bare name (matching what `extract_callee_name`
/// returns) to the set of its own parameter positions whose declared
/// TypeScript type is function-shaped (an inline arrow-function type,
/// `Function`, or a `type X = (...) => ...` alias). Built once per file by
/// `collect_callback_param_shapes` and consulted by
/// `extract_callback_reference_calls` to recognize identifier arguments
/// passed to arbitrary user-defined higher-order functions (issue #1845),
/// not just the `CALLBACK_ACCEPTING_CALLEES` name allowlist.
///
/// Name-keyed rather than receiver-typed, consistent with the rest of this
/// gate (see `positional_callback_arg_index`'s doc comment for the same
/// tradeoff) — but unlike a plain name-keyed union, a position is only kept
/// when *every* same-named declaration in the file agrees it is
/// function-shaped (see `collect_callback_param_shapes`), so two unrelated
/// same-named declarations with different signatures (e.g. same-named
/// methods on two different classes) cancel out instead of merging into a
/// false positive.
///
/// Mirrors `CallbackParamShapes` in `src/extractors/javascript.ts`.
type CallbackParamShapes = HashMap<String, HashSet<usize>>;

/// True iff `type_node` denotes a function-shaped TypeScript type: an inline
/// arrow-function type (`(x: T) => R`), the `Function` type, a parenthesized
/// function type, a generic instantiation of one (`UserProcessor<T>`), or a
/// `type` alias name that itself resolves to one of the above (see
/// `collect_function_shaped_type_aliases`).
///
/// Deliberately not full type-checking: union/intersection types and
/// interface call signatures are not recognized, matching the same
/// "defensible heuristic, not full inference" scope as `extract_simple_type_name`.
///
/// Mirrors `isFunctionShapedTypeNode` in `src/extractors/javascript.ts`.
fn is_function_shaped_type_node(
    type_node: &Node,
    source: &[u8],
    alias_shapes: &HashMap<String, bool>,
) -> bool {
    match type_node.kind() {
        "function_type" => true,
        "parenthesized_type" => type_node
            .named_child(0)
            .map(|inner| is_function_shaped_type_node(&inner, source, alias_shapes))
            .unwrap_or(false),
        "type_identifier" => {
            let name = node_text(type_node, source);
            name == "Function" || alias_shapes.get(name).copied().unwrap_or(false)
        }
        "generic_type" => type_node
            .child(0)
            .map(|base| is_function_shaped_type_node(&base, source, alias_shapes))
            .unwrap_or(false),
        _ => false,
    }
}

/// True iff a `type_annotation` node's inner type is function-shaped.
///
/// Mirrors `isFunctionShapedTypeAnnotation` in `src/extractors/javascript.ts`.
fn is_function_shaped_type_annotation(
    type_annotation_node: &Node,
    source: &[u8],
    alias_shapes: &HashMap<String, bool>,
) -> bool {
    for i in 0..type_annotation_node.child_count() {
        if let Some(child) = type_annotation_node.child(i) {
            if child.kind() != ":" {
                return is_function_shaped_type_node(&child, source, alias_shapes);
            }
        }
    }
    false
}

/// Walk the file for `type X = ...` aliases and classify each by whether it
/// resolves to a function-shaped type, following one level of alias-to-alias
/// indirection (`type A = B` where `B` is itself function-shaped) with a
/// cycle guard. Motivating case: `export type UserProcessor = (user: User) => void;`.
///
/// Mirrors `collectFunctionShapedTypeAliases` in `src/extractors/javascript.ts`.
fn collect_function_shaped_type_aliases(root: &Node, source: &[u8]) -> HashMap<String, bool> {
    let mut direct_alias_of: HashMap<String, String> = HashMap::new();
    let mut resolved: HashMap<String, bool> = HashMap::new();

    fn walk(
        node: &Node,
        source: &[u8],
        depth: usize,
        direct_alias_of: &mut HashMap<String, String>,
        resolved: &mut HashMap<String, bool>,
    ) {
        if depth >= MAX_WALK_DEPTH {
            return;
        }
        if node.kind() == "type_alias_declaration" {
            let name_node = node.child_by_field_name("name");
            let value_node = node.child_by_field_name("value");
            if let (Some(name_node), Some(value_node)) = (name_node, value_node) {
                let name = node_text(&name_node, source).to_string();
                if value_node.kind() == "type_identifier" {
                    direct_alias_of.insert(name, node_text(&value_node, source).to_string());
                } else {
                    let shaped = is_function_shaped_type_node(&value_node, source, resolved);
                    resolved.insert(name, shaped);
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(&child, source, depth + 1, direct_alias_of, resolved);
            }
        }
    }
    walk(root, source, 0, &mut direct_alias_of, &mut resolved);

    // Resolve `type A = B` chains against the direct classifications above.
    for (name, alias_of) in &direct_alias_of {
        if !resolved.contains_key(name) {
            let shaped = alias_of == "Function" || resolved.get(alias_of).copied().unwrap_or(false);
            resolved.insert(name.clone(), shaped);
        }
    }
    resolved
}

/// Walk the whole file once to record, per `CallbackParamShapes`, which
/// parameter positions of every `function`/method declaration are
/// function-shaped — the callee-definition side of recognizing identifier
/// arguments to arbitrary user-defined higher-order functions (issue #1845).
/// Also covers same-file `const f = (...) => ...` / `const f = function(...) {}`
/// assignments, which are otherwise invisible to a walk that only looks at
/// `function_declaration`/`method_definition` nodes.
///
/// Same-file only: a call site whose callee is defined in another file has no
/// entry here and falls back to the existing name/position allowlist.
///
/// Mirrors `collectCallbackParamShapes` in `src/extractors/javascript.ts`.
fn collect_callback_param_shapes(root: &Node, source: &[u8]) -> CallbackParamShapes {
    let alias_shapes = collect_function_shaped_type_aliases(root, source);
    // One entry per same-named declaration; intersected below so a bare name
    // shared by two unrelated declarations only keeps a position that every
    // declaration agrees is function-shaped.
    let mut declarations: HashMap<String, Vec<HashSet<usize>>> = HashMap::new();

    fn function_shaped_param_indices(
        fn_node: &Node,
        source: &[u8],
        alias_shapes: &HashMap<String, bool>,
    ) -> HashSet<usize> {
        let mut indices = HashSet::new();
        let params_node = fn_node
            .child_by_field_name("parameters")
            .or_else(|| find_child(fn_node, "formal_parameters"));
        let Some(params_node) = params_node else {
            return indices;
        };

        let mut arg_index: usize = 0;
        for child in iter_children(&params_node, PUNCTUATION_TOKENS) {
            let kind = child.kind();
            if kind == "required_parameter" || kind == "optional_parameter" {
                // TypeScript's explicit `this` parameter (`function f(this: Foo, cb: Bar)`)
                // is compiled away and never appears at the call site, so it must not
                // consume an argument-index slot — otherwise every later parameter's
                // index would be off by one relative to the call's actual arguments.
                let is_this_param = child
                    .child_by_field_name("pattern")
                    .or_else(|| child.child_by_field_name("name"))
                    .map(|n| n.kind() == "this")
                    .unwrap_or(false);
                if is_this_param {
                    continue;
                }
            }
            if kind == "required_parameter" || kind == "optional_parameter" {
                if let Some(type_anno) = find_child(&child, "type_annotation") {
                    if is_function_shaped_type_annotation(&type_anno, source, alias_shapes) {
                        indices.insert(arg_index);
                    }
                }
            }
            arg_index += 1;
        }
        indices
    }

    fn record_declaration(
        name_node: Option<Node>,
        fn_node: &Node,
        source: &[u8],
        alias_shapes: &HashMap<String, bool>,
        declarations: &mut HashMap<String, Vec<HashSet<usize>>>,
    ) {
        let Some(name_node) = name_node else { return };
        let indices = function_shaped_param_indices(fn_node, source, alias_shapes);
        declarations
            .entry(node_text(&name_node, source).to_string())
            .or_default()
            .push(indices);
    }

    fn walk(
        node: &Node,
        source: &[u8],
        depth: usize,
        alias_shapes: &HashMap<String, bool>,
        declarations: &mut HashMap<String, Vec<HashSet<usize>>>,
    ) {
        if depth >= MAX_WALK_DEPTH {
            return;
        }
        match node.kind() {
            "function_declaration" | "generator_function_declaration" => {
                record_declaration(
                    node.child_by_field_name("name"),
                    node,
                    source,
                    alias_shapes,
                    declarations,
                );
            }
            "method_definition" => {
                record_declaration(
                    node.child_by_field_name("name"),
                    node,
                    source,
                    alias_shapes,
                    declarations,
                );
            }
            "variable_declarator" => {
                if let (Some(name_node), Some(value_node)) = (
                    node.child_by_field_name("name"),
                    node.child_by_field_name("value"),
                ) {
                    let vt = value_node.kind();
                    if name_node.kind() == "identifier"
                        && (vt == "arrow_function"
                            || vt == "function_expression"
                            || vt == "generator_function")
                    {
                        record_declaration(
                            Some(name_node),
                            &value_node,
                            source,
                            alias_shapes,
                            declarations,
                        );
                    }
                }
            }
            _ => {}
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(&child, source, depth + 1, alias_shapes, declarations);
            }
        }
    }
    walk(root, source, 0, &alias_shapes, &mut declarations);

    let mut shapes: CallbackParamShapes = HashMap::new();
    for (name, per_decl_indices) in declarations {
        let mut iter = per_decl_indices.into_iter();
        let Some(mut intersected) = iter.next() else {
            continue;
        };
        for other in iter {
            intersected.retain(|idx| other.contains(idx));
        }
        if !intersected.is_empty() {
            shapes.insert(name, intersected);
        }
    }
    shapes
}

/// Extract Call entries for named function references passed as arguments.
/// e.g. `router.use(handleToken, checkAuth)` yields calls to handleToken and checkAuth.
/// `app.use(auth.validate)` yields a call to validate with receiver auth.
///
/// Both identifier and member-expression args are only emitted when the
/// callee is in `CALLBACK_ACCEPTING_CALLEES`, the argument sits at the
/// specific index a `positional_callback_arg_index` entry designates, or the
/// callee is a same-file function/method whose own parameter at that index
/// is function-shaped per `CallbackParamShapes` (issue #1845 — arbitrary
/// user-defined higher-order functions like `processEach(users, fn:
/// UserProcessor)`, which no name/position allowlist can enumerate).
///
/// Known gap: `CallbackParamShapes` only covers callees defined in the same
/// file. A cross-file arbitrary higher-order function still falls back to
/// the name/position allowlist. Extending this to cross-file callees needs
/// the resolver's import-resolution machinery; tracked as a follow-up.
///
/// Mirrors `extractCallbackReferenceCalls` in `src/extractors/javascript.ts`.
fn extract_callback_reference_calls(
    call_node: &Node,
    source: &[u8],
    callback_param_shapes: &CallbackParamShapes,
    calls: &mut Vec<Call>,
) {
    let args = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"));
    let Some(args) = args else { return };
    let call_line = start_line(call_node);

    let callee_name = extract_callee_name(call_node, source);
    // .call() / .apply() / .bind() — the first arg is the `this` context (not a
    // callback of the enclosing function) and subsequent args flow into the
    // delegated function's parameters. Emitting them here would produce
    // false-positive edges from the *calling* function. This-rebinding
    // (fn::this → ctx) is handled separately by collect_this_call_and_bindings.
    if matches!(callee_name, Some("call") | Some("apply") | Some("bind")) {
        return;
    }
    let mut callback_args_allowed = callee_name
        .map(|n| CALLBACK_ACCEPTING_CALLEES.contains(&n))
        .unwrap_or(false);
    if callback_args_allowed {
        if let Some(name) = callee_name {
            if HTTP_VERB_CALLEES.contains(&name) {
                // HTTP verbs require a string-literal route path to be treated as a
                // callback-accepting API; otherwise `cache.get(user.id)` etc. would
                // still emit `id` as a dynamic call.
                callback_args_allowed = first_arg_is_string_literal(&args);
            }
        }
    }

    let positional_index = callee_name.and_then(positional_callback_arg_index);
    let callee_param_shapes = callee_name.and_then(|n| callback_param_shapes.get(n));
    if !callback_args_allowed
        && positional_index.is_none()
        && callee_param_shapes.map(|s| s.is_empty()).unwrap_or(true)
    {
        return;
    }

    for (arg_index, child) in iter_children(&args, PUNCTUATION_TOKENS).enumerate() {
        if let Some(idx) = positional_index {
            // A positional entry restricts eligibility to its one designated
            // index, regardless of what the generic (any-position) gate above
            // decided.
            if arg_index != idx {
                continue;
            }
        } else if !callback_args_allowed
            && !callee_param_shapes
                .map(|s| s.contains(&arg_index))
                .unwrap_or(false)
        {
            continue;
        }

        match child.kind() {
            "identifier" => {
                calls.push(Call {
                    name: node_text(&child, source).to_string(),
                    line: call_line,
                    dynamic: Some(true),
                    receiver: None,
                    ..Default::default()
                });
            }
            "member_expression" => {
                if let Some(prop) = child.child_by_field_name("property") {
                    let receiver = child
                        .child_by_field_name("object")
                        .map(|obj| extract_receiver_name(&obj, source));
                    calls.push(Call {
                        name: node_text(&prop, source).to_string(),
                        line: call_line,
                        dynamic: Some(true),
                        receiver,
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }
}

/// Collect a dynamic value-ref `Call` for an object-literal `pair` node whose
/// value is a bare identifier — e.g. `{ resolve: someFunction }`, the
/// "dispatch table" pattern (`{ matches, resolve }`-style handler arrays,
/// issue #1771). Restricted to plain `identifier` values: call expressions,
/// member expressions, and inline function/arrow values are handled by their
/// own extraction paths (regular call resolution, `seed_objlit_type_map_entries`
/// / `extract_object_literal_functions`) and must not be double-counted here.
///
/// Emitted unconditionally for every bare-identifier property value in the
/// file — `dynamic_kind: "value-ref"` is resolved downstream (build_edges.rs)
/// against function/method-kind targets ONLY, so plain data references
/// (`{ name: SOME_CONSTANT }`) naturally fail to resolve into an edge rather
/// than needing a structural allowlist gate here.
///
/// `key_expr` carries the property KEY (e.g. `resolve`), distinct from `name`
/// (the referenced value's own identifier, e.g. `someFunction`) — the
/// downstream "is this property ever invoked" liveness check (#1895) needs
/// the key, since that's the name a dispatch consumer would actually call
/// (`table.resolve(...)`), not the function's own declared name.
///
/// Node kinds `find_enclosing_table_name` passes through on its way up to a
/// `variable_declarator`. Mirrors `TABLE_NAME_PASSTHROUGH_TYPES` in
/// `src/extractors/javascript.ts`.
const TABLE_NAME_PASSTHROUGH_KINDS: &[&str] = &[
    "object",
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "non_null_expression",
];

/// Walk outward from `node` through EVERY enclosing scope-introducing
/// ancestor — not just function scopes — returning the start line of the
/// nearest one that directly declares/shadows `name` itself
/// (`introduces_shadowed_binding`, the same hardened shadow-detection #2257
/// built out, already handles function-likes, `catch`, `for`/`for-in`,
/// `statement_block`, and `switch_body`). `None` when no enclosing scope
/// redeclares it, i.e. it comes from module scope.
///
/// Shared by both sides of issue #2260's computed-dispatch-table
/// disambiguation (Greptile review, PR #2445, rounds 2 and 3): a file-scoped
/// evidence key alone let two different FUNCTIONS in one file, each
/// declaring their own same-named local table, share one entry; scoping by
/// enclosing FUNCTION alone (round 2's fix) still let two sibling BLOCKS
/// inside the SAME function do the same (e.g. an `if`/`else` each declaring
/// their own same-named table). Walking every scope level, not just
/// function boundaries, and identifying the match by its own line — not a
/// human-readable qualifier, since a bare block has no name — disambiguates
/// any two distinct lexical bindings of the same name anywhere in the file,
/// regardless of nesting shape. Mirrors `findDeclaringScopeLine` in
/// `src/extractors/javascript.ts`.
fn find_declaring_scope_line(node: &Node, name: &str, source: &[u8]) -> Option<u32> {
    let mut current = node.parent();
    while let Some(cur) = current {
        if introduces_shadowed_binding(&cur, name, source) {
            return Some(cur.start_position().row as u32);
        }
        current = cur.parent();
    }
    None
}

/// Walk up from a dispatch-table object-literal's `pair`/shorthand-property
/// node to find the name of the variable it's assigned to (e.g.
/// `GROOVY_NODE_HANDLERS` for `const GROOVY_NODE_HANDLERS = { ... }`) — used
/// to key the computed-access liveness pathway (issue #2260) on the TABLE's
/// own name, set as the value-ref Call's `receiver`. Bounded to a small
/// number of hops through common TS wrapper shapes so a deeply-nested or
/// non-declarator-assigned object literal simply yields no table name.
///
/// When the table's own declaration is scoped inside any block (not
/// module-level), the returned name carries a `#${line}` suffix identifying
/// that declaring scope (`find_declaring_scope_line`) — `#` can never
/// appear in a real identifier, so this can't collide with an actual table
/// name, and a module-scope table (the common case) is returned bare,
/// unchanged from before this suffix existed. Mirrors
/// `findEnclosingTableName` in `src/extractors/javascript.ts`.
fn find_enclosing_table_name(node: &Node, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    let mut hops = 0;
    while let Some(cur) = current {
        if hops >= 6 {
            return None;
        }
        if cur.kind() == "variable_declarator" {
            let name_n = cur.child_by_field_name("name")?;
            if name_n.kind() != "identifier" {
                return None;
            }
            let name = node_text(&name_n, source);
            return Some(match find_declaring_scope_line(&cur, name, source) {
                Some(scope_line) => format!("{name}#{scope_line}"),
                None => name.to_string(),
            });
        }
        if !TABLE_NAME_PASSTHROUGH_KINDS.contains(&cur.kind()) {
            return None;
        }
        current = cur.parent();
        hops += 1;
    }
    None
}

const MAX_ALIAS_DEPTH: usize = 6;
const OBJLIT_TRACKED_PARENTS: &[&str] = &[
    "member_expression",
    "subscript_expression",
    "for_in_statement",
];
const GLOBAL_OBJECT_NAMES: &[&str] = &["globalThis", "global", "self", "window"];

fn object_literal_site_id(object_node: &Node) -> String {
    format!(
        "{}:{}",
        object_node.start_position().row,
        object_node.start_position().column
    )
}

fn enclosing_object_literal<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    let parent = node.parent()?;
    if parent.kind() == "object" {
        Some(parent)
    } else {
        None
    }
}

fn seed_object_literal_site(
    object_node: Option<Node>,
    symbols: &mut FileSymbols,
) -> Option<String> {
    let object_node = object_node?;
    let site = object_literal_site_id(&object_node);
    if !symbols.object_literal_sites.iter().any(|s| s.site == site) {
        symbols.object_literal_sites.push(ObjectLiteralSite {
            site: site.clone(),
            owner: None,
            escapes: true,
        });
    }
    Some(site)
}

fn finalize_object_literal_sites(root: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if symbols.object_literal_sites.is_empty() {
        return;
    }
    let exported_names = collect_exported_binding_names(root, source);
    let definition_names: HashSet<String> = symbols
        .definitions
        .iter()
        .filter(|d| d.kind == "function" || d.kind == "method")
        .map(|d| d.name.clone())
        .collect();
    compute_object_literal_site_escapes(
        &mut symbols.object_literal_sites,
        root,
        source,
        &exported_names,
        &definition_names,
    );
}

fn unwrap_parens<'a>(node: Node<'a>, depth: usize) -> Node<'a> {
    if depth >= MAX_WALK_DEPTH {
        return node;
    }
    if node.kind() != "parenthesized_expression" {
        return node;
    }
    match node.named_child(0) {
        Some(inner) => unwrap_parens(inner, depth + 1),
        None => node,
    }
}

fn compute_object_literal_site_escapes(
    sites: &mut [ObjectLiteralSite],
    root: &Node,
    source: &[u8],
    exported_names: &HashSet<String>,
    definition_names: &HashSet<String>,
) {
    for entry in sites.iter_mut() {
        let Some(object_node) = find_node_at_site(root, &entry.site) else {
            continue;
        };
        let Some(owner) = resolve_site_owner(&object_node, source) else {
            continue;
        };
        entry.owner = Some(owner.key.clone());
        if literal_has_unmodeled_this_reference(&object_node, root, source, definition_names) {
            entry.escapes = true;
            continue;
        }
        if owner.binding_name.is_none() {
            entry.escapes = true;
            continue;
        }
        let binding_name = owner.binding_name.as_deref().unwrap();
        if exported_names.contains(binding_name) {
            continue;
        }
        let is_array_owner = owner.key != binding_name;
        entry.escapes = !all_references_tracked(
            root,
            source,
            exported_names,
            binding_name,
            &object_node,
            is_array_owner,
            None,
            0,
            None,
        );
    }
}

struct SiteOwner {
    key: String,
    binding_name: Option<String>,
}

fn resolve_site_owner(object_node: &Node, source: &[u8]) -> Option<SiteOwner> {
    let mut current = object_node.parent();
    let mut hops = 0;
    let mut in_array = false;
    while let Some(cur) = current {
        if hops >= 6 {
            return None;
        }
        if cur.kind() == "array" {
            in_array = true;
            current = cur.parent();
            hops += 1;
            continue;
        }
        if cur.kind() == "variable_declarator" {
            let name_n = cur.child_by_field_name("name")?;
            if name_n.kind() != "identifier" {
                return None;
            }
            let binding_name = node_text(&name_n, source).to_string();
            let key = if in_array {
                format!("{binding_name}[*]")
            } else {
                binding_name.clone()
            };
            return Some(SiteOwner {
                key,
                binding_name: Some(binding_name),
            });
        }
        if cur.kind() == "return_statement" {
            let fn_name = find_enclosing_function_qualifier(&cur, source)?;
            return Some(SiteOwner {
                key: format!("{fn_name}::return"),
                binding_name: None,
            });
        }
        if !TABLE_NAME_PASSTHROUGH_KINDS.contains(&cur.kind()) {
            return None;
        }
        current = cur.parent();
        hops += 1;
    }
    None
}

fn find_node_at_site<'a>(root: &Node<'a>, site: &str) -> Option<Node<'a>> {
    let (row_s, col_s) = site.split_once(':')?;
    let row: usize = row_s.parse().ok()?;
    let col: usize = col_s.parse().ok()?;
    fn walk<'a>(node: Node<'a>, row: usize, col: usize, depth: usize) -> Option<Node<'a>> {
        if depth >= MAX_WALK_DEPTH {
            return None;
        }
        if node.kind() == "object"
            && node.start_position().row == row
            && node.start_position().column == col
        {
            return Some(node);
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if let Some(found) = walk(child, row, col, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    walk(*root, row, col, 0)
}

fn collect_exported_binding_names(root: &Node, source: &[u8]) -> HashSet<String> {
    let mut names = HashSet::new();
    fn add_from_decl(decl: &Node, source: &[u8], names: &mut HashSet<String>) {
        match decl.kind() {
            "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration" => {
                if let Some(n) = decl.child_by_field_name("name") {
                    names.insert(node_text(&n, source).to_string());
                }
            }
            "lexical_declaration" | "variable_declaration" => {
                for i in 0..decl.child_count() {
                    let Some(declarator) = decl.child(i) else {
                        continue;
                    };
                    if declarator.kind() != "variable_declarator" {
                        continue;
                    }
                    let Some(name_n) = declarator.child_by_field_name("name") else {
                        continue;
                    };
                    match name_n.kind() {
                        "identifier" => {
                            names.insert(node_text(&name_n, source).to_string());
                        }
                        "object_pattern" => {
                            for n in collect_object_pattern_names(&name_n, source, &mut Vec::new())
                            {
                                names.insert(n);
                            }
                        }
                        "array_pattern" => {
                            for n in collect_array_pattern_names(&name_n, source) {
                                names.insert(n);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    fn visit(node: &Node, source: &[u8], names: &mut HashSet<String>, depth: usize) {
        if depth >= MAX_WALK_DEPTH {
            return;
        }
        if node.kind() == "export_statement" {
            if let Some(decl) = node.child_by_field_name("declaration") {
                add_from_decl(&decl, source, names);
            }
            collect_export_clause_names(node, source, names, 0);
            return;
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                visit(&child, source, names, depth + 1);
            }
        }
    }
    visit(root, source, &mut names, 0);
    names
}

fn collect_export_clause_names(
    node: &Node,
    source: &[u8],
    names: &mut HashSet<String>,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    if node.kind() == "export_specifier" {
        let local = node
            .child_by_field_name("local")
            .or_else(|| node.child_by_field_name("name"))
            .or_else(|| node.child(0));
        if let Some(local) = local {
            if local.kind() == "identifier" || local.kind() == "property_identifier" {
                names.insert(node_text(&local, source).to_string());
            }
        }
        return;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            collect_export_clause_names(&child, source, names, depth + 1);
        }
    }
}

fn is_positively_this_free_literal(value: &Node) -> bool {
    matches!(
        value.kind(),
        "string"
            | "number"
            | "true"
            | "false"
            | "null"
            | "template_string"
            | "regex"
            | "array"
            | "object"
    )
}

fn subtree_contains_this_keyword(node: &Node, depth: usize) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return true;
    }
    if node.kind() == "this" {
        return true;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if subtree_contains_this_keyword(&child, depth + 1) {
                return true;
            }
        }
    }
    false
}

fn literal_has_unmodeled_this_reference(
    object_node: &Node,
    root: &Node,
    source: &[u8],
    definition_names: &HashSet<String>,
) -> bool {
    for i in 0..object_node.child_count() {
        let Some(child) = object_node.child(i) else {
            continue;
        };
        if child.kind() == "method_definition" {
            for gi in 0..child.child_count() {
                if child.child(gi).is_some_and(|c| c.kind() == "get") {
                    return true;
                }
            }
            if subtree_contains_this_keyword(&child, 0) {
                return true;
            }
            continue;
        }
        if child.kind() == "shorthand_property_identifier" {
            let text = node_text(&child, source);
            if JS_BUILTIN_GLOBALS.contains(&text) {
                return true;
            }
            if resolve_identifier_value_this_reference(
                object_node,
                root,
                source,
                text,
                definition_names,
            ) {
                return true;
            }
            continue;
        }
        if child.kind() == "pair" {
            if let Some(key) = child.child_by_field_name("key") {
                if key.kind() != "computed_property_name" {
                    let raw = node_text(&key, source);
                    if raw.contains('\\') || raw.replace(['\'', '"', '`'], "") == "__proto__" {
                        return true;
                    }
                }
            }
            let Some(value) = child.child_by_field_name("value") else {
                return true;
            };
            if value.kind() == "arrow_function" {
                continue;
            }
            if value.kind() == "function_expression" || value.kind() == "function" {
                if subtree_contains_this_keyword(&value, 0) {
                    return true;
                }
                continue;
            }
            if value.kind() == "identifier" {
                let text = node_text(&value, source);
                if JS_BUILTIN_GLOBALS.contains(&text) {
                    return true;
                }
                if resolve_identifier_value_this_reference(
                    object_node,
                    root,
                    source,
                    text,
                    definition_names,
                ) {
                    return true;
                }
                continue;
            }
            if is_positively_this_free_literal(&value) {
                continue;
            }
            return true;
        }
        if child.kind() == "spread_element" {
            return true;
        }
    }
    false
}

fn resolve_identifier_value_this_reference(
    object_node: &Node,
    root: &Node,
    source: &[u8],
    name: &str,
    definition_names: &HashSet<String>,
) -> bool {
    if !definition_names.contains(name) {
        return true;
    }
    let declaring_scope = find_resolving_scope_node(object_node, name, source).unwrap_or(*root);
    if declaring_scope.id() != root.id() {
        return true;
    }
    let Some(fn_node) = find_top_level_function_node_by_name(root, name, source) else {
        return true;
    };
    if subtree_contains_reassignment_of(root, name, source, 0) {
        return true;
    }
    if fn_node.kind() == "arrow_function" {
        return false;
    }
    subtree_contains_this_keyword(&fn_node, 0)
}

fn find_resolving_scope_node<'a>(node: &Node<'a>, name: &str, source: &[u8]) -> Option<Node<'a>> {
    let mut current = node.parent();
    while let Some(cur) = current {
        if cur.kind() == "for_in_statement" {
            if let Some(left) = cur.child_by_field_name("left") {
                if pattern_binds_name(&unwrap_parens(left, 0), name, source, 0) {
                    return Some(cur);
                }
            }
        }
        if cur.kind() == "arrow_function" {
            if let Some(param) = cur.child_by_field_name("parameter") {
                if node_text(&param, source) == name {
                    return Some(cur);
                }
            }
        }
        if cur.kind() == "with_statement" {
            return Some(cur);
        }
        if introduces_shadowed_binding(&cur, name, source) {
            return Some(cur);
        }
        current = cur.parent();
    }
    None
}

fn find_top_level_function_node_by_name<'a>(
    root: &Node<'a>,
    name: &str,
    source: &[u8],
) -> Option<Node<'a>> {
    let mut result = None;
    let mut declaration_count = 0usize;
    for i in 0..root.child_count() {
        let mut stmt = root.child(i);
        if let Some(s) = stmt {
            if s.kind() == "export_statement" {
                stmt = s.child_by_field_name("declaration").or_else(|| s.child(1));
            }
        }
        let Some(stmt) = stmt else {
            continue;
        };
        if stmt.kind() == "function_declaration" || stmt.kind() == "generator_function_declaration"
        {
            if stmt
                .child_by_field_name("name")
                .is_some_and(|n| node_text(&n, source) == name)
            {
                declaration_count += 1;
                result = Some(stmt);
            }
            continue;
        }
        if stmt.kind() == "lexical_declaration" || stmt.kind() == "variable_declaration" {
            for j in 0..stmt.child_count() {
                let Some(decl) = stmt.child(j) else {
                    continue;
                };
                if decl.kind() != "variable_declarator" {
                    continue;
                }
                if decl
                    .child_by_field_name("name")
                    .is_none_or(|n| node_text(&n, source) != name)
                {
                    continue;
                }
                declaration_count += 1;
                if let Some(value) = decl.child_by_field_name("value") {
                    if value.kind() == "arrow_function"
                        || value.kind() == "function_expression"
                        || value.kind() == "function"
                    {
                        result = Some(value);
                    }
                }
            }
            continue;
        }
        declaration_count += count_hoisted_var_scope_declarations(&stmt, name, source, 0);
    }
    if declaration_count > 1 {
        None
    } else {
        result
    }
}

fn count_hoisted_var_scope_declarations(
    node: &Node,
    name: &str,
    source: &[u8],
    depth: usize,
) -> usize {
    if depth >= MAX_WALK_DEPTH {
        return 2;
    }
    let mut count = 0usize;
    if node.kind() == "variable_declaration" && declaration_declares_name(node, name, source) {
        count += 1;
    }
    if node.kind() == "function_declaration"
        && node
            .child_by_field_name("name")
            .is_some_and(|n| node_text(&n, source) == name)
    {
        count += 1;
    }
    if FUNCTION_SCOPE_NODE_TYPES.contains(&node.kind()) {
        return count;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            count += count_hoisted_var_scope_declarations(&child, name, source, depth + 1);
        }
    }
    count
}

fn subtree_contains_reassignment_of(node: &Node, name: &str, source: &[u8], depth: usize) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return true;
    }
    if node.kind() == "assignment_expression" || node.kind() == "augmented_assignment_expression" {
        if let Some(left) = node.child_by_field_name("left") {
            let unwrapped = unwrap_parens(left, 0);
            if pattern_binds_name(&unwrapped, name, source, 0) {
                return true;
            }
            if is_global_object_qualified_write(&unwrapped, name, source) {
                return true;
            }
        }
    } else if node.kind() == "update_expression" {
        if let Some(arg) = node.child_by_field_name("argument") {
            let target = unwrap_parens(arg, 0);
            if target.kind() == "identifier" && node_text(&target, source) == name {
                return true;
            }
        }
    } else if node.kind() == "for_in_statement" {
        if let Some(left) = node.child_by_field_name("left") {
            let kind = node.child_by_field_name("kind");
            let is_var = kind.map(|k| node_text(&k, source) == "var").unwrap_or(true);
            if pattern_binds_name(&unwrap_parens(left, 0), name, source, 0) && is_var {
                return true;
            }
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if subtree_contains_reassignment_of(&child, name, source, depth + 1) {
                return true;
            }
        }
    }
    false
}

fn is_global_object_qualified_write(node: &Node, name: &str, source: &[u8]) -> bool {
    if node.kind() == "member_expression" {
        let Some(object) = node.child_by_field_name("object") else {
            return false;
        };
        let Some(property) = node.child_by_field_name("property") else {
            return false;
        };
        let obj = unwrap_parens(object, 0);
        return obj.kind() == "identifier"
            && GLOBAL_OBJECT_NAMES.contains(&node_text(&obj, source))
            && node_text(&property, source) == name;
    }
    if node.kind() == "subscript_expression" {
        let Some(object) = node.child_by_field_name("object") else {
            return false;
        };
        let obj = unwrap_parens(object, 0);
        if obj.kind() != "identifier" || !GLOBAL_OBJECT_NAMES.contains(&node_text(&obj, source)) {
            return false;
        }
        let Some(raw_index) = node.child_by_field_name("index") else {
            return false;
        };
        let index = unwrap_parens(raw_index, 0);
        if index.kind() != "string" && index.kind() != "template_string" {
            return false;
        }
        let property_name = node_text(&index, source).replace(['\'', '"', '`'], "");
        return !property_name.is_empty() && !property_name.contains('$') && property_name == name;
    }
    false
}

fn function_scope_declares_var_excluding_static_blocks(
    node: &Node,
    name: &str,
    source: &[u8],
    depth: usize,
) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    if node.kind() == "variable_declaration" && declaration_declares_name(node, name, source) {
        return true;
    }
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else {
            continue;
        };
        if FUNCTION_SCOPE_NODE_TYPES.contains(&child.kind()) || child.kind() == "class_static_block"
        {
            continue;
        }
        if function_scope_declares_var_excluding_static_blocks(&child, name, source, depth + 1) {
            return true;
        }
    }
    false
}

fn scope_shadows_name(node: &Node, name: &str, source: &[u8]) -> bool {
    if FUNCTION_SCOPE_NODE_TYPES.contains(&node.kind()) {
        if node
            .child_by_field_name("name")
            .is_some_and(|n| node_text(&n, source) == name)
        {
            return true;
        }
        if let Some(params) = node.child_by_field_name("parameters") {
            for i in 0..params.child_count() {
                if let Some(param) = params.child(i) {
                    if pattern_binds_name(&param, name, source, 0) {
                        return true;
                    }
                }
            }
        }
        if let Some(param) = node.child_by_field_name("parameter") {
            if pattern_binds_name(&unwrap_parens(param, 0), name, source, 0) {
                return true;
            }
        }
        return node.child_by_field_name("body").is_some_and(|body| {
            function_scope_declares_var_excluding_static_blocks(&body, name, source, 0)
        });
    }
    if SCOPE_NODE_TYPES.contains(&node.kind()) {
        return introduces_shadowed_binding(node, name, source);
    }
    false
}

fn find_declaring_scope_node<'a>(node: &Node<'a>, name: &str, source: &[u8]) -> Option<Node<'a>> {
    let mut current = node.parent();
    while let Some(cur) = current {
        if scope_shadows_name(&cur, name, source) {
            return Some(cur);
        }
        current = cur.parent();
    }
    None
}

fn find_enclosing_function_body<'a>(node: &Node<'a>) -> Option<Node<'a>> {
    let mut current = node.parent();
    while let Some(cur) = current {
        if FUNCTION_SCOPE_NODE_TYPES.contains(&cur.kind()) {
            return cur.child_by_field_name("body");
        }
        current = cur.parent();
    }
    None
}

fn is_binding_occurrence(node: &Node, source: &[u8]) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    if parent.kind() == "variable_declarator"
        && parent
            .child_by_field_name("name")
            .is_some_and(|n| n.id() == node.id())
    {
        return true;
    }
    if parent.kind() == "for_in_statement" {
        if let Some(left) = parent.child_by_field_name("left") {
            if left.id() == node.id()
                || pattern_binds_name(&unwrap_parens(left, 0), node_text(node, source), source, 0)
            {
                return true;
            }
        }
    }
    if (parent.kind() == "function_declaration"
        || parent.kind() == "generator_function_declaration")
        && parent
            .child_by_field_name("name")
            .is_some_and(|n| n.id() == node.id())
    {
        return true;
    }
    false
}

fn enclosing_declarator_if_value<'a>(ref_node: &Node<'a>) -> Option<Node<'a>> {
    let mut current = Some(*ref_node);
    while let Some(cur) = current {
        let parent = cur.parent()?;
        if parent.kind() == "variable_declarator"
            && parent
                .child_by_field_name("value")
                .is_some_and(|v| v.id() == cur.id())
        {
            return Some(parent);
        }
        if TABLE_NAME_PASSTHROUGH_KINDS.contains(&parent.kind()) {
            current = Some(parent);
            continue;
        }
        return None;
    }
    None
}

fn is_tracked_reference_position_src(ref_node: &Node, is_array_owner: bool, source: &[u8]) -> bool {
    let Some(parent) = ref_node.parent() else {
        return false;
    };
    if !OBJLIT_TRACKED_PARENTS.contains(&parent.kind()) {
        return false;
    }
    if parent.kind() == "member_expression" || parent.kind() == "subscript_expression" {
        if is_array_owner {
            return false;
        }
        let Some(object) = parent.child_by_field_name("object") else {
            return false;
        };
        if object.id() != ref_node.id() {
            return false;
        }
        if let Some(prop) = parent.child_by_field_name("property") {
            let prop_text = node_text(&prop, source);
            if prop_text == "call" || prop_text == "apply" || prop_text == "bind" {
                return false;
            }
        }
        let Some(grandparent) = parent.parent() else {
            return false;
        };
        if grandparent.kind() != "call_expression" {
            return false;
        }
        if grandparent
            .child_by_field_name("function")
            .is_none_or(|f| f.id() != parent.id())
        {
            return false;
        }
        if parent.kind() == "subscript_expression" {
            let Some(index) = parent.child_by_field_name("index") else {
                return false;
            };
            if index.kind() != "string" && index.kind() != "template_string" {
                return false;
            }
            let method_name = node_text(&index, source).replace(['\'', '"', '`'], "");
            if method_name.is_empty() || method_name.contains('$') {
                return false;
            }
        }
        return true;
    }
    if parent
        .child_by_field_name("right")
        .is_none_or(|r| r.id() != ref_node.id())
    {
        return false;
    }
    parent
        .child_by_field_name("operator")
        .is_some_and(|op| node_text(&op, source) == "of")
}

#[allow(clippy::too_many_arguments)]
fn all_references_tracked(
    root: &Node,
    source: &[u8],
    exported_names: &HashSet<String>,
    binding_name: &str,
    object_node: &Node,
    is_array_owner: bool,
    declaring_scope: Option<Node>,
    depth: usize,
    skip_node: Option<usize>,
) -> bool {
    if exported_names.contains(binding_name) {
        return false;
    }
    if depth >= MAX_ALIAS_DEPTH {
        return false;
    }
    let scope = declaring_scope
        .or_else(|| find_declaring_scope_node(object_node, binding_name, source))
        .unwrap_or(*root);
    let mut refs = Vec::new();
    let mut covered = true;
    #[allow(clippy::too_many_arguments)]
    fn walk<'a>(
        node: Node<'a>,
        scope_id: usize,
        binding_name: &str,
        source: &[u8],
        skip_node: Option<usize>,
        refs: &mut Vec<Node<'a>>,
        covered: &mut bool,
        walk_depth: usize,
    ) {
        if walk_depth >= MAX_WALK_DEPTH {
            *covered = false;
            return;
        }
        if node.id() != scope_id && scope_shadows_name(&node, binding_name, source) {
            return;
        }
        // #2088 B5 / #2640: a globalThis/window/global/self qualified read
        // of this binding is a real reference the identifier walk cannot
        // see (`property_identifier` / string index). Unconditionally
        // untracked — no T1 channel exists for a synthetic global-object
        // lookup.
        if is_global_object_qualified_write(&node, binding_name, source) {
            *covered = false;
            return;
        }
        if (node.kind() == "identifier" || node.kind() == "shorthand_property_identifier")
            && node_text(&node, source) == binding_name
            && !is_binding_occurrence(&node, source)
            && skip_node != Some(node.id())
        {
            refs.push(node);
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(
                    child,
                    scope_id,
                    binding_name,
                    source,
                    skip_node,
                    refs,
                    covered,
                    walk_depth + 1,
                );
            }
        }
    }
    walk(
        scope,
        scope.id(),
        binding_name,
        source,
        skip_node,
        &mut refs,
        &mut covered,
        0,
    );
    if !covered {
        return false;
    }
    for ref_node in refs {
        if is_tracked_reference_position_src(&ref_node, is_array_owner, source) {
            if let Some(parent) = ref_node.parent() {
                if parent.kind() == "for_in_statement" {
                    let Some(left) = parent.child_by_field_name("left") else {
                        return false;
                    };
                    let unwrapped = unwrap_parens(left, 0);
                    if unwrapped.kind() != "identifier" {
                        return false;
                    }
                    let loop_var = node_text(&unwrapped, source).to_string();
                    let kind = parent
                        .child_by_field_name("kind")
                        .map(|k| node_text(&k, source).to_string());
                    let loop_scope = if kind.as_deref() == Some("var") {
                        find_enclosing_function_body(&parent).unwrap_or(scope)
                    } else {
                        parent.child_by_field_name("body").unwrap_or(scope)
                    };
                    if !all_references_tracked(
                        root,
                        source,
                        exported_names,
                        &loop_var,
                        object_node,
                        false,
                        Some(loop_scope),
                        depth + 1,
                        Some(unwrapped.id()),
                    ) {
                        return false;
                    }
                }
            }
            continue;
        }
        if let Some(declarator) = enclosing_declarator_if_value(&ref_node) {
            let Some(name_node) = declarator.child_by_field_name("name") else {
                return false;
            };
            if name_node.kind() != "identifier" {
                return false;
            }
            let alias = node_text(&name_node, source).to_string();
            let alias_scope =
                find_declaring_scope_node(&name_node, &alias, source).unwrap_or(scope);
            if !all_references_tracked(
                root,
                source,
                exported_names,
                &alias,
                object_node,
                is_array_owner,
                Some(alias_scope),
                depth + 1,
                Some(name_node.id()),
            ) {
                return false;
            }
            continue;
        }
        return false;
    }
    true
}

/// Mirrors `collectObjectLiteralValueRefCall` in `src/extractors/javascript.ts`.
/// `receiver` (issue #2260) carries the TABLE's own variable name, when
/// resolvable — see `find_enclosing_table_name`.
fn handle_object_literal_pair_value_ref(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(value_n) = node.child_by_field_name("value") else {
        return;
    };
    if value_n.kind() != "identifier" {
        return;
    }
    let text = node_text(&value_n, source);
    if JS_BUILTIN_GLOBALS.contains(&text) {
        return;
    }
    let key_expr = node
        .child_by_field_name("key")
        .and_then(|k| resolve_pair_key_name(&k, source));
    let site = seed_object_literal_site(enclosing_object_literal(node), symbols);
    symbols.calls.push(Call {
        name: text.to_string(),
        line: start_line(&value_n),
        dynamic: Some(true),
        dynamic_kind: Some("value-ref".to_string()),
        key_expr,
        receiver: find_enclosing_table_name(node, source),
        object_literal_site: site,
        ..Default::default()
    });
}

/// Collect a dynamic value-ref `Call` for an object-literal shorthand property
/// (`{ someFunction }`) — semantically identical to `{ someFunction: someFunction }`.
/// `shorthand_property_identifier` only appears inside object-literal
/// EXPRESSIONS in this grammar (destructuring patterns use the distinct
/// `shorthand_property_identifier_pattern` kind), so this can't misfire on
/// destructuring targets.
///
/// `key_expr` equals `name` here — the property key and the referenced value
/// are the same identifier in shorthand form (#1895).
///
/// Mirrors the walk path's `shorthand_property_identifier` handling in
/// `src/extractors/javascript.ts`'s `runCollectorWalk` (issue #1771).
fn handle_object_literal_shorthand_value_ref(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    let text = node_text(node, source);
    if JS_BUILTIN_GLOBALS.contains(&text) {
        return;
    }
    let site = seed_object_literal_site(enclosing_object_literal(node), symbols);
    symbols.calls.push(Call {
        name: text.to_string(),
        line: start_line(node),
        dynamic: Some(true),
        dynamic_kind: Some("value-ref".to_string()),
        key_expr: Some(text.to_string()),
        receiver: find_enclosing_table_name(node, source),
        object_literal_site: site,
        ..Default::default()
    });
}

/// Collect a dynamic value-ref `Call` for the right-hand operand of an
/// `instanceof` binary expression when it's a bare identifier — e.g.
/// `err instanceof CodegraphError` (issue #1784). `instanceof` reads its
/// right operand as a value (a prototype-chain check), never calls it, so
/// this is the same "referenced as a value, not a call site" shape as the
/// object-literal (#1771) and Lua builtin-reassignment (#1776) sites —
/// reused rather than given its own `dynamic_kind` (see ADR-002).
///
/// Restricted to plain `identifier` right operands: `a instanceof B.C`
/// (`member_expression`) and `a instanceof (foo())` (parenthesized/call
/// expressions) are left unresolved rather than guessing — same
/// "restrict to the simplest syntactic shape" precedent as #1771.
///
/// Unlike the function/method-only value-ref sites, `instanceof`'s operand
/// is always a class/constructor — the resolver-side kind filter in
/// `build_edges.rs` accepts `class`-kind targets in addition to
/// function/method for this reason.
///
/// A JSX element's opening/self-closing tag name is a reference to the
/// component it renders — `<Header />` is exactly as much a use of `Header`
/// as `Header()` would be, but produces no call edge by construction since
/// it's not a `call_expression` (issue #2389). Emitted as a `value-ref`
/// dynamic call, the same mechanism already used for object-literal
/// property values, `instanceof` operands, and logical-or/ternary fallbacks.
///
/// Only a capitalized bare identifier is treated as a component reference,
/// matching JSX's own convention: a lowercase-first tag name (`<div>`,
/// `<span>`) compiles to a DOM/intrinsic element (not an identifier
/// reference) and must not be credited as a symbol use. A `member_expression`
/// name (`<Namespace.Component />`) credits the base object identifier.
///
/// Mirrors `handleJsxElementRef` in `src/extractors/javascript.ts`.
fn handle_jsx_element_ref(node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let line = start_line(node);
    match name_node.kind() {
        "identifier" => {
            let text = node_text(&name_node, source);
            if !text.starts_with(|c: char| c.is_ascii_uppercase())
                || JS_BUILTIN_GLOBALS.contains(&text)
            {
                return;
            }
            calls.push(Call {
                name: text.to_string(),
                line,
                dynamic: Some(true),
                dynamic_kind: Some("value-ref".to_string()),
                ..Default::default()
            });
        }
        "member_expression" => {
            let Some(obj_node) = name_node.child_by_field_name("object") else {
                return;
            };
            if obj_node.kind() != "identifier" {
                return;
            }
            let text = node_text(&obj_node, source);
            if JS_BUILTIN_GLOBALS.contains(&text) {
                return;
            }
            calls.push(Call {
                name: text.to_string(),
                line,
                dynamic: Some(true),
                dynamic_kind: Some("value-ref".to_string()),
                ..Default::default()
            });
        }
        _ => {}
    }
}

/// A capitalized bare identifier passed as a call argument is a value
/// reference to whatever it names — `Factory.create(AppModule)` is a
/// genuine use of `AppModule` (issue #2389; the NestJS module/controller
/// registration idiom, `NestFactory.create(AppModule)`, relies on exactly
/// this pattern).
///
/// Restricted to capitalized identifiers — the same class/component-naming
/// convention already used to gate JSX element references
/// (`handle_jsx_element_ref`) — deliberately, not merely for style: issue
/// #1741 is a regression guard proving that crediting an arbitrary
/// lowercase DATA argument (e.g. `analyzeDrift(communities, communityDirs)`)
/// as any kind of reference risks the global-fallback resolver binding it
/// to an unrelated same-named function elsewhere in the repo, fabricating a
/// call edge and, transitively, a phantom cycle. A class/component
/// reference passed by value is overwhelmingly PascalCase in JS/TS
/// convention, so this restriction captures the pattern #2389 asks for
/// while leaving #1741's already-diagnosed false-positive risk exactly as
/// closed as it was.
///
/// Restricted to direct-child bare identifiers of the arguments list,
/// mirroring this file's "restrict to the simplest syntactic shape"
/// precedent (#1771/#1784).
///
/// Mirrors `extractCallArgumentIdentifierRefs` in `src/extractors/javascript.ts`.
fn extract_call_argument_identifier_refs(call_node: &Node, source: &[u8]) -> Vec<Call> {
    let mut result = Vec::new();
    let Some(args) = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"))
    else {
        return result;
    };
    let line = start_line(call_node);
    for i in 0..args.child_count() {
        let Some(child) = args.child(i) else { continue };
        if child.kind() != "identifier" {
            continue;
        }
        let text = node_text(&child, source);
        if !text.starts_with(|c: char| c.is_ascii_uppercase()) || JS_BUILTIN_GLOBALS.contains(&text)
        {
            continue;
        }
        result.push(Call {
            name: text.to_string(),
            line,
            dynamic: Some(true),
            dynamic_kind: Some("value-ref".to_string()),
            ..Default::default()
        });
    }
    result
}

/// Mirrors `collectInstanceofValueRefCall` in `src/extractors/javascript.ts`.
fn handle_instanceof_value_ref(node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let Some(operator_n) = node.child_by_field_name("operator") else {
        return;
    };
    if node_text(&operator_n, source) != "instanceof" {
        return;
    }
    let Some(right_n) = node.child_by_field_name("right") else {
        return;
    };
    if right_n.kind() != "identifier" {
        return;
    }
    let text = node_text(&right_n, source);
    if JS_BUILTIN_GLOBALS.contains(&text) {
        return;
    }
    calls.push(Call {
        name: text.to_string(),
        line: start_line(&right_n),
        dynamic: Some(true),
        dynamic_kind: Some("value-ref".to_string()),
        ..Default::default()
    });
}

/// Node types that introduce their own lexical scope — checked for shadowing
/// by `introduces_shadowed_binding` before `block_contains_identifier_excluding`
/// recurses into them, so a same-named binding declared in a NESTED scope
/// doesn't get mistaken for a reference to the outer fallback variable being
/// checked (issue #2257, Greptile review).
///
/// `for_in_statement` is deliberately ABSENT (Greptile review, PR #2432): a
/// `for (… of right)` head that binds `name` must not prune the whole loop,
/// because `right` is evaluated in the ENCLOSING scope and can hold a genuine
/// read (`for (const x of fn())`). `block_contains_identifier_excluding`
/// handles that shape directly instead — scanning `right` while skipping the
/// body.
///
/// Mirrors `SCOPE_NODE_TYPES` in `src/extractors/javascript.ts`.
const SCOPE_NODE_TYPES: &[&str] = &[
    "statement_block",
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
    "arrow_function",
    "method_definition",
    "catch_clause",
    "for_statement",
    "switch_body",
];

/// Node types that open a new FUNCTION scope — the boundary at which a `var`
/// declaration is scoped, and therefore the level at which a `var` shadow of
/// `name` has to be detected (see `function_scope_declares_var`).
///
/// Mirrors `FUNCTION_SCOPE_NODE_TYPES` in `src/extractors/javascript.ts`.
const FUNCTION_SCOPE_NODE_TYPES: &[&str] = &[
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
    "arrow_function",
    "method_definition",
];

/// True when `node`'s subtree declares `var name` anywhere within the SAME
/// function scope — i.e. without crossing into a nested function, which opens
/// its own independent `var` scope and is checked separately when the
/// recursive scan reaches it.
///
/// `var` is function-scoped, not block-scoped, so a `var name` buried in any
/// nested block/loop/switch of a function body still shadows an outer `name`
/// for that ENTIRE function — `function inner() { if (x) { var fn = 1; } fn(); }`
/// reads `inner`'s own hoisted `fn`, not the outer fallback variable, so the
/// whole function must be pruned from the liveness scan (Greptile review, PR
/// #2432). Detecting this only at the block that physically contains the
/// `var` would miss the read that sits outside that block.
///
/// Depth-bounded like every other recursive walk in this file
/// (`MAX_WALK_DEPTH`).
///
/// Mirrors `functionScopeDeclaresVar` in `src/extractors/javascript.ts`.
fn function_scope_declares_var(node: &Node, name: &str, source: &[u8], depth: usize) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    if node.kind() == "variable_declaration" && declaration_declares_name(node, name, source) {
        return true;
    }
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else {
            continue;
        };
        // A nested function opens its own `var` scope — its declarations
        // don't shadow anything out here.
        if FUNCTION_SCOPE_NODE_TYPES.contains(&child.kind()) {
            continue;
        }
        if function_scope_declares_var(&child, name, source, depth + 1) {
            return true;
        }
    }
    false
}

/// True when `node` (one of `SCOPE_NODE_TYPES`) declares its OWN binding
/// named `name` at this scope's own level — a function/method parameter or
/// own name, a `var` hoisted anywhere inside a function body, a catch
/// clause's exception binding, a for-loop's own `let`/`const` loop variable,
/// or a `let`/`const` declared directly inside this block (not a deeper
/// nested block, which gets its own independent shadow check when the
/// recursive scan reaches it).
///
/// The BLOCK-level cases deliberately exclude `variable_declaration` (`var`)
/// (Greptile review, PR #2432): `var` is function-scoped, so a `var` anywhere
/// below such a node is always the SAME binding as an outer `var` of the same
/// name, never a distinct shadow — treating it as one would wrongly prune a
/// genuine read elsewhere in that subtree for a redeclaration that isn't
/// actually a different variable.
///
/// `var` shadowing is therefore decided at the FUNCTION boundary instead, via
/// `function_scope_declares_var` — the scope a `var` actually belongs to.
///
/// Mirrors `introducesShadowedBinding` in `src/extractors/javascript.ts`.
fn introduces_shadowed_binding(node: &Node, name: &str, source: &[u8]) -> bool {
    match node.kind() {
        "function_declaration"
        | "function_expression"
        | "generator_function_declaration"
        | "generator_function"
        | "arrow_function"
        | "method_definition" => {
            if let Some(name_n) = node.child_by_field_name("name") {
                if node_text(&name_n, source) == name {
                    return true;
                }
            }
            if let Some(params) = node.child_by_field_name("parameters") {
                for i in 0..params.child_count() {
                    if let Some(param) = params.child(i) {
                        if pattern_binds_name(&param, name, source, 0) {
                            return true;
                        }
                    }
                }
            }
            // A `var` anywhere in this function's body is scoped to THIS
            // function.
            match node.child_by_field_name("body") {
                Some(body) => function_scope_declares_var(&body, name, source, 0),
                None => false,
            }
        }
        "catch_clause" => match node.child_by_field_name("parameter") {
            Some(param) => pattern_binds_name(&param, name, source, 0),
            None => false,
        },
        // A C-style for-loop's init clause wraps its declaration in a
        // `lexical_declaration` child, and a for-head `let`/`const fn` is a
        // genuinely new binding scoped to the loop whose own initializer lives
        // in that same loop scope (`for (let fn = fn; …)` is a TDZ error), so
        // pruning the whole loop is correct.
        //
        // `var` is deliberately EXCLUDED: it's function-scoped, so a `var`
        // init here is the SAME binding as the outer variable, never a
        // distinct shadow (matching the reasoning applied to
        // `statement_block` and `switch_body`). It's handled as a KILL in
        // `block_contains_identifier_excluding` instead — which still scans
        // the initializer, so `for (var fn = fn; …)` keeps its genuine read
        // (Greptile review, PR #2432).
        //
        // A for-in/for-of head is NOT handled here at all — see
        // `SCOPE_NODE_TYPES` and the for-in branch of
        // `block_contains_identifier_excluding`: its `right` is evaluated in
        // the ENCLOSING scope, so pruning the whole node would lose a real
        // read.
        "for_statement" => {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    if child.kind() == "lexical_declaration"
                        && declaration_declares_name(&child, name, source)
                    {
                        return true;
                    }
                }
            }
            false
        }
        "statement_block" => {
            for i in 0..node.child_count() {
                let Some(child) = node.child(i) else {
                    continue;
                };
                // `var`, deliberately EXCLUDED (Greptile review, PR #2432):
                // it's function-scoped, not block-scoped, so a `var`
                // declared directly in this block is the SAME binding as
                // the outer variable, never a distinct shadow — treating it
                // as one would wrongly prune a genuine read anywhere in
                // this block (e.g. a read before the `var` redeclaration,
                // in the same block).
                if child.kind() == "lexical_declaration"
                    && declaration_declares_name(&child, name, source)
                {
                    return true;
                }
                // A block-local function/class declaration also introduces
                // its own binding at this block's level (Greptile review,
                // PR #2432) — e.g. `const fn = custom || fallback; { function
                // fn() {} fn(); }` calls the INNER fn, not the outer
                // fallback variable.
                if child.kind() == "function_declaration"
                    || child.kind() == "generator_function_declaration"
                    || child.kind() == "class_declaration"
                {
                    if let Some(name_n) = child.child_by_field_name("name") {
                        if node_text(&name_n, source) == name {
                            return true;
                        }
                    }
                }
            }
            false
        }
        // All `case`/`default` clauses in a switch share ONE lexical scope
        // (unlike a function's separate statement blocks) — an UNBRACED
        // case's own `let`/`const`/function/class declaration shadows the
        // outer variable for the whole switch, even though it isn't wrapped
        // in its own `statement_block` (Greptile review, PR #2432). A
        // BRACED case (`case 1: { let fn = 1; }`) creates its own
        // independent block scope instead, already handled when the
        // recursive scan reaches that nested `statement_block`.
        //
        // Like the `statement_block` case above, deliberately EXCLUDES
        // `variable_declaration` (`var`) — it's function-scoped, so a `var
        // fn` in one case is never a genuinely NEW binding, just the SAME
        // outer `fn` (and if the outer `fn` is `let`/`const`, redeclaring it
        // is a SyntaxError, so a valid parse can't reach this with a real
        // shadow anyway). Treating it as a shadow here would skip the ENTIRE
        // switch — including a genuine read in a DIFFERENT, unrelated case —
        // for a redeclaration that isn't a distinct binding at all (Greptile
        // review, PR #2432).
        "switch_body" => {
            for i in 0..node.child_count() {
                let Some(switch_case) = node.child(i) else {
                    continue;
                };
                if switch_case.kind() != "switch_case" && switch_case.kind() != "switch_default" {
                    continue;
                }
                for j in 0..switch_case.child_count() {
                    let Some(stmt) = switch_case.child(j) else {
                        continue;
                    };
                    if stmt.kind() == "lexical_declaration"
                        && declaration_declares_name(&stmt, name, source)
                    {
                        return true;
                    }
                    if stmt.kind() == "function_declaration"
                        || stmt.kind() == "generator_function_declaration"
                        || stmt.kind() == "class_declaration"
                    {
                        if let Some(name_n) = stmt.child_by_field_name("name") {
                            if node_text(&name_n, source) == name {
                                return true;
                            }
                        }
                    }
                }
            }
            false
        }
        _ => false,
    }
}

/// Uses `pattern_binds_name`, not a blanket text scan — a destructuring
/// default that READS the outer variable (`const { value = fn } = input;`)
/// must not be mistaken for a declaration that BINDS it (Greptile review, PR
/// #2432): `pattern_binds_name` already knows a default's `right` side is a
/// reference, not a binding.
fn declaration_declares_name(declaration_node: &Node, name: &str, source: &[u8]) -> bool {
    for i in 0..declaration_node.child_count() {
        let Some(declarator) = declaration_node.child(i) else {
            continue;
        };
        if declarator.kind() != "variable_declarator" {
            continue;
        }
        if let Some(decl_name) = declarator.child_by_field_name("name") {
            if pattern_binds_name(&decl_name, name, source, 0) {
                return true;
            }
        }
    }
    false
}

/// True when `param_node` BINDS `name` — i.e. `name` is the pattern being
/// declared/written to, not a reference appearing inside a nested
/// expression. Two callers reuse this same pattern-shape logic:
///
/// - A function/method's `parameters` list, or a `catch` clause's exception
///   binding: `function helper(x = fetchFn) {}` does NOT bind `fetchFn` —
///   `fetchFn` there is a REFERENCE (a real use of the outer variable), and
///   the old blanket "does the whole parameters subtree contain this text
///   anywhere" check wrongly treated that reference as a binding,
///   incorrectly pruning the function body from the liveness scan and
///   losing a real edge (Greptile review, PR #2432).
/// - An assignment expression's `left` side, INCLUDING destructuring
///   targets (`({ fn } = replacement)`, `[fn] = replacement`) — those are
///   WRITES, not reads, the same as a plain `fn = replacement` (Greptile
///   review, PR #2432): overwriting a fallback variable through
///   destructuring doesn't consume its previous value either.
///
/// Only the BOUND side of an `assignment_pattern`/`object_assignment_pattern`
/// (`left`) is checked — the default-value side (`right`) is deliberately
/// left for the ordinary reference scan to find.
///
/// Depth-bounded like every other recursive walk in this file
/// (`MAX_WALK_DEPTH`) — stops a pathologically deep destructuring/parameter
/// pattern from overflowing the stack (Greptile review, PR #2432).
///
/// Mirrors `patternBindsName` in `src/extractors/javascript.ts`.
fn pattern_binds_name(param_node: &Node, name: &str, source: &[u8], depth: usize) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    match param_node.kind() {
        "identifier" => node_text(param_node, source) == name,
        "assignment_pattern" | "object_assignment_pattern" => {
            match param_node.child_by_field_name("left") {
                Some(left) => pattern_binds_name(&left, name, source, depth + 1),
                None => false,
            }
        }
        "rest_pattern" => {
            for i in 0..param_node.child_count() {
                if let Some(child) = param_node.child(i) {
                    if child.kind() != "..." && pattern_binds_name(&child, name, source, depth + 1)
                    {
                        return true;
                    }
                }
            }
            false
        }
        "object_pattern" => {
            for i in 0..param_node.child_count() {
                let Some(child) = param_node.child(i) else {
                    continue;
                };
                match child.kind() {
                    "shorthand_property_identifier_pattern"
                        if node_text(&child, source) == name =>
                    {
                        return true;
                    }
                    "pair_pattern" => {
                        if let Some(value) = child.child_by_field_name("value") {
                            if pattern_binds_name(&value, name, source, depth + 1) {
                                return true;
                            }
                        }
                    }
                    "rest_pattern" | "object_assignment_pattern"
                        if pattern_binds_name(&child, name, source, depth + 1) =>
                    {
                        return true;
                    }
                    _ => {}
                }
            }
            false
        }
        "array_pattern" => {
            for i in 0..param_node.child_count() {
                if let Some(child) = param_node.child(i) {
                    if pattern_binds_name(&child, name, source, depth + 1) {
                        return true;
                    }
                }
            }
            false
        }
        // TS-specific parameter wrappers (type-annotated / optional params).
        "required_parameter" | "optional_parameter" => {
            let pattern = param_node
                .child_by_field_name("pattern")
                .or_else(|| param_node.child_by_field_name("name"));
            match pattern {
                Some(p) => pattern_binds_name(&p, name, source, depth + 1),
                None => false,
            }
        }
        _ => false,
    }
}

/// Scans a binding/destructuring pattern (a `variable_declarator`'s `name`
/// field, or an `assignment_expression`'s `left` field) for genuine READS
/// hidden inside default-value expressions (`{ value = fn }`, `[a = fn]`) —
/// without treating the pattern's own BOUND names as reads. `({ fn = fn } =
/// replacement)` both writes `fn` (a binding, ignored here) and reads its
/// previous value as the default (a real reference) — `pattern_binds_name`
/// alone can't tell the two apart, since it only answers "is `name` bound
/// here at all," not "where, specifically" (Greptile review, PR #2432).
/// Delegates each default expression found to the ordinary
/// `block_contains_identifier_excluding` scan, since a default value is a
/// normal expression that can contain any kind of reference, not just a
/// bare identifier. Depth-bounded for the same reason as `pattern_binds_name`.
///
/// Mirrors `scanPatternDefaultsForReference` in `src/extractors/javascript.ts`.
fn scan_pattern_defaults_for_reference(
    pattern_node: &Node,
    name: &str,
    exclude_id: usize,
    source: &[u8],
    depth: usize,
    require_call_site: bool,
) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    match pattern_node.kind() {
        "identifier" => false,
        "assignment_pattern" | "object_assignment_pattern" => {
            match pattern_node.child_by_field_name("right") {
                Some(right) => block_contains_identifier_excluding(
                    &right,
                    name,
                    exclude_id,
                    source,
                    depth + 1,
                    require_call_site,
                ),
                None => false,
            }
        }
        "rest_pattern" => {
            for i in 0..pattern_node.child_count() {
                if let Some(child) = pattern_node.child(i) {
                    if child.kind() != "..."
                        && scan_pattern_defaults_for_reference(
                            &child,
                            name,
                            exclude_id,
                            source,
                            depth + 1,
                            require_call_site,
                        )
                    {
                        return true;
                    }
                }
            }
            false
        }
        "object_pattern" => {
            for i in 0..pattern_node.child_count() {
                let Some(child) = pattern_node.child(i) else {
                    continue;
                };
                match child.kind() {
                    "pair_pattern" => {
                        if let Some(value) = child.child_by_field_name("value") {
                            if scan_pattern_defaults_for_reference(
                                &value,
                                name,
                                exclude_id,
                                source,
                                depth + 1,
                                require_call_site,
                            ) {
                                return true;
                            }
                        }
                    }
                    "rest_pattern" | "object_assignment_pattern"
                        if scan_pattern_defaults_for_reference(
                            &child,
                            name,
                            exclude_id,
                            source,
                            depth + 1,
                            require_call_site,
                        ) =>
                    {
                        return true;
                    }
                    _ => {}
                }
            }
            false
        }
        "array_pattern" => {
            for i in 0..pattern_node.child_count() {
                if let Some(child) = pattern_node.child(i) {
                    if scan_pattern_defaults_for_reference(
                        &child,
                        name,
                        exclude_id,
                        source,
                        depth + 1,
                        require_call_site,
                    ) {
                        return true;
                    }
                }
            }
            false
        }
        _ => false,
    }
}

/// Recursively scans `node` for a bare identifier reference to `name`,
/// skipping the node whose id is `exclude_id` entirely — excluding only the
/// declarator being analyzed, not its whole enclosing statement, so a
/// sibling declarator in the same comma-separated declaration (`const
/// fetchFn = a || b, result = fetchFn();`) still counts as a reference
/// (issue #2257, Greptile review) — and stops descending into any nested
/// scope that shadows `name` (see `introduces_shadowed_binding`).
/// Depth-bounded like every other recursive walk in this file
/// (`MAX_WALK_DEPTH`) — stops a pathologically deep expression/statement
/// tree (e.g. deeply nested generated JS) from overflowing the stack
/// (Greptile review, #2257).
///
/// A `variable_declarator`'s `name` field is a BINDING, not a read — even
/// for a sibling declarator in the same statement, a legal `var` rebinding
/// (`var fn = a || b, fn = c;`) must not be mistaken for a use of `fn`
/// (Greptile review, PR #2432). But a destructuring `name` field can ALSO
/// contain a genuine read hidden in a default value (`const { value = fn }
/// = input;`) — `scan_pattern_defaults_for_reference` finds those
/// specifically, while the bound names themselves are still excluded from
/// the `value` field's ordinary scan below.
///
/// Similarly, a plain `=` assignment's left side (`assignment_expression`,
/// distinct from the tree-sitter grammar's `augmented_assignment_expression`
/// for `+=`/`||=`/etc.) — whether a bare identifier or a destructuring
/// pattern (`({ fn } = replacement)`, `[fn] = replacement`) — is a WRITE,
/// not a read: it overwrites `fn` without ever consuming its current
/// value, so it must not count as evidence the fallback assigned to `fn` is
/// used (Greptile review, PR #2432; `pattern_binds_name` covers both
/// shapes). The same destructuring-default exception applies here too —
/// `({ fn = fn } = replacement)` both writes `fn` and reads its previous
/// value as the default, and `scan_pattern_defaults_for_reference` finds
/// that read. A compound assignment DOES read the current value before
/// writing, so it's deliberately left to the generic scan below (its
/// `left` is scanned like any other reference).
///
/// True when `node` is the `function` field of its parent `call_expression`
/// — i.e. `node` names the callee being CALLED, not merely referenced.
/// Used by `block_contains_identifier_excluding`'s `require_call_site` mode
/// (issue #2260) to require call-shape evidence specifically, matching
/// #1895's own "invoked... via member-call syntax" precision (a bare
/// reference — e.g. `console.log(handler)` — is not invocation evidence).
/// Mirrors `isCallCallee` in `src/extractors/javascript.ts`.
fn is_call_callee(node: &Node) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    parent.kind() == "call_expression"
        && parent
            .child_by_field_name("function")
            .is_some_and(|f| f.id() == node.id())
}

/// Mirrors `blockContainsIdentifierExcluding` in `src/extractors/javascript.ts`.
fn block_contains_identifier_excluding(
    node: &Node,
    name: &str,
    exclude_id: usize,
    source: &[u8],
    depth: usize,
    require_call_site: bool,
) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    if node.id() == exclude_id {
        return false;
    }
    if node.kind() == "identifier"
        && node_text(node, source) == name
        && (!require_call_site || is_call_callee(node))
    {
        return true;
    }
    if SCOPE_NODE_TYPES.contains(&node.kind()) && introduces_shadowed_binding(node, name, source) {
        return false;
    }
    // A declaration statement with MULTIPLE sibling declarators
    // (`var result = fn(), fn = custom || fallback;`) — if the excluded
    // (target) declarator is one of this statement's own declarators, only
    // scan siblings AT OR AFTER it. An earlier sibling's initializer runs
    // (and is assigned) BEFORE this declarator, so it cannot have consumed a
    // value that hasn't been assigned yet; a LATER sibling reading this
    // declarator's name after it's assigned is still valid evidence
    // (Greptile review, PR #2432 — matches the same at-or-after ordering
    // already applied at the enclosing-block level in
    // has_later_reference_in_enclosing_block).
    if node.kind() == "variable_declaration" || node.kind() == "lexical_declaration" {
        let mut has_excluded_declarator = false;
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "variable_declarator" && child.id() == exclude_id {
                    has_excluded_declarator = true;
                    break;
                }
            }
        }
        if has_excluded_declarator {
            let mut reached_excluded = false;
            for i in 0..node.child_count() {
                let Some(child) = node.child(i) else {
                    continue;
                };
                if !reached_excluded {
                    if child.id() == exclude_id {
                        reached_excluded = true;
                    } else {
                        continue;
                    }
                }
                if block_contains_identifier_excluding(
                    &child,
                    name,
                    exclude_id,
                    source,
                    depth + 1,
                    require_call_site,
                ) {
                    return true;
                }
                // A LATER sibling declarator in this SAME statement can
                // itself unconditionally redeclare `name` — `var fn = a ||
                // fallback, fn = other, result = fn();` must not credit
                // `result`'s read to `fallback` once the intervening `fn =
                // other` has already run (Greptile review, PR #2554).
                // `declarator_kills_name` already excludes `exclude_id`
                // itself, so the original declarator's own initializer is
                // never mistaken for a kill of its own value.
                if child.kind() == "variable_declarator"
                    && declarator_kills_name(&child, name, source, exclude_id)
                {
                    return false;
                }
            }
            return false;
        }
        // This statement doesn't contain the declarator we're checking
        // liveness FOR, but its OWN declarators still execute left-to-right
        // — an earlier declarator unconditionally redeclaring `name` kills
        // the value before a LATER declarator's initializer in the SAME
        // statement runs (`var fn = replacement, result = fn();` must not
        // credit `fn()`'s read to whatever `fn` held before this statement —
        // Greptile review, #2438).
        for i in 0..node.child_count() {
            let Some(declarator) = node.child(i) else {
                continue;
            };
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            if block_contains_identifier_excluding(
                &declarator,
                name,
                exclude_id,
                source,
                depth + 1,
                require_call_site,
            ) {
                return true;
            }
            if declarator_kills_name(&declarator, name, source, exclude_id) {
                return false;
            }
        }
        return false;
    }
    if node.kind() == "variable_declarator" {
        let decl_name = node.child_by_field_name("name");
        let value = node.child_by_field_name("value");
        if let Some(decl_name) = &decl_name {
            if scan_pattern_defaults_for_reference(
                decl_name,
                name,
                exclude_id,
                source,
                depth + 1,
                require_call_site,
            ) {
                return true;
            }
        }
        return match value {
            Some(value) => block_contains_identifier_excluding(
                &value,
                name,
                exclude_id,
                source,
                depth + 1,
                require_call_site,
            ),
            None => false,
        };
    }
    // A comma-separated sequence (`fn = replacement, fn()`) executes its
    // parts in order — a kill earlier in the sequence must suppress a read
    // later in the SAME sequence, the same ordering already applied across
    // top-level block statements and multi-declarator statements above
    // (Greptile review, PR #2554: `(fn = replacement, fn())` was crediting
    // the read because the generic recursive walk below has no concept of
    // sequence-internal order).
    if node.kind() == "sequence_expression" {
        for i in 0..node.named_child_count() {
            let Some(part) = node.named_child(i) else {
                continue;
            };
            if block_contains_identifier_excluding(
                &part,
                name,
                exclude_id,
                source,
                depth + 1,
                require_call_site,
            ) {
                return true;
            }
            if kills_binding(&part, name, source, exclude_id, depth + 1) {
                return false;
            }
        }
        return false;
    }
    if node.kind() == "assignment_expression" {
        if let Some(left) = node.child_by_field_name("left") {
            if pattern_binds_name(&left, name, source, 0) {
                if scan_pattern_defaults_for_reference(
                    &left,
                    name,
                    exclude_id,
                    source,
                    depth + 1,
                    require_call_site,
                ) {
                    return true;
                }
                return match node.child_by_field_name("right") {
                    Some(right) => block_contains_identifier_excluding(
                        &right,
                        name,
                        exclude_id,
                        source,
                        depth + 1,
                        require_call_site,
                    ),
                    None => false,
                };
            }
        }
    }
    // A `for (… of right)` / `for (… in right)` head that BINDS `name` kills
    // the value `name` held before the loop: `right` is evaluated first, then
    // `name` is assigned on every iteration, so nothing in the body can be
    // reading the pre-loop value (Greptile review, PR #2432). So scan `right`
    // — which is evaluated in the ENCLOSING scope and can hold a genuine read
    // (`for (const x of fn())`) — plus any default hidden in the `left`
    // pattern, and never the body.
    //
    // This covers ALL binding forms uniformly, whichever kills the value:
    // - bare (`for (fn of values)`) — reassigns the existing binding;
    // - `var` (`for (var fn of values)`) — the SAME function-scoped binding;
    // - `let`/`const` (`for (let fn of values)`) — a new per-iteration binding
    //   that shadows the outer one inside the body.
    //
    // Note the grammar gives a declaring for-in/of head a `kind` FIELD
    // (`var`/`let`/`const`) with `left` holding the pattern directly — there
    // is no `variable_declaration` child to detect, which is why this must be
    // handled here rather than in `introduces_shadowed_binding`.
    //
    // A `let`/`const` target's own pattern DEFAULTS are the one place where
    // `scan_pattern_defaults_for_reference` must NOT run (Greptile review, PR
    // #2440): `let`/`const` creates a brand-new per-iteration binding for
    // `name`, so a default inside THIS SAME pattern that mentions `name`
    // (`for (let [fn = fn] of values)`) resolves to that new binding — in the
    // temporal dead zone until its own position initializes it — never to the
    // enclosing fallback. `var`/bare targets reuse the SAME pre-existing
    // binding (no new scope), so a default reading `name` there is still a
    // genuine read of its current, soon-to-be-overwritten value.
    if node.kind() == "for_in_statement" {
        if let Some(left) = node.child_by_field_name("left") {
            if pattern_binds_name(&left, name, source, 0) {
                let is_lexical = node
                    .child_by_field_name("kind")
                    .map(|k| {
                        let kind_text = node_text(&k, source);
                        kind_text == "let" || kind_text == "const"
                    })
                    .unwrap_or(false);
                if !is_lexical
                    && scan_pattern_defaults_for_reference(
                        &left,
                        name,
                        exclude_id,
                        source,
                        depth + 1,
                        require_call_site,
                    )
                {
                    return true;
                }
                return match node.child_by_field_name("right") {
                    Some(right) => block_contains_identifier_excluding(
                        &right,
                        name,
                        exclude_id,
                        source,
                        depth + 1,
                        require_call_site,
                    ),
                    None => false,
                };
            }
        }
    }
    // A classic `for (var fn = …; cond; update) body` head likewise kills the
    // value before `cond`/`update`/`body` ever run. The `let`/`const` form never
    // reaches here — `introduces_shadowed_binding` prunes the whole loop for it
    // (Greptile review, PR #2432).
    //
    // Only an INITIALIZER actually overwrites the value, and only the
    // declarators up to and including it can still be reading the old one
    // (Greptile review, PR #2440):
    //
    // - `for (var fn; cond; update) body` — a bare redeclaration assigns
    //   nothing, so it is NOT a kill and the whole loop still has to be scanned;
    // - `for (var a = fn(), fn = 0; …)` — `a`'s initializer runs BEFORE the
    //   kill, so its read is genuine;
    // - `for (var fn = fn; …)` — the killing declarator's own initializer reads
    //   the pre-loop value;
    // - `for (var fn = 0, a = fn(); …)` — `a`'s initializer runs AFTER the kill,
    //   so it reads the new value and must not count.
    if node.kind() == "for_statement" {
        for i in 0..node.child_count() {
            let Some(decl) = node.child(i) else {
                continue;
            };
            if decl.kind() != "variable_declaration" {
                continue;
            }
            let mut kill_index: Option<usize> = None;
            for j in 0..decl.child_count() {
                let Some(declarator) = decl.child(j) else {
                    continue;
                };
                if declarator.kind() != "variable_declarator" {
                    continue;
                }
                let Some(decl_name) = declarator.child_by_field_name("name") else {
                    continue;
                };
                if pattern_binds_name(&decl_name, name, source, 0)
                    && declarator.child_by_field_name("value").is_some()
                {
                    kill_index = Some(j);
                    break;
                }
            }
            // No initialized declarator for `name` — nothing is overwritten
            // here, so fall through to the ordinary whole-loop scan below.
            let Some(kill_index) = kill_index else {
                continue;
            };
            for j in 0..=kill_index {
                if let Some(child) = decl.child(j) {
                    if block_contains_identifier_excluding(
                        &child,
                        name,
                        exclude_id,
                        source,
                        depth + 1,
                        require_call_site,
                    ) {
                        return true;
                    }
                }
            }
            return false;
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if block_contains_identifier_excluding(
                &child,
                name,
                exclude_id,
                source,
                depth + 1,
                require_call_site,
            ) {
                return true;
            }
        }
    }
    false
}

/// True when `declarator` unconditionally overwrites `name`: an initialized
/// (has a `value`) declarator whose binding pattern includes `name`, other
/// than `exclude_id` itself — the declarator the whole liveness check is
/// FOR, which trivially "binds" name via its own declaration and must never
/// be mistaken for a kill of its own freshly-assigned value.
///
/// Mirrors `declaratorKillsName` in `src/extractors/javascript.ts`.
fn declarator_kills_name(declarator: &Node, name: &str, source: &[u8], exclude_id: usize) -> bool {
    if declarator.kind() != "variable_declarator" || declarator.id() == exclude_id {
        return false;
    }
    let decl_name = declarator.child_by_field_name("name");
    let value = declarator.child_by_field_name("value");
    match (decl_name, value) {
        (Some(decl_name), Some(_)) => pattern_binds_name(&decl_name, name, source, 0),
        _ => false,
    }
}

/// True when `statement` — a DIRECT child of the enclosing block, exactly the
/// granularity `has_later_reference_in_enclosing_block` iterates —
/// unconditionally overwrites `name`: a top-level `name = value;` assignment
/// (any operator; `pattern_binds_name` also covers destructuring targets
/// like `[name] = arr`) or a `var name = value;` redeclaration sitting
/// directly in the block. A write nested inside an `if`/loop/`switch`/`try`
/// never matches here — it surfaces as a single
/// `if_statement`/`for_statement`/etc. child, not as the assignment itself —
/// so a conditional write correctly never kills (issue #2438's own
/// requirement: the original value can still reach a later read when the
/// write didn't actually run).
///
/// Transparently unwraps `expression_statement` and any number of nested
/// `parenthesized_expression`s (`(fn = replacement);` is exactly as
/// unconditional as `fn = replacement;` — Greptile review), and treats a
/// `sequence_expression` as a kill the moment ANY of its comma-separated
/// parts kills `name`: every part of a sequence unconditionally executes in
/// order, so by the time the whole statement finishes, `name` no longer
/// holds whatever it held before that part ran (Greptile review).
/// Depth-bounded like every other recursive walk in this file.
///
/// `exclude_id` skips the declarator this liveness check is FOR — see
/// `declarator_kills_name`.
///
/// Mirrors `killsBinding` in `src/extractors/javascript.ts`.
fn kills_binding(
    statement: &Node,
    name: &str,
    source: &[u8],
    exclude_id: usize,
    depth: usize,
) -> bool {
    if depth >= MAX_WALK_DEPTH {
        return false;
    }
    // Recurse (not just peel once) — `((fn = x));` nests `expression_statement
    // -> parenthesized_expression -> parenthesized_expression ->
    // assignment_expression`, so a single unwrap leaves a
    // `parenthesized_expression` that matches none of the checks below.
    if statement.kind() == "expression_statement" || statement.kind() == "parenthesized_expression"
    {
        return match statement.named_child(0) {
            Some(child) => kills_binding(&child, name, source, exclude_id, depth + 1),
            None => false,
        };
    }
    if statement.kind() == "sequence_expression" {
        for i in 0..statement.named_child_count() {
            if let Some(part) = statement.named_child(i) {
                if kills_binding(&part, name, source, exclude_id, depth + 1) {
                    return true;
                }
            }
        }
        return false;
    }
    if statement.kind() == "assignment_expression" {
        return match statement.child_by_field_name("left") {
            Some(left) => pattern_binds_name(&left, name, source, 0),
            None => false,
        };
    }
    if statement.kind() == "variable_declaration" || statement.kind() == "lexical_declaration" {
        for i in 0..statement.child_count() {
            if let Some(declarator) = statement.child(i) {
                if declarator_kills_name(&declarator, name, source, exclude_id) {
                    return true;
                }
            }
        }
    }
    false
}

/// True when `name` appears as a bare identifier reference anywhere else in
/// `declarator_node`'s enclosing block (function body, module top level, or
/// arrow-function body) — the local, position-scoped liveness evidence
/// `handle_logical_or_ternary_value_ref` requires before extracting a
/// value-ref (issue #2257).
///
/// Deliberately NOT the same mechanism as #1895's `invoked_property_names` (a
/// global, name-only set matched across the whole codebase): a bare local
/// variable name (`fetchFn`, `handler`) collides across unrelated files far
/// more often than a dispatch-table property key does, so crediting liveness
/// from an identically-named variable in a different file would fabricate a
/// relationship that doesn't exist. Scoping the search to the declaration's
/// own enclosing block avoids that risk entirely, at the cost of missing a
/// consumer in a different function/file (accepted — matches this file's
/// general "restrict to the simplest syntactic shape, prefer no edge over a
/// wrong one" precedent, #1771/#1784). A NESTED scope that shadows `name`
/// (`introduces_shadowed_binding`) is excluded from the scan entirely, so a
/// same-named binding declared inside a nested function/block never gets
/// mistaken for a use of the outer variable.
///
/// `require_call_site` (issue #2260): when true, a matching identifier
/// only counts if it's the callee of a `call_expression` (see
/// `is_call_callee`) — used by `handle_computed_dispatch_table_evidence`
/// to require genuine invocation evidence (`handler(...)`), not just any
/// reference (`console.log(handler)`), matching #1895's own "invoked...
/// via member-call syntax" precision.
///
/// Stops crediting reads once a sibling statement unconditionally overwrites
/// `name` (`kills_binding`, issue #2438): `var fn = a || b; fn = other;
/// fn();` must NOT count `fn();` as evidence that `b` is reachable — by the
/// time it runs, `fn` already holds `other`, not the fallback. The killing
/// statement's OWN right-hand side is still scanned for a genuine read
/// before the kill takes effect (`fn = fn || other;` still credits the read
/// of the pre-existing value), since the read-check on each statement always
/// runs before its kill-check.
///
/// Mirrors `hasLaterReferenceInEnclosingBlock` in `src/extractors/javascript.ts`.
fn has_later_reference_in_enclosing_block(
    declarator_node: &Node,
    name: &str,
    source: &[u8],
    require_call_site: bool,
) -> bool {
    let mut block = declarator_node.parent();
    while let Some(n) = block {
        if n.kind() == "statement_block" || n.kind() == "program" {
            break;
        }
        block = n.parent();
    }
    let Some(block) = block else {
        return false;
    };

    // Find the direct child of `block` that contains declarator_node (its
    // enclosing statement), so earlier sibling statements can be skipped —
    // for a hoisted `var`, a reference earlier in the block executes before
    // the assignment and reads the pre-assignment value, not the fallback
    // (Greptile review, PR #2432).
    let mut decl_statement = *declarator_node;
    while let Some(parent) = decl_statement.parent() {
        if parent.id() == block.id() {
            break;
        }
        decl_statement = parent;
    }

    // Scan the starting block's CHILDREN, not the block itself — the block
    // necessarily contains the very declaration we're checking liveness
    // for, so running the shadow check (`introduces_shadowed_binding`) on
    // the block itself would always find that declaration and wrongly treat
    // the whole block as shadowed, skipping every sibling statement.
    let mut reached_decl_statement = false;
    for i in 0..block.child_count() {
        if let Some(child) = block.child(i) {
            if !reached_decl_statement {
                if child.id() == decl_statement.id() {
                    reached_decl_statement = true;
                } else {
                    continue;
                }
            }
            if block_contains_identifier_excluding(
                &child,
                name,
                declarator_node.id(),
                source,
                0,
                require_call_site,
            ) {
                return true;
            }
            if kills_binding(&child, name, source, declarator_node.id(), 0) {
                return false;
            }
        }
    }
    false
}

/// Collect a dynamic value-ref `Call` for a logical-or/nullish-coalescing
/// fallback or ternary default assigned to a named variable — e.g.
/// `const fetchFn = options._fetchLatest || fetchLatestVersion` or
/// `const fn = cond ? a : b` (issue #2257). Restricted to declarations with a
/// plain identifier name (no destructuring) whose enclosing block contains at
/// least one other reference to that name
/// (`has_later_reference_in_enclosing_block`) — without that check, this
/// would fabricate a `calls` edge for a fallback value that's assigned but
/// never actually read anywhere.
///
/// Only fires when the declarator's value is DIRECTLY a `binary_expression`
/// (`||`/`??`) or `ternary_expression` — a wrapped/parenthesized or nested
/// form (`const x = a || (b || c)`) is left unresolved rather than recursing,
/// matching this file's "restrict to the simplest syntactic shape" precedent
/// (#1771/#1784).
///
/// Mirrors `collectLogicalOrTernaryValueRefCall` in `src/extractors/javascript.ts`.
fn handle_logical_or_ternary_value_ref(declarator: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let Some(name_n) = declarator.child_by_field_name("name") else {
        return;
    };
    if name_n.kind() != "identifier" {
        return;
    }
    let Some(value_n) = declarator.child_by_field_name("value") else {
        return;
    };

    let mut candidates: Vec<Node> = Vec::new();
    if value_n.kind() == "binary_expression" {
        let Some(op_n) = value_n.child_by_field_name("operator") else {
            return;
        };
        let op = node_text(&op_n, source);
        if op != "||" && op != "??" {
            return;
        }
        if let Some(left) = value_n.child_by_field_name("left") {
            candidates.push(left);
        }
        if let Some(right) = value_n.child_by_field_name("right") {
            candidates.push(right);
        }
    } else if value_n.kind() == "ternary_expression" {
        if let Some(consequence) = value_n.child_by_field_name("consequence") {
            candidates.push(consequence);
        }
        if let Some(alternative) = value_n.child_by_field_name("alternative") {
            candidates.push(alternative);
        }
    } else {
        return;
    }

    let identifier_candidates: Vec<Node> = candidates
        .into_iter()
        .filter(|n| n.kind() == "identifier" && !JS_BUILTIN_GLOBALS.contains(&node_text(n, source)))
        .collect();
    if identifier_candidates.is_empty() {
        return;
    }
    let name_text = node_text(&name_n, source);
    if !has_later_reference_in_enclosing_block(declarator, name_text, source, false) {
        return;
    }

    for n in identifier_candidates {
        calls.push(Call {
            name: node_text(&n, source).to_string(),
            line: start_line(&n),
            dynamic: Some(true),
            dynamic_kind: Some("value-ref".to_string()),
            ..Default::default()
        });
    }
}

/// Collect computed/bracket-access dispatch-table invocation evidence (issue
/// #2260) — extends the #1771/#1895 dot-property value-ref mechanism to the
/// `const handler = TABLE[computedExpr]; ...; handler(...)` idiom (a
/// `node.type`-keyed AST-dispatch table is the canonical example:
/// `src/extractors/groovy.ts`'s `GROOVY_NODE_HANDLERS`). A computed key
/// can't name a specific property statically the way `TABLE.key(...)` can,
/// so — unlike #1895, which checks each property's own key individually —
/// this credits invocation evidence for the WHOLE table once any computed
/// access into it is confirmed to be genuinely invoked.
///
/// Fires only when:
///  - the declarator's value is DIRECTLY a `subscript_expression` (matching
///    this file's "restrict to the simplest syntactic shape" precedent,
///    #1771/#1784 — a wrapped/parenthesized form is left unresolved);
///  - its `object` is a bare identifier (the table's own name) — a
///    computed/dynamic object expression has no static name to credit;
///  - its `index` is NOT a string/template-string literal — a literal key
///    (`TABLE['resolve']`) already resolves through the existing
///    computed-literal call-extraction path and needs no new mechanism;
///  - the declared name is a plain identifier (no destructuring) that is
///    later found as the CALLEE of a call expression in its own enclosing
///    block (`has_later_reference_in_enclosing_block` with
///    `require_call_site`) — the same local, position-scoped liveness
///    check #2257 established, reused here for the intermediate variable
///    specifically because a generic local name (`handler`) collides
///    across unrelated files/functions far more often than a
///    dispatch-table's own constant name does.
///
/// Mirrors `collectComputedDispatchTableEvidence` in `src/extractors/javascript.ts`.
fn handle_computed_dispatch_table_evidence(
    declarator: &Node,
    source: &[u8],
    evidence: &mut Vec<String>,
) {
    let Some(name_n) = declarator.child_by_field_name("name") else {
        return;
    };
    if name_n.kind() != "identifier" {
        return;
    }
    let Some(value_n) = declarator.child_by_field_name("value") else {
        return;
    };
    if value_n.kind() != "subscript_expression" {
        return;
    }
    let Some(object_n) = value_n.child_by_field_name("object") else {
        return;
    };
    if object_n.kind() != "identifier" || JS_BUILTIN_GLOBALS.contains(&node_text(&object_n, source))
    {
        return;
    }
    if let Some(index_n) = value_n.child_by_field_name("index") {
        if index_n.kind() == "string" || index_n.kind() == "template_string" {
            return;
        }
    }
    let name_text = node_text(&name_n, source);
    if !has_later_reference_in_enclosing_block(declarator, name_text, source, true) {
        return;
    }
    let table_name = node_text(&object_n, source);
    evidence.push(
        match find_declaring_scope_line(declarator, table_name, source) {
            Some(scope_line) => format!("{table_name}#{scope_line}"),
            None => table_name.to_string(),
        },
    );
}

/// Extract definitions from destructured object bindings: `const { handleToken,
/// checkPermissions } = initAuth(...)` creates definitions for `handleToken`
/// and `checkPermissions`, kind `constant` — matching the convention for plain
/// `const x = <literal>` bindings and array-pattern destructuring.
///
/// Every call site of this function is already gated to `const` declarations
/// (never `let`/`var`), so `constant` is unconditionally correct here. Prior to
/// #1773 this used `kind: "function"` on the theory that destructured names
/// are usually callbacks, but that miscategorized every non-function
/// destructured value (e.g. `const { dbPath } = workerData`). `constant`-kind
/// nodes remain fully resolvable as call targets — call-target resolution is
/// kind-agnostic — so callback-style destructured bindings still resolve.
///
/// Also handles a shorthand default value (`const { a = 1 } = value`, node
/// kind `object_assignment_pattern`) and a rest element (`const { a, ...rest }
/// = value`, node kind `rest_pattern`/`rest_element`) — both were previously
/// dropped entirely, the same class of bug fixed for dynamic-import
/// destructure extraction in #1920 (see `extract_rest_identifier`) (#2051).
/// Mirrors the TS extractor's `extractDestructuredBindings`.
fn extract_destructured_bindings(
    pattern: &Node,
    source: &[u8],
    line: u32,
    end_line: u32,
    definitions: &mut Vec<Definition>,
) {
    for i in 0..pattern.child_count() {
        let Some(child) = pattern.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier_pattern" | "shorthand_property_identifier" => {
                definitions.push(Definition {
                    name: node_text(&child, source).to_string(),
                    kind: "constant".to_string(),
                    line,
                    end_line: Some(end_line),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                    bodyless: None,
                    content_hash: None,
                    accessor_kind: None,
                });
            }
            "pair_pattern" | "pair" => {
                if let Some(value) = child.child_by_field_name("value") {
                    if value.kind() == "identifier"
                        || value.kind() == "shorthand_property_identifier_pattern"
                    {
                        definitions.push(Definition {
                            name: node_text(&value, source).to_string(),
                            kind: "constant".to_string(),
                            line,
                            end_line: Some(end_line),
                            decorators: None,
                            complexity: None,
                            cfg: None,
                            children: None,
                            bodyless: None,
                            content_hash: None,
                            accessor_kind: None,
                        });
                    } else if value.kind() == "assignment_pattern" {
                        // { original: renamed = defaultValue } — the local
                        // binding is the assignment_pattern's left identifier
                        // (Greptile follow-up to #2051, mirrors the identical
                        // branch already in collect_object_pattern_names
                        // since #1824).
                        if let Some(left) = value.child_by_field_name("left") {
                            if left.kind() == "identifier" {
                                definitions.push(Definition {
                                    name: node_text(&left, source).to_string(),
                                    kind: "constant".to_string(),
                                    line,
                                    end_line: Some(end_line),
                                    decorators: None,
                                    complexity: None,
                                    cfg: None,
                                    children: None,
                                    bodyless: None,
                                    content_hash: None,
                                    accessor_kind: None,
                                });
                            }
                        }
                    }
                }
            }
            "object_assignment_pattern" => {
                // { a = defaultValue } — shorthand binding with a default
                // value; the bound name is the left-hand identifier (#2051,
                // mirrors #1920's fix to collect_object_pattern_names).
                if let Some(left) = child.child_by_field_name("left") {
                    if left.kind() == "shorthand_property_identifier_pattern"
                        || left.kind() == "identifier"
                    {
                        definitions.push(Definition {
                            name: node_text(&left, source).to_string(),
                            kind: "constant".to_string(),
                            line,
                            end_line: Some(end_line),
                            decorators: None,
                            complexity: None,
                            cfg: None,
                            children: None,
                            bodyless: None,
                            content_hash: None,
                            accessor_kind: None,
                        });
                    }
                }
            }
            "rest_pattern" | "rest_element" => {
                // { a, ...rest } — the rest binding was silently dropped
                // entirely before (#2051, mirrors #1920).
                let mut rest_names = Vec::new();
                extract_rest_identifier(&child, source, &mut rest_names);
                for name in rest_names {
                    definitions.push(Definition {
                        name,
                        kind: "constant".to_string(),
                        line,
                        end_line: Some(end_line),
                        decorators: None,
                        complexity: None,
                        cfg: None,
                        children: None,
                        bodyless: None,
                        content_hash: None,
                        accessor_kind: None,
                    });
                }
            }
            _ => {}
        }
    }
}

/// Extract a per-element "constant" Definition from each bound identifier in
/// an array-destructuring pattern (`const [a, b] = fn()`) — the array-pattern
/// counterpart to `extract_destructured_bindings`'s per-property handling of
/// object patterns (#1773). Each bound name becomes its own resolvable node,
/// superseding the prior single-node-named-by-raw-pattern-text approach
/// (`[a, b]` as one unresolvable node), which was never a real identifier and
/// could never be a call target (#1901). Mirrors the TS extractor's
/// `extractArrayPatternBindings`.
fn extract_array_pattern_bindings(
    pattern: &Node,
    source: &[u8],
    line: u32,
    end_line: u32,
    definitions: &mut Vec<Definition>,
) {
    for i in 0..pattern.child_count() {
        let Some(child) = pattern.child(i) else {
            continue;
        };
        match child.kind() {
            "identifier" => {
                definitions.push(Definition {
                    name: node_text(&child, source).to_string(),
                    kind: "constant".to_string(),
                    line,
                    end_line: Some(end_line),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                    bodyless: None,
                    content_hash: None,
                    accessor_kind: None,
                });
            }
            "assignment_pattern" => {
                if let Some(left) = child.child_by_field_name("left") {
                    if left.kind() == "identifier" {
                        definitions.push(Definition {
                            name: node_text(&left, source).to_string(),
                            kind: "constant".to_string(),
                            line,
                            end_line: Some(end_line),
                            decorators: None,
                            complexity: None,
                            cfg: None,
                            children: None,
                            bodyless: None,
                            content_hash: None,
                            accessor_kind: None,
                        });
                    }
                }
            }
            "rest_pattern" | "rest_element" => {
                // `rest_pattern`/`rest_element` has no named fields at all (verified
                // against tree-sitter-javascript/typescript's node-types.json) — its
                // single named child (after the `...` token) is whichever pattern the
                // rest binds to. [...rest] binds a plain identifier; [...[a, b]] nests
                // another array pattern whose own elements each need their own
                // Definition. Scan all children (rather than assuming a fixed index)
                // and recurse into a nested array_pattern instead of silently
                // dropping it, mirroring extract_js_parameters' own rest_pattern scan.
                for j in 0..child.child_count() {
                    let Some(inner) = child.child(j) else {
                        continue;
                    };
                    match inner.kind() {
                        "identifier" => {
                            definitions.push(Definition {
                                name: node_text(&inner, source).to_string(),
                                kind: "constant".to_string(),
                                line,
                                end_line: Some(end_line),
                                decorators: None,
                                complexity: None,
                                cfg: None,
                                children: None,
                                bodyless: None,
                                content_hash: None,
                                accessor_kind: None,
                            });
                            break;
                        }
                        "array_pattern" => {
                            // [...[a, b]] — recurse so the nested pattern's own
                            // bound identifiers each get their own Definition.
                            extract_array_pattern_bindings(
                                &inner,
                                source,
                                line,
                                end_line,
                                definitions,
                            );
                            break;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
}

/// Mirrors `extractReceiverName` in src/extractors/javascript.ts: normalize a
/// call receiver node to a resolvable name. Inline-new (`new Foo().method()`)
/// and single-paren-wrapped new (`(new Foo()).method()`) yield the constructor
/// name so the resolver can look up `Foo.method` directly.
fn extract_receiver_name(obj: &Node, source: &[u8]) -> String {
    match obj.kind() {
        "new_expression" => {
            if let Some(name) = extract_new_expr_type_name(obj, source) {
                return name.to_string();
            }
        }
        "parenthesized_expression" => {
            // Only one level of parentheses is unwrapped, matching the TS
            // extractor; deeper nesting falls through to raw-text handling.
            for i in 0..obj.child_count() {
                let Some(child) = obj.child(i) else { continue };
                if child.kind() == "new_expression" {
                    if let Some(name) = extract_new_expr_type_name(&child, source) {
                        return name.to_string();
                    }
                }
            }
        }
        _ => {}
    }
    node_text(obj, source).to_string()
}

/// Return the first non-punctuation argument node from a call_expression.
/// Mirrors `getFirstCallArg` in src/extractors/javascript.ts, which likewise
/// only needs node structure (not source text) to locate the argument.
fn get_first_call_arg<'a>(call_node: &'a Node) -> Option<Node<'a>> {
    let args = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"))?;
    for i in 0..args.child_count() {
        let child = args.child(i)?;
        match child.kind() {
            "(" | ")" | "," => continue,
            _ => return Some(child),
        }
    }
    None
}

/// Extract the logical callee from a Reflect.apply/call/construct first argument.
fn extract_reflect_callee_from_arg(first_arg: Option<Node>, call_line: u32, source: &[u8]) -> Call {
    if let Some(arg) = first_arg {
        match arg.kind() {
            "identifier" => {
                return Call {
                    name: node_text(&arg, source).to_string(),
                    line: call_line,
                    dynamic: Some(true),
                    dynamic_kind: Some("reflection".to_string()),
                    ..Default::default()
                }
            }
            "member_expression" => {
                if let Some(inner_prop) = arg.child_by_field_name("property") {
                    let receiver = arg
                        .child_by_field_name("object")
                        .map(|o| extract_receiver_name(&o, source));
                    return Call {
                        name: node_text(&inner_prop, source).to_string(),
                        line: call_line,
                        dynamic: Some(true),
                        dynamic_kind: Some("reflection".to_string()),
                        receiver,
                        ..Default::default()
                    };
                }
            }
            _ => {}
        }
    }
    Call {
        name: "<dynamic:unresolved>".to_string(),
        line: call_line,
        dynamic: Some(true),
        dynamic_kind: Some("unresolved-dynamic".to_string()),
        ..Default::default()
    }
}

/// Whether `node` is an inline function literal — `function(){}`, `()=>{}`,
/// or `function*(){}` — either directly, or wrapped in exactly one level of
/// parentheses (`(function(){})`, `(()=>{})`; arrow functions used as a
/// `.call`/`.apply`/`.bind` receiver always need the parens). Used by
/// `extract_call_info`'s `.call`/`.apply`/`.bind` branch (issue #2321) to
/// recognize an anonymous callee with no meaningful name to record, rather
/// than falling through to `extract_receiver_name`'s raw-text fallback
/// (which would otherwise embed the entire function body as `receiver`).
/// Only one level of parens is unwrapped. Mirrors isInlineFunctionLiteral in
/// src/extractors/javascript.ts.
fn is_inline_function_literal(node: &Node) -> bool {
    fn is_fn_literal(n: &Node) -> bool {
        matches!(
            n.kind(),
            "function_expression" | "arrow_function" | "generator_function"
        )
    }
    if is_fn_literal(node) {
        return true;
    }
    if node.kind() != "parenthesized_expression" {
        return false;
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if is_fn_literal(&child) {
                return true;
            }
        }
    }
    false
}

fn extract_call_info(fn_node: &Node, call_node: &Node, source: &[u8]) -> Option<Call> {
    match fn_node.kind() {
        "identifier" => {
            let name = node_text(fn_node, source);
            if name == "eval" {
                // eval(code) — dynamic code execution; capture first arg if string literal
                let key_expr = get_first_call_arg(call_node)
                    .filter(|a| a.kind() == "string" || a.kind() == "template_string")
                    .map(|a| node_text(&a, source).to_string());
                return Some(Call {
                    name: "<dynamic:eval>".to_string(),
                    line: start_line(call_node),
                    dynamic: Some(true),
                    dynamic_kind: Some("eval".to_string()),
                    key_expr,
                    ..Default::default()
                });
            }
            Some(Call {
                name: name.to_string(),
                line: start_line(call_node),
                dynamic: None,
                receiver: None,
                ..Default::default()
            })
        }
        "member_expression" => {
            let obj = fn_node.child_by_field_name("object");
            let prop = fn_node.child_by_field_name("property");
            let prop = prop?;
            let prop_text = node_text(&prop, source);
            let call_line = start_line(call_node);
            let is_reflect = obj
                .as_ref()
                .map(|o| o.kind() == "identifier" && node_text(o, source) == "Reflect")
                .unwrap_or(false);

            // Reflect.apply(fn, thisArg, args) — extract the first argument as the actual callee.
            // Note: Reflect.call does not exist in the ECMAScript spec; only Reflect.apply, construct, get, etc.
            if is_reflect && prop_text == "apply" {
                return Some(extract_reflect_callee_from_arg(
                    get_first_call_arg(call_node),
                    call_line,
                    source,
                ));
            }

            // Reflect.construct(Target, args) — extract constructor as callee
            if is_reflect && prop_text == "construct" {
                return Some(extract_reflect_callee_from_arg(
                    get_first_call_arg(call_node),
                    call_line,
                    source,
                ));
            }

            // Reflect.get(target, prop) — property access via reflection
            if is_reflect && prop_text == "get" {
                let args = call_node
                    .child_by_field_name("arguments")
                    .or_else(|| find_child(call_node, "arguments"));
                if let Some(args) = args {
                    let mut first_arg: Option<Node> = None;
                    let mut second_arg: Option<Node> = None;
                    let mut arg_idx = 0usize;
                    for i in 0..args.child_count() {
                        let Some(child) = args.child(i) else { continue };
                        if matches!(child.kind(), "(" | ")" | ",") {
                            continue;
                        }
                        if arg_idx == 0 {
                            first_arg = Some(child);
                        } else if arg_idx == 1 {
                            second_arg = Some(child);
                            break;
                        }
                        arg_idx += 1;
                    }
                    let receiver = first_arg.as_ref().map(|a| extract_receiver_name(a, source));
                    if let Some(prop_arg) = second_arg {
                        match prop_arg.kind() {
                            "string" | "string_fragment" => {
                                let prop_name =
                                    node_text(&prop_arg, source).replace(&['\'', '"'][..], "");
                                if !prop_name.is_empty() {
                                    return Some(Call {
                                        name: prop_name,
                                        line: call_line,
                                        dynamic: Some(true),
                                        dynamic_kind: Some("computed-literal".to_string()),
                                        key_expr: Some(node_text(&prop_arg, source).to_string()),
                                        receiver,
                                        ..Default::default()
                                    });
                                }
                            }
                            "identifier" => {
                                return Some(Call {
                                    name: "<dynamic:computed-key>".to_string(),
                                    line: call_line,
                                    dynamic: Some(true),
                                    dynamic_kind: Some("computed-key".to_string()),
                                    key_expr: Some(node_text(&prop_arg, source).to_string()),
                                    receiver,
                                    ..Default::default()
                                });
                            }
                            _ => {}
                        }
                    }
                }
                return Some(Call {
                    name: "<dynamic:unresolved>".to_string(),
                    line: call_line,
                    dynamic: Some(true),
                    dynamic_kind: Some("unresolved-dynamic".to_string()),
                    ..Default::default()
                });
            }

            if prop_text == "call" || prop_text == "apply" || prop_text == "bind" {
                if let Some(obj) = &obj {
                    if obj.kind() == "identifier" {
                        return Some(Call {
                            name: node_text(obj, source).to_string(),
                            line: call_line,
                            dynamic: Some(true),
                            dynamic_kind: Some("reflection".to_string()),
                            receiver: None,
                            ..Default::default()
                        });
                    }
                    if obj.kind() == "member_expression" {
                        if let Some(inner_prop) = obj.child_by_field_name("property") {
                            return Some(Call {
                                name: node_text(&inner_prop, source).to_string(),
                                line: call_line,
                                dynamic: Some(true),
                                dynamic_kind: Some("reflection".to_string()),
                                receiver: None,
                                ..Default::default()
                            });
                        }
                    }
                    // Inline function literal (`function(){...}.bind(this)`, or the
                    // same wrapped in one level of parens — `(function(){}).bind(x)`,
                    // `(() => {}).bind(x)`; arrow functions in this position always
                    // need the parens) — there is no meaningful bound-target NAME to
                    // record (the wrapped function is anonymous), and falling through
                    // to the generic tail below would set `receiver` to the entire
                    // function body's source text via extract_receiver_name's
                    // raw-text fallback (issue #2321). Still tag the call site itself
                    // as a dynamic/reflection invocation — same informational value
                    // as the identifier/member_expression cases above — just without
                    // a receiver, since none exists. Mirrors isInlineFunctionLiteral
                    // + extractMemberExprCallInfo in src/extractors/javascript.ts.
                    if is_inline_function_literal(obj) {
                        return Some(Call {
                            name: prop_text.to_string(),
                            line: call_line,
                            dynamic: Some(true),
                            dynamic_kind: Some("reflection".to_string()),
                            receiver: None,
                            ..Default::default()
                        });
                    }
                }
            }

            if prop.kind() == "string" || prop.kind() == "string_fragment" {
                let method_name = node_text(&prop, source).replace(&['\'', '"'][..], "");
                if !method_name.is_empty() {
                    let receiver = obj.as_ref().map(|o| extract_receiver_name(o, source));
                    return Some(Call {
                        name: method_name,
                        line: call_line,
                        dynamic: Some(true),
                        dynamic_kind: Some("computed-literal".to_string()),
                        receiver,
                        ..Default::default()
                    });
                }
            }

            // #2085: `this.method()` where an intervening plain function
            // breaks the `this`-binding chain to the lexically enclosing
            // class (e.g. a bare `function` passed to
            // `setTimeout`/`addEventListener`) — `this` is not guaranteed to
            // be that class's instance at runtime, so resolving this as a
            // same-class call would be a false positive. The real target is
            // statically unknowable here, so this is flagged the same way
            // other undecidable dynamic call shapes are, rather than
            // guessed at.
            if obj.as_ref().map(|o| o.kind()) == Some("this")
                && this_rebinding_breaks_class_scope(fn_node, source)
            {
                return Some(Call {
                    name: "<dynamic:unresolved>".to_string(),
                    line: call_line,
                    dynamic: Some(true),
                    dynamic_kind: Some("unresolved-dynamic".to_string()),
                    ..Default::default()
                });
            }

            let receiver = obj.as_ref().map(|o| extract_receiver_name(o, source));
            Some(Call {
                name: prop_text.to_string(),
                line: start_line(call_node),
                dynamic: None,
                receiver,
                ..Default::default()
            })
        }
        "subscript_expression" => {
            let index = fn_node.child_by_field_name("index");
            if let Some(index) = index {
                let receiver = fn_node
                    .child_by_field_name("object")
                    .map(|o| extract_receiver_name(&o, source));
                match index.kind() {
                    "string" | "template_string" => {
                        let method_name =
                            node_text(&index, source).replace(&['\'', '"', '`'][..], "");
                        if !method_name.is_empty() && !method_name.contains('$') {
                            return Some(Call {
                                name: method_name,
                                line: start_line(call_node),
                                dynamic: Some(true),
                                dynamic_kind: Some("computed-literal".to_string()),
                                receiver,
                                ..Default::default()
                            });
                        }
                    }
                    "identifier" => {
                        return Some(Call {
                            name: "<dynamic:computed-key>".to_string(),
                            line: start_line(call_node),
                            dynamic: Some(true),
                            dynamic_kind: Some("computed-key".to_string()),
                            key_expr: Some(node_text(&index, source).to_string()),
                            receiver,
                            ..Default::default()
                        });
                    }
                    _ => {
                        return Some(Call {
                            name: "<dynamic:unresolved>".to_string(),
                            line: start_line(call_node),
                            dynamic: Some(true),
                            dynamic_kind: Some("unresolved-dynamic".to_string()),
                            ..Default::default()
                        });
                    }
                }
            }
            None
        }
        // Bare `super(...)` — see the early dispatch in `handle_call_expr` for why
        // callback-reference-call extraction is skipped for the arguments here.
        "super" => Some(Call {
            name: "constructor".to_string(),
            line: start_line(call_node),
            receiver: Some("super".to_string()),
            ..Default::default()
        }),
        _ => None,
    }
}

fn find_anonymous_callback<'a>(args_node: &Node<'a>) -> Option<Node<'a>> {
    for i in 0..args_node.child_count() {
        if let Some(child) = args_node.child(i) {
            if child.kind() == "arrow_function" || child.kind() == "function_expression" {
                return Some(child);
            }
        }
    }
    None
}

fn find_first_string_arg<'a>(args_node: &Node<'a>, source: &'a [u8]) -> Option<String> {
    for i in 0..args_node.child_count() {
        if let Some(child) = args_node.child(i) {
            if child.kind() == "string" {
                return Some(node_text(&child, source).replace(&['\'', '"'][..], ""));
            }
        }
    }
    None
}

fn walk_call_chain<'a>(
    start_node: &Node<'a>,
    method_name: &str,
    source: &[u8],
) -> Option<Node<'a>> {
    let mut current = Some(*start_node);
    while let Some(node) = current {
        if node.kind() == "call_expression" {
            if let Some(fn_node) = node.child_by_field_name("function") {
                if fn_node.kind() == "member_expression" {
                    if let Some(prop) = fn_node.child_by_field_name("property") {
                        if node_text(&prop, source) == method_name {
                            return Some(node);
                        }
                    }
                }
            }
        }
        current = match node.kind() {
            "member_expression" => node.child_by_field_name("object"),
            "call_expression" => node.child_by_field_name("function"),
            _ => None,
        };
    }
    None
}

fn is_express_method(method: &str) -> bool {
    matches!(
        method,
        "get" | "post" | "put" | "delete" | "patch" | "options" | "head" | "all" | "use"
    )
}

fn is_event_method(method: &str) -> bool {
    matches!(method, "on" | "once" | "addEventListener" | "addListener")
}

fn extract_callback_definition(call_node: &Node, source: &[u8]) -> Option<Definition> {
    let fn_node = call_node.child_by_field_name("function")?;
    if fn_node.kind() != "member_expression" {
        return None;
    }

    let prop = fn_node.child_by_field_name("property")?;
    let method = node_text(&prop, source);

    let args = call_node
        .child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"))?;

    // Commander: .action(callback) with .command('name') in chain
    if method == "action" {
        let cb = find_anonymous_callback(&args)?;
        let obj = fn_node.child_by_field_name("object")?;
        let command_call = walk_call_chain(&obj, "command", source)?;
        let cmd_args = command_call
            .child_by_field_name("arguments")
            .or_else(|| find_child(&command_call, "arguments"))?;
        let cmd_name = find_first_string_arg(&cmd_args, source)?;
        let first_word = cmd_name.split_whitespace().next().unwrap_or(&cmd_name);
        return Some(Definition {
            name: format!("command:{}", first_word),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }

    // Express: app.get('/path', callback)
    if is_express_method(method) {
        let str_arg = find_first_string_arg(&args, source)?;
        if !str_arg.starts_with('/') {
            return None;
        }
        let cb = find_anonymous_callback(&args)?;
        return Some(Definition {
            name: format!("route:{} {}", method.to_uppercase(), str_arg),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }

    // Events: emitter.on('event', callback)
    if is_event_method(method) {
        let event_name = find_first_string_arg(&args, source)?;
        let cb = find_anonymous_callback(&args)?;
        return Some(Definition {
            name: format!("event:{}", event_name),
            kind: "function".to_string(),
            line: start_line(&cb),
            end_line: Some(end_line(&cb)),
            decorators: None,
            complexity: compute_all_metrics(&cb, source, "javascript"),
            cfg: build_function_cfg(&cb, "javascript", source),
            children: None,
            bodyless: None,
            content_hash: None,
            accessor_kind: None,
        });
    }

    None
}

fn extract_superclass(heritage: &Node, source: &[u8]) -> Option<String> {
    for i in 0..heritage.child_count() {
        if let Some(child) = heritage.child(i) {
            if child.kind() == "identifier" || child.kind() == "member_expression" {
                return Some(node_text(&child, source).to_string());
            }
            if let Some(found) = extract_superclass(&child, source) {
                return Some(found);
            }
        }
    }
    None
}

const JS_CLASS_KINDS: &[&str] = &["class_declaration", "abstract_class_declaration", "class"];

fn find_parent_class(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, JS_CLASS_KINDS, source)
}

/// Plain (non-arrow) function scopes that do NOT inherit `this` lexically
/// from their enclosing scope — JS/TS rebinds `this` at every ordinary
/// function call unless the function is explicitly bound (see
/// `is_bound_to_outer_this`). Arrow functions are deliberately excluded:
/// they close over the enclosing scope's `this` rather than establishing
/// their own, so they are transparent to a `this`-binding walk. Distinct
/// from `JS_FN_SCOPE_KINDS` above, which serves an unrelated typeMap-reset
/// purpose and also treats arrow functions and methods as boundaries.
const JS_THIS_REBINDING_BOUNDARY_KINDS: &[&str] = &[
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
];

/// True when `fn_node` (a function_declaration/function_expression/generator
/// variant) is the direct receiver of an inline `.bind(this)` call —
/// `function () { ... }.bind(this)` explicitly re-establishes the enclosing
/// `this` at the point the function is created, so it does not rebind
/// `this` away from the enclosing scope despite being a plain function.
///
/// Deliberately narrow: only the immediate `fn.bind(this)` shape is
/// recognized. A named function referenced and bound elsewhere falls
/// through to the conservative (boundary-respecting) treatment — a missed
/// resolution, not an incorrect one. Mirrors `isBoundToOuterThis` in
/// src/extractors/javascript.ts.
fn is_bound_to_outer_this(fn_node: &Node, source: &[u8]) -> bool {
    let Some(parent) = fn_node.parent() else {
        return false;
    };
    if parent.kind() != "member_expression" {
        return false;
    }
    if parent.child_by_field_name("object").map(|o| o.id()) != Some(fn_node.id()) {
        return false;
    }
    let Some(prop) = parent.child_by_field_name("property") else {
        return false;
    };
    if node_text(&prop, source) != "bind" {
        return false;
    }
    let Some(call_expr) = parent.parent() else {
        return false;
    };
    if call_expr.kind() != "call_expression" {
        return false;
    }
    if call_expr.child_by_field_name("function").map(|f| f.id()) != Some(parent.id()) {
        return false;
    }
    let Some(args) = call_expr
        .child_by_field_name("arguments")
        .or_else(|| find_child(&call_expr, "arguments"))
    else {
        return false;
    };
    for i in 0..args.child_count() {
        let Some(child) = args.child(i) else { continue };
        match child.kind() {
            "(" | ")" | "," => continue,
            other => return other == "this",
        }
    }
    false
}

fn is_this_rebinding_boundary(node: &Node, source: &[u8]) -> bool {
    JS_THIS_REBINDING_BOUNDARY_KINDS.contains(&node.kind()) && !is_bound_to_outer_this(node, source)
}

/// Like `find_parent_class`, but stops (returning `None`) at an intervening
/// plain function scope rather than walking through it — the scope-respecting
/// lookup a `this`-qualified receiver's enclosing class needs (#2085). A
/// non-arrow function does not inherit `this` from its enclosing method, so
/// `this` inside it is not guaranteed to be that method's class instance.
fn find_parent_class_for_this_binding(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name_with_boundary(node, JS_CLASS_KINDS, source, |n| {
        is_this_rebinding_boundary(n, source)
    })
}

/// True when `node`'s enclosing class (if any) cannot be reached from `node`
/// without crossing a `this`-rebinding boundary — i.e. there IS a lexically
/// enclosing class, but an intervening plain function breaks the `this`
/// chain to it (#2085). Returns false when there is no enclosing class at
/// all, since there is nothing to falsely attribute `this` to in that case.
fn this_rebinding_breaks_class_scope(node: &Node, source: &[u8]) -> bool {
    find_parent_class(node, source).is_some()
        && find_parent_class_for_this_binding(node, source).is_none()
}

/// Like `find_parent_class` but stops at function scope boundaries.
///
/// The WASM `extractReturnTypeMapWalk` resets `currentClass` to `null` before
/// recursing into any function or method body. This means nested function
/// declarations and arrow-function variable declarators inside a method body
/// are never attributed to the enclosing class. This function replicates that
/// behavior by halting the ancestor walk when a function/method node is found
/// before reaching a class.
const JS_FN_SCOPE_KINDS: &[&str] = &[
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
];

fn find_parent_class_no_fn_boundary(node: &Node, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        let kind = parent.kind();
        if JS_FN_SCOPE_KINDS.contains(&kind) {
            // Crossed a function scope boundary — stop, as WASM does.
            return None;
        }
        if JS_CLASS_KINDS.contains(&kind) {
            return named_child_text(&parent, "name", source).map(|s| s.to_string());
        }
        current = parent.parent();
    }
    None
}

/// Wrapper node kinds that can sit between a dynamic `import()` call and its
/// enclosing `variable_declarator` without changing which value gets bound —
/// `await`, redundant parentheses, and TypeScript `as`/`satisfies` casts.
/// Real-world call sites often combine several of these, e.g.
/// `const { X } = (await import('./mod.js')) as { X: Fn }` nests
/// await_expression → parenthesized_expression → as_expression before
/// reaching the declarator (#1781). `satisfies_expression` (TS 4.9+
/// `... satisfies { X: Fn }`) is structurally identical to `as_expression`
/// here — Greptile follow-up, mirrors the TS extractor.
const DYNAMIC_IMPORT_WRAPPER_KINDS: &[&str] = &[
    "await_expression",
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
];

/// Extract named bindings from a dynamic `import()` call expression.
/// Handles: `const { a, b } = await import(...)`, `const mod = await import(...)`,
/// casts/parens wrapping the awaited call, e.g.
/// `const { a } = (await import(...)) as { a: Fn }`, and destructuring
/// renames, e.g. `const { a: b } = await import(...)`.
///
/// `renamed_out` is populated with `{ local, imported }` pairs for every
/// `{ imported: local }` specifier — mirrors `extract_import_names_with_renames`'s
/// static-import convention (#1730) so call-edge resolution can recover the
/// original exported name when a call site uses the local alias (#1824).
fn extract_dynamic_import_names(
    call_node: &Node,
    source: &[u8],
    renamed_out: &mut Vec<RenamedImport>,
) -> Vec<String> {
    // Walk up through any combination/nesting of await/parenthesized/as-cast
    // wrappers to reach the variable_declarator.
    let mut current = call_node.parent();
    while let Some(parent) = current {
        if DYNAMIC_IMPORT_WRAPPER_KINDS.contains(&parent.kind()) {
            current = parent.parent();
        } else {
            break;
        }
    }
    let declarator = match current {
        Some(n) if n.kind() == "variable_declarator" => n,
        _ => return Vec::new(),
    };
    let Some(name_node) = declarator.child_by_field_name("name") else {
        return Vec::new();
    };
    match name_node.kind() {
        "object_pattern" => collect_object_pattern_names(&name_node, source, renamed_out),
        "identifier" => vec![node_text(&name_node, source).to_string()],
        "array_pattern" => collect_array_pattern_names(&name_node, source),
        _ => Vec::new(),
    }
}

/// Collect names from `const { a, b } = await import(...)`
fn collect_object_pattern_names(
    pattern: &Node,
    source: &[u8],
    renamed_out: &mut Vec<RenamedImport>,
) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..pattern.child_count() {
        let Some(child) = pattern.child(i) else {
            continue;
        };
        match child.kind() {
            "shorthand_property_identifier_pattern" | "shorthand_property_identifier" => {
                names.push(node_text(&child, source).to_string());
            }
            "pair_pattern" | "pair" => {
                // { imported: local } → the local binding (`value`) is what
                // call sites actually reference; `key` is the name exported
                // by the target module. Preferring `key` unconditionally (as
                // this branch used to) silently dropped the local alias for
                // every renamed destructure — the same class of bug fixed for
                // static `import { X as Y }` specifiers in #1730 (#1824).
                let key = child.child_by_field_name("key");
                let value = child.child_by_field_name("value");
                let local_node = match value.map(|v| (v.kind(), v)) {
                    Some(("identifier", v))
                    | Some(("shorthand_property_identifier_pattern", v)) => Some(v),
                    Some(("assignment_pattern", v)) => {
                        // { imported: local = defaultValue } — the local
                        // binding is the assignment_pattern's left identifier.
                        v.child_by_field_name("left")
                            .filter(|left| left.kind() == "identifier")
                    }
                    _ => None,
                };
                // A quoted (`{ 'foo-bar': local }`) or computed
                // (`{ ['foo-bar']: local }`) key's raw text includes the
                // quotes/brackets — using it verbatim as `imported` makes the
                // resolver look for an export literally named `'foo-bar'`,
                // which never matches (Greptile, #1824 follow-up). Resolve to
                // the clean export name the same way resolve_computed_key_name
                // already does for object-literal keys.
                let key_name: Option<String> = key.and_then(|key| match key.kind() {
                    "computed_property_name" => resolve_computed_key_name(&key, source),
                    "string" => extract_string_fragment(&key, source).map(String::from),
                    "string_fragment" => Some(node_text(&key, source).to_string()),
                    _ => Some(node_text(&key, source).to_string()),
                });
                match (local_node, key_name) {
                    (Some(local_node), key_name) => {
                        // The local binding is always trackable on its own,
                        // even when the key isn't statically resolvable (e.g.
                        // `{ [Symbol()]: local }`) — only the rename-pair
                        // mapping is skipped in that case.
                        let local_text = node_text(&local_node, source).to_string();
                        if let Some(key_name) = key_name {
                            if local_text != key_name {
                                renamed_out.push(RenamedImport {
                                    local: local_text.clone(),
                                    imported: key_name,
                                });
                            }
                        }
                        names.push(local_text);
                    }
                    (None, Some(key_name)) => {
                        // Nested pattern (`{ foo: { nested } }`) or other
                        // unsupported value shape — no single local binding
                        // to extract; fall back to the key so the specifier
                        // isn't dropped entirely.
                        names.push(key_name);
                    }
                    _ => {}
                }
            }
            "object_assignment_pattern" => {
                // { a = 'default' } → extract the left-hand binding
                if let Some(left) = child.child_by_field_name("left") {
                    names.push(node_text(&left, source).to_string());
                }
            }
            "rest_pattern" | "rest_element" => {
                extract_rest_identifier(&child, source, &mut names);
            }
            _ => {}
        }
    }
    names
}

/// Collect names from `const [first, second] = await import(...)`
fn collect_array_pattern_names(pattern: &Node, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..pattern.child_count() {
        let Some(child) = pattern.child(i) else {
            continue;
        };
        match child.kind() {
            "identifier" => {
                names.push(node_text(&child, source).to_string());
            }
            "assignment_pattern" => {
                if let Some(left) = child.child_by_field_name("left") {
                    names.push(node_text(&left, source).to_string());
                }
            }
            "rest_pattern" | "rest_element" => {
                // `[...rest]` binds a plain identifier; `[...[a, b]]` nests
                // another array pattern whose own bound names must each be
                // collected too — plain `extract_rest_identifier` only ever
                // extracts a single identifier, which left nested-rest names
                // (created as Definitions by extract_array_pattern_bindings's
                // own rest_pattern branch below) with no matching Export,
                // diverging from the Definition side for e.g.
                // `export const [x, ...[a, b]] = value` (#2070). Mirrors
                // extract_array_pattern_bindings's rest_pattern handling
                // instead of the plain-identifier-only extract_rest_identifier.
                for j in 0..child.child_count() {
                    let Some(inner) = child.child(j) else {
                        continue;
                    };
                    match inner.kind() {
                        "identifier" => {
                            names.push(node_text(&inner, source).to_string());
                            break;
                        }
                        "array_pattern" => {
                            names.extend(collect_array_pattern_names(&inner, source));
                            break;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    names
}

/// Extract the identifier from a rest/spread element (`...rest` → `rest`).
/// Scans all children for the `identifier` node rather than assuming a fixed
/// index — the `...` token itself is child 0, so indexing into a fixed slot
/// silently returns the wrong node and drops the binding entirely (#1920).
/// Mirrors `extract_array_pattern_bindings`'s own rest_pattern handling.
fn extract_rest_identifier(rest_node: &Node, source: &[u8], names: &mut Vec<String>) {
    for i in 0..rest_node.child_count() {
        if let Some(inner) = rest_node.child(i) {
            if inner.kind() == "identifier" {
                names.push(node_text(&inner, source).to_string());
                break;
            }
        }
    }
}

/// Extract import names and collect `{ local, imported }` pairs for
/// `import_specifier` nodes that rename a binding (`import { X as Y }`), plus
/// the local names of specifiers carrying an inline `type`/`typeof`
/// modifier (`import { type X }`, #1813). Mirrors `extractImportNames`'s
/// `renamedOut`/`typeOnlyOut` parameters in src/extractors/javascript.ts
/// (#1730, #1813).
fn extract_import_names_with_renames(
    node: &Node,
    source: &[u8],
    renamed_out: &mut Vec<RenamedImport>,
    type_only_out: &mut Vec<String>,
) -> Vec<String> {
    let mut names = Vec::new();
    scan_import_names(node, source, &mut names, renamed_out, type_only_out);
    names
}

fn scan_import_names(
    node: &Node,
    source: &[u8],
    names: &mut Vec<String>,
    renamed_out: &mut Vec<RenamedImport>,
    type_only_out: &mut Vec<String>,
) {
    scan_import_names_depth(node, source, names, renamed_out, type_only_out, 0);
}

/// Grammar note (see tree-sitter-javascript): for `import_specifier`, the
/// `name` field is *always* present — it holds the name as declared by the
/// source module. `alias` is only present for `X as Y` and holds the *local*
/// binding actually referenced by call sites in this file. Preferring `name`
/// unconditionally (as this function used to) silently drops the local alias
/// for every renamed import: call sites use `Y`, not `X` (#1730).
///
/// `export_specifier` has the same `name`/`alias` shape but the opposite
/// consumer: `name` (X) is the declaration being re-exported, `alias` (Y) is
/// the external name a consumer of *this* barrel imports. `names` keeps
/// recording X (barrel/reexport tracing keys off the original declaration —
/// see `resolve_barrel_export`), but when the two differ, `renamed_out` also
/// receives the `{ local: Y, imported: X }` pair so barrel resolution can
/// translate a consumer's requested external name back to X (#1823).
///
/// The tree-sitter-typescript grammar defines `import_specifier` as
/// `optional(choice('type', 'typeof'))` followed by the name/alias fields, so
/// an inline per-specifier type modifier (`import { type X }`) — when
/// present — is always the specifier's first child (#1813).
fn scan_import_names_depth(
    node: &Node,
    source: &[u8],
    names: &mut Vec<String>,
    renamed_out: &mut Vec<RenamedImport>,
    type_only_out: &mut Vec<String>,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match node.kind() {
        "import_specifier" => {
            let source_name_node = node.child_by_field_name("name");
            let alias_node = node.child_by_field_name("alias");
            let local_node = alias_node.or(source_name_node);
            if let Some(local_node) = local_node {
                let local_text = node_text(&local_node, source).to_string();
                names.push(local_text.clone());
                if let (Some(alias), Some(source_name)) = (alias_node, source_name_node) {
                    let alias_text = node_text(&alias, source);
                    let source_text = node_text(&source_name, source);
                    if alias_text != source_text {
                        renamed_out.push(RenamedImport {
                            local: alias_text.to_string(),
                            imported: source_text.to_string(),
                        });
                    }
                }
                if let Some(modifier) = node.child(0) {
                    if modifier.kind() == "type" || modifier.kind() == "typeof" {
                        type_only_out.push(local_text);
                    }
                }
            } else {
                names.push(node_text(node, source).to_string());
            }
        }
        "export_specifier" => {
            // export_specifier's `name` is the local declaration being (re-)exported;
            // `alias` is the external name it's exposed as. Barrel/reexport tracing
            // (resolve_barrel_export) keys off the *original* declaration name, so
            // this branch keeps picking `name` first — do not unify with the
            // import_specifier branch above. When `alias` differs from `name`, the
            // rename pair is recorded in renamed_out so resolve_barrel_export can
            // map a consumer's requested external name (Y) back to X (#1823).
            let source_name_node = node.child_by_field_name("name");
            let alias_node = node.child_by_field_name("alias");
            let name_node = source_name_node.or(alias_node);
            if let Some(name_node) = name_node {
                names.push(node_text(&name_node, source).to_string());
                if let (Some(alias), Some(source_name)) = (alias_node, source_name_node) {
                    let alias_text = node_text(&alias, source);
                    let source_text = node_text(&source_name, source);
                    if alias_text != source_text {
                        renamed_out.push(RenamedImport {
                            local: alias_text.to_string(),
                            imported: source_text.to_string(),
                        });
                    }
                }
            } else {
                names.push(node_text(node, source).to_string());
            }
        }
        "identifier" => {
            if let Some(parent) = node.parent() {
                if parent.kind() == "import_clause" {
                    names.push(node_text(node, source).to_string());
                }
            }
        }
        "namespace_import" => {
            names.push(node_text(node, source).to_string());
        }
        _ => {}
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            scan_import_names_depth(&child, source, names, renamed_out, type_only_out, depth + 1);
        }
    }
}

// ── Points-to binding collectors (Phase 8.3c–8.3f) ──────────────────────────
// Mirror the TS collectors invoked from runCollectorWalk / runContextCollectorWalk
// in `src/extractors/javascript.ts`. Each collector records bindings consumed by
// the pts constraint solver in `build_edges.rs`.

/// Collectors whose interest spans multiple node kinds, dispatched per node.
fn match_js_pts_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "call_expression" => {
            collect_this_call_and_bindings(node, source, symbols);
            collect_param_bindings(node, source, symbols);
            collect_spread_and_array_from_bindings(node, source, symbols);
        }
        "variable_declarator" => {
            collect_array_elem_bindings(node, source, symbols);
            collect_object_prop_bindings(node, source, symbols);
            collect_collection_wrap_binding(node, source, symbols);
        }
        "for_in_statement" => collect_for_of_binding(node, source, symbols),
        _ => {}
    }
    collect_object_rest_params(node, source, symbols);
}

/// Nearest enclosing *named* callable for for-of binding context.
///
/// Mirrors the TS `funcStack` in runContextCollectorWalk: named function
/// declarations, class methods (qualified `Class.method` when the class name
/// parses as `identifier` — TS class names are `type_identifier` and stay
/// unqualified), variables initialized with arrow/function expressions, and
/// `obj.method = function()` property assignments. Anonymous callables are
/// skipped so the outer context wins. Top level → `<module>`.
fn enclosing_func_context(node: &Node, source: &[u8]) -> String {
    let mut cur = node.parent();
    while let Some(n) = cur {
        match n.kind() {
            "function_declaration" | "generator_function_declaration" => {
                if let Some(name_n) = n.child_by_field_name("name") {
                    if name_n.kind() == "identifier" {
                        return node_text(&name_n, source).to_string();
                    }
                }
            }
            "method_definition" => {
                if let Some(name_n) = n.child_by_field_name("name") {
                    let method = node_text(&name_n, source);
                    let class_name = find_parent_of_types(
                        &n,
                        &["class_declaration", "abstract_class_declaration", "class"],
                    )
                    .and_then(|c| c.child_by_field_name("name"))
                    .filter(|name| name.kind() == "identifier")
                    .map(|name| node_text(&name, source));
                    return match class_name {
                        Some(c) => format!("{c}.{method}"),
                        None => method.to_string(),
                    };
                }
            }
            "arrow_function" | "function_expression" | "generator_function" => {
                if let Some(parent) = n.parent() {
                    if parent.kind() == "variable_declarator" {
                        if let Some(name_n) = parent.child_by_field_name("name") {
                            if name_n.kind() == "identifier" {
                                return node_text(&name_n, source).to_string();
                            }
                        }
                    } else if parent.kind() == "assignment_expression" {
                        // `obj.method = function() { ... }` — func-prop assignment.
                        if let Some(lhs) = parent.child_by_field_name("left") {
                            if lhs.kind() == "member_expression" {
                                if let (Some(obj), Some(prop)) = (
                                    lhs.child_by_field_name("object"),
                                    lhs.child_by_field_name("property"),
                                ) {
                                    let prop_kind = prop.kind();
                                    let obj_text = node_text(&obj, source);
                                    let prop_text = node_text(&prop, source);
                                    if obj.kind() == "identifier"
                                        && (prop_kind == "property_identifier"
                                            || prop_kind == "identifier")
                                        && !JS_BUILTIN_GLOBALS.contains(&obj_text)
                                        && prop_text != "prototype"
                                    {
                                        return format!("{obj_text}.{prop_text}");
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        cur = n.parent();
    }
    "<module>".to_string()
}

/// Collect from a call_expression node:
/// - `this(args)` → `Call { name: "this" }` (this used as a function)
/// - `fn.call(ctx, ...)` / `fn.apply(ctx, ...)` → ThisCallBinding
fn collect_this_call_and_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    if fn_node.kind() == "this" {
        symbols.calls.push(Call {
            name: "this".to_string(),
            line: start_line(node),
            dynamic: None,
            receiver: None,
            ..Default::default()
        });
        return;
    }
    if fn_node.kind() != "member_expression" {
        return;
    }
    let (Some(obj), Some(prop)) = (
        fn_node.child_by_field_name("object"),
        fn_node.child_by_field_name("property"),
    ) else {
        return;
    };
    let prop_text = node_text(&prop, source);
    let obj_text = node_text(&obj, source);
    if obj.kind() != "identifier"
        || (prop_text != "call" && prop_text != "apply")
        || JS_BUILTIN_GLOBALS.contains(&obj_text)
    {
        return;
    }
    let args = node
        .child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args) = args else { return };
    // First real argument: only bind if it's a plain identifier.
    for i in 0..args.child_count() {
        let Some(child) = args.child(i) else { continue };
        let t = child.kind();
        if t == "(" || t == ")" || t == "," {
            continue;
        }
        if t == "identifier" {
            let arg_text = node_text(&child, source);
            if !JS_BUILTIN_GLOBALS.contains(&arg_text)
                && arg_text != "undefined"
                && arg_text != "null"
            {
                symbols.this_call_bindings.push(ThisCallBinding {
                    callee: obj_text.to_string(),
                    this_arg: arg_text.to_string(),
                });
            }
        }
        break;
    }
}

/// Phase 8.3c: `f(x)` identifier-argument bindings, including inline
/// `f(...[a, b])` array-literal spread expansion.
fn collect_param_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    if fn_node.kind() != "identifier" {
        return;
    }
    let fn_text = node_text(&fn_node, source);
    if JS_BUILTIN_GLOBALS.contains(&fn_text) {
        return;
    }
    let args = node
        .child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args) = args else { return };
    let mut arg_idx: u32 = 0;
    for i in 0..args.child_count() {
        let Some(child) = args.child(i) else { continue };
        let ct = child.kind();
        if ct == "," || ct == "(" || ct == ")" {
            continue;
        }
        if ct == "identifier" {
            let arg_text = node_text(&child, source);
            if !JS_BUILTIN_GLOBALS.contains(&arg_text) {
                symbols.param_bindings.push(ParamBinding {
                    callee: fn_text.to_string(),
                    arg_index: arg_idx,
                    arg_name: arg_text.to_string(),
                });
            }
        } else if ct == "spread_element" {
            // f(...[a, b]) — inline array literal: expand each element as a direct binding.
            let inner = child.child_by_field_name("argument").or_else(|| {
                if child.child_count() > 1 {
                    child.child(1)
                } else {
                    None
                }
            });
            if let Some(inner) = inner {
                if inner.kind() == "array" {
                    let mut elem_count: u32 = 0;
                    for j in 0..inner.child_count() {
                        let Some(elem) = inner.child(j) else { continue };
                        let et = elem.kind();
                        if et == "," || et == "[" || et == "]" {
                            continue;
                        }
                        if et == "identifier" {
                            let elem_text = node_text(&elem, source);
                            if !JS_BUILTIN_GLOBALS.contains(&elem_text) {
                                symbols.param_bindings.push(ParamBinding {
                                    callee: fn_text.to_string(),
                                    arg_index: arg_idx + elem_count,
                                    arg_name: elem_text.to_string(),
                                });
                            }
                        }
                        elem_count += 1;
                    }
                    // Advance by the exact number of slots this spread occupies so
                    // zero-element spreads (...[]) don't shift subsequent indices.
                    arg_idx += elem_count;
                    continue;
                }
            }
        }
        arg_idx += 1;
    }
}

/// Phase 8.3e: `f(...arr)` spread bindings and `Array.from(src, cb)` callbacks.
fn collect_spread_and_array_from_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else {
        return;
    };
    let args = node
        .child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args) = args else { return };

    // Spread: f(...arr)
    if fn_node.kind() == "identifier" {
        let fn_text = node_text(&fn_node, source);
        if !JS_BUILTIN_GLOBALS.contains(&fn_text) {
            let mut arg_idx: u32 = 0;
            for i in 0..args.child_count() {
                let Some(child) = args.child(i) else { continue };
                let ct = child.kind();
                if ct == "," || ct == "(" || ct == ")" {
                    continue;
                }
                if ct == "spread_element" {
                    let target = child.child_by_field_name("argument").or_else(|| {
                        if child.child_count() > 1 {
                            child.child(1)
                        } else {
                            None
                        }
                    });
                    if let Some(target) = target {
                        if target.kind() == "identifier" {
                            let target_text = node_text(&target, source);
                            if !JS_BUILTIN_GLOBALS.contains(&target_text) {
                                symbols.spread_arg_bindings.push(SpreadArgBinding {
                                    callee: fn_text.to_string(),
                                    array_name: target_text.to_string(),
                                    start_index: arg_idx,
                                });
                            }
                        }
                    }
                }
                arg_idx += 1;
            }
        }
    }

    // Array.from(source, cb)
    if fn_node.kind() == "member_expression" {
        let (Some(obj), Some(prop)) = (
            fn_node.child_by_field_name("object"),
            fn_node.child_by_field_name("property"),
        ) else {
            return;
        };
        if node_text(&obj, source) != "Array" || node_text(&prop, source) != "from" {
            return;
        }
        let mut fn_args: Vec<Node> = Vec::new();
        for i in 0..args.child_count() {
            let Some(child) = args.child(i) else { continue };
            let ct = child.kind();
            if ct == "," || ct == "(" || ct == ")" {
                continue;
            }
            fn_args.push(child);
        }
        if fn_args.len() >= 2 {
            let src_arg = &fn_args[0];
            let cb_arg = &fn_args[1];
            let src_text = node_text(src_arg, source);
            let cb_text = node_text(cb_arg, source);
            if src_arg.kind() == "identifier"
                && !JS_BUILTIN_GLOBALS.contains(&src_text)
                && cb_arg.kind() == "identifier"
                && !JS_BUILTIN_GLOBALS.contains(&cb_text)
            {
                symbols.array_callback_bindings.push(ArrayCallbackBinding {
                    source_name: src_text.to_string(),
                    callee_name: cb_text.to_string(),
                });
            }
        }
    }
}

/// Phase 8.3e: `const arr = [fn1, fn2]` array-element bindings.
fn collect_array_elem_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let (Some(name_n), Some(value_n)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("value"),
    ) else {
        return;
    };
    if name_n.kind() != "identifier" || value_n.kind() != "array" {
        return;
    }
    let array_name = node_text(&name_n, source);
    let mut idx: u32 = 0;
    for i in 0..value_n.child_count() {
        let Some(elem) = value_n.child(i) else {
            continue;
        };
        let et = elem.kind();
        if et == "," || et == "[" || et == "]" {
            continue;
        }
        if et == "identifier" {
            let elem_text = node_text(&elem, source);
            if !JS_BUILTIN_GLOBALS.contains(&elem_text) {
                symbols.array_elem_bindings.push(ArrayElemBinding {
                    array_name: array_name.to_string(),
                    index: idx,
                    elem_name: elem_text.to_string(),
                });
            }
        }
        idx += 1;
    }
}

/// Phase 8.3e: collection wrap `const s = new Set(arr)` / `new Map(arr)` →
/// FnRefBinding `s[*] ⊇ arr[*]`.
fn collect_collection_wrap_binding(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let (Some(name_n), Some(value_n)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("value"),
    ) else {
        return;
    };
    if name_n.kind() != "identifier" || value_n.kind() != "new_expression" {
        return;
    }
    let (Some(ctor), Some(args)) = (
        value_n.child_by_field_name("constructor"),
        value_n.child_by_field_name("arguments"),
    ) else {
        return;
    };
    let ctor_text = node_text(&ctor, source);
    if ctor_text != "Set" && ctor_text != "Map" {
        return;
    }
    for i in 0..args.child_count() {
        let Some(arg) = args.child(i) else { continue };
        let at = arg.kind();
        if at == "(" || at == ")" {
            continue;
        }
        if at == "identifier" {
            let arg_text = node_text(&arg, source);
            if !JS_BUILTIN_GLOBALS.contains(&arg_text) {
                symbols.fn_ref_bindings.push(FnRefBinding {
                    lhs: format!("{}[*]", node_text(&name_n, source)),
                    rhs: format!("{arg_text}[*]"),
                    rhs_receiver: None,
                });
                break;
            }
        }
        break;
    }
}

/// Phase 8.3e: `for (const x of arr)` iteration bindings
/// (for_in_statement with an `of` keyword).
fn collect_for_of_binding(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mut is_for_of = false;
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if node_text(&child, source) == "of" {
                is_for_of = true;
                break;
            }
        }
    }
    if !is_for_of {
        return;
    }
    let Some(right) = node.child_by_field_name("right") else {
        return;
    };
    let right_text = node_text(&right, source);
    if right.kind() != "identifier" || JS_BUILTIN_GLOBALS.contains(&right_text) {
        return;
    }
    let Some(left) = node.child_by_field_name("left") else {
        return;
    };
    let mut var_name: Option<&str> = None;
    if left.kind() == "identifier" {
        var_name = Some(node_text(&left, source));
    } else {
        for i in 0..left.child_count() {
            let Some(lc) = left.child(i) else { continue };
            if lc.kind() == "variable_declarator" {
                if let Some(nc) = lc.child_by_field_name("name") {
                    if nc.kind() == "identifier" {
                        var_name = Some(node_text(&nc, source));
                        break;
                    }
                }
            } else if lc.kind() == "identifier" {
                let lc_text = node_text(&lc, source);
                if lc_text != "const" && lc_text != "let" && lc_text != "var" {
                    var_name = Some(lc_text);
                    break;
                }
            }
        }
    }
    if let Some(var_name) = var_name {
        if !JS_BUILTIN_GLOBALS.contains(&var_name) {
            let enclosing_func = enclosing_func_context(node, source);
            symbols.for_of_bindings.push(ForOfBinding {
                var_name: var_name.to_string(),
                source_name: right_text.to_string(),
                enclosing_func,
            });
        }
    }
}

/// Phase 8.3f: object-destructuring rest-parameter bindings from function
/// definitions (`function f({ a, ...rest })` → callee "f", restName "rest").
/// Class methods are qualified `ClassName.method`, mirroring the TS
/// `objectRestClass` propagation (class_declaration|class → class_body →
/// method_definition; abstract classes intentionally excluded).
fn collect_object_rest_params(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let t = node.kind();
    let mut fn_name: Option<String> = None;
    let mut params_node: Option<Node> = None;

    match t {
        "function_declaration" | "generator_function_declaration" => {
            if let Some(name_n) = node.child_by_field_name("name") {
                if name_n.kind() == "identifier" {
                    fn_name = Some(node_text(&name_n, source).to_string());
                }
            }
            params_node = node
                .child_by_field_name("parameters")
                .or_else(|| find_child(node, "formal_parameters"));
        }
        "variable_declarator" => {
            if let (Some(name_n), Some(value_n)) = (
                node.child_by_field_name("name"),
                node.child_by_field_name("value"),
            ) {
                let vt = value_n.kind();
                if name_n.kind() == "identifier"
                    && (vt == "arrow_function"
                        || vt == "function_expression"
                        || vt == "generator_function")
                {
                    fn_name = Some(node_text(&name_n, source).to_string());
                    params_node = value_n
                        .child_by_field_name("parameters")
                        .or_else(|| find_child(&value_n, "formal_parameters"));
                }
            }
        }
        "method_definition" => {
            // class method `class Foo { bar({ ...rest }) {} }` or object-literal
            // shorthand method `{ bar({ ...rest }) {} }`.
            if let Some(name_n) = node.child_by_field_name("name") {
                let method = node_text(&name_n, source);
                let current_class = node
                    .parent()
                    .filter(|p| p.kind() == "class_body")
                    .and_then(|p| p.parent())
                    .filter(|c| c.kind() == "class_declaration" || c.kind() == "class")
                    .and_then(|c| {
                        c.child_by_field_name("name")
                            .map(|n| node_text(&n, source).to_string())
                    });
                fn_name = Some(match current_class {
                    Some(c) => format!("{c}.{method}"),
                    None => method.to_string(),
                });
                params_node = node
                    .child_by_field_name("parameters")
                    .or_else(|| find_child(node, "formal_parameters"));
            }
        }
        "pair" => {
            // object-literal method: `{ bar: function({ ...rest }) {} }`.
            // Computed keys resolve through resolve_pair_key_name, which unwraps resolvable
            // string literals (e.g. `['bar']`) and returns None for non-string computed keys
            // (e.g. `[Symbol.iterator]`) — those can never match a paramBinding callee.
            if let (Some(key_n), Some(value_n)) = (
                node.child_by_field_name("key"),
                node.child_by_field_name("value"),
            ) {
                let vt = value_n.kind();
                if vt == "arrow_function"
                    || vt == "function_expression"
                    || vt == "generator_function"
                {
                    if let Some(key_name) = resolve_pair_key_name(&key_n, source) {
                        fn_name = Some(key_name);
                        params_node = value_n
                            .child_by_field_name("parameters")
                            .or_else(|| find_child(&value_n, "formal_parameters"));
                    }
                }
            }
        }
        _ => {}
    }

    let (Some(fn_name), Some(params_node)) = (fn_name, params_node) else {
        return;
    };
    let mut param_idx: u32 = 0;
    for i in 0..params_node.child_count() {
        let Some(child) = params_node.child(i) else {
            continue;
        };
        let ct = child.kind();
        if ct == "," || ct == "(" || ct == ")" {
            continue;
        }
        // TypeScript wraps EVERY parameter — typed or not — in a
        // required_parameter/optional_parameter node (confirmed by parsing
        // `function f({ ...rest }) {}` with tree-sitter-typescript, which
        // still wraps despite no type annotation at all), unlike plain JS
        // where the object_pattern is a direct child. Without unwrapping,
        // object-rest-param bindings were silently never recorded for any
        // .ts/.tsx file, not just ones using a type annotation (#2080).
        let pattern_node = if ct == "required_parameter" || ct == "optional_parameter" {
            child.child_by_field_name("pattern")
        } else {
            Some(child)
        };
        if let Some(pattern_node) = pattern_node {
            if pattern_node.kind() == "object_pattern" {
                for j in 0..pattern_node.child_count() {
                    let Some(inner) = pattern_node.child(j) else {
                        continue;
                    };
                    if inner.kind() == "rest_pattern" || inner.kind() == "rest_element" {
                        let rest_id = inner.child(1).or_else(|| inner.child_by_field_name("name"));
                        if let Some(rest_id) = rest_id {
                            if rest_id.kind() == "identifier" {
                                symbols
                                    .object_rest_param_bindings
                                    .push(ObjectRestParamBinding {
                                        callee: fn_name.clone(),
                                        rest_name: node_text(&rest_id, source).to_string(),
                                        arg_index: param_idx,
                                    });
                            }
                        }
                    }
                }
            }
        }
        param_idx += 1;
    }
}

/// Phase 8.3f: object-property bindings from object literals.
/// `const obj = { e4 }` and `const obj = { e1: fn }` (identifier values only).
fn collect_object_prop_bindings(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let (Some(name_n), Some(value_n)) = (
        node.child_by_field_name("name"),
        node.child_by_field_name("value"),
    ) else {
        return;
    };
    if name_n.kind() != "identifier" || value_n.kind() != "object" {
        return;
    }
    let object_name = node_text(&name_n, source);
    for i in 0..value_n.child_count() {
        let Some(child) = value_n.child(i) else {
            continue;
        };
        if child.kind() == "shorthand_property_identifier" {
            let prop = node_text(&child, source);
            symbols.object_prop_bindings.push(ObjectPropBinding {
                object_name: object_name.to_string(),
                prop_name: prop.to_string(),
                value_name: prop.to_string(),
            });
        } else if child.kind() == "pair" {
            if let (Some(key_n), Some(val_n)) = (
                child.child_by_field_name("key"),
                child.child_by_field_name("value"),
            ) {
                let val_text = node_text(&val_n, source);
                if key_n.kind() == "property_identifier"
                    && val_n.kind() == "identifier"
                    && !JS_BUILTIN_GLOBALS.contains(&val_text)
                {
                    symbols.object_prop_bindings.push(ObjectPropBinding {
                        object_name: object_name.to_string(),
                        prop_name: node_text(&key_n, source).to_string(),
                        value_name: val_text.to_string(),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_js(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        JsExtractor.extract(&tree, code.as_bytes(), "test.js")
    }

    fn parse_ts(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        JsExtractor.extract(&tree, code.as_bytes(), "test.ts")
    }

    #[test]
    fn finds_function_declaration() {
        let s = parse_js("function greet(name) { return name; }");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "greet");
        assert_eq!(s.definitions[0].kind, "function");
    }

    #[test]
    fn finds_arrow_function() {
        let s = parse_js("const add = (a, b) => a + b;");
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "add");
        assert_eq!(s.definitions[0].kind, "function");
    }

    /// Issue #2265: a multi-declarator `const a = fn1, b = fn2;` statement
    /// previously gave every declarator the SAME `line` (the whole
    /// statement's start, not each function value's own start) — misleading
    /// for anything keyed on line, including the JS-side complexity/CFG
    /// matcher this mirrors (`matchResultToDef` in apply-results.ts).
    #[test]
    fn multi_declarator_var_fn_assignment_uses_each_functions_own_line() {
        let s = parse_js(
            "const a = (x) => {\n  if (x) { return 1; }\n  return 0;\n}, b = (x) => {\n  return 2;\n};\n",
        );
        let a = s.definitions.iter().find(|d| d.name == "a").unwrap();
        let b = s.definitions.iter().find(|d| d.name == "b").unwrap();
        assert_eq!(a.line, 1);
        assert_eq!(b.line, 4);
        assert_ne!(a.line, b.line);
    }

    #[test]
    fn finds_class_with_methods() {
        let s = parse_js("class Foo { bar() {} baz() {} }");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
        assert!(names.contains(&"Foo.baz"));
        // Real class methods have a body — a dotted name alone must never be
        // treated as a signature-only stub (#1922).
        let bar = s.definitions.iter().find(|d| d.name == "Foo.bar").unwrap();
        assert_ne!(bar.bodyless, Some(true));
    }

    /// Regression test for #1922: an interface's `method_signature` structurally
    /// has no body field and must be marked `bodyless`, even when the signature
    /// spans multiple lines (the exact shape #606's original dot-check targeted).
    /// A real, dotted class method implementing the same interface must NOT be
    /// affected by the interface's own stub — it keeps a real body and complexity.
    #[test]
    fn interface_method_signature_is_bodyless_but_implementing_class_method_is_not() {
        let s = parse_ts(
            "interface Repo {\n\
               save(\n\
                 id: string,\n\
                 value: number,\n\
               ): boolean;\n\
             }\n\
             class InMemoryRepo implements Repo {\n\
               save(id: string, value: number): boolean {\n\
                 if (value < 0) { return false; }\n\
                 return true;\n\
               }\n\
             }\n",
        );
        let iface_save = s
            .definitions
            .iter()
            .find(|d| d.name == "Repo.save")
            .unwrap();
        assert_eq!(iface_save.bodyless, Some(true));

        let class_save = s
            .definitions
            .iter()
            .find(|d| d.name == "InMemoryRepo.save")
            .unwrap();
        assert_ne!(class_save.bodyless, Some(true));
    }

    #[test]
    fn finds_imports() {
        let s = parse_js("import { readFile } from 'fs';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].source, "fs");
        assert_eq!(s.imports[0].names, vec!["readFile"]);
    }

    /// Regression test for #1730: `import { X as Y }` must record the *local*
    /// binding (Y) in `names` — that's what call sites reference — plus the
    /// `{ local: Y, imported: X }` pair in `renamed_imports` so call-edge
    /// resolution can recover the original exported name X.
    #[test]
    fn renamed_import_records_local_name_and_rename_pair() {
        let s = parse_js("import { collectFiles as collectFilesUtil } from './helpers';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].names, vec!["collectFilesUtil"]);
        let renamed = s.imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for a renamed specifier");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "collectFilesUtil");
        assert_eq!(renamed[0].imported, "collectFiles");
    }

    #[test]
    fn non_renamed_import_has_no_renamed_imports() {
        let s = parse_js("import { readFile } from 'fs';");
        assert!(s.imports[0].renamed_imports.is_none());
    }

    #[test]
    fn finds_calls() {
        let s = parse_js("function f() { console.log('hi'); foo(); }");
        let call_names: Vec<&str> = s.calls.iter().map(|c| c.name.as_str()).collect();
        assert!(call_names.contains(&"log"));
        assert!(call_names.contains(&"foo"));
    }

    #[test]
    fn finds_exports() {
        let s = parse_js("export function hello() {} export class World {}");
        assert_eq!(s.exports.len(), 2);
        assert_eq!(s.exports[0].name, "hello");
        assert_eq!(s.exports[1].name, "World");
    }

    #[test]
    fn finds_class_heritage() {
        let s = parse_js("class Dog extends Animal {}");
        assert_eq!(s.classes.len(), 1);
        assert_eq!(s.classes[0].name, "Dog");
        assert_eq!(s.classes[0].extends, Some("Animal".to_string()));
    }

    #[test]
    fn finds_reexports() {
        let s = parse_js("export { foo, bar } from './utils';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].reexport, Some(true));
        assert_eq!(s.imports[0].source, "./utils");
    }

    #[test]
    fn finds_wildcard_reexport() {
        let s = parse_js("export * from './helpers';");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].wildcard_reexport, Some(true));
    }

    #[test]
    fn extracts_commander_action_callback() {
        let s = parse_js("program.command('build [dir]').action(async (dir, opts) => { run(); });");
        let def = s.definitions.iter().find(|d| d.name == "command:build");
        assert!(def.is_some(), "should extract command:build definition");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_commander_query_command() {
        let s = parse_js("program.command('query <name>').action(() => { search(); });");
        let def = s.definitions.iter().find(|d| d.name == "command:query");
        assert!(def.is_some(), "should extract command:query definition");
    }

    #[test]
    fn skips_commander_named_handler() {
        let s = parse_js("program.command('test').action(handleTest);");
        let defs: Vec<_> = s
            .definitions
            .iter()
            .filter(|d| d.name.starts_with("command:"))
            .collect();
        assert!(
            defs.is_empty(),
            "should not extract when handler is a named reference"
        );
    }

    #[test]
    fn extracts_express_get_route() {
        let s = parse_js("app.get('/api/users', (req, res) => { res.json([]); });");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "route:GET /api/users");
        assert!(def.is_some(), "should extract route:GET /api/users");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_express_post_route() {
        let s = parse_js("router.post('/api/items', async (req, res) => { save(); });");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "route:POST /api/items");
        assert!(def.is_some(), "should extract route:POST /api/items");
    }

    #[test]
    fn skips_map_get_false_positive() {
        let s = parse_js("myMap.get('someKey');");
        let defs: Vec<_> = s
            .definitions
            .iter()
            .filter(|d| d.name.starts_with("route:"))
            .collect();
        assert!(defs.is_empty(), "should not extract Map.get as a route");
    }

    #[test]
    fn extracts_event_on_callback() {
        let s = parse_js("emitter.on('data', (chunk) => { process(chunk); });");
        let def = s.definitions.iter().find(|d| d.name == "event:data");
        assert!(def.is_some(), "should extract event:data");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_event_once_callback() {
        let s = parse_js("server.once('listening', () => { log(); });");
        let def = s.definitions.iter().find(|d| d.name == "event:listening");
        assert!(def.is_some(), "should extract event:listening");
    }

    #[test]
    fn skips_event_named_handler() {
        let s = parse_js("emitter.on('data', handleData);");
        let defs: Vec<_> = s
            .definitions
            .iter()
            .filter(|d| d.name.starts_with("event:"))
            .collect();
        assert!(
            defs.is_empty(),
            "should not extract when handler is a named reference"
        );
    }

    // ── Extended kinds tests ────────────────────────────────────────────────

    #[test]
    fn extracts_function_parameters() {
        let s = parse_js("function greet(name, age) { }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        let children = greet.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "name");
        assert_eq!(children[0].kind, "parameter");
        assert_eq!(children[1].name, "age");
    }

    #[test]
    fn extracts_arrow_function_parameters() {
        let s = parse_js("const add = (a, b) => a + b;");
        let add = s.definitions.iter().find(|d| d.name == "add").unwrap();
        let children = add.children.as_ref().unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0].name, "a");
        assert_eq!(children[1].name, "b");
    }

    #[test]
    fn extracts_class_properties() {
        let s = parse_js("class User { name; age; greet() {} }");
        let user = s.definitions.iter().find(|d| d.name == "User").unwrap();
        let children = user.children.as_ref().unwrap();
        let prop_names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();
        assert!(prop_names.contains(&"name"));
        assert!(prop_names.contains(&"age"));
        assert!(children.iter().all(|c| c.kind == "property"));
    }

    #[test]
    fn extracts_const_literal_as_constant() {
        let s = parse_js("const MAX = 100;");
        let max = s.definitions.iter().find(|d| d.name == "MAX").unwrap();
        assert_eq!(max.kind, "constant");
    }

    #[test]
    fn skips_const_function_as_constant() {
        let s = parse_js("const fn = () => {};");
        let f = s.definitions.iter().find(|d| d.name == "fn").unwrap();
        assert_eq!(f.kind, "function");
    }

    #[test]
    fn skips_local_const_inside_function() {
        let s = parse_js("function main() { const x = 42; const y = new Foo(); }");
        // Only `main` should be extracted — local constants are not top-level symbols
        assert_eq!(s.definitions.len(), 1);
        assert_eq!(s.definitions[0].name, "main");
    }

    // ── #1819: top-level const with a non-"literal-shaped" initializer ────────

    #[test]
    fn extracts_const_with_member_expression_initializer_as_constant() {
        // Repro from #1819: a parenthesized member-expression initializer
        // (`(...).version`) was not one of the recognized "literal" shapes, so
        // the whole declaration was silently dropped — not just unexported,
        // absent from `definitions` entirely.
        let s = parse_js(
            "const CODEGRAPH_VERSION = (JSON.parse(readFileSync(pkgPath, 'utf-8'))).version;",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "CODEGRAPH_VERSION")
            .unwrap_or_else(|| panic!("CODEGRAPH_VERSION should be extracted as a definition"));
        assert_eq!(def.kind, "constant");
    }

    #[test]
    fn extracts_const_with_call_expression_initializer_as_constant() {
        let s = parse_js("const config = loadConfig();");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "config")
            .unwrap_or_else(|| panic!("config should be extracted as a definition"));
        assert_eq!(def.kind, "constant");
    }

    #[test]
    fn exports_const_with_call_expression_initializer() {
        let s = parse_js("export const config = loadConfig();");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "config" && e.kind == "constant"),
            "config should be listed as an exported constant; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn extracts_const_array_pattern_with_call_expression_initializer() {
        // Parity with the identifier case above: array-pattern names must also
        // be discoverable regardless of initializer complexity — one
        // definition per bound identifier (#1901), not a single node named
        // by the raw pattern text.
        let s = parse_js("const [a, b] = computePair();");
        for name in ["a", "b"] {
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == name)
                .unwrap_or_else(|| panic!("{name} should be extracted as a definition"));
            assert_eq!(def.kind, "constant");
        }
        assert!(!s.definitions.iter().any(|d| d.name == "[a, b]"));
    }

    #[test]
    fn extracts_array_pattern_default_and_rest_bindings_as_own_definitions() {
        // #1901: array-pattern default-value and rest bindings each become
        // their own "constant" Definition, matching the plain-identifier case.
        let s = parse_js("const [a = 1, ...rest] = computeList();");
        for name in ["a", "rest"] {
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == name)
                .unwrap_or_else(|| panic!("{name} should be extracted as a definition"));
            assert_eq!(def.kind, "constant");
        }
    }

    #[test]
    fn extracts_nested_array_pattern_rest_bindings_as_own_definitions() {
        // Greptile review (#2038): a rest element that itself nests another
        // array pattern (`...[a, b]`) must recurse into it rather than
        // silently skipping — `rest_pattern`/`rest_element` has no "name"
        // field in the grammar, so the previous single-identifier check
        // dropped the nested bindings entirely.
        let s = parse_js("const [x, ...[a, b]] = computeList();");
        for name in ["x", "a", "b"] {
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == name)
                .unwrap_or_else(|| panic!("{name} should be extracted as a definition"));
            assert_eq!(def.kind, "constant");
        }
        assert!(!s.definitions.iter().any(|d| d.name.starts_with('[')));
    }

    #[test]
    fn const_alias_gets_both_definition_and_fn_ref_binding() {
        // The new "constant" Definition for an identifier-aliased const must not
        // come at the expense of the existing pts fn_ref_binding tracking — the
        // two concerns are independent (mirrors the WASM/TS extractor's
        // decoupled fnRefBindings pass).
        let s = parse_js("const alias = handler;");
        assert!(
            s.definitions
                .iter()
                .any(|d| d.name == "alias" && d.kind == "constant"),
            "alias should be extracted as a constant definition; got: {:?}",
            s.definitions
        );
        assert!(
            s.fn_ref_bindings
                .iter()
                .any(|b| b.lhs == "alias" && b.rhs == "handler"),
            "alias -> handler fn_ref_binding should still be recorded; got: {:?}",
            s.fn_ref_bindings
        );
    }

    // ── AST node extraction tests ────────────────────────────────────────────

    #[test]
    fn ast_extracts_new_expression() {
        let s = parse_js("function f() { const m = new Map(); const s = new Set(); }");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        assert_eq!(new_nodes.len(), 2);
        let names: Vec<&str> = new_nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"Map"));
        assert!(names.contains(&"Set"));
    }

    #[test]
    fn ast_extracts_new_member_expression() {
        let s = parse_js("const e = new errors.NotFoundError();");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        assert_eq!(new_nodes.len(), 1);
        assert_eq!(new_nodes[0].name, "errors.NotFoundError");
    }

    #[test]
    fn ast_extracts_throw_statement() {
        let s = parse_js("function f() { throw new Error('bad'); }");
        let throw_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "throw").collect();
        assert_eq!(throw_nodes.len(), 1);
        assert_eq!(throw_nodes[0].name, "Error");
    }

    #[test]
    fn ast_throw_no_double_count_new() {
        // `throw new Error(...)` should produce one throw node, NOT also a new node
        let s = parse_js("function f() { throw new Error('fail'); }");
        let new_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "new").collect();
        let throw_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "throw").collect();
        assert_eq!(throw_nodes.len(), 1);
        assert_eq!(
            new_nodes.len(),
            0,
            "throw new Error should not also emit a new node"
        );
    }

    #[test]
    fn ast_extracts_await_expression() {
        let s = parse_js("async function f() { const d = await fetch('/api'); }");
        let await_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "await").collect();
        assert_eq!(await_nodes.len(), 1);
        assert_eq!(await_nodes[0].name, "fetch");
    }

    #[test]
    fn ast_extracts_await_member_expression() {
        let s = parse_js("async function f() { await this.load(); }");
        let await_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "await").collect();
        assert_eq!(await_nodes.len(), 1);
        assert_eq!(await_nodes[0].name, "this.load");
    }

    #[test]
    fn ast_extracts_string_literals() {
        let s = parse_js("const x = 'hello world'; const y = \"foo bar\";");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        assert_eq!(str_nodes.len(), 2);
        let names: Vec<&str> = str_nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"hello world"));
        assert!(names.contains(&"foo bar"));
    }

    #[test]
    fn ast_skips_trivial_strings() {
        // Single char or empty strings should be skipped
        let s = parse_js("const a = ''; const b = 'x'; const c = 'ok';");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        // Only "ok" has content length >= 2
        assert_eq!(str_nodes.len(), 1);
        assert_eq!(str_nodes[0].name, "ok");
    }

    #[test]
    fn ast_extracts_regex() {
        let s = parse_js("const re = /^[a-z]+$/i;");
        let regex_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "regex").collect();
        assert_eq!(regex_nodes.len(), 1);
        assert!(regex_nodes[0].name.contains("[a-z]"));
    }

    #[test]
    fn ast_extracts_template_string() {
        let s = parse_js("const msg = `hello template`;");
        let str_nodes: Vec<_> = s.ast_nodes.iter().filter(|n| n.kind == "string").collect();
        assert_eq!(str_nodes.len(), 1);
        assert!(str_nodes[0].name.contains("hello template"));
    }

    #[test]
    fn finds_dynamic_import() {
        let s = parse_js("const mod = import('./foo.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./foo.js");
    }

    #[test]
    fn finds_dynamic_import_with_destructuring() {
        let s = parse_js("const { a, b } = await import('./bar.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./bar.js");
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_aliased_destructuring() {
        // #1824: the local binding actually referenced by call sites
        // (`fromBarrel`) must be recorded in `names`, not the name exported by
        // the target module (`buildGraph`) — mirrors the static
        // `import { X as Y }` fix from #1730. `renamed_imports` carries the
        // local → original mapping so call-edge resolution can still find
        // `buildGraph` in the target file.
        let s = parse_js("const { buildGraph: fromBarrel } = await import('./builder.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./builder.js");
        assert!(dyn_imports[0].names.contains(&"fromBarrel".to_string()));
        assert!(!dyn_imports[0].names.contains(&"buildGraph".to_string()));
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for a renamed destructure");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "fromBarrel");
        assert_eq!(renamed[0].imported, "buildGraph");
    }

    #[test]
    fn strips_quotes_from_string_literal_destructuring_key() {
        // { 'foo-bar': local } — the key's raw text includes quotes; using it
        // verbatim as `imported` would make the resolver look for an export
        // literally named `'foo-bar'`, which never matches (Greptile follow-up).
        let s = parse_js("const { 'foo-bar': local } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].names, vec!["local".to_string()]);
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "local");
        assert_eq!(renamed[0].imported, "foo-bar");
    }

    #[test]
    fn unwraps_computed_string_literal_destructuring_key() {
        let s = parse_js("const { ['foo-bar']: local } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].names, vec!["local".to_string()]);
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "local");
        assert_eq!(renamed[0].imported, "foo-bar");
    }

    #[test]
    fn tracks_local_binding_for_non_string_computed_key_without_rename_pair() {
        // `[Symbol()]` has no statically resolvable export name — the local
        // binding must still be tracked, just without a renamed_imports entry.
        let s = parse_js("const { [Symbol()]: local } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].names, vec!["local".to_string()]);
        assert!(dyn_imports[0].renamed_imports.is_none());
    }

    #[test]
    fn finds_dynamic_import_with_mixed_destructuring() {
        let s = parse_js("const { a, buildGraph: fromBarrel, c } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./mod.js");
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"fromBarrel".to_string()));
        assert!(dyn_imports[0].names.contains(&"c".to_string()));
        assert!(!dyn_imports[0].names.contains(&"buildGraph".to_string()));
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for a renamed destructure");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "fromBarrel");
        assert_eq!(renamed[0].imported, "buildGraph");
    }

    #[test]
    fn finds_dynamic_import_with_aliased_default_destructuring() {
        let s = parse_js("const { buildGraph: local = null } = await import('./builder.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"local".to_string()));
        assert!(!dyn_imports[0].names.contains(&"buildGraph".to_string()));
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for a renamed destructure");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "local");
        assert_eq!(renamed[0].imported, "buildGraph");
    }

    #[test]
    fn finds_dynamic_import_with_nested_object_destructuring() {
        let s = parse_js("const { foo: { nested } } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"foo".to_string()));
        assert!(!dyn_imports[0].names.contains(&"nested".to_string()));
    }

    // Regression tests for #1781: `codegraph exports` failed to credit consumers
    // reached via `const { X } = (await import('./mod.js')) as {...}` — the
    // walk-up from the import() call to its enclosing variable_declarator only
    // skipped a single optional await_expression, so the extra
    // parenthesized_expression / as_expression layers introduced by wrapping
    // parens and a TS type-assertion caused name extraction to bail out with
    // an empty list, exactly as if the destructured names couldn't be
    // determined at all.

    #[test]
    fn finds_dynamic_import_with_parenthesized_destructuring() {
        let s = parse_ts("const { a, b } = (await import('./foo.js'));");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_as_cast_destructuring() {
        let s = parse_ts("const { a, b } = await import('./foo.js') as { a: Fn; b: Fn };");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_satisfies_cast_destructuring() {
        // TS 4.9+ `satisfies` is structurally identical to `as` here (Greptile
        // follow-up to #1781) — same walk-up gap would otherwise reproduce.
        let s = parse_ts("const { a, b } = await import('./foo.js') satisfies { a: Fn; b: Fn };");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_parenthesized_as_cast_destructuring() {
        // Exact repro shape from #1781 (native-orchestrator.ts):
        // `const { X, Y } = (await import('../mod.js')) as { X: Fn; Y: Fn };`
        let s = parse_ts(
            "const { buildDataflowVerticesFromMap, buildDataflowEdges } = (await import('../../../../features/dataflow.js')) as { buildDataflowVerticesFromMap: Fn; buildDataflowEdges: Fn };",
        );
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "../../../../features/dataflow.js");
        assert!(dyn_imports[0]
            .names
            .contains(&"buildDataflowVerticesFromMap".to_string()));
        assert!(dyn_imports[0]
            .names
            .contains(&"buildDataflowEdges".to_string()));
    }

    // Regression tests for #1920: `extract_rest_identifier` indexed into a
    // fixed child slot (0) that is actually the `...` token, not the bound
    // identifier, so rest elements in both object- and array-pattern
    // destructures of a dynamic `import()` were silently dropped.

    #[test]
    fn finds_dynamic_import_with_object_rest_destructuring() {
        let s = parse_js("const { a, ...rest } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(
            dyn_imports[0].names,
            vec!["a".to_string(), "rest".to_string()]
        );
    }

    /// Regression test for #2037: the native `require()` destructuring path
    /// reuses `collect_object_pattern_names` (already fixed for #1920), so a
    /// rest binding must come through correctly here — this locks in parity
    /// with the WASM/TS `extractCjsRequireBinding` fix for the same issue.
    #[test]
    fn finds_cjs_require_with_object_rest_destructuring() {
        let s = parse_js("const { a, ...rest } = require('./mod');");
        let cjs_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.cjs_require == Some(true))
            .collect();
        assert_eq!(cjs_imports.len(), 1);
        assert_eq!(cjs_imports[0].source, "./mod");
        assert_eq!(
            cjs_imports[0].names,
            vec!["a".to_string(), "rest".to_string()]
        );
    }

    /// Issue #2268: only the object-pattern require() destructure was ever
    /// recorded as a CJS-require import artifact — `const [a, b] =
    /// require('./mod')` was silently dropped by both engines.
    #[test]
    fn finds_cjs_require_with_array_pattern_destructuring() {
        let s = parse_js("const [a, b] = require('./mod');");
        let cjs_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.cjs_require == Some(true))
            .collect();
        assert_eq!(cjs_imports.len(), 1);
        assert_eq!(cjs_imports[0].source, "./mod");
        assert_eq!(cjs_imports[0].names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn finds_cjs_require_with_array_pattern_rest_destructuring() {
        let s = parse_js("const [a, ...rest] = require('./mod');");
        let cjs_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.cjs_require == Some(true))
            .collect();
        assert_eq!(cjs_imports.len(), 1);
        assert_eq!(cjs_imports[0].source, "./mod");
        assert_eq!(
            cjs_imports[0].names,
            vec!["a".to_string(), "rest".to_string()]
        );
    }

    #[test]
    fn finds_dynamic_import_with_shorthand_default_destructuring() {
        let s = parse_js("const { a = 1 } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].names, vec!["a".to_string()]);
    }

    #[test]
    fn finds_dynamic_import_with_mixed_plain_renamed_default_and_rest_destructuring() {
        let s = parse_js("const { a, b: alias, c = 1, ...rest } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(
            dyn_imports[0].names,
            vec![
                "a".to_string(),
                "alias".to_string(),
                "c".to_string(),
                "rest".to_string()
            ]
        );
        let renamed = dyn_imports[0]
            .renamed_imports
            .as_ref()
            .expect("renamed_imports should be populated for the renamed specifier");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].local, "alias");
        assert_eq!(renamed[0].imported, "b");
    }

    #[test]
    fn finds_dynamic_import_with_array_rest_destructuring() {
        let s = parse_js("const [a, ...rest] = await import('./mod.js');");
        let dyn_imports: Vec<_> = s
            .imports
            .iter()
            .filter(|i| i.dynamic_import == Some(true))
            .collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(
            dyn_imports[0].names,
            vec!["a".to_string(), "rest".to_string()]
        );
    }

    #[test]
    fn extracts_callback_reference_in_router_use() {
        let s = parse_js("router.use(handleToken);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(
            dynamic_calls.iter().any(|c| c.name == "handleToken"),
            "should extract handleToken as dynamic call"
        );
    }

    #[test]
    fn extracts_multiple_callback_references() {
        let s = parse_js("app.get('/api', authenticate, validate, handler);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(dynamic_calls.iter().any(|c| c.name == "authenticate"));
        assert!(dynamic_calls.iter().any(|c| c.name == "validate"));
        assert!(dynamic_calls.iter().any(|c| c.name == "handler"));
    }

    #[test]
    fn extracts_member_expression_callback() {
        let s = parse_js("app.use(auth.validate);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        let cb = dynamic_calls.iter().find(|c| c.name == "validate");
        assert!(cb.is_some(), "should extract validate as dynamic call");
        assert_eq!(cb.unwrap().receiver.as_deref(), Some("auth"));
    }

    #[test]
    fn extracts_callback_in_array_method() {
        let s = parse_js("items.map(transform);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(dynamic_calls.iter().any(|c| c.name == "transform"));
    }

    #[test]
    fn extracts_callback_in_settimeout() {
        let s = parse_js("setTimeout(tick, 1000);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(dynamic_calls.iter().any(|c| c.name == "tick"));
    }

    #[test]
    fn no_dynamic_calls_for_non_identifiers() {
        let s = parse_js("app.get('/path', {key: 1}, [], 42);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(dynamic_calls.is_empty());
    }

    // ── #1778: .call/.apply/.bind reflection tagging (parity pin) ───────────
    //
    // Pins the native extractor's classification of `.call/.apply/.bind` on both
    // identifier and member-expression receivers as dynamic/reflection. This is
    // the Option-A semantic from #1778: the WASM extractor previously stripped
    // this tag for identifier receivers only, diverging from native. These tests
    // guard against either engine's classification drifting again — the
    // dedup-collision case that originally motivated the WASM regression (#1687)
    // is a downstream build-edges.ts concern, not an extraction concern, so it is
    // deliberately NOT re-tested here (see the JS-side pins in
    // tests/integration for that).

    #[test]
    fn call_on_identifier_receiver_tags_reflection() {
        let s = parse_js("function test(ctx) { greet.call(ctx, 'world'); }");
        let c = s.calls.iter().find(|c| c.name == "greet").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn apply_on_identifier_receiver_tags_reflection() {
        let s = parse_js("function test(ctx) { greet.apply(ctx, ['world']); }");
        let c = s.calls.iter().find(|c| c.name == "greet").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn bind_on_identifier_receiver_tags_reflection() {
        let s = parse_js("var bound = greet.bind(ctx);");
        let c = s.calls.iter().find(|c| c.name == "greet").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn call_on_member_expression_receiver_tags_reflection() {
        let s = parse_js("obj.method.call({});");
        let c = s.calls.iter().find(|c| c.name == "method").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    // ── #2321: .call/.apply/.bind on an inline function literal ──────────────
    //
    // Before the fix, an inline function_expression/arrow_function/
    // generator_function object fell through to the generic tail of
    // extract_call_info, which set `receiver` to the ENTIRE function body's
    // source text via extract_receiver_name's raw-text fallback.

    #[test]
    fn bind_on_unwrapped_function_expression_has_no_receiver() {
        let s = parse_js(
            "class Session {
                isReady() { return true; }
                checkBound() {
                    setTimeout(function () {
                        return this.isReady();
                    }.bind(this), 100);
                }
            }",
        );
        let c = s.calls.iter().find(|c| c.name == "bind").unwrap();
        assert_eq!(c.receiver, None);
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn call_on_parenthesized_arrow_function_has_no_receiver() {
        let s = parse_js("(() => { doWork(); }).call(ctx);");
        let c = s.calls.iter().find(|c| c.name == "call").unwrap();
        assert_eq!(c.receiver, None);
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn apply_on_parenthesized_generator_function_has_no_receiver() {
        let s = parse_js("(function* () { yield 1; }).apply(ctx, args);");
        let c = s.calls.iter().find(|c| c.name == "apply").unwrap();
        assert_eq!(c.receiver, None);
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    // ── #1817: get_first_call_arg consumers (eval/Reflect.apply/Reflect.construct) ──
    //
    // Exercises the three call sites that resolve their first call argument via
    // `get_first_call_arg`, which used to take an unused `source` parameter.

    #[test]
    fn eval_captures_string_literal_key_expr() {
        let s = parse_js("function test() { eval(\"console.log('hi')\"); }");
        let c = s.calls.iter().find(|c| c.name == "<dynamic:eval>").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("eval"));
        assert!(c.key_expr.as_deref().unwrap().contains("console.log"));
    }

    #[test]
    fn eval_with_non_literal_arg_has_no_key_expr() {
        let s = parse_js("function test(code) { eval(code); }");
        let c = s.calls.iter().find(|c| c.name == "<dynamic:eval>").unwrap();
        assert_eq!(c.dynamic_kind.as_deref(), Some("eval"));
        assert!(c.key_expr.is_none());
    }

    #[test]
    fn reflect_apply_extracts_first_arg_as_callee() {
        let s = parse_js("function test(fn, ctx) { Reflect.apply(fn, ctx, []); }");
        let c = s.calls.iter().find(|c| c.name == "fn").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn reflect_construct_extracts_first_arg_as_callee() {
        let s = parse_js("function test(Cls) { Reflect.construct(Cls, []); }");
        let c = s.calls.iter().find(|c| c.name == "Cls").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
    }

    #[test]
    fn reflect_apply_member_expression_arg_extracts_property_with_receiver() {
        let s = parse_js("function test(obj, ctx) { Reflect.apply(obj.method, ctx, []); }");
        let c = s.calls.iter().find(|c| c.name == "method").unwrap();
        assert_eq!(c.dynamic, Some(true));
        assert_eq!(c.dynamic_kind.as_deref(), Some("reflection"));
        assert_eq!(c.receiver.as_deref(), Some("obj"));
    }

    // ── #1771: object-literal value-ref extraction ──────────────────────────

    #[test]
    fn extracts_value_ref_call_for_object_literal_property() {
        let s = parse_js("const table = { resolve: resolveWrapperParam };");
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "resolveWrapperParam"));
        assert!(value_refs.iter().all(|c| c.dynamic == Some(true)));
    }

    #[test]
    fn extracts_value_ref_calls_for_every_handler_in_dispatch_table_array() {
        // Mirrors this repo's own PARAM_NODE_HANDLERS pattern (issue #1771).
        let s = parse_js(
            "const HANDLERS = [\n\
               { matches: isA, resolve: resolveA },\n\
               { matches: isB, resolve: resolveB },\n\
             ];",
        );
        let names: Vec<&str> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .map(|c| c.name.as_str())
            .collect();
        for expected in ["isA", "resolveA", "isB", "resolveB"] {
            assert!(
                names.contains(&expected),
                "missing value-ref call for {}",
                expected
            );
        }
    }

    #[test]
    fn extracts_value_ref_call_for_shorthand_property() {
        let s = parse_js("const table = { someFunction };");
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "someFunction"));
    }

    // ── #2389: JSX element value-ref extraction ──────────────────────────────

    #[test]
    fn extracts_value_ref_call_for_self_closing_jsx_component() {
        let s = parse_js("function App() { return <Header title=\"x\" />; }");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "Header" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    #[test]
    fn extracts_value_ref_call_for_jsx_component_with_children() {
        let s = parse_js("function App() { return <Wrapper><span /></Wrapper>; }");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "Wrapper" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    #[test]
    fn does_not_extract_value_ref_call_for_lowercase_intrinsic_jsx_tag() {
        let s = parse_js("function App() { return <div className=\"x\"><span /></div>; }");
        assert!(!s
            .calls
            .iter()
            .any(|c| c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    #[test]
    fn credits_base_identifier_for_namespaced_jsx_component() {
        let s = parse_js("function App() { return <NS.Header />; }");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "NS" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    // ── #2389: call-argument identifier value-ref extraction ────────────────

    #[test]
    fn extracts_value_ref_call_for_capitalized_call_argument() {
        let s = parse_js("Factory.create(AppModule);");
        assert!(s
            .calls
            .iter()
            .any(|c| c.name == "AppModule" && c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    #[test]
    fn does_not_extract_value_ref_call_for_lowercase_data_argument_regression_1741() {
        // Regression guard mirroring #1741: a lowercase DATA argument must
        // never be credited as any kind of reference, or the global-fallback
        // resolver can bind it to an unrelated same-named function elsewhere
        // in the repo, fabricating a call edge and a phantom cycle.
        let s = parse_js("analyzeDrift(communities, communityDirs);");
        assert!(!s.calls.iter().any(|c| c.dynamic == Some(true)));
    }

    #[test]
    fn does_not_extract_value_ref_call_for_builtin_global_argument() {
        let s = parse_js("register(console);");
        assert!(!s
            .calls
            .iter()
            .any(|c| c.dynamic_kind.as_deref() == Some("value-ref")));
    }

    // ── #2257: logical-or/nullish-coalescing/ternary value-ref extraction ───

    #[test]
    fn extracts_value_ref_call_for_logical_or_fallback_when_variable_used_again() {
        let s = parse_js("const fetchFn = options.custom || fetchLatestVersion;\ncall(fetchFn);");
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "fetchLatestVersion"));
    }

    #[test]
    fn does_not_extract_value_ref_call_when_variable_never_used_again() {
        let s = parse_js(
            "const fetchFn = options.custom || fetchLatestVersion;\nconsole.log('unrelated');",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    #[test]
    fn extracts_value_ref_calls_for_both_ternary_branches_when_variable_used_again() {
        let s = parse_js("const picked = cond ? left : right;\ncall(picked);");
        let names: Vec<&str> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .map(|c| c.name.as_str())
            .collect();
        assert!(names.contains(&"left"));
        assert!(names.contains(&"right"));
    }

    #[test]
    fn extracts_value_ref_call_for_nullish_coalescing_fallback() {
        let s = parse_js("const fetchFn = options.custom ?? fetchLatestVersion;\ncall(fetchFn);");
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    #[test]
    fn does_not_credit_liveness_from_a_shadowed_binding_in_a_nested_scope() {
        let s = parse_js(
            "function outer() {\n\
               const fetchFn = options.custom || fetchLatestVersion;\n\
               function helper() {\n\
                 let fetchFn = somethingElse();\n\
                 return fetchFn();\n\
               }\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    #[test]
    fn extracts_value_ref_call_when_variable_used_in_same_statement_sibling_declarator() {
        let s =
            parse_js("const fetchFn = options.custom || fetchLatestVersion, result = fetchFn();");
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    #[test]
    fn extracts_value_ref_call_when_variable_used_inside_a_nested_non_shadowing_block() {
        let s = parse_js(
            "function outer() {\n\
               const fetchFn = options.custom || fetchLatestVersion;\n\
               try {\n\
                 call(fetchFn);\n\
               } catch (e) {}\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: the liveness scan's recursive walk must be
    // depth-bounded (MAX_WALK_DEPTH), matching every other recursive walk in
    // this file, so a pathologically deep enclosing block (e.g. deeply
    // nested generated JS) can't overflow the stack.
    #[test]
    fn does_not_overflow_the_stack_on_a_pathologically_deep_enclosing_block() {
        let depth = 300;
        let nested = format!(
            "{}call(fetchFn);\n{}",
            "if (true) {\n".repeat(depth),
            "}\n".repeat(depth)
        );
        let source = format!("const fetchFn = options.custom || fetchLatestVersion;\n{nested}");
        let _ = parse_js(&source);
    }

    // Greptile review, PR #2432: a default-value expression referencing the
    // outer fallback variable is a REFERENCE (a real use), not a shadowing
    // parameter binding — must not be pruned from the liveness scan.
    #[test]
    fn does_not_treat_a_parameter_default_reference_as_a_shadowing_binding() {
        let s = parse_js(
            "function outer() {\n\
               const fetchFn = options.custom || fetchLatestVersion;\n\
               function helper(x = fetchFn) {\n\
                 return x();\n\
               }\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: a legal `var` sibling rebinding the SAME
    // name in the same statement (`var fn = a, fn = b;`) is a binding, not a
    // read — must not fabricate liveness for the first declarator's fallback.
    #[test]
    fn does_not_credit_liveness_from_a_var_sibling_rebinding_the_same_name() {
        let s = parse_js("var fn = options.custom || fetchLatestVersion, fn = replacement;");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: a block-local function declaration also
    // introduces its own binding — a call to it inside that block must not
    // be mistaken for a use of the outer fallback variable sharing its name.
    #[test]
    fn does_not_credit_liveness_from_a_block_local_function_declaration_sharing_the_name() {
        let s = parse_js(
            "const fn = options.custom || fetchLatestVersion;\n\
             {\n\
               function fn() {}\n\
               fn();\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: a plain `=` reassignment overwrites the
    // variable without ever consuming its current value — must not
    // fabricate liveness for the fallback that was assigned to it.
    #[test]
    fn does_not_credit_liveness_from_a_write_only_reassignment() {
        let s = parse_js("let fn = options.custom || fetchLatestVersion;\nfn = replacement;");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Issue #2438 (deferred from PR #2432's review): a write correctly does
    // not count as a read of ITS OWN statement, but a plain reassignment
    // must also KILL the value for every LATER statement — a read after the
    // fallback has already been overwritten sees the new value, never the
    // fallback.
    #[test]
    fn does_not_credit_liveness_from_a_read_after_an_unconditional_reassignment_killed_it() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             fn = replacement;\n\
             fn();",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Same kill semantics via a `var` redeclaration in a separate later
    // statement, rather than a plain assignment expression.
    #[test]
    fn does_not_credit_liveness_from_a_read_after_a_var_redeclaration_in_a_later_statement() {
        let s = parse_js(
            "var fn = options.custom || fetchLatestVersion;\n\
             var fn = replacement;\n\
             fn();",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Issue #2438: a write nested inside a conditional is NOT a guaranteed
    // kill — the branch might not run, so the fallback can still reach the
    // later read.
    #[test]
    fn still_credits_liveness_from_a_read_after_a_write_nested_inside_a_conditional() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             if (cond) {\n\
               fn = replacement;\n\
             }\n\
             fn();",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Issue #2438: the killing statement's OWN right-hand side is scanned
    // for a genuine read BEFORE the kill takes effect — `fn` on the right of
    // its own reassignment still reads the pre-existing (possibly fallback)
    // value.
    #[test]
    fn still_credits_a_genuine_read_on_the_right_hand_side_of_the_killing_statement_itself() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             fn = fn || somethingElse;",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2554: a kill wrapped in parentheses is exactly as
    // unconditional as a bare assignment statement.
    #[test]
    fn does_not_credit_liveness_from_a_read_after_a_parenthesized_kill_assignment() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             (fn = replacement);\n\
             fn();",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2554: within a single LATER statement, an
    // earlier declarator's redeclaration kills the value before a later
    // declarator's own initializer in that same statement runs.
    #[test]
    fn does_not_credit_liveness_from_a_later_declarator_reading_a_value_an_earlier_declarator_in_the_same_statement_killed(
    ) {
        let s = parse_js(
            "var fn = options.custom || fetchLatestVersion;\n\
             var fn = replacement, result = fn();",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2554: a sequence expression's parts execute in
    // order — a kill earlier in the sequence must suppress a read later in
    // the SAME sequence.
    #[test]
    fn does_not_credit_liveness_from_a_read_later_in_a_sequence_expression_whose_earlier_part_killed_it(
    ) {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             (fn = replacement, fn());",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2554: a later sibling declarator in the SAME
    // statement as the original fallback declarator can itself
    // unconditionally redeclare the name — must suppress a read from a
    // declarator after that.
    #[test]
    fn does_not_credit_liveness_from_a_declarator_reading_a_value_a_later_sibling_in_its_own_declaration_statement_killed(
    ) {
        let s = parse_js(
            "var fn = options.custom || fetchLatestVersion, fn = replacement, result = fn();",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A compound assignment (`+=`, `||=`, etc. — a distinct
    // `augmented_assignment_expression` node in this grammar) DOES read the
    // current value before writing, so its left-hand identifier is a real
    // reference and must still count.
    #[test]
    fn credits_liveness_from_a_compound_assignment_reference() {
        let s = parse_js("let fn = options.custom || fetchLatestVersion;\nfn += 1;");
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: overwriting a fallback variable through
    // OBJECT destructuring is still a WRITE, not a read — the same as a
    // plain `fn = replacement`.
    #[test]
    fn does_not_credit_liveness_from_a_write_only_object_destructuring_reassignment() {
        let s = parse_js("let fn = options.custom || fetchLatestVersion;\n({ fn } = replacement);");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Same as above, for ARRAY destructuring.
    #[test]
    fn does_not_credit_liveness_from_a_write_only_array_destructuring_reassignment() {
        let s = parse_js("let fn = options.custom || fetchLatestVersion;\n[fn] = replacement;");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: `pattern_binds_name`'s own recursive descent
    // through nested destructuring patterns must be depth-bounded too, like
    // every other recursive walk in this file (MAX_WALK_DEPTH) — a
    // pathologically deep array/object pattern must not overflow the stack.
    #[test]
    fn does_not_overflow_the_stack_on_a_pathologically_deep_destructuring_pattern() {
        let depth = 300;
        let pattern = format!("{}fn{}", "[".repeat(depth), "]".repeat(depth));
        let source =
            format!("let fn = options.custom || fetchLatestVersion;\n{pattern} = replacement;");
        let _ = parse_js(&source);
    }

    // Greptile review, PR #2432: a destructuring default that READS the
    // outer fallback variable (`const { value = fn } = input;`) must not be
    // mistaken for a binding of `fn` when deciding whether a nested block
    // shadows it — the read must still be found.
    #[test]
    fn does_not_treat_a_destructuring_default_reference_as_a_shadowing_declaration() {
        let s = parse_js(
            "const fn = options.custom || fetchLatestVersion;\n\
             {\n\
               const { value = fn } = input;\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: `({ fn = fn } = replacement)` both WRITES
    // `fn` and READS its previous value as the default — the write must not
    // suppress the read.
    #[test]
    fn credits_liveness_from_a_default_read_inside_a_destructuring_write() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n({ fn = fn } = replacement);",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: a `var` is hoisted, so a reference in an
    // earlier sibling statement executes BEFORE the fallback is assigned and
    // reads the pre-assignment value, not the fallback — must not fabricate
    // liveness for it.
    #[test]
    fn does_not_credit_liveness_from_a_reference_before_a_hoisted_var_initializer() {
        let s = parse_js("fn();\nvar fn = options.custom || fetchLatestVersion;");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A reference in a LATER sibling statement is exactly the liveness
    // evidence this mechanism requires — the position filter above must not
    // suppress it too.
    #[test]
    fn still_credits_liveness_from_a_reference_after_the_declaration() {
        let s = parse_js("var fn = options.custom || fetchLatestVersion;\nfn();");
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: all `case`/`default` clauses in a switch
    // share ONE lexical scope. An UNBRACED case's own `let` declaration of
    // the SAME name shadows the outer fallback variable for the whole
    // switch, even though it isn't wrapped in its own block.
    #[test]
    fn does_not_credit_liveness_from_an_unbraced_switch_case_shadowing_the_name() {
        let s = parse_js(
            "const fn = options.custom || fetchLatestVersion;\n\
             switch (x) {\n\
               case 1:\n\
                 let fn = 1;\n\
                 fn();\n\
                 break;\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: `var` is function-scoped, not switch-scoped
    // — a `var fn` redeclaration in one case is the SAME outer binding, not
    // a distinct shadow, so it must not suppress a genuine read in a
    // DIFFERENT, unrelated case.
    #[test]
    fn still_credits_liveness_from_a_switch_case_read_when_another_case_redeclares_the_name_via_var(
    ) {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               switch (x) {\n\
                 case 1:\n\
                   fn();\n\
                   break;\n\
                 case 2:\n\
                   var fn = something;\n\
                   break;\n\
               }\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: `for (fn of values) {}` / `for (fn in obj)
    // {}` with NO declaration keyword reassigns fn on every iteration — a
    // WRITE, not a read of the value it held before the loop started.
    #[test]
    fn does_not_credit_liveness_from_a_for_of_loop_write_target() {
        let s = parse_js("const fn = options.custom || fetchLatestVersion;\nfor (fn of values) {}");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    #[test]
    fn does_not_credit_liveness_from_a_for_in_loop_write_target() {
        let s = parse_js("const fn = options.custom || fetchLatestVersion;\nfor (fn in obj) {}");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Using the fallback variable as the ITERABLE (not the loop target) is
    // a genuine read and must still count.
    #[test]
    fn still_credits_liveness_when_the_fallback_variable_is_the_for_of_iterable() {
        let s =
            parse_js("const fn = options.custom || fetchLatestVersion;\nfor (const x of fn) {}");
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: with a hoisted declaration like
    // `var result = fn(), fn = custom || fallback`, the EARLIER sibling
    // declarator's initializer runs before this one is assigned — it
    // cannot have consumed a value that doesn't exist yet.
    #[test]
    fn does_not_credit_liveness_from_an_earlier_sibling_declarator_in_the_same_statement() {
        let s = parse_js("var result = fn(), fn = options.custom || fetchLatestVersion;");
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2432: `var` is function-scoped, so a `var`
    // redeclaration anywhere in a nested block is the SAME binding as an
    // outer `var` of the same name — it must not prune a genuine read
    // elsewhere in that same block (here, one that textually precedes the
    // redeclaration).
    #[test]
    fn still_credits_liveness_from_a_read_in_a_nested_block_that_also_redeclares_the_name_via_var()
    {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               {\n\
                 fn();\n\
                 var fn = something;\n\
               }\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A C-style for-loop whose own init clause rebinds the name via `var` is
    // the SAME function-scoped binding — and that is precisely why it KILLS
    // the fallback value rather than reading it: `var fn = 0` runs before the
    // test/update clauses, so `fn < 10` and `fn++` only ever see the number.
    // Verified at runtime: `typeof fn` inside that loop is always `number`,
    // and the fallback function is never invoked. Crediting liveness here
    // would fabricate an edge for a value that is assigned and immediately
    // overwritten without ever being consumed.
    //
    // A loop that does NOT rebind the name is unaffected — see the next test.
    #[test]
    fn does_not_credit_liveness_from_a_for_loop_whose_own_var_init_overwrote_the_value() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var fn = 0; fn < 10; fn++) {}\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2440: only an INITIALIZER overwrites the value. A
    // bare `var fn;` redeclaration in the loop head assigns nothing, so it is
    // not a kill and the body's read is genuine.
    #[test]
    fn credits_liveness_from_a_for_loop_body_read_when_the_head_does_not_initialize() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var fn; cond; update) { fn(); }\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A sibling declarator BEFORE the killing one runs before the overwrite, so
    // its read is genuine.
    #[test]
    fn credits_liveness_from_a_for_head_sibling_initializer_before_the_kill() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var a = fn(), fn = 0; fn < 3; fn++) {}\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // …but a sibling declarator AFTER the killing one reads the NEW value.
    #[test]
    fn does_not_credit_liveness_from_a_for_head_sibling_initializer_after_the_kill() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var fn = 0, a = fn(); fn < 3; fn++) {}\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // The killing declarator's own initializer still reads the pre-loop value.
    #[test]
    fn credits_liveness_from_a_for_head_initializer_that_reads_what_it_overwrites() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var fn = fn; cond; update) {}\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // The guard for that last sentence: a loop counter with a DIFFERENT name
    // must not suppress a real read in the loop body.
    #[test]
    fn credits_liveness_from_a_loop_body_read_when_the_loop_counter_is_a_different_name() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var i = 0; i < 10; i++) { fn(); }\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A `let`/`const` declaring for-in loop variable IS a genuinely distinct
    // block-scoped binding (unlike `var`) — it must still shadow correctly.
    #[test]
    fn does_not_credit_liveness_from_a_let_declared_for_in_loop_variable() {
        let s = parse_js(
            "function outer() {\n\
               const fn = options.custom || fetchLatestVersion;\n\
               for (let fn in obj) {\n\
                 doSomething(fn);\n\
               }\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // Greptile review, PR #2440: a `let`/`const` for-of target creates a
    // BRAND-NEW per-iteration binding for `name` — a default hidden inside
    // that SAME destructuring pattern which mentions `name` resolves to that
    // new binding (in the temporal dead zone until its own position
    // initializes it), never to the enclosing fallback. Verified at runtime:
    // `let [fn = fn] = [undefined]` throws "Cannot access 'fn' before
    // initialization" — it never reads the outer `fn`.
    #[test]
    fn does_not_credit_liveness_from_a_lexical_destructuring_default_that_self_references_the_loop_target(
    ) {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (const [fn = fn] of values) { fn(); }\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // …but a `var` target reuses the SAME pre-existing binding (no new
    // scope), so the identical shape still reads the current,
    // soon-to-be-overwritten value — this must stay credited.
    #[test]
    fn still_credits_liveness_from_a_var_destructuring_default_that_self_references_the_loop_target(
    ) {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               for (var [fn = fn] of values) {}\n\
             }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // The flip side of the var-is-function-scoped model: because `var` hoists
    // to the FUNCTION scope, a nested function declaring `var fn` at ANY depth
    // in its body shadows the outer `fn` for that whole function — including a
    // read sitting outside the block that physically contains the `var`.
    #[test]
    fn does_not_credit_liveness_from_a_nested_function_that_hoists_its_own_var_deeper_down() {
        let s = parse_js(
            "function outer() {\n\
               var fn = options.custom || fetchLatestVersion;\n\
               function inner(flag) {\n\
                 if (flag) { var fn = 1; }\n\
                 return fn();\n\
               }\n\
             }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // A for-in/of head that binds the name kills the pre-loop value, so the
    // BODY can never be reading it — even for a bare (non-declaring) target.
    #[test]
    fn does_not_credit_liveness_from_a_for_of_body_read_of_a_bare_loop_target() {
        let s = parse_js(
            "let fn = options.custom || fetchLatestVersion;\n\
             for (fn of values) { fn(); }",
        );
        assert!(!s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // …but `right` IS evaluated in the enclosing scope, so a genuine read
    // there must still count.
    #[test]
    fn credits_liveness_from_a_for_of_right_hand_side_read_in_the_enclosing_scope() {
        let s = parse_js(
            "const fn = options.custom || fetchLatestVersion;\n\
             for (const item of fn()) { use(item); }",
        );
        assert!(s.calls.iter().any(|c| {
            c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "fetchLatestVersion"
        }));
    }

    // This mechanism's Call extraction is UNCONDITIONAL (like #1771/#1895 —
    // every bare-identifier object-literal property value always produces a
    // value-ref Call, regardless of liveness); only the RESOLVER (build_edges.rs)
    // later gates whether that Call becomes a real edge, consulting
    // invoked_property_names/computed_dispatch_table_evidence at that point —
    // NOT here. So the correct thing to assert at the extractor level is
    // computed_dispatch_table_evidence's own contents, not the calls array.

    // The confirmed real-world case: an AST-node-type-keyed dispatch table
    // (src/extractors/groovy.rs's GROOVY_NODE_HANDLERS), consumed via a
    // computed lookup stored in an intermediate variable, then called.
    #[test]
    fn records_the_table_name_when_the_intermediate_variable_is_later_called() {
        let s = parse_js(
            "const NODE_HANDLERS = {\n\
               interface_definition: handleInterfaceDecl,\n\
             };\n\
             function walkNode(node, ctx) {\n\
               const handler = NODE_HANDLERS[node.type];\n\
               if (handler) handler(node, ctx);\n\
             }",
        );
        assert_eq!(s.computed_dispatch_table_evidence, vec!["NODE_HANDLERS"]);
    }

    #[test]
    fn does_not_record_the_table_name_when_the_intermediate_variable_is_only_referenced_never_called(
    ) {
        let s = parse_js(
            "const NODE_HANDLERS = {\n\
               interface_definition: handleInterfaceDecl,\n\
             };\n\
             function walkNode(node, ctx) {\n\
               const handler = NODE_HANDLERS[node.type];\n\
               console.log(handler);\n\
             }",
        );
        assert!(s.computed_dispatch_table_evidence.is_empty());
    }

    #[test]
    fn does_not_fire_for_a_string_literal_key() {
        let s = parse_js(
            "const NODE_HANDLERS = {\n\
               interface_definition: handleInterfaceDecl,\n\
             };\n\
             function walkNode() {\n\
               const handler = NODE_HANDLERS['interface_definition'];\n\
               handler();\n\
             }",
        );
        assert!(s.computed_dispatch_table_evidence.is_empty());
    }

    #[test]
    fn does_not_record_the_table_name_when_the_call_is_inside_a_shadowing_nested_scope() {
        let s = parse_js(
            "const NODE_HANDLERS = {\n\
               interface_definition: handleInterfaceDecl,\n\
             };\n\
             function walkNode(node, ctx) {\n\
               const handler = NODE_HANDLERS[node.type];\n\
               {\n\
                 let handler = unrelatedFn;\n\
                 handler();\n\
               }\n\
             }",
        );
        assert!(s.computed_dispatch_table_evidence.is_empty());
    }

    #[test]
    fn only_records_the_specific_table_that_has_its_own_computed_invocation_evidence() {
        let s = parse_js(
            "const HANDLERS_A = {\n\
               interface_definition: handleA,\n\
             };\n\
             const HANDLERS_B = {\n\
               interface_definition: handleB,\n\
             };\n\
             function walkNode(node, ctx) {\n\
               const handler = HANDLERS_A[node.type];\n\
               handler();\n\
             }",
        );
        assert_eq!(s.computed_dispatch_table_evidence, vec!["HANDLERS_A"]);
    }

    #[test]
    fn does_not_overflow_the_stack_on_a_pathologically_deep_enclosing_block_2260() {
        let depth = 300;
        let nested = format!(
            "{}handler();\n{}",
            "if (true) {\n".repeat(depth),
            "}\n".repeat(depth)
        );
        let source = format!(
            "const NODE_HANDLERS = {{ interface_definition: handleInterfaceDecl }};\n\
             function walkNode(node) {{\n\
               const handler = NODE_HANDLERS[node.type];\n\
               {nested}\n\
             }}"
        );
        let _ = parse_js(&source);
    }

    // #1895: key_expr capture — the property key, distinct from the
    // referenced value's own name, is what a dispatch consumer would
    // actually call (`table.resolve(...)`).
    #[test]
    fn value_ref_captures_property_key_distinct_from_referenced_name() {
        let s = parse_js("const table = { resolve: someFunction };");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "someFunction")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr.as_deref(), Some("resolve"));
    }

    #[test]
    fn value_ref_captures_string_literal_key_with_quotes_stripped() {
        let s = parse_js("const table = { 'resolve': someFunction };");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "someFunction")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr.as_deref(), Some("resolve"));
    }

    #[test]
    fn value_ref_captures_computed_string_literal_key() {
        let s = parse_js("const table = { ['resolve']: someFunction };");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "someFunction")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr.as_deref(), Some("resolve"));
    }

    #[test]
    fn value_ref_leaves_key_expr_unset_for_non_string_computed_key() {
        let s = parse_js("const table = { [Symbol.iterator]: someFunction };");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "someFunction")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr, None);
    }

    #[test]
    fn value_ref_key_expr_equals_name_for_shorthand_property() {
        let s = parse_js("const table = { someFunction };");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "someFunction")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr.as_deref(), Some("someFunction"));
    }

    #[test]
    fn instanceof_value_ref_leaves_key_expr_unset() {
        let s = parse_js("if (err instanceof CodegraphError) {}");
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "CodegraphError")
            .expect("expected a value-ref call");
        assert_eq!(call.key_expr, None);
    }

    #[test]
    fn no_value_ref_call_for_call_expression_value() {
        let s = parse_js("const table = { resolve: someFunction() };");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_member_expression_value() {
        let s = parse_js("const table = { resolve: obj.someFunction };");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_inline_function_value() {
        let s = parse_js("const table = { resolve: () => {}, other: function () {} };");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_literal_or_data_shaped_values() {
        let s = parse_js(
            "const config = { name: 'literal', count: 42, active: true, empty: null, list: [1, 2] };",
        );
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_builtin_globals() {
        let s = parse_js("const table = { log: console, Ctor: Object };");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    // ── #1784: instanceof value-ref extraction ──────────────────────────────

    #[test]
    fn extracts_value_ref_call_for_instanceof_class_name() {
        let s = parse_js(
            "function handle(err) { if (err instanceof CodegraphError) { report(err); } }",
        );
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "CodegraphError"));
        assert!(value_refs.iter().all(|c| c.dynamic == Some(true)));
    }

    #[test]
    fn extracts_value_ref_call_for_instanceof_as_expression_value() {
        let s = parse_js("const isConfig = (err) => err instanceof ConfigError;");
        let value_refs: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic_kind.as_deref() == Some("value-ref"))
            .collect();
        assert!(value_refs.iter().any(|c| c.name == "ConfigError"));
    }

    #[test]
    fn no_value_ref_call_for_instanceof_member_expression_operand() {
        let s = parse_js("const check = (a) => a instanceof ns.SomeClass;");
        assert!(s
            .calls
            .iter()
            .all(|c| !(c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "SomeClass")));
    }

    #[test]
    fn no_value_ref_call_for_instanceof_call_expression_operand() {
        let s = parse_js("const check = (a) => a instanceof getClass();");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_instanceof_builtin_globals() {
        let s = parse_js(
            "function isBuiltin(x) { return x instanceof Error || x instanceof Array || x instanceof Map; }",
        );
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_in_operator() {
        let s = parse_js("const has = (obj) => 'key' in obj;");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_other_binary_operators() {
        let s = parse_js("const sum = (a, b) => a + b === Total;");
        assert!(s
            .calls
            .iter()
            .all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_duplicate_call_for_call_expression_arg() {
        let s = parse_js("router.use(checkPermissions(['admin']));");
        let cp_calls: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.name == "checkPermissions")
            .collect();
        assert_eq!(cp_calls.len(), 1);
    }

    #[test]
    fn no_member_expr_callback_for_non_allowlisted_callee() {
        // `store.set(user.id, user)` — `user.id` is a property read passed as a
        // value (map key), NOT a callback. Only allowlisted callees (use, then,
        // map, addEventListener, etc.) get member_expression args emitted as
        // dynamic calls. Mirrors WASM test in `tests/parsers/javascript.test.ts`.
        let s = parse_js("store.set(user.id, user);");
        let dyn_member_calls: Vec<_> = s
            .calls
            .iter()
            .filter(|c| c.dynamic == Some(true) && c.name == "id")
            .collect();
        assert!(
            dyn_member_calls.is_empty(),
            "store.set non-allowlisted callee must not emit member-expr arg `id` as dynamic call",
        );
    }

    #[test]
    fn emits_member_expr_callback_for_allowlisted_callee() {
        // Positive companion: `app.use(auth.validate)` and `promise.then(handlers.onSuccess)`
        // must still produce dynamic calls with receivers, because `use` and `then`
        // are callback-accepting APIs.
        let use_s = parse_js("app.use(auth.validate);");
        let use_cb = use_s
            .calls
            .iter()
            .find(|c| c.dynamic == Some(true) && c.name == "validate");
        assert!(
            use_cb.is_some(),
            "app.use must still emit validate as dynamic call"
        );
        assert_eq!(use_cb.unwrap().receiver.as_deref(), Some("auth"));

        let then_s = parse_js("promise.then(handlers.onSuccess);");
        let then_cb = then_s
            .calls
            .iter()
            .find(|c| c.dynamic == Some(true) && c.name == "onSuccess");
        assert!(
            then_cb.is_some(),
            "promise.then must still emit onSuccess as dynamic call"
        );
        assert_eq!(then_cb.unwrap().receiver.as_deref(), Some("handlers"));
    }

    #[test]
    fn no_member_expr_callback_for_cache_or_map_get() {
        // `cache.get(user.id)` shares the verb name `get` with Express routes,
        // but has no string-literal route path first arg — so member-expr args
        // must not be emitted as dynamic calls. Same for `repo.put`, `map.delete`.
        let cache_s = parse_js("cache.get(user.id);");
        assert!(
            !cache_s
                .calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "id"),
            "cache.get(user.id) must not emit `id` as dynamic call",
        );

        let repo_s = parse_js("repo.put(record.key, value);");
        assert!(
            !repo_s
                .calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "key"),
            "repo.put(record.key) must not emit `key` as dynamic call",
        );

        let map_s = parse_js("map.delete(entry.id);");
        assert!(
            !map_s
                .calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "id"),
            "map.delete(entry.id) must not emit `id` as dynamic call",
        );
    }

    #[test]
    fn emits_member_expr_callback_for_http_route_with_string_path() {
        // Positive regression guard: HTTP-verb calls with a string-literal
        // first arg (Express route signature) must still emit member-expr args.
        let router_s = parse_js("router.get('/users/:id', auth.check);");
        let router_cb = router_s
            .calls
            .iter()
            .find(|c| c.dynamic == Some(true) && c.name == "check");
        assert!(
            router_cb.is_some(),
            "Express route with string path must emit auth.check"
        );
        assert_eq!(router_cb.unwrap().receiver.as_deref(), Some("auth"));

        let template_s = parse_js("app.post(`/api`, handlers.create);");
        let template_cb = template_s
            .calls
            .iter()
            .find(|c| c.dynamic == Some(true) && c.name == "create");
        assert!(
            template_cb.is_some(),
            "Express route with template string must emit handlers.create"
        );
        assert_eq!(template_cb.unwrap().receiver.as_deref(), Some("handlers"));
    }

    #[test]
    fn handles_optional_chaining_callee_in_allowlist() {
        // `emitter?.on('tick', handlers.fn)` — tree-sitter-javascript/typescript
        // represent `obj?.on` as a `member_expression` with an `optional_chain`
        // child, so `extract_callee_name` returns `on` and the allowlist gate works.
        let s = parse_js("emitter?.on('tick', handlers.fn);");
        let cb = s
            .calls
            .iter()
            .find(|c| c.dynamic == Some(true) && c.name == "fn");
        assert!(
            cb.is_some(),
            "optional-chain callee must still gate by allowlist"
        );
        assert_eq!(cb.unwrap().receiver.as_deref(), Some("handlers"));
    }

    #[test]
    fn no_identifier_callback_for_non_allowlisted_callee_issue_1741() {
        // Regression guard for #1741: `findMergeCandidates(communities)` and
        // `analyzeDrift(communities, communityDirs)` pass `communities` as a
        // plain DATA argument, not a callback reference. Neither
        // `findMergeCandidates` nor `analyzeDrift` is a callback-accepting
        // callee, so identifier args must be gated exactly like
        // member_expression args — otherwise the global-fallback resolver
        // can bind the identifier to an unrelated same-named function
        // elsewhere in the repo, fabricating a call edge (and, transitively,
        // a phantom cycle — see codegraph's own src/features/communities.ts
        // vs src/presentation/communities.ts).
        let s = parse_js("findMergeCandidates(communities);");
        assert!(
            !s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "communities"),
            "findMergeCandidates non-allowlisted callee must not emit `communities` as dynamic call; got: {:?}",
            s.calls,
        );

        let s2 = parse_js("analyzeDrift(communities, communityDirs);");
        assert!(
            !s2.calls.iter().any(|c| c.dynamic == Some(true)),
            "analyzeDrift non-allowlisted callee must not emit any dynamic calls; got: {:?}",
            s2.calls,
        );
    }

    #[test]
    fn emits_identifier_callback_for_allowlisted_callee_issue_1741() {
        // Positive companion to the #1741 fix: identifier args passed to a
        // genuine callback-accepting callee must still be resolved, e.g.
        // `arr.forEach(myNamedCallback)` — the exact pattern the original
        // "identifier args are always emitted" trade-off existed to preserve.
        let s = parse_js("arr.forEach(myNamedCallback);");
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "myNamedCallback"),
            "arr.forEach must still emit myNamedCallback as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_identifier_arg_via_function_shaped_type_alias_issue_1845() {
        // Regression guard for #1845: `processEach`'s `fn` param is typed with a
        // function-shaped type alias (`UserProcessor`), so `logUser` must be
        // recognized as a callback reference even though neither `processEach`
        // nor `logUser` is in CALLBACK_ACCEPTING_CALLEES.
        let s = parse_ts(
            "type UserProcessor = (user: string) => void;
             function processEach(users: string[], fn: UserProcessor): void {
               for (const user of users) fn(user);
             }
             function logUser(user: string): void { console.log(user); }
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "processEach(users, logUser) must emit logUser as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_identifier_arg_via_inline_arrow_function_type_issue_1845() {
        let s = parse_ts(
            "function processEach(users: string[], fn: (user: string) => void): void {
               for (const user of users) fn(user);
             }
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "inline arrow-function-type param must recognize logUser; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_identifier_arg_via_function_typed_param_issue_1845() {
        let s = parse_ts(
            "function runWith(fn: Function): void { fn(); }
             function handler(): void {}
             function runDemo(): void {
               runWith(handler);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "handler"),
            "Function-typed param must recognize handler; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn does_not_recognize_identifier_arg_when_param_not_function_shaped_issue_1845() {
        // Regression guard: the new type-based gate must not reintroduce the
        // #1741 false positive for callees whose parameter is plain data.
        let s = parse_ts(
            "function findMergeCandidates(communities: string[]): void {}
             function runDemo(communities: string[]): void {
               findMergeCandidates(communities);
             }",
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "communities"),
            "non-function-shaped param must not emit communities as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn only_recognizes_function_shaped_param_position_issue_1845() {
        let s = parse_ts(
            "type UserPredicate = (user: string) => boolean;
             type UserProcessor = (user: string) => void;
             function filterThen(users: string[], pred: UserPredicate, fn: UserProcessor): void {}
             function hasEmail(user: string): boolean { return true; }
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               filterThen(users, hasEmail, logUser);
             }",
        );
        let dynamic_names: Vec<&str> = s
            .calls
            .iter()
            .filter(|c| c.dynamic == Some(true))
            .map(|c| c.name.as_str())
            .collect();
        assert!(dynamic_names.contains(&"hasEmail"), "got: {:?}", s.calls);
        assert!(dynamic_names.contains(&"logUser"), "got: {:?}", s.calls);
        assert!(!dynamic_names.contains(&"users"), "got: {:?}", s.calls);
    }

    #[test]
    fn resolves_one_level_of_type_alias_indirection_issue_1845() {
        let s = parse_ts(
            "type Handler = (user: string) => void;
             type UserProcessor = Handler;
             function processEach(users: string[], fn: UserProcessor): void {}
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "one-level alias indirection must still recognize logUser; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_function_shaped_param_on_class_methods_issue_1845() {
        let s = parse_ts(
            "class Runner {
               processEach(users: string[], fn: (user: string) => void): void {}
             }
             function logUser(user: string): void {}
             function runDemo(runner: Runner, users: string[]): void {
               runner.processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "class-method function-shaped param must recognize logUser; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn does_not_misalign_param_index_with_explicit_this_param_issue_1845() {
        // TypeScript's explicit `this` parameter is compiled away and never
        // appears at the call site — it must not consume an argument-index slot.
        let s = parse_ts(
            "function processEach(this: void, users: string[], fn: (user: string) => void): void {}
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "explicit this param must not misalign the callback param index; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_identifier_arg_via_arrow_function_hof_issue_1845() {
        let s = parse_ts(
            "type UserProcessor = (user: string) => void;
             const processEach = (users: string[], fn: UserProcessor): void => {
               for (const user of users) fn(user);
             };
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "arrow-function HOF must recognize logUser; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn recognizes_identifier_arg_via_function_expression_hof_issue_1845() {
        let s = parse_ts(
            "type UserProcessor = (user: string) => void;
             const processEach = function (users: string[], fn: UserProcessor): void {
               for (const user of users) fn(user);
             };
             function logUser(user: string): void {}
             function runDemo(users: string[]): void {
               processEach(users, logUser);
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "logUser"),
            "function-expression HOF must recognize logUser; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn does_not_merge_callback_shapes_across_unrelated_same_named_methods_issue_1845() {
        let s = parse_ts(
            "class Uploader {
               process(data: string, cb: (result: string) => void): void {}
             }
             class Reporter {
               process(users: string[]): void {}
             }
             function runDemo(reporter: Reporter, users: string[]): void {
               reporter.process(users);
             }",
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "users"),
            "unrelated same-named methods must not merge callback shapes; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn no_identifier_callback_for_cache_or_map_get() {
        // Identifier-arg counterpart to `no_member_expr_callback_for_cache_or_map_get`:
        // `cache.get(someKey)` shares the verb name `get` with Express routes
        // but has no string-literal route path first arg, so the identifier
        // arg must not be emitted as a dynamic call either.
        let s = parse_js("cache.get(someKey);");
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "someKey"),
            "cache.get(someKey) must not emit `someKey` as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn emits_array_from_mapfn_but_not_arraylike() {
        // Regression guard for #1741 follow-up: `Array.from(arrayLike, mapFn)` is
        // a well-known stdlib callback pattern (also every TypedArray.from), but
        // the callback is the SECOND positional argument, not the first. Emitting
        // `arrayLike` too would reintroduce the exact name-collision false-positive
        // class #1741 fixes for the data argument; only `mapFn` should resolve.
        let s = parse_js("Array.from(arr, mapCallback);");
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
            "Array.from(arr, mapCallback) must emit mapCallback as dynamic call; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "arr"),
            "Array.from(arr, mapCallback) must not emit `arr` (index 0) as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn emits_only_index_one_for_array_from_with_this_arg() {
        // `Array.from(arrayLike, mapFn, thisArg)` — thisArg (index 2) is a `this`
        // binding context, not a callback, and must not be emitted either.
        let s = parse_js("Array.from(arr, mapCallback, thisArg);");
        let dynamic_names: Vec<&str> = s
            .calls
            .iter()
            .filter(|c| c.dynamic == Some(true))
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(
            dynamic_names,
            vec!["mapCallback"],
            "only index-1 mapCallback should be dynamic; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn applies_array_from_positional_gate_to_typed_array_constructors() {
        // Every TypedArray constructor (Uint8Array, Int32Array, etc.) mirrors
        // Array.from's (arrayLike, mapFn, thisArg) signature; the gate is
        // name-based on the property `from`, not receiver-typed, so it applies
        // uniformly.
        let s = parse_js("Uint8Array.from(arr, mapCallback);");
        assert!(
            s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
            "Uint8Array.from(arr, mapCallback) must emit mapCallback; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "arr"),
            "Uint8Array.from(arr, mapCallback) must not emit `arr`; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn applies_array_from_positional_gate_to_member_expression_args_too() {
        // Mirrors the TS test of the same intent: the old member_expression
        // guard was an explicit `&& memberExprArgsAllowed` inline check; the
        // positional restructuring moved that responsibility to the shared
        // early-return above the loop. `Array.from(arr, obj.mapper)` exercises
        // that a member_expression at the positional index (1) is still
        // emitted with its receiver, while one at index 0 is not.
        let s = parse_js("Array.from(arr, obj.mapper);");
        assert!(
            s.calls.iter().any(|c| c.dynamic == Some(true)
                && c.name == "mapper"
                && c.receiver.as_deref() == Some("obj")),
            "Array.from(arr, obj.mapper) must emit mapper with receiver obj; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "arr"),
            "Array.from(arr, obj.mapper) must not emit `arr` (index 0); got: {:?}",
            s.calls,
        );

        let s2 = parse_js("Array.from(obj.arrayLike, mapCallback);");
        assert!(
            !s2.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "arrayLike"),
            "Array.from(obj.arrayLike, mapCallback) must not emit `arrayLike` (index 0); got: {:?}",
            s2.calls,
        );
        assert!(
            s2.calls
                .iter()
                .any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
            "Array.from(obj.arrayLike, mapCallback) must emit mapCallback; got: {:?}",
            s2.calls,
        );
    }

    #[test]
    fn no_dynamic_call_for_dynamic_import_arg() {
        // Parity with TS walk path: callback-reference extraction must be skipped
        // when the call is a dynamic `import()`. Otherwise `import(modulePath)`
        // would emit a spurious dynamic call to `modulePath`.
        let s = parse_js("const mod = await import(modulePath);");
        let dyn_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(
            !dyn_calls.iter().any(|c| c.name == "modulePath"),
            "import() argument must not be emitted as a dynamic call"
        );
    }

    #[test]
    fn extracts_destructured_const_bindings() {
        // kind is "constant" (#1773), not "function" — matches the plain
        // `const x = <literal>` and array-pattern destructuring convention.
        // Destructured names remain resolvable as call targets regardless of
        // kind (call-target resolution is kind-agnostic), so callback-style
        // destructured bindings like `handleToken` still resolve when called.
        let s = parse_js("const { handleToken, checkPermissions } = initAuth(config);");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"handleToken"),
            "should extract handleToken definition"
        );
        assert!(
            names.contains(&"checkPermissions"),
            "should extract checkPermissions definition"
        );
        let ht = s
            .definitions
            .iter()
            .find(|d| d.name == "handleToken")
            .unwrap();
        assert_eq!(ht.kind, "constant");
    }

    #[test]
    fn extracts_non_renamed_destructured_bindings_with_kind_constant() {
        // Regression guard for issue #1773: plain (non-renamed) destructured
        // bindings from a non-call RHS (e.g. `workerData`) must not default to
        // kind "function" — they hold arbitrary values, not callables.
        let s = parse_js("const { dbPath, name, force } = workerData;");
        for expected in ["dbPath", "name", "force"] {
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == expected)
                .unwrap_or_else(|| panic!("should extract {expected} definition"));
            assert_eq!(def.kind, "constant");
        }
    }

    #[test]
    fn extracts_exported_destructured_const_bindings() {
        let s = parse_js("export const { handleToken, checkPermissions } = initAuth(config);");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"handleToken"));
        assert!(names.contains(&"checkPermissions"));
    }

    #[test]
    fn marks_exported_destructured_object_pattern_bindings_as_exports() {
        // Regression guard for #2070: collect_exported_var_declarations used
        // to skip any declarator whose name field wasn't a plain identifier,
        // so `export const { a, b } = value` produced Definitions for a/b
        // (see extracts_exported_destructured_const_bindings above) but no
        // matching ExportInfo at all — the exported=1 UPDATE never fired.
        let s = parse_js("export const { handleToken, checkPermissions } = initAuth(config);");
        for name in ["handleToken", "checkPermissions"] {
            assert!(
                s.exports
                    .iter()
                    .any(|e| e.name == name && e.kind == "constant"),
                "{name} should be listed as an exported constant; got: {:?}",
                s.exports
            );
        }
    }

    #[test]
    fn marks_exported_destructured_array_pattern_bindings_as_exports() {
        let s = parse_js("export const [a, b] = computePair();");
        for name in ["a", "b"] {
            assert!(
                s.exports
                    .iter()
                    .any(|e| e.name == name && e.kind == "constant"),
                "{name} should be listed as an exported constant; got: {:?}",
                s.exports
            );
        }
    }

    #[test]
    fn marks_exported_nested_array_pattern_rest_bindings_as_exports() {
        // Greptile review (#2070): collect_array_pattern_names's rest_pattern
        // branch used to call the plain-identifier-only extract_rest_identifier,
        // so a rest element that itself nests another array pattern
        // (`...[a, b]`) got Definitions (see
        // extracts_nested_array_pattern_rest_bindings_as_own_definitions) but no
        // matching Export at all, diverging from the Definition side and from
        // the TS engine (which already recursed here).
        let s = parse_js("export const [x, ...[a, b]] = computeList();");
        for name in ["x", "a", "b"] {
            assert!(
                s.exports
                    .iter()
                    .any(|e| e.name == name && e.kind == "constant"),
                "{name} should be listed as an exported constant; got: {:?}",
                s.exports
            );
        }
    }

    #[test]
    fn export_line_uses_value_line_for_multi_binding_function_valued_const() {
        // #2293: each function-valued declarator's export line must match its
        // own Definition's line (the value node's line, per #2265), not a
        // single line shared across every declarator in the statement.
        let s = parse_js("export const first = () => 1,\n  second = () => 2;");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "first" && e.kind == "function" && e.line == 1),
            "expected 'first' exported as function at line 1; got: {:?}",
            s.exports
        );
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "second" && e.kind == "function" && e.line == 2),
            "expected 'second' exported as function at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn export_line_uses_declaration_line_not_export_keyword_line_for_default_class() {
        // #2293: collect_exported_var_declarations / handle_export_declaration
        // used to compute a single line from the wrapping `export_statement`
        // node, mismatching the Definition's own line whenever `export` and
        // the declaration weren't on the same source line — silently
        // dropping the exported=1 UPDATE (matched by name/kind/file/line).
        // A bare `export\nclass Widget {}` isn't a valid repro here: the
        // grammar doesn't parse a newline-separated bare `export` followed by
        // a declaration keyword as one `export_statement` at all (filed
        // separately as #2459) — `export default` is parsed correctly across
        // a newline, so it's used here to exercise the line fix itself.
        let s = parse_js("export default\nclass Widget {}");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "Widget" && e.kind == "class" && e.line == 2),
            "expected 'Widget' exported as class at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn export_line_uses_declaration_line_not_export_keyword_line_for_default_function() {
        let s = parse_js("export default\nfunction greet() {}");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "greet" && e.kind == "function" && e.line == 2),
            "expected 'greet' exported as function at line 2; got: {:?}",
            s.exports
        );
    }

    // #2459: tree-sitter-javascript/typescript misparses `export` followed by
    // a newline before const/let/var/class/function/interface/type as a
    // standalone `(expression_statement (identifier))` rather than a single
    // `export_statement` — `export default`/`{`/`*` ARE handled correctly
    // across a newline (see the two tests directly above, which use
    // `export default` for exactly that reason), which is why this needed
    // recover_bare_export_misparse rather than a line-computation fix.
    #[test]
    fn recovers_an_exported_const_split_across_a_newline_from_the_export_keyword() {
        let s = parse_js("export\nconst onOwnLine = 5;");
        assert!(
            s.definitions
                .iter()
                .any(|d| d.name == "onOwnLine" && d.kind == "constant" && d.line == 2),
            "expected 'onOwnLine' defined as constant at line 2; got: {:?}",
            s.definitions
        );
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "onOwnLine" && e.kind == "constant" && e.line == 2),
            "expected 'onOwnLine' exported as constant at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn recovers_an_exported_class_split_across_a_newline_from_the_export_keyword() {
        let s = parse_js("export\nclass Widget {}");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "Widget" && e.kind == "class" && e.line == 2),
            "expected 'Widget' exported as class at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn recovers_an_exported_function_split_across_a_newline_from_the_export_keyword() {
        let s = parse_js("export\nfunction greet() {}");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "greet" && e.kind == "function" && e.line == 2),
            "expected 'greet' exported as function at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn recovers_an_exported_ts_interface_split_across_a_newline_from_the_export_keyword() {
        let s = parse_ts("export\ninterface Shape {}");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "Shape" && e.kind == "interface" && e.line == 2),
            "expected 'Shape' exported as interface at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn recovers_an_exported_ts_type_alias_split_across_a_newline_from_the_export_keyword() {
        let s = parse_ts("export\ntype Id = string;");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "Id" && e.kind == "type" && e.line == 2),
            "expected 'Id' exported as type at line 2; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn exports_an_enum_declaration_with_kind_enum() {
        // Regression guard for #2560: enum_declaration had no arm in
        // handle_export_declaration's match, so `export enum Foo {}` was
        // extracted as a Definition (via handle_enum_decl) but never marked
        // exported.
        let s = parse_ts("export enum Color { Red, Green, Blue }");
        assert!(
            s.definitions
                .iter()
                .any(|d| d.name == "Color" && d.kind == "enum" && d.line == 1),
            "expected 'Color' defined as enum at line 1; got: {:?}",
            s.definitions
        );
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "Color" && e.kind == "enum" && e.line == 1),
            "expected 'Color' exported as enum at line 1; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn does_not_export_a_non_exported_enum() {
        let s = parse_ts("enum Internal { A, B }");
        assert!(
            s.definitions
                .iter()
                .any(|d| d.name == "Internal" && d.kind == "enum"),
            "expected 'Internal' defined as enum; got: {:?}",
            s.definitions
        );
        assert!(
            !s.exports.iter().any(|e| e.name == "Internal"),
            "did not expect 'Internal' to be exported; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn skips_a_comment_between_the_export_keyword_and_the_declaration() {
        let s = parse_js("export\n// why is this exported\nconst withComment = 1;");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "withComment" && e.kind == "constant" && e.line == 3),
            "expected 'withComment' exported as constant at line 3; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn still_exports_a_same_line_declaration_normally_no_regression_from_the_recovery_path() {
        let s = parse_js("export const sameLine = 6;");
        assert!(
            s.exports
                .iter()
                .any(|e| e.name == "sameLine" && e.kind == "constant" && e.line == 1),
            "expected 'sameLine' exported as constant at line 1; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn does_not_export_a_plain_top_level_statement_referencing_an_unrelated_identifier() {
        // Sanity check that recovery is keyed on the literal text "export" (a
        // reserved word — this can only ever be the misparse), not on "any
        // bare identifier expression statement followed by a declaration".
        let s = parse_js("notExport;\nconst untouched = 1;");
        assert!(!s.exports.iter().any(|e| e.name == "untouched"));
    }

    #[test]
    fn does_not_export_let_var_destructured_bindings() {
        // Mirrors skips_let_var_destructured_bindings below — the Export side
        // must stay restricted to const too, never diverging from which
        // bindings get a Definition in the first place (#2070).
        let s = parse_js("export let { userId, email } = parseRequest(req);");
        assert!(!s.exports.iter().any(|e| e.name == "userId"));
        assert!(!s.exports.iter().any(|e| e.name == "email"));

        let s2 = parse_js("export var [foo, bar] = getConfig();");
        assert!(!s2.exports.iter().any(|e| e.name == "foo"));
        assert!(!s2.exports.iter().any(|e| e.name == "bar"));
    }

    #[test]
    fn skips_let_var_destructured_bindings() {
        let s = parse_js("let { userId, email } = parseRequest(req);");
        assert!(!s.definitions.iter().any(|d| d.name == "userId"));
        assert!(!s.definitions.iter().any(|d| d.name == "email"));

        let s2 = parse_js("var { foo, bar } = getConfig();");
        assert!(!s2.definitions.iter().any(|d| d.name == "foo"));
        assert!(!s2.definitions.iter().any(|d| d.name == "bar"));
    }

    #[test]
    fn skips_destructured_bindings_inside_function_scope() {
        // Parity with TS query path (extractDestructuredBindingsWalk), which
        // skips FUNCTION_SCOPE_TYPES. Function-internal destructured const
        // bindings must not be emitted as definitions in the Rust walk path.
        let s = parse_js(
            "function setup() { const { handleToken, checkPermissions } = initAuth(config); }",
        );
        assert!(
            !s.definitions.iter().any(|d| d.name == "handleToken"),
            "function-nested destructured binding must not be emitted"
        );
        assert!(
            !s.definitions.iter().any(|d| d.name == "checkPermissions"),
            "function-nested destructured binding must not be emitted"
        );
    }

    #[test]
    fn extracts_renamed_destructured_binding() {
        let s = parse_js("const { original: renamed } = initAuth();");
        let renamed = s
            .definitions
            .iter()
            .find(|d| d.name == "renamed")
            .expect("should use the local alias");
        // kind is "constant" (#1773) — see comment on extracts_destructured_const_bindings.
        assert_eq!(renamed.kind, "constant");
        assert!(
            !s.definitions.iter().any(|d| d.name == "original"),
            "should not use the original key"
        );
    }

    // Regression tests for #2051: extract_destructured_bindings's object_pattern
    // branch only recognized shorthand_property_identifier_pattern and
    // pair_pattern children, so a rest element (`...rest`) never got a
    // Definition at all and a shorthand default (`{ a = 1 }`) produced no
    // Definition either — the same class of bug fixed for dynamic-import
    // destructure extraction in #1920, but for the generic
    // destructured-const-binding path used by any object destructure.

    #[test]
    fn extracts_constant_definition_for_rest_binding_alongside_plain_names() {
        let s = parse_js("const { a, ...rest } = someValue;");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"a"), "should extract a definition");
        assert!(names.contains(&"rest"), "should extract rest definition");
        let rest = s.definitions.iter().find(|d| d.name == "rest").unwrap();
        assert_eq!(rest.kind, "constant");
    }

    #[test]
    fn extracts_constant_definition_for_shorthand_default_value_binding() {
        let s = parse_js("const { a = 1 } = someValue;");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "a")
            .expect("should extract a definition for the default-valued binding");
        assert_eq!(def.kind, "constant");
    }

    #[test]
    fn extracts_mixed_plain_renamed_default_and_rest_destructured_bindings() {
        let s = parse_js("const { a, b: alias, c = 1, ...rest } = someValue;");
        for expected in ["a", "alias", "c", "rest"] {
            let def = s
                .definitions
                .iter()
                .find(|d| d.name == expected)
                .unwrap_or_else(|| panic!("should extract {expected} definition"));
            assert_eq!(def.kind, "constant");
        }
        assert!(
            !s.definitions.iter().any(|d| d.name == "b"),
            "should not use the original key"
        );
    }

    #[test]
    fn extracts_constant_definition_for_renamed_binding_with_default_value() {
        // Greptile follow-up: { key: local = fallback } nests an
        // assignment_pattern under pair_pattern's value field — a distinct
        // shape from the plain shorthand default ({ a = 1 }) case above.
        // Without this branch the pair_pattern handler rejected the nested
        // assignment_pattern and `local` never got a Definition at all.
        let s = parse_js("const { key: local = fallback } = someValue;");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "local")
            .expect("should extract local definition");
        assert_eq!(def.kind, "constant");
        assert!(
            !s.definitions.iter().any(|d| d.name == "key"),
            "should not use the original key"
        );
    }

    /// Regression test for issue #1271: native engine missing receiver edges.
    /// Uses the exact sample-project index.js content (CommonJS, constructor
    /// inside a function body). The extractor must produce:
    ///   - a typeMap entry: calc → Calculator (confidence 1.0)
    ///   - a call with name="compute" and receiver=Some("calc")
    #[test]
    fn extracts_type_map_from_constructor_assignment() {
        let s = parse_js(
            "const { sumOfSquares, Calculator } = require('./utils');\n\
             const { add } = require('./math');\n\
             function main() {\n\
               console.log(add(1, 2));\n\
               console.log(sumOfSquares(3, 4));\n\
               const calc = new Calculator();\n\
               console.log(calc.compute(5, 6));\n\
             }\n\
             module.exports = { main };",
        );
        let tm = s.type_map.iter().find(|t| t.name == "calc");
        assert!(
            tm.is_some(),
            "type_map should contain an entry for 'calc'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "Calculator");
        assert_eq!(tm.unwrap().confidence, 1.0);

        let compute_call = s.calls.iter().find(|c| c.name == "compute");
        assert!(
            compute_call.is_some(),
            "calls should contain 'compute'; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, &c.receiver))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            compute_call.unwrap().receiver.as_deref(),
            Some("calc"),
            "compute call should have receiver='calc'"
        );
    }

    /// Issue #1453: `this.prop = new Ctor()` inside a class must seed a
    /// class-scoped typeMap key `ClassName.prop` (mirrors issue #1323 in TS).
    #[test]
    fn this_prop_constructor_assignment_seeds_class_scoped_type_map() {
        let s = parse_js(
            "class Logger { error(m) {} }\n\
             class UserService {\n\
               constructor() { this.logger = new Logger(); }\n\
               run() { this.logger.error('x'); }\n\
             }",
        );
        let tm = s.type_map.iter().find(|t| t.name == "UserService.logger");
        assert!(
            tm.is_some(),
            "type_map should contain 'UserService.logger'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "Logger");
        assert_eq!(tm.unwrap().confidence, 1.0);
    }

    /// Issue #2396: `const x = Foo.create()` must type `x` as `Foo` at
    /// confidence 0.7 — the same factory-method heuristic TS's
    /// `handleCallExprTypeMap` already implements, previously missing here.
    #[test]
    fn factory_method_call_seeds_type_map_at_point_seven_confidence() {
        let s = parse_js("const client = HttpClient.create();");
        let tm = s.type_map.iter().find(|t| t.name == "client");
        assert!(
            tm.is_some(),
            "type_map should contain 'client'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "HttpClient");
        assert_eq!(tm.unwrap().confidence, 0.7);
    }

    #[test]
    fn factory_method_heuristic_ignores_lowercase_receiver() {
        let s = parse_js("const result = utils.create();");
        assert!(s.type_map.iter().all(|t| t.name != "result"));
    }

    #[test]
    fn factory_method_heuristic_ignores_object_create_and_other_builtin_globals() {
        let s = parse_js(
            "const r = Math.random();\n\
             const d = JSON.parse('{}');\n\
             const p = Promise.resolve(42);\n\
             const o = Object.create({});",
        );
        assert!(s.type_map.iter().all(|t| t.name != "r"));
        assert!(s.type_map.iter().all(|t| t.name != "d"));
        assert!(s.type_map.iter().all(|t| t.name != "p"));
        assert!(s.type_map.iter().all(|t| t.name != "o"));
    }

    // Greptile review on #2396: JS string indexing (`name[0]`) operates on
    // UTF-16 code units, not full Unicode scalars, so an astral-plane leading
    // character becomes a lone surrogate that never case-folds — TS's
    // `objName[0] !== objName[0].toLowerCase()` therefore never recognizes it
    // as uppercase. A naive `chars().next().is_uppercase()` in Rust decodes
    // the full scalar and WOULD recognize it, silently diverging from WASM
    // for this heuristic.
    #[test]
    fn factory_method_heuristic_matches_js_utf16_semantics_for_a_bmp_letter() {
        // 'Ω' (U+03A9 GREEK CAPITAL LETTER OMEGA) is a single UTF-16 code unit
        // and IS recognized as uppercase by both `str[0].toLowerCase()` in JS
        // and `char::is_uppercase()` in Rust — both engines must agree here.
        let s = parse_js("const conn = Ωmega.create();");
        let tm = s.type_map.iter().find(|t| t.name == "conn");
        assert!(
            tm.is_some(),
            "expected 'conn' to be typed; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "Ωmega");
        assert_eq!(tm.unwrap().confidence, 0.7);
    }

    #[test]
    fn factory_method_heuristic_matches_js_utf16_semantics_for_an_astral_letter() {
        // '𐐔' (U+10414 DESERET CAPITAL LETTER LONG I) is astral-plane — its
        // first UTF-16 code unit is a lone high surrogate, which JS's
        // `objName[0].toLowerCase()` leaves unchanged, so
        // `objName[0] !== objName[0].toLowerCase()` is false and TS's
        // heuristic does NOT fire. Rust must not fire here either, even
        // though `'𐐔'.is_uppercase()` is true for the full decoded scalar.
        let s = parse_js("const conn = \u{10414}mega.create();");
        assert!(
            s.type_map.iter().all(|t| t.name != "conn"),
            "must not type 'conn' — matches TS's UTF-16-surrogate semantics; got {:?}",
            s.type_map
        );
    }

    // Greptile's second review round on #2396: `char::is_uppercase()` and
    // "does lowercasing change this character" (what JS's `.toLowerCase()`
    // check actually implements) disagree for Unicode titlecase letters.
    #[test]
    fn factory_method_heuristic_matches_js_utf16_semantics_for_a_titlecase_letter() {
        // 'ǅ' (U+01C5 LATIN CAPITAL LETTER D WITH SMALL LETTER Z WITH CARON)
        // is Unicode category Lt (titlecase) — `char::is_uppercase()` is
        // false for it, but JS's `'ǅ'.toLowerCase()` ('ǆ') differs from 'ǅ',
        // so TS's heuristic DOES fire. Rust must fire here too.
        let s = parse_js("const conn = \u{1C5}omega.create();");
        let tm = s.type_map.iter().find(|t| t.name == "conn");
        assert!(
            tm.is_some(),
            "expected 'conn' to be typed for a titlecase receiver; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "\u{1C5}omega");
        assert_eq!(tm.unwrap().confidence, 0.7);
    }

    // Issue #2397: `as`-cast target must seed the typeMap directly, at the
    // source, rather than leaving the local unresolvable and dependent on
    // fragile bare-key propagation from an unrelated function in the file —
    // exactly the divergence #2235's scoping fix didn't reach for
    // `src/db/connection.ts`'s `openReadonlyOrFail`.
    #[test]
    fn as_cast_seeds_type_map_at_point_nine_confidence() {
        let s = parse_ts("const db = new Database(path) as BetterSqlite3Database;");
        let tm = s.type_map.iter().find(|t| t.name == "db");
        assert!(
            tm.is_some(),
            "expected 'db' to be typed; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "BetterSqlite3Database");
        assert_eq!(tm.unwrap().confidence, 0.9);
    }

    #[test]
    fn as_cast_extracts_final_target_type_from_a_chained_as_unknown_as_x() {
        let s = parse_ts("const db = new Database(path) as unknown as BetterSqlite3Database;");
        let tm = s.type_map.iter().find(|t| t.name == "db");
        assert!(
            tm.is_some(),
            "expected 'db' to be typed; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "BetterSqlite3Database");
        assert_eq!(tm.unwrap().confidence, 0.9);
    }

    #[test]
    fn as_cast_seeds_nothing_for_a_bare_as_unknown_with_no_further_cast() {
        let s = parse_ts("const db = new Database(path) as unknown;");
        assert!(s.type_map.iter().all(|t| t.name != "db"));
    }

    #[test]
    fn as_cast_wins_over_a_same_declaration_type_annotation() {
        // dedup_type_map is first-write-wins on confidence TIES — this proves
        // the cast is checked (and skips the annotation push) BEFORE the
        // annotation branch, not merely pushed alongside it at the same 0.9
        // and left to an ambiguous tie.
        let s = parse_ts("const db: RawHandle = new Database(path) as BetterSqlite3Database;");
        let tm = s.type_map.iter().find(|t| t.name == "db");
        assert!(
            tm.is_some(),
            "expected 'db' to be typed; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "BetterSqlite3Database");
    }

    #[test]
    fn as_cast_does_not_mistake_a_bare_identifier_cast_input_for_the_target_type() {
        // Regression guard: extract_as_expression_type_name must scan for
        // type_identifier specifically, not identifier, or `raw` (the cast's
        // INPUT, an ordinary identifier) would be wrongly returned instead of
        // the actual target type `Handle`.
        let s = parse_ts("const db = raw as Handle;");
        let tm = s.type_map.iter().find(|t| t.name == "db");
        assert!(
            tm.is_some(),
            "expected 'db' to be typed; got {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "Handle");
    }

    /// `this.prop = new Ctor()` outside any class declaration (function-style
    /// constructor) falls back to the un-scoped `this.prop` key.
    #[test]
    fn this_prop_constructor_assignment_outside_class_uses_this_key() {
        let s = parse_js("function Service() { this.client = new HttpClient(); }");
        let tm = s.type_map.iter().find(|t| t.name == "this.client");
        assert!(
            tm.is_some(),
            "type_map should contain 'this.client'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "HttpClient");
    }

    /// Issue #1458: two classes with identically-named field annotations must
    /// produce separate class-scoped typeMap keys, not overwrite each other.
    /// Mirrors the TS `prevents cross-class collision` test.
    #[test]
    fn field_annotation_multi_class_seeds_separate_scoped_keys() {
        let s = parse_ts(
            "class OrderService {\n\
               private repo: OrderRepository;\n\
             }\n\
             class UserService {\n\
               private repo: UserRepository;\n\
             }",
        );
        let order_entry = s.type_map.iter().find(|t| t.name == "OrderService.repo");
        assert!(
            order_entry.is_some(),
            "type_map should contain 'OrderService.repo'; got: {:?}",
            s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_eq!(order_entry.unwrap().type_name, "OrderRepository");
        assert_eq!(order_entry.unwrap().confidence, 0.9);

        let user_entry = s.type_map.iter().find(|t| t.name == "UserService.repo");
        assert!(
            user_entry.is_some(),
            "type_map should contain 'UserService.repo'; got: {:?}",
            s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_eq!(user_entry.unwrap().type_name, "UserRepository");
        assert_eq!(user_entry.unwrap().confidence, 0.9);
    }

    /// Issue #1453 (edge 4): `const f = fn.bind(ctx)` must record a
    /// fnRefBinding f → fn so later `f()` calls resolve through pts.
    #[test]
    fn bind_call_records_fn_ref_binding() {
        let s = parse_js(
            "function doWork() {}\n\
             const f = doWork.bind(null);",
        );
        let b = s.fn_ref_bindings.iter().find(|b| b.lhs == "f");
        assert!(
            b.is_some(),
            "fn_ref_bindings should contain lhs 'f'; got: {:?}",
            s.fn_ref_bindings
        );
        assert_eq!(b.unwrap().rhs, "doWork");
        assert!(b.unwrap().rhs_receiver.is_none());
    }

    /// Method-receiver binds (`obj.method.bind`) and builtin-global binds
    /// (`Math.max.bind`) are not tracked, mirroring the TS extractor.
    #[test]
    fn bind_call_skips_method_receiver_and_builtins() {
        let s = parse_js(
            "const a = obj.method.bind(ctx);\n\
             const b = Math.bind(null);",
        );
        assert!(
            s.fn_ref_bindings
                .iter()
                .all(|b| b.lhs != "a" && b.lhs != "b"),
            "method-receiver and builtin binds must not be tracked; got: {:?}",
            s.fn_ref_bindings
        );
    }

    // ── Prototype-method extraction ─────────────────────────────────────────

    #[test]
    fn prototype_direct_method_emits_definition() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.foo = function() { return 1; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.foo");
        assert!(
            def.is_some(),
            "C.foo definition missing; got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(
            def.complexity.is_some(),
            "C.foo should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.foo should have a CFG");
    }

    #[test]
    fn prototype_arrow_function_method_emits_definition() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.foo = () => { return 1; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.foo");
        assert!(
            def.is_some(),
            "C.foo definition missing; got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(
            def.complexity.is_some(),
            "C.foo (arrow) should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.foo (arrow) should have a CFG");
    }

    #[test]
    fn prototype_identifier_alias_seeds_type_map() {
        let s = parse_js(
            "let f = () => {};\n\
             class A {}\n\
             A.prototype.t = f;",
        );
        let entry = s.type_map.iter().find(|e| e.name == "A.t");
        assert!(
            entry.is_some(),
            "type_map entry A.t missing; got: {:?}",
            s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_eq!(entry.unwrap().type_name, "f");
    }

    #[test]
    fn prototype_object_literal_emits_definitions() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype = {\n\
               foo: function() {},\n\
               bar: function() {},\n\
             };",
        );
        let foo = s.definitions.iter().find(|d| d.name == "C.foo");
        let bar = s.definitions.iter().find(|d| d.name == "C.bar");
        assert!(foo.is_some(), "C.foo missing");
        let foo = foo.unwrap();
        assert_eq!(foo.kind, "method");
        assert!(
            foo.complexity.is_some(),
            "C.foo should have complexity metrics"
        );
        assert!(foo.cfg.is_some(), "C.foo should have a CFG");
        assert!(bar.is_some(), "C.bar missing");
        let bar = bar.unwrap();
        assert_eq!(bar.kind, "method");
        assert!(
            bar.complexity.is_some(),
            "C.bar should have complexity metrics"
        );
        assert!(bar.cfg.is_some(), "C.bar should have a CFG");
    }

    #[test]
    fn prototype_object_literal_shorthand_method() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype = {\n\
               greet() { return 'hi'; },\n\
             };",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.greet");
        assert!(
            def.is_some(),
            "C.greet definition missing; got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(
            def.complexity.is_some(),
            "C.greet should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.greet should have a CFG");
    }

    #[test]
    fn prototype_object_literal_shorthand_property_seeds_type_map() {
        let s = parse_js(
            "function helper() {}\n\
             function C() {}\n\
             C.prototype = { helper };",
        );
        let entry = s.type_map.iter().find(|e| e.name == "C.helper");
        assert!(
            entry.is_some(),
            "type_map entry C.helper missing; got: {:?}",
            s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_eq!(entry.unwrap().type_name, "helper");
    }

    #[test]
    fn prototype_builtin_globals_are_excluded() {
        let s = parse_js("Array.prototype.custom = function() {};");
        let def = s.definitions.iter().find(|d| d.name.contains("Array"));
        assert!(
            def.is_none(),
            "built-in prototype assignment should be ignored; got: {:?}",
            def
        );
    }

    #[test]
    fn prototype_direct_method_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.foo = function(x, y) { if (true) { return 1; } return 0; };",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "C.foo")
            .expect("C.foo missing");
        assert!(
            def.complexity.is_some(),
            "C.foo should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.foo should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "x"),
            "C.foo should have parameter 'x'; got: {:?}",
            children
        );
        assert!(
            children.iter().any(|c| c.name == "y"),
            "C.foo should have parameter 'y'; got: {:?}",
            children
        );
    }

    // ── Function-as-object-property extraction (#1432) ─────────────────────
    // Mirrors `handleFuncPropAssignment` in src/extractors/javascript.ts.

    #[test]
    fn func_prop_function_emits_method_definition() {
        let s = parse_js(
            "function f() {}\n\
             f.g = function() { return 1; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "f.g");
        assert!(
            def.is_some(),
            "f.g definition missing; got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(
            def.complexity.is_some(),
            "f.g should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "f.g should have a CFG");
    }

    #[test]
    fn func_prop_arrow_emits_method_definition() {
        let s = parse_js(
            "function f() {}\n\
             f.g = (x) => x + 1;",
        );
        let def = s.definitions.iter().find(|d| d.name == "f.g");
        assert!(
            def.is_some(),
            "f.g definition missing; got: {:?}",
            s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        assert_eq!(def.unwrap().kind, "method");
    }

    #[test]
    fn func_prop_extracts_parameters_as_children() {
        let s = parse_js(
            "function f() {}\n\
             f.process = function(a, b) { return a + b; };",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "f.process")
            .expect("f.process missing");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "a"),
            "f.process should have parameter 'a'; got: {:?}",
            children
        );
        assert!(
            children.iter().any(|c| c.name == "b"),
            "f.process should have parameter 'b'; got: {:?}",
            children
        );
    }

    #[test]
    fn func_prop_builtin_globals_are_excluded() {
        let s = parse_js("console.log = function() {};");
        let def = s.definitions.iter().find(|d| d.name == "console.log");
        assert!(
            def.is_none(),
            "built-in global func-prop assignment should be ignored; got: {:?}",
            def
        );
    }

    #[test]
    fn func_prop_nested_member_receiver_is_skipped() {
        // Only bare-identifier receivers qualify — `a.b.c = fn` must not emit a
        // definition (mirrors the `obj.type !== 'identifier'` guard in the WASM
        // extractor).
        let s = parse_js("const a = { b: {} };\na.b.c = function() {};");
        let def = s.definitions.iter().find(|d| d.name.ends_with(".c"));
        assert!(
            def.is_none(),
            "nested member receiver should be skipped; got: {:?}",
            def
        );
    }

    #[test]
    fn func_prop_prototype_function_assignment_is_not_a_method() {
        // `C.prototype = function(){}` matches neither the prototype object-literal
        // pattern (rhs must be an object) nor the func-prop pattern (property must
        // not be `prototype`). No definition should be emitted.
        let s = parse_js(
            "function C() {}\n\
             C.prototype = function() {};",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.prototype");
        assert!(
            def.is_none(),
            "C.prototype function assignment should not emit a method; got: {:?}",
            def
        );
    }

    #[test]
    fn prototype_direct_arrow_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.bar = (a, b) => a > 0 ? a : b;",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "C.bar")
            .expect("C.bar missing");
        assert!(
            def.complexity.is_some(),
            "C.bar arrow should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.bar arrow should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "a"),
            "C.bar should have parameter 'a'; got: {:?}",
            children
        );
        assert!(
            children.iter().any(|c| c.name == "b"),
            "C.bar should have parameter 'b'; got: {:?}",
            children
        );
    }

    #[test]
    fn prototype_object_literal_method_definition_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype = {\n\
               greet(name) { if (true) { return 'hi'; } return ''; },\n\
             };",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "C.greet")
            .expect("C.greet missing");
        assert!(
            def.complexity.is_some(),
            "C.greet should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.greet should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "name"),
            "C.greet should have parameter 'name'; got: {:?}",
            children
        );
    }

    #[test]
    fn prototype_object_literal_pair_fn_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype = {\n\
               bar: function(n) { if (true) { return 1; } return 0; },\n\
             };",
        );
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "C.bar")
            .expect("C.bar missing");
        assert!(
            def.complexity.is_some(),
            "C.bar should have complexity metrics"
        );
        assert!(def.cfg.is_some(), "C.bar should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "n"),
            "C.bar should have parameter 'n'; got: {:?}",
            children
        );
    }

    /// Phase 8.3e: Object.defineProperty seeds composite type_map key.
    #[test]
    fn type_map_from_define_property() {
        let s = parse_js(
            "function f1() {}\n\
             const obj = {};\n\
             Object.defineProperty(obj, \"f\", { value: f1 });",
        );
        let entry = s.type_map.iter().find(|e| e.name == "obj.f");
        assert!(
            entry.is_some(),
            "type_map should contain 'obj.f'; got: {:?}",
            s.type_map
        );
        assert_eq!(entry.unwrap().type_name, "f1");
    }

    /// Phase 8.3e: Object.defineProperties seeds composite type_map keys.
    #[test]
    fn type_map_from_define_properties() {
        let s = parse_js(
            "function f1() {}\n\
             function f2() {}\n\
             const obj = {};\n\
             Object.defineProperties(obj, {\n\
               \"f1\": { value: f1 },\n\
               \"f2\": { value: f2 },\n\
             });",
        );
        let e1 = s.type_map.iter().find(|e| e.name == "obj.f1");
        let e2 = s.type_map.iter().find(|e| e.name == "obj.f2");
        assert!(
            e1.is_some(),
            "type_map should contain 'obj.f1'; got: {:?}",
            s.type_map
        );
        assert!(
            e2.is_some(),
            "type_map should contain 'obj.f2'; got: {:?}",
            s.type_map
        );
        assert_eq!(e1.unwrap().type_name, "f1");
        assert_eq!(e2.unwrap().type_name, "f2");
    }

    /// Phase 8.3e: Object.create seeds composite type_map keys from shorthand proto.
    #[test]
    fn type_map_from_object_create() {
        let s = parse_js(
            "function f1() {}\n\
             function f2() {}\n\
             const obj = Object.create({ f1, f2 });",
        );
        let e1 = s.type_map.iter().find(|e| e.name == "obj.f1");
        let e2 = s.type_map.iter().find(|e| e.name == "obj.f2");
        assert!(
            e1.is_some(),
            "type_map should contain 'obj.f1'; got: {:?}",
            s.type_map
        );
        assert!(
            e2.is_some(),
            "type_map should contain 'obj.f2'; got: {:?}",
            s.type_map
        );
        assert_eq!(e1.unwrap().type_name, "f1");
        assert_eq!(e2.unwrap().type_name, "f2");
    }

    /// Object literal shorthand method `{ f() {} }` must produce BOTH a bare `f(method)` node
    /// AND a qualified `o1.f(function)` node — both emitted inline together by
    /// extract_object_literal_functions (see is_object_literal_declarator_method), with the
    /// bare node appearing FIRST. findCaller's equal-span tie-break keeps the first entry, so
    /// `f(method)` wins for call attribution — matching WASM's extractObjectLiteralFunctions,
    /// which emits both in the same relative order. Issue #1538, #1818.
    #[test]
    fn object_literal_shorthand_method_bare_node_precedes_qualified() {
        let s = parse_js(
            "const o1 = {\n\
               f() { this.g(); },\n\
               g() { return 1; },\n\
             };",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| (&d.name, &d.kind)).collect();
        let f_bare_pos = s
            .definitions
            .iter()
            .position(|d| d.name == "f" && d.kind == "method");
        let g_bare_pos = s
            .definitions
            .iter()
            .position(|d| d.name == "g" && d.kind == "method");
        let f_qual_pos = s
            .definitions
            .iter()
            .position(|d| d.name == "o1.f" && d.kind == "function");
        let g_qual_pos = s
            .definitions
            .iter()
            .position(|d| d.name == "o1.g" && d.kind == "function");
        assert!(
            f_bare_pos.is_some(),
            "bare f(method) missing; got: {:?}",
            names
        );
        assert!(
            g_bare_pos.is_some(),
            "bare g(method) missing; got: {:?}",
            names
        );
        assert!(
            f_qual_pos.is_some(),
            "qualified o1.f(function) missing; got: {:?}",
            names
        );
        assert!(
            g_qual_pos.is_some(),
            "qualified o1.g(function) missing; got: {:?}",
            names
        );
        assert!(
            f_bare_pos.unwrap() < f_qual_pos.unwrap(),
            "f(method) at {} must precede o1.f(function) at {} — equal-span tie-break",
            f_bare_pos.unwrap(),
            f_qual_pos.unwrap()
        );
        assert!(
            g_bare_pos.unwrap() < g_qual_pos.unwrap(),
            "g(method) at {} must precede o1.g(function) at {}",
            g_bare_pos.unwrap(),
            g_qual_pos.unwrap()
        );
        // typeMap entry must point to bare name for two-step accessor dispatch.
        let tm_f = s.type_map.iter().find(|e| e.name == "o1.f");
        assert!(tm_f.is_some(), "typeMap o1.f missing");
        assert_eq!(tm_f.unwrap().type_name, "f");
    }

    /// Issue #1764: a computed string-literal pair key (`['foo']: () => {}`) must resolve to
    /// the plain qualified name `obj.foo`, not the raw bracket/quote text `obj.['foo']` — the
    /// same unwrapping `resolve_method_def_name` already applies to method_definition keys.
    #[test]
    fn computed_string_literal_pair_key_resolves_to_plain_name() {
        let s = parse_js(
            "const obj = {\n\
               ['foo']: () => { return 1; },\n\
               bar: () => { return 2; },\n\
             };\n\
             obj.foo();\n\
             obj.bar();",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"obj.foo"),
            "expected 'obj.foo'; got: {:?}",
            names
        );
        assert!(
            names.contains(&"obj.bar"),
            "expected 'obj.bar'; got: {:?}",
            names
        );
        assert!(
            !names.iter().any(|n| n.contains('[')),
            "no definition name should retain the bracketed/quoted form; got: {:?}",
            names
        );
    }

    /// Issue #2033: an object literal returned from a factory function's body must be
    /// qualified against the factory's name, exactly like a `const x = {...}` declarator
    /// — so calls inside a returned property's closure attribute to the qualified
    /// property, not the enclosing factory (which never itself executes that call; only
    /// invoking the returned object's property does).
    #[test]
    fn return_statement_object_literal_qualifies_against_factory_name() {
        let s = parse_js(
            "function computeDeltaCPM(s, v) { return s + v; }\n\
             function computeDeltaModularity(s, v) { return s * v; }\n\
             function makePartition(seed) {\n\
               const s = seed;\n\
               return {\n\
                 deltaCPM: (v) => computeDeltaCPM(s, v),\n\
                 deltaModularity: (v) => computeDeltaModularity(s, v),\n\
               };\n\
             }\n\
             function useIt() {\n\
               const p = makePartition(42);\n\
               return p.deltaModularity(1);\n\
             }",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"makePartition.deltaCPM"),
            "expected qualified 'makePartition.deltaCPM' definition; got: {:?}",
            names
        );
        assert!(
            names.contains(&"makePartition.deltaModularity"),
            "expected qualified 'makePartition.deltaModularity' definition; got: {:?}",
            names
        );
        // typeMap entries mirror the const-case seeding, so `p.deltaModularity(1)`
        // can resolve through the qualified definition once `p` is typed as
        // `makePartition` (via the self-type return-type inference below).
        let tm = s
            .type_map
            .iter()
            .find(|e| e.name == "makePartition.deltaModularity");
        assert!(
            tm.is_some(),
            "typeMap 'makePartition.deltaModularity' missing; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "makePartition.deltaModularity");
        // Self-referential return-type inference: makePartition's body directly
        // returns an object literal with callable properties, so its own name
        // becomes its inferred return type (mirrors `return new Ctor()` inference).
        let rt = s.return_type_map.iter().find(|e| e.name == "makePartition");
        assert!(
            rt.is_some(),
            "return_type_map 'makePartition' missing; got: {:?}",
            s.return_type_map
        );
        assert_eq!(rt.unwrap().type_name, "makePartition");
        // Same-file Phase 8.2 propagation: `const p = makePartition(42)` resolves
        // `p`'s type from makePartition's self-typed return_type_map entry above,
        // so `p.deltaModularity(1)` in useIt can resolve through the qualified
        // definition (confirmed end-to-end via the resolver, not re-tested here).
        let p_type = s.type_map.iter().find(|e| e.name == "p");
        assert!(
            p_type.is_some(),
            "type_map 'p' missing; got: {:?}",
            s.type_map
        );
        assert_eq!(p_type.unwrap().type_name, "makePartition");
    }

    /// Issue #2033 follow-up: an async factory's runtime return value is a Promise
    /// wrapper around the returned expression, not the expression itself — so
    /// `const p = makePartitionAsync(seed); p.deltaCPM(...)` must NOT resolve `p` as
    /// `makePartitionAsync` (that would skip the required `await`). The qualified
    /// property definition itself is still extracted; only self-typing is skipped.
    #[test]
    fn does_not_self_type_an_async_factory_function() {
        let s = parse_js(
            "async function makePartitionAsync(seed) {\n\
               return { deltaCPM: (v) => v + seed };\n\
             }",
        );
        assert!(
            s.return_type_map
                .iter()
                .all(|e| e.name != "makePartitionAsync"),
            "async factory must not be self-typed; got: {:?}",
            s.return_type_map
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"makePartitionAsync.deltaCPM"),
            "expected qualified 'makePartitionAsync.deltaCPM' definition; got: {:?}",
            names
        );
    }

    /// Same as above, for a generator factory (`function*`) — its runtime return
    /// value is a Generator object, not the returned expression directly.
    #[test]
    fn does_not_self_type_a_generator_factory_function() {
        let s = parse_js(
            "function* makePartitionGen(seed) {\n\
               return { deltaCPM: (v) => v + seed };\n\
             }",
        );
        assert!(
            s.return_type_map
                .iter()
                .all(|e| e.name != "makePartitionGen"),
            "generator factory must not be self-typed; got: {:?}",
            s.return_type_map
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"makePartitionGen.deltaCPM"),
            "expected qualified 'makePartitionGen.deltaCPM' definition; got: {:?}",
            names
        );
    }

    /// Regression guard for the pre-existing `return new Ctor()` inference, which has
    /// the identical async-wrapper flaw and is gated by the same
    /// is_async_function_node/is_generator_function_node check.
    #[test]
    fn does_not_apply_return_new_constructor_self_typing_to_an_async_function() {
        let s = parse_js(
            "class Foo {}\n\
             async function makeFoo() {\n\
               return new Foo();\n\
             }",
        );
        assert!(
            s.return_type_map.iter().all(|e| e.name != "makeFoo"),
            "async function must not get return-new-Constructor type inference; got: {:?}",
            s.return_type_map
        );
    }

    /// Issue #1764: a non-string computed pair key (`[Symbol.iterator]: () => {}`) has no
    /// statically resolvable name — the pair must be skipped entirely, mirroring
    /// method_definition's existing precedent for the same computed-key shape.
    #[test]
    fn non_string_computed_pair_key_is_skipped() {
        let s = parse_js(
            "const obj = {\n\
               [Symbol.iterator]: () => { return 1; },\n\
               bar: () => { return 2; },\n\
             };",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            !names.iter().any(|n| n.contains("iterator")),
            "non-string computed key must not produce a definition; got: {:?}",
            names
        );
        assert!(
            names.contains(&"obj.bar"),
            "expected 'obj.bar'; got: {:?}",
            names
        );
    }

    /// Issue #1944: a plain quoted (non-computed) method key (`'foo'() {}`, kind `"string"`,
    /// distinct from `computed_property_name`) must have its quotes stripped, not stored as
    /// the literal `'foo'` — mirrors the computed-key unwrapping `resolve_method_def_name`
    /// already applies, extended to the plain-string branch.
    #[test]
    fn quoted_plain_method_key_resolves_to_plain_name() {
        let s = parse_js("class A {\n  'foo'() { return 1; }\n}");
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"A.foo"),
            "expected 'A.foo'; got: {:?}",
            names
        );
        assert!(
            !names.iter().any(|n| n.contains('\'')),
            "no definition name should retain the quoted form; got: {:?}",
            names
        );
    }

    /// Issue #1944: same quote-stripping for a plain quoted object-literal method shorthand key.
    #[test]
    fn quoted_plain_object_literal_method_key_resolves_to_plain_name() {
        let s = parse_js("const obj = { 'quoted'() { return 1; } };");
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"obj.quoted"),
            "expected 'obj.quoted'; got: {:?}",
            names
        );
        assert!(
            !names.iter().any(|n| n.contains('\'')),
            "no definition name should retain the quoted form; got: {:?}",
            names
        );
    }

    /// Issue #1764: the same computed-key unwrapping must apply to `let`/`var` object literals,
    /// not just `const` — both now go through extract_object_literal_functions inline.
    #[test]
    fn computed_string_literal_pair_key_resolves_for_let_and_var() {
        let s = parse_js(
            "let obj2 = { ['computedLet']: () => {}, plain: () => {} };\n\
             var obj3 = { ['computedVar']: () => {} };",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"obj2.computedLet"),
            "expected 'obj2.computedLet'; got: {:?}",
            names
        );
        assert!(
            names.contains(&"obj2.plain"),
            "expected 'obj2.plain'; got: {:?}",
            names
        );
        assert!(
            names.contains(&"obj3.computedVar"),
            "expected 'obj3.computedVar'; got: {:?}",
            names
        );
    }

    /// Issue #1884: `seed_object_create_entries`'s pair arm must unwrap a computed
    /// string-literal key (`Object.create({ ['foo']: fn })`) instead of falling back to the
    /// raw bracket/quote source text.
    #[test]
    fn computed_key_in_object_create_resolves() {
        let s = parse_js(
            "function fn() {}\n\
             const obj = Object.create({ ['foo']: fn });",
        );
        let entry = s.type_map.iter().find(|e| e.name == "obj.foo");
        assert!(
            entry.is_some(),
            "type_map should contain 'obj.foo'; got: {:?}",
            s.type_map
        );
        assert_eq!(entry.unwrap().type_name, "fn");
    }

    /// Issue #1884: `seed_descriptor_object`'s pair arm (Object.defineProperties) must unwrap
    /// a computed string-literal key instead of falling back to the raw bracket/quote text.
    #[test]
    fn computed_key_in_define_properties_resolves() {
        let s = parse_js(
            "function f1() {}\n\
             const obj = {};\n\
             Object.defineProperties(obj, { ['foo']: { value: f1 } });",
        );
        let entry = s.type_map.iter().find(|e| e.name == "obj.foo");
        assert!(
            entry.is_some(),
            "type_map should contain 'obj.foo'; got: {:?}",
            s.type_map
        );
        assert_eq!(entry.unwrap().type_name, "f1");
    }

    /// Issue #1884: a non-string computed key in Object.defineProperties has no statically
    /// resolvable name — must be skipped rather than emitting a garbled entry.
    #[test]
    fn non_string_computed_key_in_define_properties_skipped() {
        let s = parse_js(
            "function f1() {}\n\
             const obj = {};\n\
             Object.defineProperties(obj, { [Symbol.iterator]: { value: f1 } });",
        );
        assert!(
            !s.type_map.iter().any(|e| e.name.contains("Symbol")),
            "non-string computed key must not produce a type_map entry; got: {:?}",
            s.type_map
        );
    }

    /// Issue #1884: `seed_objlit_type_map_entries`'s pair arm (let/var object literals) must
    /// unwrap a computed string-literal key instead of falling back to the raw bracket/quote text.
    #[test]
    fn computed_key_in_let_objlit_pair_seeds_type_map() {
        let s = parse_js(
            "function handler() {}\n\
             var routes = { ['get']: handler };",
        );
        let entry = s.type_map.iter().find(|e| e.name == "routes.get");
        assert!(
            entry.is_some(),
            "type_map should contain 'routes.get'; got: {:?}",
            s.type_map
        );
        assert_eq!(entry.unwrap().type_name, "handler");
    }

    /// Issue #1884: `extract_js_prototype_object_literal`'s pair arm must unwrap a computed
    /// string-literal key instead of falling back to the raw bracket/quote text.
    #[test]
    fn computed_key_in_prototype_object_literal_pair_resolves() {
        let s = parse_js(
            "function helper() {}\n\
             function C() {}\n\
             C.prototype = { ['run']: helper };",
        );
        let entry = s.type_map.iter().find(|e| e.name == "C.run");
        assert!(
            entry.is_some(),
            "type_map should contain 'C.run'; got: {:?}",
            s.type_map
        );
        assert_eq!(entry.unwrap().type_name, "helper");
    }

    /// Issue #1884: a computed string-literal pair key with a function value in a prototype
    /// object literal must emit a method definition under the plain qualified name.
    #[test]
    fn computed_key_in_prototype_object_literal_pair_fn_value_emits_definition() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype = { ['foo']: function() { return 1; } };",
        );
        let names: Vec<_> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(
            names.contains(&"C.foo"),
            "expected 'C.foo'; got: {:?}",
            names
        );
    }

    /// Issue #1884: `collect_object_rest_params`'s pair arm previously skipped ALL computed
    /// keys, including resolvable string literals — it must now unwrap them the same way
    /// `resolve_pair_key_name` does elsewhere, instead of blanket-skipping.
    #[test]
    fn computed_string_literal_key_unwrapped_for_object_rest_param_binding() {
        let s = parse_js(
            "const api = {\n\
               ['process']: function({ items, ...rest }) {\n\
                 rest.flush();\n\
               }\n\
             };",
        );
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "process");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        let b = b.unwrap();
        assert_eq!(b.rest_name, "rest");
        assert_eq!(b.arg_index, 0);
    }

    /// Issue #1884: a non-string computed key must still be skipped for rest-param binding
    /// extraction — there's no statically resolvable callee name to bind against.
    #[test]
    fn non_string_computed_key_still_skipped_for_object_rest_param_binding() {
        let s = parse_js(
            "const api = {\n\
               [Symbol.iterator]: function({ ...rest }) {\n\
                 rest.flush();\n\
               }\n\
             };",
        );
        assert!(
            !s.object_rest_param_bindings
                .iter()
                .any(|b| b.rest_name == "rest"),
            "non-string computed key must not produce a binding; got: {:?}",
            s.object_rest_param_bindings
        );
    }

    /// Issue #1551: `let` and `var` object-literal declarations must seed composite typeMap keys
    /// just like `const` declarations. Regression test for the parity gap where native bailed
    /// early for non-`const` declarations in the object-literal typeMap walk.
    #[test]
    fn let_var_objlit_seeds_type_map_entries() {
        // Method shorthand: `let obj = { f() {} }` → typeMap['obj.f'] present
        let s_let_method = parse_js(
            "let obj = { f() { return 1; } };\n\
             obj.f();",
        );
        let tm = s_let_method.type_map.iter().find(|e| e.name == "obj.f");
        assert!(
            tm.is_some(),
            "let obj method: typeMap 'obj.f' missing; got: {:?}",
            s_let_method
                .type_map
                .iter()
                .map(|e| &e.name)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            tm.unwrap().type_name,
            "f",
            "typeMap 'obj.f' must point at bare name 'f', not the qualified key"
        );
        let call = s_let_method
            .calls
            .iter()
            .find(|c| c.name == "f" && c.receiver.as_deref() == Some("obj"));
        assert!(
            call.is_some(),
            "calls must contain obj.f() with receiver='obj'; got: {:?}",
            s_let_method
                .calls
                .iter()
                .map(|c| (&c.name, &c.receiver))
                .collect::<Vec<_>>()
        );

        // Shorthand property: `var obj = { e4 }` → typeMap['obj.e4'] = 'e4'
        let s_var_shorthand = parse_js(
            "function e4() {}\n\
             var obj = { e4 };",
        );
        let tm2 = s_var_shorthand.type_map.iter().find(|e| e.name == "obj.e4");
        assert!(
            tm2.is_some(),
            "var obj shorthand: typeMap 'obj.e4' missing; got: {:?}",
            s_var_shorthand
                .type_map
                .iter()
                .map(|e| &e.name)
                .collect::<Vec<_>>()
        );
        assert_eq!(tm2.unwrap().type_name, "e4");

        // Pair with identifier value: `var routes = { get: handler }` → typeMap['routes.get'] = 'handler'
        let s_var_pair = parse_js(
            "function handler() {}\n\
             var routes = { get: handler };",
        );
        let tm3 = s_var_pair.type_map.iter().find(|e| e.name == "routes.get");
        assert!(
            tm3.is_some(),
            "var routes pair: typeMap 'routes.get' missing; got: {:?}",
            s_var_pair
                .type_map
                .iter()
                .map(|e| &e.name)
                .collect::<Vec<_>>()
        );
        assert_eq!(tm3.unwrap().type_name, "handler");

        // Pair with arrow value: `let api = { save: () => {} }` → typeMap['api.save'] = 'api.save'
        // and a qualified definition 'api.save' must exist (emitted inline by
        // extract_object_literal_functions, called from handle_var_decl's let/var branch).
        let s_let_arrow = parse_js(
            "let api = { save: () => {} };\n\
             api.save();",
        );
        let tm4 = s_let_arrow.type_map.iter().find(|e| e.name == "api.save");
        assert!(
            tm4.is_some(),
            "let api arrow: typeMap 'api.save' missing; got: {:?}",
            s_let_arrow
                .type_map
                .iter()
                .map(|e| &e.name)
                .collect::<Vec<_>>()
        );
        assert_eq!(tm4.unwrap().type_name, "api.save",
            "typeMap 'api.save' must point at the qualified name 'api.save' (qualified definition exists)");
        assert!(
            s_let_arrow.definitions.iter().any(|d| d.name == "api.save"),
            "let api arrow: qualified definition 'api.save' missing; got: {:?}",
            s_let_arrow
                .definitions
                .iter()
                .map(|d| &d.name)
                .collect::<Vec<_>>()
        );
        let call4 = s_let_arrow
            .calls
            .iter()
            .find(|c| c.name == "save" && c.receiver.as_deref() == Some("api"));
        assert!(
            call4.is_some(),
            "calls must contain api.save() with receiver='api'; got: {:?}",
            s_let_arrow
                .calls
                .iter()
                .map(|c| (&c.name, &c.receiver))
                .collect::<Vec<_>>()
        );

        // Scope guard: object literal inside a function body must NOT seed module-level typeMap.
        let s_scoped = parse_js(
            "function init() {\n\
               let local = { run() {} };\n\
               local.run();\n\
             }",
        );
        assert!(
            s_scoped.type_map.iter().all(|e| e.name != "local.run"),
            "function-scoped let obj must not pollute typeMap; got: {:?}",
            s_scoped
                .type_map
                .iter()
                .map(|e| &e.name)
                .collect::<Vec<_>>()
        );
    }

    /// Phase 8.3e: call receiver is correctly recorded for obj.f() inside defProp body.
    #[test]
    fn call_receiver_for_define_property() {
        let s = parse_js(
            "function f1() {}\n\
             function defProp() {\n\
               const obj = {};\n\
               Object.defineProperty(obj, \"f\", { value: f1 });\n\
               obj.f();\n\
             }",
        );
        let tm = s.type_map.iter().find(|e| e.name == "obj.f");
        assert!(
            tm.is_some(),
            "type_map should contain 'obj.f'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "f1");

        let call = s
            .calls
            .iter()
            .find(|c| c.name == "f" && c.receiver.as_deref() == Some("obj"));
        assert!(
            call.is_some(),
            "calls should contain obj.f() with receiver='obj'; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, &c.receiver))
                .collect::<Vec<_>>()
        );
    }

    // ── Pts binding collectors (parity with src/extractors/javascript.ts) ───

    #[test]
    fn param_binding_recorded_for_identifier_args() {
        let s = parse_js(
            "function target() {}\n\
             function hof(cb) { cb(); }\n\
             hof(target);",
        );
        let b = s
            .param_bindings
            .iter()
            .find(|b| b.callee == "hof" && b.arg_name == "target");
        assert!(
            b.is_some(),
            "param_bindings should contain hof←target; got: {:?}",
            s.param_bindings
        );
        assert_eq!(b.unwrap().arg_index, 0);
    }

    #[test]
    fn param_binding_inline_spread_array_expands_elements() {
        let s = parse_js(
            "function a() {}\n\
             function b() {}\n\
             function pair(x, y) { x(); y(); }\n\
             pair(...[a, b]);",
        );
        let idx: Vec<(u32, &str)> = s
            .param_bindings
            .iter()
            .filter(|p| p.callee == "pair")
            .map(|p| (p.arg_index, p.arg_name.as_str()))
            .collect();
        assert!(idx.contains(&(0, "a")), "expected (0, a); got: {:?}", idx);
        assert!(idx.contains(&(1, "b")), "expected (1, b); got: {:?}", idx);
    }

    #[test]
    fn this_call_binding_recorded_for_call_and_apply() {
        let s = parse_js(
            "function f() { this(); }\n\
             function ctx() {}\n\
             f.call(ctx);\n\
             f.apply(ctx);",
        );
        let bindings: Vec<(&str, &str)> = s
            .this_call_bindings
            .iter()
            .map(|b| (b.callee.as_str(), b.this_arg.as_str()))
            .collect();
        assert_eq!(
            bindings.iter().filter(|b| **b == ("f", "ctx")).count(),
            2,
            "expected f→ctx from both .call and .apply; got: {:?}",
            bindings
        );
        // `this()` inside f must be recorded as a call named "this".
        assert!(
            s.calls.iter().any(|c| c.name == "this"),
            "calls should contain bare this(); got: {:?}",
            s.calls.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
    }

    #[test]
    fn this_call_binding_skips_null_and_undefined() {
        let s = parse_js(
            "function f() {}\n\
             f.call(null);\n\
             f.apply(undefined);",
        );
        assert!(
            s.this_call_bindings.is_empty(),
            "null/undefined this-args must not bind; got: {:?}",
            s.this_call_bindings
        );
    }

    /// `invoker.call(handler, 10)` must emit a dynamic call to `invoker` only.
    /// Emitting the identifier args too would create a false runCallThis→handler
    /// edge; the handler flow is covered by the ThisCallBinding (invoker::this).
    #[test]
    fn call_apply_bind_args_do_not_emit_callback_reference_calls() {
        let s = parse_js(
            "function invoker(x) { return this(x); }\n\
             function handler(n) { return n * 2; }\n\
             function runCallThis() { return invoker.call(handler, 10); }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "invoker" && c.dynamic == Some(true)),
            "invoker.call() should emit a dynamic call to invoker; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, c.dynamic))
                .collect::<Vec<_>>()
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "handler"),
            ".call() args must not become callback-reference calls; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, c.dynamic))
                .collect::<Vec<_>>()
        );
        let b = s.this_call_bindings.iter().find(|b| b.callee == "invoker");
        assert!(
            b.is_some(),
            "this_call_bindings should contain invoker→handler; got: {:?}",
            s.this_call_bindings
        );
        assert_eq!(b.unwrap().this_arg, "handler");
    }

    /// `this(b)` must NOT emit `b` as a dynamic callback-reference call.
    /// Without the early-return guard, `b` would be emitted as a dynamic call
    /// and the pts resolver would match any globally-defined function named `b`,
    /// producing false cross-file call edges (issue #1543).
    #[test]
    fn this_call_args_do_not_emit_callback_reference_calls() {
        let s = parse_js(
            "function foo(b) { return this(b); }\n\
             foo.call((a) => a, () => {});",
        );
        assert!(
            s.calls.iter().any(|c| c.name == "this"),
            "this() must be recorded; got: {:?}",
            s.calls.iter().map(|c| &c.name).collect::<Vec<_>>()
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "b"),
            "argument `b` of this(b) must not become a callback-reference call; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, c.dynamic))
                .collect::<Vec<_>>()
        );
    }

    /// `super(a, b)` must NOT emit `a` or `b` as dynamic callback-reference calls.
    /// Same root cause as this(b): the callee `super` is not a named identifier,
    /// so extract_callback_reference_calls must not run on the arguments.
    #[test]
    fn super_call_args_do_not_emit_callback_reference_calls() {
        let s = parse_js(
            "class E { constructor(c, d) { this.cc = c; this.dd = d; } }\n\
             class G extends E {\n\
               constructor(a, b) { super(a, b); }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "a"),
            "argument `a` of super(a, b) must not become a callback-reference call; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, c.dynamic))
                .collect::<Vec<_>>()
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "b"),
            "argument `b` of super(a, b) must not become a callback-reference call; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, c.dynamic))
                .collect::<Vec<_>>()
        );
    }

    /// Bare `super(...)` must be extracted as a `constructor` call with
    /// receiver `super`, mirroring `super.method()` — the this/super hierarchy
    /// dispatch (WASM-mirrored `resolveThisDispatch`) then attributes it to the
    /// parent class's constructor (#1929).
    #[test]
    fn bare_super_call_extracted_as_constructor_call() {
        let s = parse_js(
            "class E { constructor(c) { this.cc = c; } }\n\
             class G extends E {\n\
               constructor(a) { super(a); }\n\
             }",
        );
        let super_call = s
            .calls
            .iter()
            .find(|c| c.name == "constructor" && c.receiver.as_deref() == Some("super"));
        assert!(
            super_call.is_some(),
            "bare super(...) must be recorded as a constructor call with receiver=super; got: {:?}",
            s.calls
                .iter()
                .map(|c| (&c.name, &c.receiver))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn array_elem_bindings_recorded() {
        let s = parse_js(
            "function fn1() {}\n\
             function fn2() {}\n\
             const arr = [fn1, fn2];",
        );
        let got: Vec<(u32, &str)> = s
            .array_elem_bindings
            .iter()
            .filter(|b| b.array_name == "arr")
            .map(|b| (b.index, b.elem_name.as_str()))
            .collect();
        assert!(
            got.contains(&(0, "fn1")),
            "expected (0, fn1); got: {:?}",
            got
        );
        assert!(
            got.contains(&(1, "fn2")),
            "expected (1, fn2); got: {:?}",
            got
        );
    }

    #[test]
    fn spread_arg_binding_recorded() {
        let s = parse_js(
            "function callAll(a, b) { a(); b(); }\n\
             const fns = [x, y];\n\
             callAll(...fns);",
        );
        let b = s.spread_arg_bindings.iter().find(|b| b.callee == "callAll");
        assert!(
            b.is_some(),
            "spread_arg_bindings missing; got: {:?}",
            s.spread_arg_bindings
        );
        let b = b.unwrap();
        assert_eq!(b.array_name, "fns");
        assert_eq!(b.start_index, 0);
    }

    #[test]
    fn collection_wrap_set_emits_wildcard_fn_ref_binding() {
        let s = parse_js(
            "const arr = [f1];\n\
             const wrapped = new Set(arr);",
        );
        let b = s.fn_ref_bindings.iter().find(|b| b.lhs == "wrapped[*]");
        assert!(
            b.is_some(),
            "Set wrap should bind wrapped[*] ⊇ arr[*]; got: {:?}",
            s.fn_ref_bindings
        );
        assert_eq!(b.unwrap().rhs, "arr[*]");
    }

    #[test]
    fn for_of_binding_records_enclosing_func() {
        let s = parse_js(
            "function run(handlers) {\n\
               for (const h of handlers) { h(); }\n\
             }",
        );
        let b = s.for_of_bindings.iter().find(|b| b.var_name == "h");
        assert!(
            b.is_some(),
            "for_of_bindings missing; got: {:?}",
            s.for_of_bindings
        );
        let b = b.unwrap();
        assert_eq!(b.source_name, "handlers");
        assert_eq!(b.enclosing_func, "run");
    }

    #[test]
    fn for_of_binding_in_method_uses_class_qualified_context() {
        let s = parse_js(
            "class Runner {\n\
               runAll() { for (const h of this.handlers) {} const x = 1; for (const g of list) { g(); } }\n\
             }",
        );
        let b = s.for_of_bindings.iter().find(|b| b.var_name == "g");
        assert!(
            b.is_some(),
            "for_of_bindings missing for g; got: {:?}",
            s.for_of_bindings
        );
        assert_eq!(b.unwrap().enclosing_func, "Runner.runAll");
    }

    #[test]
    fn for_of_binding_at_module_level_uses_module_context() {
        let s = parse_js("for (const cb of callbacks) { cb(); }");
        let b = s.for_of_bindings.iter().find(|b| b.var_name == "cb");
        assert!(
            b.is_some(),
            "for_of_bindings missing; got: {:?}",
            s.for_of_bindings
        );
        assert_eq!(b.unwrap().enclosing_func, "<module>");
    }

    #[test]
    fn array_from_callback_binding_recorded() {
        let s = parse_js(
            "function makeThing(x) { return x; }\n\
             const things = Array.from(items, makeThing);",
        );
        let b = s
            .array_callback_bindings
            .iter()
            .find(|b| b.callee_name == "makeThing");
        assert!(
            b.is_some(),
            "array_callback_bindings missing; got: {:?}",
            s.array_callback_bindings
        );
        assert_eq!(b.unwrap().source_name, "items");
    }

    #[test]
    fn object_rest_param_binding_recorded() {
        let s = parse_js("function f3({ e1, ...eerest }) { eerest.e4(); }");
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "f3");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        let b = b.unwrap();
        assert_eq!(b.rest_name, "eerest");
        assert_eq!(b.arg_index, 0);
    }

    #[test]
    fn object_rest_param_binding_in_method_uses_class_context() {
        let s = parse_js(
            "class Svc {\n\
               handle({ id, ...rest }) { rest.go(); }\n\
             }",
        );
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.rest_name == "rest");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        assert_eq!(b.unwrap().callee, "Svc.handle");
    }

    // #2080: TypeScript wraps EVERY parameter (typed or not) in a
    // required_parameter/optional_parameter node, unlike plain JS where the
    // object_pattern is a direct formal_parameters child. Without unwrapping
    // that wrapper, object_rest_param_bindings was never recorded for any
    // .ts/.tsx file at all — not just ones using a type annotation.
    #[test]
    fn object_rest_param_binding_recorded_in_typescript_without_type_annotation() {
        let s = parse_ts("function f3({ e1, ...eerest }) { eerest.e4(); }");
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "f3");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        assert_eq!(b.unwrap().rest_name, "eerest");
    }

    #[test]
    fn object_rest_param_binding_recorded_in_typescript_with_type_annotation() {
        let s = parse_ts("function dispatchRest({ ...rest }: IWorker) { rest.doWork(); }");
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "dispatchRest");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        assert_eq!(b.unwrap().rest_name, "rest");
    }

    // #2080: a type-annotated object-rest parameter (`{ ...rest }: IWorker`)
    // should seed a direct type_map entry on the rest binding's own name,
    // the same way a plain typed parameter (`worker: IWorker`) does — so
    // CHA/interface dispatch through the rest binding can resolve.
    #[test]
    fn object_rest_param_type_annotation_seeds_type_map() {
        let s = parse_ts("function dispatchRest({ ...rest }: IWorker) { rest.doWork(); }");
        let tm = s.type_map.iter().find(|t| t.name == "rest");
        assert!(
            tm.is_some(),
            "type_map should contain an entry for 'rest'; got: {:?}",
            s.type_map
        );
        assert_eq!(tm.unwrap().type_name, "IWorker");
        assert_eq!(tm.unwrap().confidence, 0.9);
    }

    #[test]
    fn object_rest_param_without_type_annotation_does_not_seed_type_map() {
        let s = parse_ts("function f3({ ...rest }) { rest.go(); }");
        let tm = s.type_map.iter().find(|t| t.name == "rest");
        assert!(
            tm.is_none(),
            "type_map should not contain an entry for untyped 'rest'; got: {:?}",
            s.type_map
        );
    }

    // #2080 review (Greptile): a named property alongside the rest element
    // excludes that property from rest's real type (`Omit<IWorker,
    // 'doWork'>`), so seeding the full IWorker type onto `rest` would let a
    // call like `rest.doWork()` — invalid, since doWork was destructured
    // away — falsely resolve via CHA dispatch.
    #[test]
    fn object_rest_param_with_sibling_property_does_not_seed_full_type() {
        let s = parse_ts("function f({ doWork, ...rest }: IWorker) { rest.other(); }");
        let tm = s.type_map.iter().find(|t| t.name == "rest");
        assert!(
            tm.is_none(),
            "type_map should not seed the full annotation type onto 'rest' when a sibling property is destructured out; got: {:?}",
            s.type_map
        );
    }

    // #2235: a same-named parameter/local in two different functions in the
    // same file collides under the bare typeMap key — the function-scoped
    // key (`callerName::name`) disambiguates them. Mirrors the TS test suite
    // in tests/parsers/javascript.test.ts.
    #[test]
    fn typed_parameter_seeds_a_function_scoped_key_alongside_the_bare_key() {
        let s = parse_ts("function processOrder(db: OrderDb) {}");
        let bare = s.type_map.iter().find(|t| t.name == "db");
        assert_eq!(
            bare.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("OrderDb", 0.9))
        );
        let scoped = s.type_map.iter().find(|t| t.name == "processOrder::db");
        assert_eq!(
            scoped.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("OrderDb", 0.9)),
            "expected a processOrder::db scoped entry; got: {:?}",
            s.type_map
        );
    }

    #[test]
    fn typed_local_seeds_a_function_scoped_key_alongside_the_bare_key() {
        let s = parse_ts("function makeOrder() { const db: OrderDb = getDb(); }");
        let scoped = s.type_map.iter().find(|t| t.name == "makeOrder::db");
        assert_eq!(
            scoped.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("OrderDb", 0.9)),
            "expected a makeOrder::db scoped entry; got: {:?}",
            s.type_map
        );
    }

    #[test]
    fn constructor_typed_local_seeds_a_function_scoped_key_alongside_the_bare_key() {
        let s = parse_ts("function makeOrderConn() { const conn = new OrderDb(); }");
        let scoped = s.type_map.iter().find(|t| t.name == "makeOrderConn::conn");
        assert_eq!(
            scoped.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("OrderDb", 1.0)),
            "expected a makeOrderConn::conn scoped entry; got: {:?}",
            s.type_map
        );
    }

    #[test]
    fn prevents_cross_function_collision_for_same_named_parameters() {
        let s = parse_ts(
            "function processOrder(db: OrderDb) { db.commit(); } \
             function processUser(db: UserDb) { db.commit(); }",
        );
        let order_scoped = s.type_map.iter().find(|t| t.name == "processOrder::db");
        assert_eq!(
            order_scoped.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("OrderDb", 0.9))
        );
        let user_scoped = s.type_map.iter().find(|t| t.name == "processUser::db");
        assert_eq!(
            user_scoped.map(|t| (t.type_name.as_str(), t.confidence)),
            Some(("UserDb", 0.9)),
            "expected each function to keep its own scoped entry despite the shared param name; got: {:?}",
            s.type_map
        );
    }

    // #2235: ReturnType<typeof fn>/InstanceType<typeof Ctor>/Parameters<typeof
    // fn>/ConstructorParameters<typeof Ctor> transform their argument into an
    // unrelated type — the wrapper's own name is never a legitimate receiver
    // type, unlike an ordinary generic (Map<string, number> -> Map).
    #[test]
    fn does_not_seed_a_type_map_entry_for_opaque_generic_type_transform_wrappers() {
        let s = parse_ts(
            "function processOrder(db: ReturnType<typeof makeConn>) {} \
             function processInstance(x: InstanceType<typeof Ctor>) {} \
             function processArgs(a: Parameters<typeof fn>) {} \
             function processCtorArgs(a: ConstructorParameters<typeof Ctor>) {}",
        );
        for name in ["db", "x", "a"] {
            assert!(
                s.type_map.iter().find(|t| t.name == name).is_none(),
                "expected no type_map entry for '{name}'; got: {:?}",
                s.type_map
            );
        }
    }

    // The object_rest_param_bindings extraction itself (the value-chase
    // mechanism, #1336) is unaffected by the sibling-property guard above —
    // it always recorded the rest binding regardless of sibling properties.
    #[test]
    fn object_rest_param_binding_still_recorded_with_sibling_property() {
        let s = parse_ts("function f({ doWork, ...rest }: IWorker) { rest.other(); }");
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "f");
        assert!(
            b.is_some(),
            "object_rest_param_bindings missing; got: {:?}",
            s.object_rest_param_bindings
        );
        assert_eq!(b.unwrap().rest_name, "rest");
    }

    #[test]
    fn object_prop_bindings_recorded_for_shorthand_and_pair() {
        let s = parse_js(
            "function e4() {}\n\
             function named() {}\n\
             const obj = { e4, alias: named };",
        );
        let shorthand = s
            .object_prop_bindings
            .iter()
            .find(|b| b.object_name == "obj" && b.prop_name == "e4");
        assert!(
            shorthand.is_some(),
            "shorthand binding missing; got: {:?}",
            s.object_prop_bindings
        );
        assert_eq!(shorthand.unwrap().value_name, "e4");

        let pair = s
            .object_prop_bindings
            .iter()
            .find(|b| b.object_name == "obj" && b.prop_name == "alias");
        assert!(
            pair.is_some(),
            "pair binding missing; got: {:?}",
            s.object_prop_bindings
        );
        assert_eq!(pair.unwrap().value_name, "named");
    }

    #[test]
    fn inline_new_receiver_normalized_to_constructor_name() {
        let s = parse_js(
            "class A { t() {} }\n\
             export function testPrototypeAlias() { new A().t(); }",
        );
        let call = s.calls.iter().find(|c| c.name == "t");
        assert!(call.is_some(), "t() call missing; got: {:?}", s.calls);
        assert_eq!(call.unwrap().receiver.as_deref(), Some("A"));
    }

    #[test]
    fn paren_wrapped_new_receiver_normalized_to_constructor_name() {
        let s = parse_js(
            "class Dog { bark() {} }\n\
             export function run() { (new Dog()).bark(); }",
        );
        let call = s.calls.iter().find(|c| c.name == "bark");
        assert!(call.is_some(), "bark() call missing; got: {:?}", s.calls);
        assert_eq!(call.unwrap().receiver.as_deref(), Some("Dog"));
    }

    // RES-2: inline object-literal dispatch table — `({a:fnA,b:fnB})[key]()`
    // Mirrors WASM extractSubscriptCallInfo dispatch-table branch (javascript.ts:3196–3233).
    #[test]
    fn dispatch_table_emits_dt_call_and_array_elem_bindings() {
        let s = parse_js(
            "function dtFn1() {}\n\
             function dtFn2() {}\n\
             function runDispatch(key) { ({ a: dtFn1, b: dtFn2 })[key](); }",
        );
        // The call name must be <dt_line_col>[*]
        let dt_call = s
            .calls
            .iter()
            .find(|c| c.name.starts_with("<dt_") && c.name.ends_with(">[*]"));
        assert!(
            dt_call.is_some(),
            "dispatch-table call missing; got: {:?}",
            s.calls
        );
        let dt_call = dt_call.unwrap();
        assert_eq!(dt_call.dynamic, Some(true));
        assert_eq!(dt_call.dynamic_kind.as_deref(), Some("dispatch-table"));

        // The array_elem_bindings must contain dtFn1 and dtFn2 under the same table name
        let table_name = dt_call.name.trim_end_matches("[*]");
        let elem1 = s
            .array_elem_bindings
            .iter()
            .find(|b| b.array_name == table_name && b.elem_name == "dtFn1");
        let elem2 = s
            .array_elem_bindings
            .iter()
            .find(|b| b.array_name == table_name && b.elem_name == "dtFn2");
        assert!(
            elem1.is_some(),
            "dtFn1 array_elem_binding missing; got: {:?}",
            s.array_elem_bindings
        );
        assert!(
            elem2.is_some(),
            "dtFn2 array_elem_binding missing; got: {:?}",
            s.array_elem_bindings
        );
        assert_eq!(elem1.unwrap().index, 0);
        assert_eq!(elem2.unwrap().index, 1);
    }

    #[test]
    fn dispatch_table_parenthesized_object_also_works() {
        let s = parse_js(
            "function fnA() {}\n\
             function fnB() {}\n\
             function run(k) { ({a: fnA, b: fnB})[k](); }",
        );
        let dt_call = s
            .calls
            .iter()
            .find(|c| c.name.starts_with("<dt_") && c.name.ends_with(">[*]"));
        assert!(
            dt_call.is_some(),
            "dispatch-table call missing for parenthesized object; got: {:?}",
            s.calls
        );
    }

    // ── ES6 getter/setter same-file property-read call attribution (#1893) ──

    #[test]
    fn attributes_bare_this_prop_read_to_same_class_getter() {
        let s = parse_js(
            "class Session {\n\
               get isReady() { return this._ready; }\n\
               check() { if (this.isReady) { report(); } }\n\
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "isReady" && c.receiver.as_deref() == Some("this")),
            "expected a call to isReady via this; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn attributes_bare_varname_prop_read_to_same_file_class_getter_via_type_map() {
        let s = parse_ts(
            "class Repo {\n\
               get db() { return this._db; }\n\
             }\n\
             function useRepo(repo: Repo) {\n\
               return repo.db;\n\
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "db" && c.receiver.as_deref() == Some("repo")),
            "expected a call to db via repo; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn attributes_plain_assignment_write_to_same_class_setter() {
        let s = parse_js(
            "class Toggle {\n\
               set flag(v) { this._f = v; }\n\
               reset() { this.flag = false; }\n\
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "flag" && c.receiver.as_deref() == Some("this")),
            "expected a call to flag via this; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn skips_property_with_both_getter_and_setter() {
        let s = parse_js(
            "class Toggle {\n\
               get flag() { return this._f; }\n\
               set flag(v) { this._f = v; }\n\
               flip() { this.flag = !this.flag; }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "flag"),
            "ambiguous get+set accessor must not produce a call; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn does_not_duplicate_a_real_call_to_an_accessor_name() {
        let s = parse_js(
            "class Widget {\n\
               get value() { return this._v; }\n\
             }\n\
             function useWidget(w) {\n\
               return w.value();\n\
             }",
        );
        let matches = s
            .calls
            .iter()
            .filter(|c| c.name == "value" && c.receiver.as_deref() == Some("w"))
            .count();
        assert_eq!(
            matches, 1,
            "expected exactly one call to w.value(); got: {:?}",
            s.calls
        );
    }

    #[test]
    fn does_not_attribute_plain_method_reference_as_call() {
        let s = parse_js(
            "class Widget {\n\
               render() { return 1; }\n\
             }\n\
             function useWidget(w) {\n\
               const fn = w.render;\n\
               return fn;\n\
             }",
        );
        assert!(
            !s.calls
                .iter()
                .any(|c| c.name == "render" && c.receiver.as_deref() == Some("w")),
            "plain method reference (no accessor) must not produce a call; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn recognizes_static_accessor_same_as_instance() {
        let s = parse_js(
            "class Config {\n\
               static get version() { return Config._v; }\n\
               static describe() { return this.version; }\n\
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "version" && c.receiver.as_deref() == Some("this")),
            "expected a call to version via this; got: {:?}",
            s.calls
        );
    }

    // ── Accessor registry static vs instance distinction (#2086) ──

    #[test]
    fn does_not_attribute_instance_context_this_read_to_a_static_only_accessor() {
        let s = parse_js(
            "class Config {\n\
               static get version() { return Config._v; }\n\
               static _v = '1.0';\n\
               describe() { return this.version; }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "version"),
            "this.version inside an INSTANCE method must not resolve to a \
             static-only accessor — `this` there is the instance, not the \
             class object; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn does_not_attribute_static_context_this_read_to_an_instance_only_accessor() {
        let s = parse_js(
            "class Widget {\n\
               get value() { return this._v; }\n\
               _v = 1;\n\
               static describe() { return this.value; }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "value"),
            "this.value inside a STATIC method must not resolve to an \
             instance-only accessor — `this` there is the class object, not \
             an instance; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn still_attributes_instance_context_this_read_to_an_instance_accessor() {
        let s = parse_js(
            "class Widget {\n\
               get value() { return this._v; }\n\
               _v = 1;\n\
               useOther() { return this.value; }\n\
             }",
        );
        assert!(
            s.calls
                .iter()
                .any(|c| c.name == "value" && c.receiver.as_deref() == Some("this")),
            "instance-to-instance accessor attribution must keep working; got: {:?}",
            s.calls
        );
    }

    // ── ES6 getter/setter cross-file property-read call attribution (#2030) ──

    #[test]
    fn tags_cross_file_property_read_with_get_and_resolved_class_name() {
        let s = parse_ts(
            "function useRepo(repo: SqliteRepository) {\n\
               return repo.db;\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "db" && c.receiver.as_deref() == Some("SqliteRepository"));
        assert!(
            call.is_some(),
            "expected a tagged accessor-read call to SqliteRepository.db; got: {:?}",
            s.calls
        );
        assert_eq!(call.unwrap().accessor_read.as_deref(), Some("get"));
    }

    #[test]
    fn tags_cross_file_property_write_with_set() {
        let s = parse_ts(
            "function useRepo(repo: SqliteRepository) {\n\
               repo.db = null;\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "db" && c.receiver.as_deref() == Some("SqliteRepository"));
        assert_eq!(
            call.expect("expected a tagged accessor-read call")
                .accessor_read
                .as_deref(),
            Some("set")
        );
    }

    #[test]
    fn same_file_confirmed_accessor_call_is_not_tagged() {
        let s = parse_ts(
            "class Repo {\n\
               get db() { return this._db; }\n\
             }\n\
             function useRepo(repo: Repo) {\n\
               return repo.db;\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "db" && c.receiver.as_deref() == Some("repo"));
        assert_eq!(
            call.expect("expected same-file accessor call")
                .accessor_read,
            None,
            "same-file confirmed accessor calls must not carry accessor_read"
        );
    }

    #[test]
    fn narrows_instanceof_type_for_cross_file_accessor_read() {
        let s = parse_js(
            "function useRepo(repo) {\n\
               if (repo instanceof SqliteRepository) {\n\
                 return repo.db;\n\
               }\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "db" && c.receiver.as_deref() == Some("SqliteRepository"));
        assert!(
            call.is_some(),
            "expected instanceof-narrowed type to produce a tagged accessor-read call; got: {:?}",
            s.calls
        );
    }

    #[test]
    fn narrows_instanceof_type_across_logical_and_chain() {
        let s = parse_js(
            "function useRepo(x, repo) {\n\
               if (x && repo instanceof SqliteRepository) {\n\
                 return repo.db;\n\
               }\n\
             }",
        );
        let call = s.calls.iter().find(|c| c.name == "db");
        assert_eq!(
            call.expect("expected a call to db").receiver.as_deref(),
            Some("SqliteRepository")
        );
    }

    #[test]
    fn does_not_narrow_instanceof_type_across_logical_or() {
        let s = parse_ts(
            "function useRepo(repo: Repository) {\n\
               if (repo instanceof SqliteRepository || true) {\n\
                 return repo.db;\n\
               }\n\
             }",
        );
        // `||` never guarantees the instanceof check held — must fall back to
        // the declared type (Repository), not the unsafe narrowed one.
        let call = s.calls.iter().find(|c| c.name == "db");
        assert_eq!(
            call.expect("expected a call to db").receiver.as_deref(),
            Some("Repository")
        );
    }

    #[test]
    fn does_not_narrow_instanceof_type_in_else_branch() {
        let s = parse_ts(
            "function useRepo(repo: Repository) {\n\
               if (repo instanceof SqliteRepository) {\n\
                 return 1;\n\
               } else {\n\
                 return repo.db;\n\
               }\n\
             }",
        );
        let call = s.calls.iter().find(|c| c.name == "db");
        assert_eq!(
            call.expect("expected a call to db").receiver.as_deref(),
            Some("Repository"),
            "the else branch must not inherit the if-branch's instanceof narrowing"
        );
    }

    #[test]
    fn does_not_tag_plain_this_field_read_even_when_not_locally_confirmed() {
        let s = parse_js(
            "class Widget {\n\
               useOther() { return this.unknownProp; }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "unknownProp"),
            "a plain (non-accessor) this.field read must never produce a call, tagged or not; got: {:?}",
            s.calls
        );
    }

    // #2085: a plain (non-arrow) function does not inherit `this` lexically —
    // `this.method()` inside one is not guaranteed to be the enclosing
    // class's instance, so it must not resolve as a same-class call.

    #[test]
    fn flags_this_call_inside_plain_callback_as_unresolved() {
        let s = parse_ts(
            "class Session {\n\
               isReady(): boolean { return true; }\n\
               checkExplicit(): void {\n\
                 setTimeout(function () {\n\
                   return this.isReady();\n\
                 }, 100);\n\
               }\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.dynamic_kind.as_deref() == Some("unresolved-dynamic"))
            .expect("expected the this.isReady() call to be flagged unresolved-dynamic");
        assert_eq!(call.name, "<dynamic:unresolved>");
        assert_eq!(call.dynamic, Some(true));
        assert_eq!(call.dynamic_kind.as_deref(), Some("unresolved-dynamic"));
        assert!(
            call.receiver.is_none(),
            "must not carry a 'this' receiver that would resolve to Session"
        );
    }

    #[test]
    fn still_resolves_this_call_inside_arrow_callback() {
        let s = parse_ts(
            "class Session {\n\
               isReady(): boolean { return true; }\n\
               checkArrow(): void {\n\
                 setTimeout(() => {\n\
                   return this.isReady();\n\
                 }, 100);\n\
               }\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "isReady")
            .expect("arrow callbacks are transparent to this-binding");
        assert_eq!(call.receiver.as_deref(), Some("this"));
    }

    #[test]
    fn still_resolves_this_call_inside_explicitly_bound_callback() {
        let s = parse_ts(
            "class Session {\n\
               isReady(): boolean { return true; }\n\
               checkBound(): void {\n\
                 setTimeout(function () {\n\
                   return this.isReady();\n\
                 }.bind(this), 100);\n\
               }\n\
             }",
        );
        let call = s
            .calls
            .iter()
            .find(|c| c.name == "isReady")
            .expect(".bind(this) explicitly re-establishes the enclosing this");
        assert_eq!(call.receiver.as_deref(), Some("this"));
    }

    #[test]
    fn flags_this_accessor_read_inside_plain_callback_as_unconfirmed() {
        let s = parse_ts(
            "class Session {\n\
               get ready(): boolean { return this._ready; }\n\
               private _ready = true;\n\
               checkExplicit(): void {\n\
                 setTimeout(function () {\n\
                   return this.ready;\n\
                 }, 100);\n\
               }\n\
             }",
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "ready"),
            "a this.field accessor read inside an unbound plain function must not \
             resolve to the enclosing class's accessor; got: {:?}",
            s.calls
        );
    }
}
