use super::helpers::*;
use super::SymbolExtractor;
use crate::ast_analysis::cfg::build_function_cfg;
use crate::ast_analysis::complexity::compute_all_metrics;
use crate::types::*;
use tree_sitter::{Node, Tree};

/// Well-known JS globals that must not be recorded as pts targets.
/// Mirrors the `BUILTIN_GLOBALS` set in `src/extractors/javascript.ts`
/// and must be identical to the set tested in `is_js_builtin_global`.
const JS_BUILTIN_GLOBALS: &[&str] = &[
    "Math", "JSON", "Promise", "Array", "Object", "Date", "Error",
    "Symbol", "Map", "Set", "RegExp", "Number", "String", "Boolean",
    "WeakMap", "WeakSet", "WeakRef", "Proxy", "Reflect", "Intl",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "BigInt",
    "Float32Array", "Float64Array", "Int8Array", "Int16Array", "Int32Array",
    "Uint8Array", "Uint16Array", "Uint32Array", "Uint8ClampedArray",
    "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
    "AbortController", "AbortSignal", "Headers", "Request", "Response",
    "FormData", "Blob", "File", "ReadableStream", "WritableStream",
    "TransformStream",
    // Browser/runtime globals — must match is_js_builtin_global below
    "console", "process", "window", "document", "globalThis",
    // Node.js built-ins
    "Buffer", "EventEmitter", "Stream",
];

pub struct JsExtractor;

impl SymbolExtractor for JsExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_node);
        walk_ast_nodes(&tree.root_node(), source, &mut symbols.ast_nodes);
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_type_map);
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_return_type_map);
        // Pre-ES6 prototype methods: `Foo.prototype.bar = fn` and `Foo.prototype = { bar: fn }`
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_prototype_methods);
        // call_assignments runs after type_map is populated (needs receiver types)
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_call_assignments);
        // Phase 8.3c–8.3f: points-to bindings (params, this-rebinding, arrays,
        // spread, for-of, object rest/props) for the pts constraint solver.
        walk_tree(&tree.root_node(), source, &mut symbols, match_js_pts_bindings);
        // Collapse duplicate keys accumulated during the tree walks (O(n)).
        dedup_type_map(&mut symbols.type_map);
        dedup_type_map(&mut symbols.return_type_map);
        symbols
    }
}

// ── Type inference helpers ──────────────────────────────────────────────────

/// Extract simple type name from a type_annotation node.
/// Returns the type name for simple types and generics, None for unions/intersections/arrays.
fn extract_simple_type_name<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            match child.kind() {
                "type_identifier" | "identifier" => return Some(node_text(&child, source)),
                "generic_type" => {
                    return child.child(0).map(|n| node_text(&n, source));
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
    let ctor = node.child_by_field_name("constructor").or_else(|| node.child(1))?;
    match ctor.kind() {
        "identifier" => Some(node_text(&ctor, source)),
        "member_expression" => {
            named_child_text(&ctor, "property", source)
        }
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
                return n.child_by_field_name("name").map(|name| node_text(&name, source));
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
        "public_field_definition" | "field_definition" => handle_field_def_type_map(node, source, symbols),
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
    let Some(name_n) = node.child_by_field_name("name") else { return };
    if name_n.kind() != "identifier" { return; }
    let var_name = node_text(&name_n, source);
    // Type annotation: confidence 0.9
    if let Some(type_anno) = find_child(node, "type_annotation") {
        if let Some(type_name) = extract_simple_type_name(&type_anno, source) {
            push_type_map_entry(symbols, var_name.to_string(), type_name.to_string());
        }
    }
    let Some(value_n) = node.child_by_field_name("value") else { return };
    // Constructor: confidence 1.0 (overrides annotation in edge builder)
    if value_n.kind() == "new_expression" {
        if let Some(type_name) = extract_new_expr_type_name(&value_n, source) {
            symbols.type_map.push(TypeMapEntry {
                name: var_name.to_string(),
                type_name: type_name.to_string(),
                confidence: 1.0,
            });
        }
    }
    // Phase 8.3e: Object.create({ key: fn }) → composite pts key per property
    if value_n.kind() == "call_expression" {
        seed_object_create_entries(var_name, &value_n, source, symbols);
    }
    // Phase 8.3f parity: seed composite typeMap keys for ALL object-literal
    // declarations (`const`, `let`, `var`) when at non-function scope.
    // Mirrors WASM handleVarDeclaratorTypeMap (no isConst guard there).
    // For `const`, extract_object_literal_functions already seeds these entries;
    // dedup_type_map collapses any duplicates at equal confidence.
    if value_n.kind() == "object" && find_parent_of_types(node, &[
        "function_declaration", "arrow_function", "function_expression",
        "method_definition", "generator_function_declaration", "generator_function",
    ]).is_none() {
        seed_objlit_type_map_entries(var_name, &value_n, source, symbols);
    }
}

/// Handle `required_parameter` / `optional_parameter` nodes in the type-map walk.
///
/// Seeds a type-map entry when the parameter carries a TypeScript type annotation.
fn handle_param_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("pattern")
        .or_else(|| node.child_by_field_name("left"))
        .or_else(|| node.child(0));
    let Some(name_node) = name_node else { return };
    if name_node.kind() != "identifier" { return };
    let Some(type_anno) = find_child(node, "type_annotation") else { return };
    if let Some(type_name) = extract_simple_type_name(&type_anno, source) {
        push_type_map_entry(
            symbols,
            node_text(&name_node, source).to_string(),
            type_name.to_string(),
        );
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
    let (Some(lhs), Some(rhs)) = (lhs, rhs) else { return };
    if lhs.kind() != "member_expression" { return; }
    let obj = lhs.child_by_field_name("object");
    let prop = lhs.child_by_field_name("property");
    let (Some(obj), Some(prop)) = (obj, prop) else { return };
    // Guard: only static property access, not computed subscripts.
    let prop_kind = prop.kind();
    if prop_kind != "property_identifier" && prop_kind != "identifier" { return; }
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
    let name_node = node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"))
        .or_else(|| find_child(node, "property_identifier"));
    let Some(name_node) = name_node else { return };
    let kind = name_node.kind();
    if kind != "property_identifier" && kind != "identifier" && kind != "private_property_identifier" {
        return;
    }
    let field_name = node_text(&name_node, source).to_string();
    let Some(type_anno) = find_child(node, "type_annotation") else { return };
    let Some(type_name) = extract_simple_type_name(&type_anno, source) else { return };
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
            set_type_map_entry(symbols, format!("this.{}", field_name), type_name.to_string(), 0.6);
        }
        None => {
            // No enclosing class declaration (e.g. class expression)
            // — use bare keys only at full confidence.
            set_type_map_entry(symbols, field_name.clone(), type_name.to_string(), 0.9);
            set_type_map_entry(symbols, format!("this.{}", field_name), type_name.to_string(), 0.9);
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
    let Some(callee) = node.child_by_field_name("function") else { return };
    if callee.kind() != "member_expression" { return; }
    let Some(callee_obj) = callee.child_by_field_name("object") else { return };
    if node_text(&callee_obj, source) != "Object" { return; }
    let Some(callee_prop) = callee.child_by_field_name("property") else { return };
    let method = node_text(&callee_prop, source);
    if method != "defineProperty" && method != "defineProperties" { return; }

    let args_node = node.child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args_node) = args_node else { return };

    // Collect non-punctuation argument nodes in order
    let mut args: Vec<Node> = Vec::new();
    for i in 0..args_node.child_count() {
        let Some(child) = args_node.child(i) else { continue };
        if !matches!(child.kind(), "(" | ")" | ",") {
            args.push(child);
        }
    }

    if method == "defineProperty" {
        // Object.defineProperty(obj, "key", { value: fn }) or { get: getter }
        if args.len() < 3 { return; }
        if args[0].kind() != "identifier" { return; }
        let obj_name = node_text(&args[0], source);
        let Some(key) = extract_string_fragment(&args[1], source) else { return };
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
        if args.len() < 2 { return; }
        if args[0].kind() != "identifier" { return; }
        let obj_name = node_text(&args[0], source).to_string();
        if args[1].kind() != "object" { return; }
        seed_descriptor_object(&obj_name, &args[1], source, symbols);
    }
}

/// Seed composite pts keys from `const obj = Object.create({ f1, f2 })`.
fn seed_object_create_entries(var_name: &str, call_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(callee) = call_node.child_by_field_name("function") else { return };
    if callee.kind() != "member_expression" { return; }
    let Some(callee_obj) = callee.child_by_field_name("object") else { return };
    if node_text(&callee_obj, source) != "Object" { return; }
    let Some(callee_prop) = callee.child_by_field_name("property") else { return };
    if node_text(&callee_prop, source) != "create" { return; }

    let args_node = call_node.child_by_field_name("arguments")
        .or_else(|| find_child(call_node, "arguments"));
    let Some(args_node) = args_node else { return };

    // First non-punctuation argument = prototype object
    let proto = (0..args_node.child_count())
        .filter_map(|i| args_node.child(i))
        .find(|n| !matches!(n.kind(), "(" | ")" | ","));
    let Some(proto) = proto else { return };
    if proto.kind() != "object" { return };

    for i in 0..proto.child_count() {
        let Some(child) = proto.child(i) else { continue };
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
                let Some(key_n) = child.child_by_field_name("key") else { continue };
                let Some(val_n) = child.child_by_field_name("value") else { continue };
                if val_n.kind() != "identifier" { continue; }
                let key = if key_n.kind() == "string" {
                    extract_string_fragment(&key_n, source).map(|s| s.to_string())
                } else {
                    Some(node_text(&key_n, source).to_string())
                };
                let Some(key) = key else { continue };
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
fn seed_descriptor_object(obj_name: &str, obj_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else { continue };
        if child.kind() != "pair" { continue; }
        let Some(key_n) = child.child_by_field_name("key") else { continue };
        let Some(val_n) = child.child_by_field_name("value") else { continue };
        let key = if key_n.kind() == "string" {
            extract_string_fragment(&key_n, source).map(|s| s.to_string())
        } else {
            Some(node_text(&key_n, source).to_string())
        };
        let Some(key) = key else { continue };
        let Some(target) = find_descriptor_value(&val_n, source) else { continue };
        symbols.type_map.push(TypeMapEntry {
            name: format!("{}.{}", obj_name, key),
            type_name: target.to_string(),
            confidence: 0.85,
        });
    }
}

/// Extract the text of the `string_fragment` child of a string node, i.e. content without quotes.
fn extract_string_fragment<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if node.kind() != "string" { return None; }
    find_child(node, "string_fragment").map(|n| node_text(&n, source))
}

/// Find the `value` identifier in a property descriptor object `{ value: fn }`.
fn find_descriptor_value<'a>(node: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    if node.kind() != "object" { return None; }
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() != "pair" { continue; }
        let Some(key) = child.child_by_field_name("key") else { continue };
        if node_text(&key, source) != "value" { continue; }
        let Some(val) = child.child_by_field_name("value") else { continue };
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
    if node.kind() != "object" { return Vec::new(); }
    let mut result = Vec::new();
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() != "pair" { continue; }
        let Some(key) = child.child_by_field_name("key") else { continue };
        let key_text = node_text(&key, source);
        if key_text != "get" && key_text != "set" { continue; }
        let Some(val) = child.child_by_field_name("value") else { continue };
        if val.kind() == "identifier" {
            result.push(node_text(&val, source));
        }
    }
    result
}

/// True when `declarator` is the shape `extract_object_literal_functions` qualifies: a plain
/// identifier name, outside any function scope. Mirrors TS `isEligibleObjectLiteralDeclarator`.
fn is_eligible_object_literal_declarator(declarator: &Node) -> bool {
    if declarator.kind() != "variable_declarator" { return false; }
    let Some(name_n) = declarator.child_by_field_name("name") else { return false };
    if name_n.kind() != "identifier" { return false; }
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
    let Some(obj) = method_node.parent() else { return false };
    if obj.kind() != "object" { return false; }
    let Some(declarator) = obj.parent() else { return false };
    if !is_eligible_object_literal_declarator(&declarator) { return false; }
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
        let Some(child) = obj_node.child(i) else { continue };
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
                let Some(key_n) = child.child_by_field_name("key") else { continue };
                let Some(val_n) = child.child_by_field_name("value") else { continue };
                // Use resolve_pair_key_name to strip brackets from computed string keys
                // (e.g. ['foo'] → "foo") and skip non-string computed keys ([Symbol.iterator]),
                // mirroring resolve_method_def_name below.
                let Some(key) = resolve_pair_key_name(&key_n, source) else { continue };
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
                let Some(method_name) = resolve_method_def_name(&child, source) else { continue };
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
fn seed_objlit_type_map_entries(var_name: &str, obj_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else { continue };
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
                let Some(key_n) = child.child_by_field_name("key") else { continue };
                let Some(val_n) = child.child_by_field_name("value") else { continue };
                let key = if key_n.kind() == "string" {
                    extract_string_fragment(&key_n, source).map(|s| s.to_string())
                } else {
                    Some(node_text(&key_n, source).to_string())
                };
                let Some(key) = key else { continue };
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
                let Some(method_name) = resolve_method_def_name(&child, source) else { continue };
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

// ── Return-type map extraction (Phase 8.2 parity) ───────────────────────────

/// Walk the AST collecting function/method return types into `symbols.return_type_map`.
/// Mirrors `extractReturnTypeMapWalk` in src/extractors/javascript.ts.
fn match_js_return_type_map(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_declaration" | "generator_function_declaration" => {
            let Some(name_n) = node.child_by_field_name("name") else { return };
            let fn_name = node_text(&name_n, source);
            if fn_name == "constructor" { return; }
            // Use the boundary-aware variant: nested function declarations inside
            // method bodies must not inherit the class prefix (matches WASM behaviour).
            let key = match find_parent_class_no_fn_boundary(node, source) {
                Some(cls) => format!("{}.{}", cls, fn_name),
                None => fn_name.to_string(),
            };
            store_return_type(node, &key, source, symbols);
        }
        "method_definition" => {
            let Some(name_n) = node.child_by_field_name("name") else { return };
            let method_name = node_text(&name_n, source);
            if method_name == "constructor" { return; }
            // method_definition is always a direct child of class_body — plain
            // find_parent_class is correct here.
            let key = match find_parent_class(node, source) {
                Some(cls) => format!("{}.{}", cls, method_name),
                None => method_name.to_string(),
            };
            store_return_type(node, &key, source, symbols);
        }
        "variable_declarator" => {
            let Some(name_n) = node.child_by_field_name("name") else { return };
            if name_n.kind() != "identifier" { return; }
            let Some(value_n) = node.child_by_field_name("value") else { return };
            // Only arrow_function, function_expression and generator_function match the TS reference;
            // "function" is not a valid tree-sitter value-expression kind here.
            if !matches!(value_n.kind(), "arrow_function" | "function_expression" | "generator_function") {
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
    // Infer from first `return new Constructor()` in body
    if let Some(body) = fn_node.child_by_field_name("body") {
        if let Some(type_name) = find_return_new_expr_type(&body, source) {
            push_return_type_entry(symbols, fn_name, type_name, 0.85);
        }
    }
}

/// Scan direct children of `body` for the first `return new X()` and return the constructor name.
fn find_return_new_expr_type<'a>(body: &Node<'a>, source: &'a [u8]) -> Option<&'a str> {
    for i in 0..body.child_count() {
        let Some(child) = body.child(i) else { continue };
        if child.kind() != "return_statement" { continue; }
        for j in 0..child.child_count() {
            let Some(expr) = child.child(j) else { continue };
            if expr.kind() == "new_expression" {
                return extract_new_expr_type_name(&expr, source);
            }
        }
    }
    None
}

/// Append a `(fn_name → type_name)` entry to `return_type_map`.
/// Deduplication (highest-confidence-wins) is handled in bulk by
/// [`dedup_type_map`] at the end of `extract()`.
fn push_return_type_entry(symbols: &mut FileSymbols, fn_name: &str, type_name: &str, confidence: f64) {
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
fn match_js_prototype_methods(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    if node.kind() != "expression_statement" { return; }
    let Some(expr) = node.child(0) else { return };
    if expr.kind() != "assignment_expression" { return; }
    let lhs = expr.child_by_field_name("left");
    let rhs = expr.child_by_field_name("right");
    if let (Some(lhs), Some(rhs)) = (lhs, rhs) {
        handle_js_prototype_assignment(&lhs, &rhs, source, symbols);
    }
}

fn handle_js_prototype_assignment(lhs: &Node, rhs: &Node, source: &[u8], symbols: &mut FileSymbols) {
    if lhs.kind() != "member_expression" { return; }
    let Some(lhs_obj) = lhs.child_by_field_name("object") else { return };
    let Some(lhs_prop) = lhs.child_by_field_name("property") else { return };

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
        });
    }
}

/// Emit one prototype method definition or typeMap alias for `ClassName.methodName = rhs`.
///
/// Mirrors `emitPrototypeMethod` in `src/extractors/javascript.ts`.
fn emit_js_prototype_method(class_name: &str, method_name: &str, rhs: &Node, source: &[u8], symbols: &mut FileSymbols) {
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
fn extract_js_prototype_object_literal(class_name: &str, obj_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for i in 0..obj_node.child_count() {
        let Some(child) = obj_node.child(i) else { continue };
        match child.kind() {
            "method_definition" => {
                let Some(method_name) = resolve_method_def_name(&child, source) else { continue };
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
                    let method_name: &str = if key_node.kind() == "string" {
                        let s = node_text(&key_node, source);
                        // Strip exactly one matching pair of surrounding quote characters.
                        // `trim_matches` would also strip embedded quotes; we only want the
                        // outermost delimiter pair so `"it's"` stays `it's`.
                        s.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
                            .or_else(|| s.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                            .unwrap_or(s)
                    } else {
                        node_text(&key_node, source)
                    };
                    if method_name.is_empty() { continue; }
                    emit_js_prototype_method(class_name, method_name, &value_node, source, symbols);
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
    if node.kind() != "variable_declarator" { return; }
    let Some(name_n) = node.child_by_field_name("name") else { return };
    if name_n.kind() != "identifier" { return; }
    let Some(value_n) = node.child_by_field_name("value") else { return };
    if value_n.kind() != "call_expression" { return; }

    let var_name = node_text(&name_n, source).to_string();
    let Some(fn_node) = value_n.child_by_field_name("function") else { return };

    match fn_node.kind() {
        "identifier" => {
            symbols.call_assignments.push(NativeCallAssignment {
                var_name,
                callee_name: node_text(&fn_node, source).to_string(),
                receiver_type_name: None,
            });
        }
        "member_expression" => {
            let Some(obj) = fn_node.child_by_field_name("object") else { return };
            let Some(prop) = fn_node.child_by_field_name("property") else { return };
            if obj.kind() != "identifier" { return; }
            let receiver_type = symbols.type_map.iter()
                .find(|e| e.name == node_text(&obj, source))
                .map(|e| e.type_name.clone());
            symbols.call_assignments.push(NativeCallAssignment {
                var_name,
                callee_name: node_text(&prop, source).to_string(),
                receiver_type_name: receiver_type,
            });
        }
        _ => {}
    }
}

fn match_js_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
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
        "call_expression" => handle_call_expr(node, source, symbols),
        "new_expression" => handle_new_expr(node, source, symbols),
        "decorator" => handle_decorator(node, source, symbols),
        "import_statement" => handle_import_stmt(node, source, symbols),
        "export_statement" => handle_export_stmt(node, source, symbols),
        "expression_statement" => handle_expr_stmt(node, source, symbols),
        // #1771: dispatch-table-style object-literal property values
        // (`{ resolve: someFunction }` / shorthand `{ someFunction }`).
        "pair" => handle_object_literal_pair_value_ref(node, source, &mut symbols.calls),
        "shorthand_property_identifier" => {
            handle_object_literal_shorthand_value_ref(node, source, &mut symbols.calls)
        }
        // #1784: `instanceof ClassName` checks, e.g. `err instanceof CodegraphError`.
        "binary_expression" => handle_instanceof_value_ref(node, source, &mut symbols.calls),
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
        });
    }
}

fn handle_class_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
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
            if s.is_empty() { return None; }
            Some(s.to_string())
        }
        "string_fragment" => {
            let s = node_text(&inner, source);
            if s.is_empty() { return None; }
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
/// cannot be resolved at dot-notation call sites — returns `None` for those.
fn resolve_method_def_name(node: &Node, source: &[u8]) -> Option<String> {
    let name_node = node.child_by_field_name("name")?;
    if name_node.kind() == "computed_property_name" {
        resolve_computed_key_name(&name_node, source)
    } else {
        Some(node_text(&name_node, source).to_string())
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
        symbols.definitions.push(Definition {
            name: full_name,
            kind: "method".to_string(),
            line: start_line(node),
            end_line: Some(end_line(node)),
            decorators: None,
            complexity: compute_all_metrics(node, source, "javascript"),
            cfg: build_function_cfg(node, "javascript", source),
            children: opt_children(children),
        });
    }
}

/// Create a synthetic `ClassName.<static:L:C>` definition for a class static block
/// so that calls inside the block are attributed to a method-kind node and
/// `super.method()` dispatch can walk up to the parent class.
///
/// The start line and column are appended to the name to ensure uniqueness when a
/// class has multiple `static { }` blocks (each has a distinct start position even
/// if on the same line).
fn handle_static_block(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(class_name) = find_parent_class(node, source) else { return };
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
    });
}

/// Emit a `ClassName.fieldName` synthetic definition for each `class { field = ... }` node.
/// Only fired when a value node is present (skips bare `x;` declarations), mirroring the WASM
/// `handleFieldDef` guard.  The synthetic definition has `kind = "method"` so that the SQL
/// call-edge filter (`kind IN ('function','method')`) accepts edges rooted here.
fn handle_field_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let name_node = node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("property"))
        .or_else(|| find_child(node, "property_identifier"));
    let Some(name_node) = name_node else { return };
    // Skip computed property names (`class C { [expr] = ... }`).
    // Allow property_identifier (regular names), identifier, private_property_identifier (#foo),
    // and string (e.g. `"method" = () => {}`) to match the TypeScript path which only denies
    // computed_property_name.
    if !matches!(name_node.kind(), "property_identifier" | "identifier" | "private_property_identifier" | "string") {
        return;
    }
    // Skip uninitialised fields (`class C { x; }`) — must have a value node.
    let Some(value_node) = node.child_by_field_name("value") else { return };
    // Only emit a callable definition when the initializer is a function/arrow expression.
    // Scalar fields like `static x = 42` should not appear as method-kind nodes.
    if !matches!(value_node.kind(), "arrow_function" | "function_expression" | "generator_function") {
        return;
    }
    let field_name = node_text(&name_node, source);
    if field_name.is_empty() { return; }
    let Some(class_name) = find_parent_class(node, source) else { return };
    symbols.definitions.push(Definition {
        name: format!("{}.{}", class_name, field_name),
        kind: "method".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_interface_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else { return };
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
        });
    }
}

/// Node types marking a function-body scope; declarations inside these are skipped by
/// the top-level-constant/destructuring branches below (parity with TS `FUNCTION_SCOPE_TYPES`).
const VAR_DECL_FN_SCOPE_TYPES: [&str; 6] = [
    "function_declaration", "arrow_function",
    "function_expression", "method_definition",
    "generator_function_declaration", "generator_function",
];

fn handle_var_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let is_const = node.child(0)
        .map(|c| node_text(&c, source) == "const")
        .unwrap_or(false);
    let in_function_scope = find_parent_of_types(node, &VAR_DECL_FN_SCOPE_TYPES).is_some();
    for i in 0..node.child_count() {
        let Some(declarator) = node.child(i) else { continue };
        if declarator.kind() != "variable_declarator" { continue; }
        let name_n = declarator.child_by_field_name("name");
        let value_n = declarator.child_by_field_name("value");
        let (Some(name_n), Some(value_n)) = (name_n, value_n) else { continue };
        let vt = value_n.kind();

        if vt == "arrow_function" || vt == "function_expression" || vt == "function" || vt == "generator_function" {
            let children = extract_js_parameters(&value_n, source);
            symbols.definitions.push(Definition {
                name: node_text(&name_n, source).to_string(),
                kind: "function".to_string(),
                line: start_line(node),
                end_line: Some(end_line(&value_n)),
                decorators: None,
                complexity: compute_all_metrics(&value_n, source, "javascript"),
                cfg: build_function_cfg(&value_n, "javascript", source),
                children: opt_children(children),
            });
        } else if is_const && name_n.kind() == "object_pattern" && !in_function_scope {
            // Parity with TS query path (extractDestructuredBindingsWalk):
            // skip destructured const bindings inside function scopes so the
            // Rust walk path matches FUNCTION_SCOPE_TYPES behaviour.
            extract_destructured_bindings(&name_n, source, start_line(node), end_line(node), &mut symbols.definitions);
            // If the RHS is a CJS require() call, also add to imports so the
            // receiver-edge resolver treats the names as import artifacts, not
            // local definitions — mirroring the WASM cjsRequireBindings fix (#1678).
            if value_n.kind() == "call_expression" {
                if let Some(fn_node) = value_n.child_by_field_name("function") {
                    if node_text(&fn_node, source) == "require" {
                        let args = value_n.child_by_field_name("arguments")
                            .or_else(|| find_child(&value_n, "arguments"));
                        if let Some(args) = args {
                            if let Some(str_arg) = find_child(&args, "string") {
                                let mod_path = node_text(&str_arg, source)
                                    .replace(&['\'', '"'][..], "");
                                // CJS require bindings never populate renamed_imports —
                                // resolve_call_targets deliberately ignores the original
                                // name for these (empty target_file forces a same-file
                                // fallback match, matching WASM's importedNamesMap
                                // exclusion, #1678) — so the rename pairs collected here
                                // are discarded.
                                let names = collect_object_pattern_names(&name_n, source, &mut Vec::new());
                                if !names.is_empty() {
                                    let mut imp = Import::new(
                                        mod_path, names, start_line(node),
                                    );
                                    imp.cjs_require = Some(true);
                                    symbols.imports.push(imp);
                                }
                            }
                        }
                    }
                }
            }
        } else if is_const
            && (name_n.kind() == "identifier" || name_n.kind() == "array_pattern")
            && !in_function_scope
        {
            // Any other initializer shape becomes a "constant" Definition, regardless of
            // complexity (call/member/parenthesized expressions, etc.) — mirroring how
            // function declarations are captured regardless of body complexity, and the
            // WASM/TS extractor's unconditional identifier + array_pattern branches (#1819).
            symbols.definitions.push(Definition {
                name: node_text(&name_n, source).to_string(),
                kind: "constant".to_string(),
                line: start_line(node),
                end_line: Some(end_line(node)),
                decorators: None,
                complexity: None,
                cfg: None,
                children: None,
            });
            // Phase 8.3f: extract function/arrow properties from object literals and seed
            // typeMap composite keys so that this.method() inside Object.defineProperty
            // accessor functions can resolve them.
            if value_n.kind() == "object" && name_n.kind() == "identifier" {
                let var_name = node_text(&name_n, source);
                extract_object_literal_functions(&value_n, source, var_name, symbols);
            }
        } else if !is_const && value_n.kind() == "object"
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
        let Some(child) = obj_node.child(i) else { continue };
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

fn handle_call_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(fn_node) = node.child_by_field_name("function") else { return };
    if fn_node.kind() == "import" {
        handle_dynamic_import(node, &fn_node, source, symbols);
        return;
    }
    // `this(args)` and `super(args)` — the callee is `this`/`super` used as a
    // function, not a named identifier.  The `this` call record is emitted by
    // collect_this_call_and_bindings (called from match_js_pts_bindings).
    // Neither case should emit callback-reference calls for the arguments, because
    // those arguments are values passed *to* the rebound function — not callbacks
    // of the enclosing scope.  Without this guard, identifier arguments like `b`
    // in `this(b)` or `a` in `super(a)` become spurious dynamic calls that the
    // pts resolver resolves to globally-defined functions with the same name in
    // other files, producing false cross-file call edges.
    // Mirrors the early-return guard in the TS handleCallExpr (javascript.ts:1135).
    if fn_node.kind() == "this" || fn_node.kind() == "super" {
        return;
    }
    // RES-2: {a:fnA,b:fnB}[k]() — inline object literal dispatch table.
    // Mirrors extractSubscriptCallInfo in src/extractors/javascript.ts (lines 3196–3233).
    // When the callee is a subscript_expression whose object is an object literal
    // (possibly wrapped in parentheses) and whose index is an identifier, collect
    // the values as array-elem bindings under a synthetic `<dt_line_col>` name and
    // emit a `<dt_line_col>[*]` call so the PTS solver can resolve each target.
    if fn_node.kind() == "subscript_expression" {
        if let Some(call) = extract_dispatch_table_call(&fn_node, node, source, &mut symbols.array_elem_bindings) {
            symbols.calls.push(call);
            if let Some(cb_def) = extract_callback_definition(node, source) {
                symbols.definitions.push(cb_def);
            }
            extract_callback_reference_calls(node, source, &mut symbols.calls);
            return;
        }
    }
    if let Some(call_info) = extract_call_info(&fn_node, node, source) {
        symbols.calls.push(call_info);
    }
    if let Some(cb_def) = extract_callback_definition(node, source) {
        symbols.definitions.push(cb_def);
    }
    extract_callback_reference_calls(node, source, &mut symbols.calls);
}

fn handle_new_expr(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let ctor = node.child_by_field_name("constructor")
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
    let args = node.child_by_field_name("arguments")
        .or_else(|| find_child(node, "arguments"));
    let Some(args) = args else { return };
    let str_node = find_child(&args, "string")
        .or_else(|| find_child(&args, "template_string"));
    if let Some(str_node) = str_node {
        let mod_path = node_text(&str_node, source)
            .replace(&['\'', '"', '`'][..], "");
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
        let mod_path = node_text(&source_node, source)
            .replace(&['\'', '"'][..], "");
        let mut renamed_imports = Vec::new();
        let mut type_only_names = Vec::new();
        let names =
            extract_import_names_with_renames(node, source, &mut renamed_imports, &mut type_only_names);
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
        handle_export_declaration(node, decl, source, symbols);
    }
    let source_node = node
        .child_by_field_name("source")
        .or_else(|| find_child(node, "string"));
    if source_node.is_some() && decl.is_none() {
        handle_reexport(node, &source_node.unwrap(), source, symbols);
    }
}

fn handle_export_declaration(node: &Node, decl: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let (kind_str, field) = match decl.kind() {
        "function_declaration" | "generator_function_declaration" => ("function", "name"),
        "class_declaration" | "abstract_class_declaration" => ("class", "name"),
        "interface_declaration" => ("interface", "name"),
        "type_alias_declaration" => ("type", "name"),
        "lexical_declaration" | "variable_declaration" => {
            collect_exported_var_declarations(node, decl, source, symbols);
            return;
        }
        _ => return,
    };
    if let Some(n) = decl.child_by_field_name(field) {
        symbols.exports.push(ExportInfo {
            name: node_text(&n, source).to_string(),
            kind: kind_str.to_string(),
            line: start_line(node),
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
fn collect_exported_var_declarations(
    node: &Node,
    decl: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
) {
    let is_const = decl
        .child(0)
        .map(|c| node_text(&c, source) == "const")
        .unwrap_or(false);
    let line = start_line(node);
    for i in 0..decl.child_count() {
        let Some(declarator) = decl.child(i) else { continue };
        if declarator.kind() != "variable_declarator" { continue; }
        let name_n = declarator.child_by_field_name("name");
        let value_n = declarator.child_by_field_name("value");
        let (Some(name_n), Some(value_n)) = (name_n, value_n) else { continue };
        if name_n.kind() != "identifier" { continue; }
        let vt = value_n.kind();
        if vt == "arrow_function" || vt == "function_expression" || vt == "function" || vt == "generator_function" {
            symbols.exports.push(ExportInfo {
                name: node_text(&name_n, source).to_string(),
                kind: "function".to_string(),
                line,
            });
        } else if is_const {
            symbols.exports.push(ExportInfo {
                name: node_text(&name_n, source).to_string(),
                kind: "constant".to_string(),
                line,
            });
        }
    }
}

fn handle_reexport(node: &Node, source_node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let mod_path = node_text(source_node, source)
        .replace(&['\'', '"'][..], "");
    let mut reexport_renames = Vec::new();
    let mut type_only_names = Vec::new();
    let reexport_names =
        extract_import_names_with_renames(node, source, &mut reexport_renames, &mut type_only_names);
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

fn handle_expr_stmt(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(expr) = node.child(0) else { return };
    if expr.kind() != "assignment_expression" { return; }
    let left = expr.child_by_field_name("left");
    let right = expr.child_by_field_name("right");
    let (Some(left), Some(right)) = (left, right) else { return };
    let left_text = node_text(&left, source);
    if !left_text.starts_with("module.exports") && left_text != "exports" { return; }
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
                let mod_path = node_text(&str_arg, source)
                    .replace(&['\'', '"'][..], "");
                let mut imp = Import::new(mod_path, vec![], start_line(node));
                imp.reexport = Some(true);
                imp.wildcard_reexport = Some(true);
                symbols.imports.push(imp);
            }
        }
    }
}

fn handle_spread_require_reexports(right: &Node, node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    for ci in 0..right.child_count() {
        let Some(child) = right.child(ci) else { continue };
        if child.kind() != "spread_element" { continue; }
        let spread_expr = child.child(1)
            .or_else(|| child.child_by_field_name("value"));
        let Some(spread_expr) = spread_expr else { continue };
        if spread_expr.kind() != "call_expression" { continue; }
        let fn2 = spread_expr.child_by_field_name("function");
        let args2 = spread_expr
            .child_by_field_name("arguments")
            .or_else(|| find_child(&spread_expr, "arguments"));
        let (Some(fn2), Some(args2)) = (fn2, args2) else { continue };
        if node_text(&fn2, source) != "require" { continue; }
        if let Some(str_arg2) = find_child(&args2, "string") {
            let mod_path2 = node_text(&str_arg2, source)
                .replace(&['\'', '"'][..], "");
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
                .trim_start_matches(|c| c == '\'' || c == '"' || c == '`')
                .trim_end_matches(|c| c == '\'' || c == '"' || c == '`');
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
            let name = if raw.is_empty() { "?".to_string() } else { raw.to_string() };
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
    let params_node = node.child_by_field_name("parameters")
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
                        let name_node = child.child_by_field_name("pattern")
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
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "class_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                match child.kind() {
                    "field_definition" | "public_field_definition" | "property_definition" => {
                        let prop = child.child_by_field_name("property")
                            .or_else(|| child.child_by_field_name("name"))
                            .or_else(|| find_child(&child, "property_identifier"));
                        if let Some(prop) = prop {
                            let kind = prop.kind();
                            if kind == "property_identifier" || kind == "identifier"
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
    let body = node.child_by_field_name("body")
        .or_else(|| find_child(node, "enum_body"));
    if let Some(body) = body {
        for i in 0..body.child_count() {
            if let Some(child) = body.child(i) {
                if child.kind() == "enum_assignment" || child.kind() == "property_identifier" {
                    let name = child.child_by_field_name("name")
                        .unwrap_or(child);
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
/// Known gap: arbitrary user-defined higher-order functions (e.g.
/// `processEach(users, fn: UserProcessor)`) are neither name-allowlisted nor
/// position-mapped (see `positional_callback_arg_index`), so `processEach(users,
/// logUser)` no longer emits a `logUser` reference from the caller.
/// Recognizing these would require looking at the callee's own parameter type
/// (is it function-shaped?) rather than its name — a resolver-level,
/// cross-engine feature, not a small extension of this gate. Tracked as a
/// follow-up.
///
/// Mirrors `CALLBACK_ACCEPTING_CALLEES` in `src/extractors/javascript.ts`.
const CALLBACK_ACCEPTING_CALLEES: &[&str] = &[
    // Express / router / middleware
    "use", "get", "post", "put", "delete", "patch", "options", "head", "all",
    // Promises
    "then", "catch", "finally",
    // Array iteration / reduction
    "map", "filter", "forEach", "find", "findIndex", "findLast", "findLastIndex",
    "some", "every", "reduce", "reduceRight", "flatMap", "sort",
    // Event emitters / DOM
    "on", "once", "off", "addListener", "removeListener",
    "addEventListener", "removeEventListener", "subscribe", "unsubscribe",
    // Scheduling / plain function callbacks
    "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
    "requestAnimationFrame", "requestIdleCallback", "nextTick",
    // Commander / yargs / hooks
    "action", "command",
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

fn extract_callback_reference_calls(call_node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let args = call_node.child_by_field_name("arguments")
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
    if !callback_args_allowed && positional_index.is_none() {
        return;
    }

    for (arg_index, child) in iter_children(&args, PUNCTUATION_TOKENS).enumerate() {
        // A positional entry restricts eligibility to its one designated
        // index, regardless of what the generic (any-position) gate above
        // decided.
        if let Some(idx) = positional_index {
            if arg_index != idx {
                continue;
            }
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
                    let receiver = child.child_by_field_name("object")
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
/// Mirrors `collectObjectLiteralValueRefCall` in `src/extractors/javascript.ts`.
fn handle_object_literal_pair_value_ref(node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let Some(value_n) = node.child_by_field_name("value") else { return };
    if value_n.kind() != "identifier" {
        return;
    }
    let text = node_text(&value_n, source);
    if JS_BUILTIN_GLOBALS.contains(&text) {
        return;
    }
    calls.push(Call {
        name: text.to_string(),
        line: start_line(&value_n),
        dynamic: Some(true),
        dynamic_kind: Some("value-ref".to_string()),
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
/// Mirrors the walk path's `shorthand_property_identifier` handling in
/// `src/extractors/javascript.ts`'s `runCollectorWalk` (issue #1771).
fn handle_object_literal_shorthand_value_ref(node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let text = node_text(node, source);
    if JS_BUILTIN_GLOBALS.contains(&text) {
        return;
    }
    calls.push(Call {
        name: text.to_string(),
        line: start_line(node),
        dynamic: Some(true),
        dynamic_kind: Some("value-ref".to_string()),
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
/// Mirrors `collectInstanceofValueRefCall` in `src/extractors/javascript.ts`.
fn handle_instanceof_value_ref(node: &Node, source: &[u8], calls: &mut Vec<Call>) {
    let Some(operator_n) = node.child_by_field_name("operator") else { return };
    if node_text(&operator_n, source) != "instanceof" {
        return;
    }
    let Some(right_n) = node.child_by_field_name("right") else { return };
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
/// Mirrors the TS extractor's `extractDestructuredBindings`.
fn extract_destructured_bindings(
    pattern: &Node,
    source: &[u8],
    line: u32,
    end_line: u32,
    definitions: &mut Vec<Definition>,
) {
    for i in 0..pattern.child_count() {
        let Some(child) = pattern.child(i) else { continue };
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
                        });
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
    let args = call_node.child_by_field_name("arguments")
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
            "identifier" => return Call {
                name: node_text(&arg, source).to_string(),
                line: call_line,
                dynamic: Some(true),
                dynamic_kind: Some("reflection".to_string()),
                ..Default::default()
            },
            "member_expression" => {
                if let Some(inner_prop) = arg.child_by_field_name("property") {
                    let receiver = arg.child_by_field_name("object")
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
            let is_reflect = obj.as_ref()
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
                let args = call_node.child_by_field_name("arguments")
                    .or_else(|| find_child(call_node, "arguments"));
                if let Some(args) = args {
                    let mut first_arg: Option<Node> = None;
                    let mut second_arg: Option<Node> = None;
                    let mut arg_idx = 0usize;
                    for i in 0..args.child_count() {
                        let Some(child) = args.child(i) else { continue };
                        if matches!(child.kind(), "(" | ")" | ",") { continue }
                        if arg_idx == 0 { first_arg = Some(child); }
                        else if arg_idx == 1 { second_arg = Some(child); break; }
                        arg_idx += 1;
                    }
                    let receiver = first_arg.as_ref().map(|a| extract_receiver_name(a, source));
                    if let Some(prop_arg) = second_arg {
                        match prop_arg.kind() {
                            "string" | "string_fragment" => {
                                let prop_name = node_text(&prop_arg, source)
                                    .replace(&['\'', '"'][..], "");
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
                let receiver = fn_node.child_by_field_name("object")
                    .map(|o| extract_receiver_name(&o, source));
                match index.kind() {
                    "string" | "template_string" => {
                        let method_name = node_text(&index, source)
                            .replace(&['\'', '"', '`'][..], "");
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

fn walk_call_chain<'a>(start_node: &Node<'a>, method_name: &str, source: &[u8]) -> Option<Node<'a>> {
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
            return named_child_text(&parent, "name", source)
                .map(|s| s.to_string());
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
        let Some(child) = pattern.child(i) else { continue };
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
                    Some(("identifier", v)) | Some(("shorthand_property_identifier_pattern", v)) => {
                        Some(v)
                    }
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
        let Some(child) = pattern.child(i) else { continue };
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
                extract_rest_identifier(&child, source, &mut names);
            }
            _ => {}
        }
    }
    names
}

/// Extract the identifier from a rest/spread element (`...rest` → `rest`)
fn extract_rest_identifier(rest_node: &Node, source: &[u8], names: &mut Vec<String>) {
    if let Some(inner) = rest_node.child(0) {
        if inner.kind() == "identifier" {
            names.push(node_text(&inner, source).to_string());
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
    let Some(fn_node) = node.child_by_field_name("function") else { return };
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
            if !JS_BUILTIN_GLOBALS.contains(&arg_text) && arg_text != "undefined" && arg_text != "null" {
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
    let Some(fn_node) = node.child_by_field_name("function") else { return };
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
            let inner = child
                .child_by_field_name("argument")
                .or_else(|| if child.child_count() > 1 { child.child(1) } else { None });
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
    let Some(fn_node) = node.child_by_field_name("function") else { return };
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
                    let target = child
                        .child_by_field_name("argument")
                        .or_else(|| if child.child_count() > 1 { child.child(1) } else { None });
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
        let Some(elem) = value_n.child(i) else { continue };
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
    let Some(right) = node.child_by_field_name("right") else { return };
    let right_text = node_text(&right, source);
    if right.kind() != "identifier" || JS_BUILTIN_GLOBALS.contains(&right_text) {
        return;
    }
    let Some(left) = node.child_by_field_name("left") else { return };
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
                    && (vt == "arrow_function" || vt == "function_expression" || vt == "generator_function")
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
                    .and_then(|c| c.child_by_field_name("name").map(|n| node_text(&n, source).to_string()));
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
            // Computed keys are skipped — they can never match a paramBinding callee.
            if let (Some(key_n), Some(value_n)) = (
                node.child_by_field_name("key"),
                node.child_by_field_name("value"),
            ) {
                let vt = value_n.kind();
                if key_n.kind() != "computed_property_name"
                    && (vt == "arrow_function" || vt == "function_expression" || vt == "generator_function")
                {
                    let key_text = node_text(&key_n, source);
                    fn_name = Some(if key_n.kind() == "string" {
                        key_text[1..key_text.len() - 1].to_string()
                    } else {
                        key_text.to_string()
                    });
                    params_node = value_n
                        .child_by_field_name("parameters")
                        .or_else(|| find_child(&value_n, "formal_parameters"));
                }
            }
        }
        _ => {}
    }

    let (Some(fn_name), Some(params_node)) = (fn_name, params_node) else { return };
    let mut param_idx: u32 = 0;
    for i in 0..params_node.child_count() {
        let Some(child) = params_node.child(i) else { continue };
        let ct = child.kind();
        if ct == "," || ct == "(" || ct == ")" {
            continue;
        }
        if ct == "object_pattern" {
            for j in 0..child.child_count() {
                let Some(inner) = child.child(j) else { continue };
                if inner.kind() == "rest_pattern" || inner.kind() == "rest_element" {
                    let rest_id = inner.child(1).or_else(|| inner.child_by_field_name("name"));
                    if let Some(rest_id) = rest_id {
                        if rest_id.kind() == "identifier" {
                            symbols.object_rest_param_bindings.push(ObjectRestParamBinding {
                                callee: fn_name.clone(),
                                rest_name: node_text(&rest_id, source).to_string(),
                                arg_index: param_idx,
                            });
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
        let Some(child) = value_n.child(i) else { continue };
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

    #[test]
    fn finds_class_with_methods() {
        let s = parse_js("class Foo { bar() {} baz() {} }");
        let names: Vec<&str> = s.definitions.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"Foo"));
        assert!(names.contains(&"Foo.bar"));
        assert!(names.contains(&"Foo.baz"));
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
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("command:")).collect();
        assert!(defs.is_empty(), "should not extract when handler is a named reference");
    }

    #[test]
    fn extracts_express_get_route() {
        let s = parse_js("app.get('/api/users', (req, res) => { res.json([]); });");
        let def = s.definitions.iter().find(|d| d.name == "route:GET /api/users");
        assert!(def.is_some(), "should extract route:GET /api/users");
        assert_eq!(def.unwrap().kind, "function");
    }

    #[test]
    fn extracts_express_post_route() {
        let s = parse_js("router.post('/api/items', async (req, res) => { save(); });");
        let def = s.definitions.iter().find(|d| d.name == "route:POST /api/items");
        assert!(def.is_some(), "should extract route:POST /api/items");
    }

    #[test]
    fn skips_map_get_false_positive() {
        let s = parse_js("myMap.get('someKey');");
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("route:")).collect();
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
        let defs: Vec<_> = s.definitions.iter().filter(|d| d.name.starts_with("event:")).collect();
        assert!(defs.is_empty(), "should not extract when handler is a named reference");
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
            s.exports.iter().any(|e| e.name == "config" && e.kind == "constant"),
            "config should be listed as an exported constant; got: {:?}",
            s.exports
        );
    }

    #[test]
    fn extracts_const_array_pattern_with_call_expression_initializer() {
        // Parity with the identifier case above: array-pattern names must also
        // be discoverable regardless of initializer complexity.
        let s = parse_js("const [a, b] = computePair();");
        let def = s
            .definitions
            .iter()
            .find(|d| d.name == "[a, b]")
            .unwrap_or_else(|| panic!("[a, b] should be extracted as a definition"));
        assert_eq!(def.kind, "constant");
    }

    #[test]
    fn const_alias_gets_both_definition_and_fn_ref_binding() {
        // The new "constant" Definition for an identifier-aliased const must not
        // come at the expense of the existing pts fn_ref_binding tracking — the
        // two concerns are independent (mirrors the WASM/TS extractor's
        // decoupled fnRefBindings pass).
        let s = parse_js("const alias = handler;");
        assert!(
            s.definitions.iter().any(|d| d.name == "alias" && d.kind == "constant"),
            "alias should be extracted as a constant definition; got: {:?}",
            s.definitions
        );
        assert!(
            s.fn_ref_bindings.iter().any(|b| b.lhs == "alias" && b.rhs == "handler"),
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
        assert_eq!(new_nodes.len(), 0, "throw new Error should not also emit a new node");
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "./foo.js");
    }

    #[test]
    fn finds_dynamic_import_with_destructuring() {
        let s = parse_js("const { a, b } = await import('./bar.js');");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].names, vec!["local".to_string()]);
        assert!(dyn_imports[0].renamed_imports.is_none());
    }

    #[test]
    fn finds_dynamic_import_with_mixed_destructuring() {
        let s = parse_js("const { a, buildGraph: fromBarrel, c } = await import('./mod.js');");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_as_cast_destructuring() {
        let s = parse_ts("const { a, b } = await import('./foo.js') as { a: Fn; b: Fn };");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert!(dyn_imports[0].names.contains(&"a".to_string()));
        assert!(dyn_imports[0].names.contains(&"b".to_string()));
    }

    #[test]
    fn finds_dynamic_import_with_satisfies_cast_destructuring() {
        // TS 4.9+ `satisfies` is structurally identical to `as` here (Greptile
        // follow-up to #1781) — same walk-up gap would otherwise reproduce.
        let s = parse_ts("const { a, b } = await import('./foo.js') satisfies { a: Fn; b: Fn };");
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
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
        let dyn_imports: Vec<_> = s.imports.iter().filter(|i| i.dynamic_import == Some(true)).collect();
        assert_eq!(dyn_imports.len(), 1);
        assert_eq!(dyn_imports[0].source, "../../../../features/dataflow.js");
        assert!(dyn_imports[0].names.contains(&"buildDataflowVerticesFromMap".to_string()));
        assert!(dyn_imports[0].names.contains(&"buildDataflowEdges".to_string()));
    }

    #[test]
    fn extracts_callback_reference_in_router_use() {
        let s = parse_js("router.use(handleToken);");
        let dynamic_calls: Vec<_> = s.calls.iter().filter(|c| c.dynamic == Some(true)).collect();
        assert!(dynamic_calls.iter().any(|c| c.name == "handleToken"), "should extract handleToken as dynamic call");
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
            assert!(names.contains(&expected), "missing value-ref call for {}", expected);
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

    #[test]
    fn no_value_ref_call_for_call_expression_value() {
        let s = parse_js("const table = { resolve: someFunction() };");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_member_expression_value() {
        let s = parse_js("const table = { resolve: obj.someFunction };");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_inline_function_value() {
        let s = parse_js("const table = { resolve: () => {}, other: function () {} };");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_literal_or_data_shaped_values() {
        let s = parse_js(
            "const config = { name: 'literal', count: 42, active: true, empty: null, list: [1, 2] };",
        );
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_builtin_globals() {
        let s = parse_js("const table = { log: console, Ctor: Object };");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
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
        assert!(
            s.calls
                .iter()
                .all(|c| !(c.dynamic_kind.as_deref() == Some("value-ref") && c.name == "SomeClass"))
        );
    }

    #[test]
    fn no_value_ref_call_for_instanceof_call_expression_operand() {
        let s = parse_js("const check = (a) => a instanceof getClass();");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_instanceof_builtin_globals() {
        let s = parse_js(
            "function isBuiltin(x) { return x instanceof Error || x instanceof Array || x instanceof Map; }",
        );
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_in_operator() {
        let s = parse_js("const has = (obj) => 'key' in obj;");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_value_ref_call_for_other_binary_operators() {
        let s = parse_js("const sum = (a, b) => a + b === Total;");
        assert!(s.calls.iter().all(|c| c.dynamic_kind.as_deref() != Some("value-ref")));
    }

    #[test]
    fn no_duplicate_call_for_call_expression_arg() {
        let s = parse_js("router.use(checkPermissions(['admin']));");
        let cp_calls: Vec<_> = s.calls.iter().filter(|c| c.name == "checkPermissions").collect();
        assert_eq!(cp_calls.len(), 1);
    }

    #[test]
    fn no_member_expr_callback_for_non_allowlisted_callee() {
        // `store.set(user.id, user)` — `user.id` is a property read passed as a
        // value (map key), NOT a callback. Only allowlisted callees (use, then,
        // map, addEventListener, etc.) get member_expression args emitted as
        // dynamic calls. Mirrors WASM test in `tests/parsers/javascript.test.ts`.
        let s = parse_js("store.set(user.id, user);");
        let dyn_member_calls: Vec<_> =
            s.calls.iter().filter(|c| c.dynamic == Some(true) && c.name == "id").collect();
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
        let use_cb = use_s.calls.iter()
            .find(|c| c.dynamic == Some(true) && c.name == "validate");
        assert!(use_cb.is_some(), "app.use must still emit validate as dynamic call");
        assert_eq!(use_cb.unwrap().receiver.as_deref(), Some("auth"));

        let then_s = parse_js("promise.then(handlers.onSuccess);");
        let then_cb = then_s.calls.iter()
            .find(|c| c.dynamic == Some(true) && c.name == "onSuccess");
        assert!(then_cb.is_some(), "promise.then must still emit onSuccess as dynamic call");
        assert_eq!(then_cb.unwrap().receiver.as_deref(), Some("handlers"));
    }

    #[test]
    fn no_member_expr_callback_for_cache_or_map_get() {
        // `cache.get(user.id)` shares the verb name `get` with Express routes,
        // but has no string-literal route path first arg — so member-expr args
        // must not be emitted as dynamic calls. Same for `repo.put`, `map.delete`.
        let cache_s = parse_js("cache.get(user.id);");
        assert!(
            !cache_s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "id"),
            "cache.get(user.id) must not emit `id` as dynamic call",
        );

        let repo_s = parse_js("repo.put(record.key, value);");
        assert!(
            !repo_s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "key"),
            "repo.put(record.key) must not emit `key` as dynamic call",
        );

        let map_s = parse_js("map.delete(entry.id);");
        assert!(
            !map_s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "id"),
            "map.delete(entry.id) must not emit `id` as dynamic call",
        );
    }

    #[test]
    fn emits_member_expr_callback_for_http_route_with_string_path() {
        // Positive regression guard: HTTP-verb calls with a string-literal
        // first arg (Express route signature) must still emit member-expr args.
        let router_s = parse_js("router.get('/users/:id', auth.check);");
        let router_cb = router_s.calls.iter()
            .find(|c| c.dynamic == Some(true) && c.name == "check");
        assert!(router_cb.is_some(), "Express route with string path must emit auth.check");
        assert_eq!(router_cb.unwrap().receiver.as_deref(), Some("auth"));

        let template_s = parse_js("app.post(`/api`, handlers.create);");
        let template_cb = template_s.calls.iter()
            .find(|c| c.dynamic == Some(true) && c.name == "create");
        assert!(template_cb.is_some(), "Express route with template string must emit handlers.create");
        assert_eq!(template_cb.unwrap().receiver.as_deref(), Some("handlers"));
    }

    #[test]
    fn handles_optional_chaining_callee_in_allowlist() {
        // `emitter?.on('tick', handlers.fn)` — tree-sitter-javascript/typescript
        // represent `obj?.on` as a `member_expression` with an `optional_chain`
        // child, so `extract_callee_name` returns `on` and the allowlist gate works.
        let s = parse_js("emitter?.on('tick', handlers.fn);");
        let cb = s.calls.iter()
            .find(|c| c.dynamic == Some(true) && c.name == "fn");
        assert!(cb.is_some(), "optional-chain callee must still gate by allowlist");
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
            s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "myNamedCallback"),
            "arr.forEach must still emit myNamedCallback as dynamic call; got: {:?}",
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
            !s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "someKey"),
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
            s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
            "Array.from(arr, mapCallback) must emit mapCallback as dynamic call; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "arr"),
            "Array.from(arr, mapCallback) must not emit `arr` (index 0) as dynamic call; got: {:?}",
            s.calls,
        );
    }

    #[test]
    fn emits_only_index_one_for_array_from_with_this_arg() {
        // `Array.from(arrayLike, mapFn, thisArg)` — thisArg (index 2) is a `this`
        // binding context, not a callback, and must not be emitted either.
        let s = parse_js("Array.from(arr, mapCallback, thisArg);");
        let dynamic_names: Vec<&str> = s.calls.iter()
            .filter(|c| c.dynamic == Some(true))
            .map(|c| c.name.as_str())
            .collect();
        assert_eq!(
            dynamic_names, vec!["mapCallback"],
            "only index-1 mapCallback should be dynamic; got: {:?}", s.calls,
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
            s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
            "Uint8Array.from(arr, mapCallback) must emit mapCallback; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "arr"),
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
            s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "mapper" && c.receiver.as_deref() == Some("obj")),
            "Array.from(arr, obj.mapper) must emit mapper with receiver obj; got: {:?}",
            s.calls,
        );
        assert!(
            !s.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "arr"),
            "Array.from(arr, obj.mapper) must not emit `arr` (index 0); got: {:?}",
            s.calls,
        );

        let s2 = parse_js("Array.from(obj.arrayLike, mapCallback);");
        assert!(
            !s2.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "arrayLike"),
            "Array.from(obj.arrayLike, mapCallback) must not emit `arrayLike` (index 0); got: {:?}",
            s2.calls,
        );
        assert!(
            s2.calls.iter().any(|c| c.dynamic == Some(true) && c.name == "mapCallback"),
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
        assert!(names.contains(&"handleToken"), "should extract handleToken definition");
        assert!(names.contains(&"checkPermissions"), "should extract checkPermissions definition");
        let ht = s.definitions.iter().find(|d| d.name == "handleToken").unwrap();
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
        let s = parse_js("function setup() { const { handleToken, checkPermissions } = initAuth(config); }");
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
        assert!(!s.definitions.iter().any(|d| d.name == "original"), "should not use the original key");
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
            s.calls.iter().map(|c| (&c.name, &c.receiver)).collect::<Vec<_>>()
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

    /// `this.prop = new Ctor()` outside any class declaration (function-style
    /// constructor) falls back to the un-scoped `this.prop` key.
    #[test]
    fn this_prop_constructor_assignment_outside_class_uses_this_key() {
        let s = parse_js(
            "function Service() { this.client = new HttpClient(); }",
        );
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
            s.fn_ref_bindings.iter().all(|b| b.lhs != "a" && b.lhs != "b"),
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
        assert!(def.is_some(), "C.foo definition missing; got: {:?}", s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>());
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(def.complexity.is_some(), "C.foo should have complexity metrics");
        assert!(def.cfg.is_some(), "C.foo should have a CFG");
    }

    #[test]
    fn prototype_arrow_function_method_emits_definition() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.foo = () => { return 1; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.foo");
        assert!(def.is_some(), "C.foo definition missing; got: {:?}", s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>());
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(def.complexity.is_some(), "C.foo (arrow) should have complexity metrics");
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
        assert!(entry.is_some(), "type_map entry A.t missing; got: {:?}", s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
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
        assert!(foo.complexity.is_some(), "C.foo should have complexity metrics");
        assert!(foo.cfg.is_some(), "C.foo should have a CFG");
        assert!(bar.is_some(), "C.bar missing");
        let bar = bar.unwrap();
        assert_eq!(bar.kind, "method");
        assert!(bar.complexity.is_some(), "C.bar should have complexity metrics");
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
        assert!(def.is_some(), "C.greet definition missing; got: {:?}", s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>());
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(def.complexity.is_some(), "C.greet should have complexity metrics");
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
        assert!(entry.is_some(), "type_map entry C.helper missing; got: {:?}", s.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(entry.unwrap().type_name, "helper");
    }

    #[test]
    fn prototype_builtin_globals_are_excluded() {
        let s = parse_js("Array.prototype.custom = function() {};");
        let def = s.definitions.iter().find(|d| d.name.contains("Array"));
        assert!(def.is_none(), "built-in prototype assignment should be ignored; got: {:?}", def);
    }

    #[test]
    fn prototype_direct_method_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.foo = function(x, y) { if (true) { return 1; } return 0; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.foo").expect("C.foo missing");
        assert!(def.complexity.is_some(), "C.foo should have complexity metrics");
        assert!(def.cfg.is_some(), "C.foo should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "x"),
            "C.foo should have parameter 'x'; got: {:?}", children
        );
        assert!(
            children.iter().any(|c| c.name == "y"),
            "C.foo should have parameter 'y'; got: {:?}", children
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
        assert!(def.is_some(), "f.g definition missing; got: {:?}", s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>());
        let def = def.unwrap();
        assert_eq!(def.kind, "method");
        assert!(def.complexity.is_some(), "f.g should have complexity metrics");
        assert!(def.cfg.is_some(), "f.g should have a CFG");
    }

    #[test]
    fn func_prop_arrow_emits_method_definition() {
        let s = parse_js(
            "function f() {}\n\
             f.g = (x) => x + 1;",
        );
        let def = s.definitions.iter().find(|d| d.name == "f.g");
        assert!(def.is_some(), "f.g definition missing; got: {:?}", s.definitions.iter().map(|d| &d.name).collect::<Vec<_>>());
        assert_eq!(def.unwrap().kind, "method");
    }

    #[test]
    fn func_prop_extracts_parameters_as_children() {
        let s = parse_js(
            "function f() {}\n\
             f.process = function(a, b) { return a + b; };",
        );
        let def = s.definitions.iter().find(|d| d.name == "f.process").expect("f.process missing");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "a"),
            "f.process should have parameter 'a'; got: {:?}", children
        );
        assert!(
            children.iter().any(|c| c.name == "b"),
            "f.process should have parameter 'b'; got: {:?}", children
        );
    }

    #[test]
    fn func_prop_builtin_globals_are_excluded() {
        let s = parse_js("console.log = function() {};");
        let def = s.definitions.iter().find(|d| d.name == "console.log");
        assert!(def.is_none(), "built-in global func-prop assignment should be ignored; got: {:?}", def);
    }

    #[test]
    fn func_prop_nested_member_receiver_is_skipped() {
        // Only bare-identifier receivers qualify — `a.b.c = fn` must not emit a
        // definition (mirrors the `obj.type !== 'identifier'` guard in the WASM
        // extractor).
        let s = parse_js("const a = { b: {} };\na.b.c = function() {};");
        let def = s.definitions.iter().find(|d| d.name.ends_with(".c"));
        assert!(def.is_none(), "nested member receiver should be skipped; got: {:?}", def);
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
        assert!(def.is_none(), "C.prototype function assignment should not emit a method; got: {:?}", def);
    }

    #[test]
    fn prototype_direct_arrow_has_complexity_cfg_and_children() {
        let s = parse_js(
            "function C() {}\n\
             C.prototype.bar = (a, b) => a > 0 ? a : b;",
        );
        let def = s.definitions.iter().find(|d| d.name == "C.bar").expect("C.bar missing");
        assert!(def.complexity.is_some(), "C.bar arrow should have complexity metrics");
        assert!(def.cfg.is_some(), "C.bar arrow should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "a"),
            "C.bar should have parameter 'a'; got: {:?}", children
        );
        assert!(
            children.iter().any(|c| c.name == "b"),
            "C.bar should have parameter 'b'; got: {:?}", children
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
        let def = s.definitions.iter().find(|d| d.name == "C.greet").expect("C.greet missing");
        assert!(def.complexity.is_some(), "C.greet should have complexity metrics");
        assert!(def.cfg.is_some(), "C.greet should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "name"),
            "C.greet should have parameter 'name'; got: {:?}", children
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
        let def = s.definitions.iter().find(|d| d.name == "C.bar").expect("C.bar missing");
        assert!(def.complexity.is_some(), "C.bar should have complexity metrics");
        assert!(def.cfg.is_some(), "C.bar should have CFG data");
        let children = def.children.as_deref().unwrap_or(&[]);
        assert!(
            children.iter().any(|c| c.name == "n"),
            "C.bar should have parameter 'n'; got: {:?}", children
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
        assert!(entry.is_some(), "type_map should contain 'obj.f'; got: {:?}", s.type_map);
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
        assert!(e1.is_some(), "type_map should contain 'obj.f1'; got: {:?}", s.type_map);
        assert!(e2.is_some(), "type_map should contain 'obj.f2'; got: {:?}", s.type_map);
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
        assert!(e1.is_some(), "type_map should contain 'obj.f1'; got: {:?}", s.type_map);
        assert!(e2.is_some(), "type_map should contain 'obj.f2'; got: {:?}", s.type_map);
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
        let f_bare_pos = s.definitions.iter().position(|d| d.name == "f" && d.kind == "method");
        let g_bare_pos = s.definitions.iter().position(|d| d.name == "g" && d.kind == "method");
        let f_qual_pos = s.definitions.iter().position(|d| d.name == "o1.f" && d.kind == "function");
        let g_qual_pos = s.definitions.iter().position(|d| d.name == "o1.g" && d.kind == "function");
        assert!(f_bare_pos.is_some(), "bare f(method) missing; got: {:?}", names);
        assert!(g_bare_pos.is_some(), "bare g(method) missing; got: {:?}", names);
        assert!(f_qual_pos.is_some(), "qualified o1.f(function) missing; got: {:?}", names);
        assert!(g_qual_pos.is_some(), "qualified o1.g(function) missing; got: {:?}", names);
        assert!(
            f_bare_pos.unwrap() < f_qual_pos.unwrap(),
            "f(method) at {} must precede o1.f(function) at {} — equal-span tie-break",
            f_bare_pos.unwrap(), f_qual_pos.unwrap()
        );
        assert!(
            g_bare_pos.unwrap() < g_qual_pos.unwrap(),
            "g(method) at {} must precede o1.g(function) at {}",
            g_bare_pos.unwrap(), g_qual_pos.unwrap()
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
        assert!(names.contains(&"obj.foo"), "expected 'obj.foo'; got: {:?}", names);
        assert!(names.contains(&"obj.bar"), "expected 'obj.bar'; got: {:?}", names);
        assert!(
            !names.iter().any(|n| n.contains('[')),
            "no definition name should retain the bracketed/quoted form; got: {:?}",
            names
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
        assert!(names.contains(&"obj.bar"), "expected 'obj.bar'; got: {:?}", names);
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
        assert!(names.contains(&"obj2.computedLet"), "expected 'obj2.computedLet'; got: {:?}", names);
        assert!(names.contains(&"obj2.plain"), "expected 'obj2.plain'; got: {:?}", names);
        assert!(names.contains(&"obj3.computedVar"), "expected 'obj3.computedVar'; got: {:?}", names);
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
        assert!(tm.is_some(), "let obj method: typeMap 'obj.f' missing; got: {:?}",
            s_let_method.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(tm.unwrap().type_name, "f",
            "typeMap 'obj.f' must point at bare name 'f', not the qualified key");
        let call = s_let_method.calls.iter().find(|c| c.name == "f" && c.receiver.as_deref() == Some("obj"));
        assert!(call.is_some(),
            "calls must contain obj.f() with receiver='obj'; got: {:?}",
            s_let_method.calls.iter().map(|c| (&c.name, &c.receiver)).collect::<Vec<_>>());

        // Shorthand property: `var obj = { e4 }` → typeMap['obj.e4'] = 'e4'
        let s_var_shorthand = parse_js(
            "function e4() {}\n\
             var obj = { e4 };",
        );
        let tm2 = s_var_shorthand.type_map.iter().find(|e| e.name == "obj.e4");
        assert!(tm2.is_some(), "var obj shorthand: typeMap 'obj.e4' missing; got: {:?}",
            s_var_shorthand.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(tm2.unwrap().type_name, "e4");

        // Pair with identifier value: `var routes = { get: handler }` → typeMap['routes.get'] = 'handler'
        let s_var_pair = parse_js(
            "function handler() {}\n\
             var routes = { get: handler };",
        );
        let tm3 = s_var_pair.type_map.iter().find(|e| e.name == "routes.get");
        assert!(tm3.is_some(), "var routes pair: typeMap 'routes.get' missing; got: {:?}",
            s_var_pair.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(tm3.unwrap().type_name, "handler");

        // Pair with arrow value: `let api = { save: () => {} }` → typeMap['api.save'] = 'api.save'
        // and a qualified definition 'api.save' must exist (emitted inline by
        // extract_object_literal_functions, called from handle_var_decl's let/var branch).
        let s_let_arrow = parse_js(
            "let api = { save: () => {} };\n\
             api.save();",
        );
        let tm4 = s_let_arrow.type_map.iter().find(|e| e.name == "api.save");
        assert!(tm4.is_some(), "let api arrow: typeMap 'api.save' missing; got: {:?}",
            s_let_arrow.type_map.iter().map(|e| &e.name).collect::<Vec<_>>());
        assert_eq!(tm4.unwrap().type_name, "api.save",
            "typeMap 'api.save' must point at the qualified name 'api.save' (qualified definition exists)");
        assert!(
            s_let_arrow.definitions.iter().any(|d| d.name == "api.save"),
            "let api arrow: qualified definition 'api.save' missing; got: {:?}",
            s_let_arrow.definitions.iter().map(|d| &d.name).collect::<Vec<_>>()
        );
        let call4 = s_let_arrow.calls.iter().find(|c| c.name == "save" && c.receiver.as_deref() == Some("api"));
        assert!(call4.is_some(),
            "calls must contain api.save() with receiver='api'; got: {:?}",
            s_let_arrow.calls.iter().map(|c| (&c.name, &c.receiver)).collect::<Vec<_>>());

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
            s_scoped.type_map.iter().map(|e| &e.name).collect::<Vec<_>>()
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
        assert!(tm.is_some(), "type_map should contain 'obj.f'; got: {:?}", s.type_map);
        assert_eq!(tm.unwrap().type_name, "f1");

        let call = s.calls.iter().find(|c| c.name == "f" && c.receiver.as_deref() == Some("obj"));
        assert!(
            call.is_some(),
            "calls should contain obj.f() with receiver='obj'; got: {:?}",
            s.calls.iter().map(|c| (&c.name, &c.receiver)).collect::<Vec<_>>()
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
        assert!(b.is_some(), "param_bindings should contain hof←target; got: {:?}", s.param_bindings);
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
            s.calls.iter().any(|c| c.name == "invoker" && c.dynamic == Some(true)),
            "invoker.call() should emit a dynamic call to invoker; got: {:?}",
            s.calls.iter().map(|c| (&c.name, c.dynamic)).collect::<Vec<_>>()
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "handler"),
            ".call() args must not become callback-reference calls; got: {:?}",
            s.calls.iter().map(|c| (&c.name, c.dynamic)).collect::<Vec<_>>()
        );
        let b = s.this_call_bindings.iter().find(|b| b.callee == "invoker");
        assert!(b.is_some(), "this_call_bindings should contain invoker→handler; got: {:?}", s.this_call_bindings);
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
            s.calls.iter().map(|c| (&c.name, c.dynamic)).collect::<Vec<_>>()
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
            s.calls.iter().map(|c| (&c.name, c.dynamic)).collect::<Vec<_>>()
        );
        assert!(
            !s.calls.iter().any(|c| c.name == "b"),
            "argument `b` of super(a, b) must not become a callback-reference call; got: {:?}",
            s.calls.iter().map(|c| (&c.name, c.dynamic)).collect::<Vec<_>>()
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
        assert!(got.contains(&(0, "fn1")), "expected (0, fn1); got: {:?}", got);
        assert!(got.contains(&(1, "fn2")), "expected (1, fn2); got: {:?}", got);
    }

    #[test]
    fn spread_arg_binding_recorded() {
        let s = parse_js(
            "function callAll(a, b) { a(); b(); }\n\
             const fns = [x, y];\n\
             callAll(...fns);",
        );
        let b = s.spread_arg_bindings.iter().find(|b| b.callee == "callAll");
        assert!(b.is_some(), "spread_arg_bindings missing; got: {:?}", s.spread_arg_bindings);
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
        assert!(b.is_some(), "Set wrap should bind wrapped[*] ⊇ arr[*]; got: {:?}", s.fn_ref_bindings);
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
        assert!(b.is_some(), "for_of_bindings missing; got: {:?}", s.for_of_bindings);
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
        assert!(b.is_some(), "for_of_bindings missing for g; got: {:?}", s.for_of_bindings);
        assert_eq!(b.unwrap().enclosing_func, "Runner.runAll");
    }

    #[test]
    fn for_of_binding_at_module_level_uses_module_context() {
        let s = parse_js("for (const cb of callbacks) { cb(); }");
        let b = s.for_of_bindings.iter().find(|b| b.var_name == "cb");
        assert!(b.is_some(), "for_of_bindings missing; got: {:?}", s.for_of_bindings);
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
        assert!(b.is_some(), "array_callback_bindings missing; got: {:?}", s.array_callback_bindings);
        assert_eq!(b.unwrap().source_name, "items");
    }

    #[test]
    fn object_rest_param_binding_recorded() {
        let s = parse_js("function f3({ e1, ...eerest }) { eerest.e4(); }");
        let b = s
            .object_rest_param_bindings
            .iter()
            .find(|b| b.callee == "f3");
        assert!(b.is_some(), "object_rest_param_bindings missing; got: {:?}", s.object_rest_param_bindings);
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
        let b = s.object_rest_param_bindings.iter().find(|b| b.rest_name == "rest");
        assert!(b.is_some(), "object_rest_param_bindings missing; got: {:?}", s.object_rest_param_bindings);
        assert_eq!(b.unwrap().callee, "Svc.handle");
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
        assert!(shorthand.is_some(), "shorthand binding missing; got: {:?}", s.object_prop_bindings);
        assert_eq!(shorthand.unwrap().value_name, "e4");

        let pair = s
            .object_prop_bindings
            .iter()
            .find(|b| b.object_name == "obj" && b.prop_name == "alias");
        assert!(pair.is_some(), "pair binding missing; got: {:?}", s.object_prop_bindings);
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
        let dt_call = s.calls.iter().find(|c| c.name.starts_with("<dt_") && c.name.ends_with(">[*]"));
        assert!(dt_call.is_some(), "dispatch-table call missing; got: {:?}", s.calls);
        let dt_call = dt_call.unwrap();
        assert_eq!(dt_call.dynamic, Some(true));
        assert_eq!(dt_call.dynamic_kind.as_deref(), Some("dispatch-table"));

        // The array_elem_bindings must contain dtFn1 and dtFn2 under the same table name
        let table_name = dt_call.name.trim_end_matches("[*]");
        let elem1 = s.array_elem_bindings.iter().find(|b| b.array_name == table_name && b.elem_name == "dtFn1");
        let elem2 = s.array_elem_bindings.iter().find(|b| b.array_name == table_name && b.elem_name == "dtFn2");
        assert!(elem1.is_some(), "dtFn1 array_elem_binding missing; got: {:?}", s.array_elem_bindings);
        assert!(elem2.is_some(), "dtFn2 array_elem_binding missing; got: {:?}", s.array_elem_bindings);
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
        let dt_call = s.calls.iter().find(|c| c.name.starts_with("<dt_") && c.name.ends_with(">[*]"));
        assert!(dt_call.is_some(), "dispatch-table call missing for parenthesized object; got: {:?}", s.calls);
    }
}
