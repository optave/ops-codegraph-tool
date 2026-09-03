use std::collections::{HashMap, HashSet, VecDeque};

use napi_derive::napi;

use crate::domain::graph::builder::barrel_resolution::{self, BarrelContext, ReexportRef};
use crate::domain::graph::builder::stages::import_edges::{import_name_pairs, ImportNameSource};
use crate::domain::graph::resolve;
use crate::graph::classifiers::roles::FRAMEWORK_ENTRY_PREFIXES;
use crate::types::{
    ArrayCallbackBinding, ArrayElemBinding, FnRefBinding, ForOfBinding, ObjectPropBinding,
    ObjectRestParamBinding, ParamBinding, RenamedImport, SpreadArgBinding, ThisCallBinding,
};

/// Kind sets for hierarchy edge resolution -- mirrors the JS constants in
/// `build-edges.js` (`HIERARCHY_SOURCE_KINDS`, `EXTENDS_TARGET_KINDS`,
/// `IMPLEMENTS_TARGET_KINDS`).  Keeping them in one place prevents the
/// native/WASM drift that caused the original parity bug.
const HIERARCHY_SOURCE_KINDS: &[&str] = &["class", "struct", "record", "enum"];
const EXTENDS_TARGET_KINDS: &[&str] = &["class", "struct", "trait", "record"];
const IMPLEMENTS_TARGET_KINDS: &[&str] = &["interface", "trait", "class"];

/// Confidence penalty per alias hop — mirrors `PROPAGATION_HOP_PENALTY` in
/// `src/extractors/javascript.ts`.
pub(crate) const PROPAGATION_HOP_PENALTY: f64 = 0.1;

/// Fixed confidence for typed-receiver (interface/CHA) dispatch edges produced
/// by the native CHA fallback in `resolve_call_targets_core` (#1949). File
/// proximity is not meaningful for virtual dispatch — mirrors
/// `CHA_TYPED_DISPATCH_CONFIDENCE` in `src/domain/graph/builder/helpers.ts`,
/// which all three WASM engine paths (inline, WASM post-pass) and the native
/// post-pass CHA expansion (`runPostNativeCha` in
/// `src/domain/graph/builder/stages/native-orchestrator.ts`) already agree on.
pub(crate) const CHA_TYPED_DISPATCH_CONFIDENCE: f64 = 0.8;

#[napi(object)]
pub struct NodeInfo {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
    /// `get`/`set` when this `method`-kind node is an ES6 accessor
    /// declaration, `None` otherwise (issue #2030). Populated from the DB
    /// `accessor_kind` column — see `loadNodes` in `build-edges.ts` (JS path)
    /// and `load_all_edge_nodes`/`load_edge_node_set` in `pipeline.rs`
    /// (native path) for the two SELECTs that populate this field.
    #[napi(js_name = "accessorKind")]
    pub accessor_kind: Option<String>,
}

#[napi(object)]
pub struct CallInfo {
    pub name: String,
    pub line: u32,
    pub dynamic: Option<bool>,
    pub receiver: Option<String>,
    #[napi(js_name = "dynamicKind")]
    pub dynamic_kind: Option<String>,
    #[napi(js_name = "keyExpr")]
    pub key_expr: Option<String>,
    /// Set on a synthetic property-read call to the accessor kind the read
    /// requires — mirrors TS `Call.accessorRead` (issue #2030). See that
    /// field's doc comment for the full rationale.
    #[napi(js_name = "accessorRead")]
    pub accessor_read: Option<String>,
    /// #2088 — file-local object-literal site id. Mirrors TS `Call.objectLiteralSite`.
    #[napi(js_name = "objectLiteralSite")]
    pub object_literal_site: Option<String>,
}

#[napi(object)]
pub struct ImportedName {
    pub name: String,
    pub file: String,
    /// For renamed specifiers (`import { X as Y }`): the original name
    /// exported by `file` (X), when it differs from `name` (the local
    /// binding Y). `resolve_call_targets` looks this up in `file` instead of
    /// `name` — the renamed local alias only exists in the importing file,
    /// not in `file` itself (#1730).
    pub imported: Option<String>,
    /// True when `name` is bound to the whole module `file` rather than to a
    /// symbol inside it (Python's `import lib as L`, `from pkg import
    /// submod`). A call written `L.f()` then means "f, as declared in `file`"
    /// — see `resolve_call_targets`'s namespace branch (#2387). Mirrors the
    /// `namespace` field of the TS `importedNames` FFI entry.
    pub namespace: Option<bool>,
}

#[napi(object)]
pub struct ClassInfo {
    pub name: String,
    pub extends: Option<String>,
    pub implements: Option<String>,
}

#[napi(object)]
pub struct DefInfo {
    pub name: String,
    pub kind: String,
    pub line: u32,
    #[napi(js_name = "endLine")]
    pub end_line: Option<u32>,
    /// Ordered parameter names for Phase 8.3c parameter-flow pts
    /// (mirrors `buildDefinitionParamsMap` input in build-edges.ts).
    pub params: Option<Vec<String>>,
}

#[napi(object)]
pub struct TypeMapInput {
    pub name: String,
    #[napi(js_name = "typeName")]
    pub type_name: String,
    /// Confidence: 0.9 = type annotation, 1.0 = constructor, 0.7 = factory.
    pub confidence: f64,
}

#[napi(object)]
pub struct FileEdgeInput {
    pub file: String,
    #[napi(js_name = "fileNodeId")]
    pub file_node_id: u32,
    pub definitions: Vec<DefInfo>,
    pub calls: Vec<CallInfo>,
    #[napi(js_name = "importedNames")]
    pub imported_names: Vec<ImportedName>,
    pub classes: Vec<ClassInfo>,
    #[napi(js_name = "typeMap")]
    pub type_map: Vec<TypeMapInput>,
    /// Function-reference bindings for Phase 8.3 pts analysis (optional).
    #[napi(js_name = "fnRefBindings")]
    pub fn_ref_bindings: Option<Vec<FnRefBinding>>,
    /// Phase 8.3c: argument-to-parameter bindings.
    #[napi(js_name = "paramBindings")]
    pub param_bindings: Option<Vec<ParamBinding>>,
    /// This-context bindings from `fn.call(ctx)` / `fn.apply(ctx)`.
    #[napi(js_name = "thisCallBindings")]
    pub this_call_bindings: Option<Vec<ThisCallBinding>>,
    /// Phase 8.3e: array-element bindings.
    #[napi(js_name = "arrayElemBindings")]
    pub array_elem_bindings: Option<Vec<ArrayElemBinding>>,
    /// Phase 8.3e: spread-argument bindings.
    #[napi(js_name = "spreadArgBindings")]
    pub spread_arg_bindings: Option<Vec<SpreadArgBinding>>,
    /// Phase 8.3e: for-of iteration bindings.
    #[napi(js_name = "forOfBindings")]
    pub for_of_bindings: Option<Vec<ForOfBinding>>,
    /// Phase 8.3e: Array.from callback bindings.
    #[napi(js_name = "arrayCallbackBindings")]
    pub array_callback_bindings: Option<Vec<ArrayCallbackBinding>>,
    /// Phase 8.3f: object-rest parameter bindings.
    #[napi(js_name = "objectRestParamBindings")]
    pub object_rest_param_bindings: Option<Vec<ObjectRestParamBinding>>,
    /// Phase 8.3f: object-property bindings.
    #[napi(js_name = "objectPropBindings")]
    pub object_prop_bindings: Option<Vec<ObjectPropBinding>>,
    /// Table names (issue #2260) with confirmed LOCAL computed-invocation
    /// evidence: `const handler = TABLE[computedExpr]; ...; handler(...)`.
    /// Mirrors `ExtractorOutput.computedDispatchTableEvidence` in
    /// `src/types.ts` — see its doc comment for the full rationale.
    #[napi(js_name = "computedDispatchTableEvidence")]
    pub computed_dispatch_table_evidence: Option<Vec<String>>,
    /// RTA instantiation evidence (issue #2346): every constructor type name
    /// that appears in ANY `new X()` expression in this file, regardless of
    /// assignment shape. Mirrors `ExtractorOutput.newExpressions` in
    /// `src/types.ts` — see `collect_cha_instantiated_types`'s doc comment.
    #[napi(js_name = "newExpressions")]
    pub new_expressions: Option<Vec<String>>,
    /// #2088 — object-literal allocation sites. Mirrors TS `ExtractorOutput.objectLiteralSites`.
    #[napi(js_name = "objectLiteralSites")]
    pub object_literal_sites: Option<Vec<crate::types::ObjectLiteralSite>>,
    /// Cross-file return-type call assignments, reused for #2088 site flow
    /// (`const t = f()` → pts(t) ⊇ pts(f::return)).
    #[napi(js_name = "callAssignments")]
    pub call_assignments: Option<Vec<crate::types::NativeCallAssignment>>,
}

#[napi(object)]
pub struct ComputedEdge {
    #[napi(js_name = "sourceId")]
    pub source_id: u32,
    #[napi(js_name = "targetId")]
    pub target_id: u32,
    pub kind: String,
    pub confidence: f64,
    pub dynamic: u32,
    #[napi(js_name = "dynamic_kind")]
    pub dynamic_kind: Option<String>,
    /// Engine-agnostic resolution-technique label (#1996). `None` for edges
    /// resolved by direct name-based lookup — the TS/JS caller backfills
    /// those as `'ts-native'`. `Some("points-to")` for alias-resolved edges
    /// (`emit_pts_alias_edges`), mirroring the WASM/JS inline path's own
    /// `'points-to'` tag for the same semantic case.
    pub technique: Option<String>,
}

/// Internal struct for caller resolution (def line range → node ID).
struct DefWithId<'a> {
    name: &'a str,
    kind: &'a str,
    line: u32,
    end_line: u32,
    node_id: Option<u32>,
}

/// Shared lookup context built once per `build_call_edges` invocation.
struct EdgeContext<'a> {
    nodes_by_name: HashMap<&'a str, Vec<&'a NodeInfo>>,
    nodes_by_name_and_file: HashMap<(&'a str, &'a str), Vec<&'a NodeInfo>>,
    builtin_set: HashSet<&'a str>,
    receiver_kinds: HashSet<&'a str>,
    /// Property/method names ever invoked via member-call syntax
    /// (`x.name(...)`) across every file in this build pass, unioned with
    /// `extra_invoked_property_names` (#2087 — durable cross-pass evidence
    /// for a scoped incremental build; empty on a full build, which is
    /// already exact) — see `collect_invoked_property_names` for the #1895
    /// liveness rationale. Owned (not borrowed) since the extra evidence
    /// comes from outside `files`' own lifetime.
    invoked_property_names: HashSet<String>,
    /// Table names (issue #2260) with confirmed LOCAL computed-invocation
    /// evidence across every file in this build pass — the alternate
    /// liveness pathway for a computed/bracket-access dispatch table
    /// (`const handler = TABLE[computedExpr]; ...; handler(...)`), where a
    /// computed key can't name a specific property statically the way
    /// `TABLE.key(...)` can, so evidence is credited to the whole table
    /// rather than per-key. See `collect_computed_dispatch_table_evidence`.
    computed_dispatch_table_evidence: HashSet<String>,
    /// #2088 correlated `${siteKey}|${name}` evidence.
    correlated_property_sites: HashSet<String>,
    /// #2088 local-closed site keys.
    non_escaping_sites: HashSet<String>,
    correlation_enabled: bool,
    /// CHA + RTA typed-dispatch context (#1949): interface/class name →
    /// concrete classes that implement or extend it, built once per build
    /// pass from every file's `classes` (`extends`/`implements`). Used by
    /// `resolve_call_targets_core`'s CHA fallback tier only — mirrors the
    /// `implementors` half of `ChaContext`/`buildChaContext` in
    /// `src/domain/graph/builder/cha.ts`.
    cha_implementors: HashMap<&'a str, Vec<&'a str>>,
    /// `${parentName}|${parentDeclaringFile}` → concrete classes recorded
    /// while that same file ALSO locally declares a class/interface named
    /// `parentName` — disambiguates two unrelated files each declaring their
    /// own same-named interface/base class (issue #2237). Mirrors
    /// `ChaContext.implementorsByFile` in `cha.ts`. Owned `String` key since
    /// it's a composite built at map-construction time.
    cha_implementors_by_file: HashMap<String, Vec<&'a str>>,
    /// Class name → direct parent class name (from `extends`), first-write-
    /// wins across the whole build pass. Used to walk up to a declaring
    /// ancestor when an instantiated concrete class inherits the dispatched
    /// method without overriding it (issue #2237's Issue 2) — mirrors the
    /// `parents` half of `ChaContext`/`buildChaContext` in `cha.ts`. Serves
    /// as the fallback when `cha_parents_by_file` has no entry for a given
    /// (class, file) pair.
    cha_parents: HashMap<&'a str, &'a str>,
    /// `${childName}|${childDeclaringFile}` → direct parent class name (from
    /// `extends`) — disambiguates two unrelated files each declaring their
    /// own same-named class with different parents (issue #2237, Greptile
    /// review finding on PR #2399). Mirrors `ChaContext.parentsByFile` in
    /// `cha.ts`.
    cha_parents_by_file: HashMap<String, &'a str>,
    /// RTA: class names that appear as a high-confidence (>= 0.9) typeMap
    /// target anywhere in this build pass — mirrors the typeMap fallback
    /// branch of `collectInstantiatedTypes` in `cha.ts` (the native
    /// `FileEdgeInput` has no dedicated `newExpressions` list, so only that
    /// fallback branch applies here).
    cha_instantiated_types: HashSet<&'a str>,
    /// STRICT subset of `cha_instantiated_types`: class names backed ONLY by
    /// a literal `new X()` expression somewhere in this build pass, never by
    /// the weaker type-annotation (confidence 0.9) heuristic. See
    /// `collect_cha_instantiated_types`'s doc comment (issue #2348) for why
    /// `resolve_cha_dispatch`'s receiver-own-type check needs this stricter
    /// bar instead of the merged `cha_instantiated_types` set.
    ///
    /// Still a bare, project-wide set, though — it carries the SAME
    /// cross-file same-name collision risk `cha_implementors_by_file` was
    /// built to fix for `cha_implementors` (Greptile review, PR #2494): two
    /// unrelated files can each declare their own unrelated class named e.g.
    /// `Handler`, and if only ONE of them is ever instantiated, this bare set
    /// can't tell them apart. `cha_new_expression_types_by_file` below exists
    /// for exactly that.
    cha_new_expression_types: HashSet<&'a str>,
    /// `${type_name}|${file}` → present when `type_name`'s OWN `new X()`
    /// evidence was recorded specifically WITHIN `file` — the file-scoped
    /// counterpart to `cha_new_expression_types`, mirroring
    /// `cha_implementors_by_file`'s relationship to `cha_implementors`.
    /// Unlike `cha_implementors_by_file` (positive-evidence-only, falls back
    /// to the bare map on a simple key miss), `resolve_cha_dispatch`'s
    /// root-type check needs a scoped miss to be authoritative whenever the
    /// caller's file is a declaring anchor (see `cha_declared_type_names_by_file`)
    /// — otherwise falling back to the bare set would immediately re-admit
    /// the exact cross-file collision this set exists to prevent.
    cha_new_expression_types_by_file: HashSet<String>,
    /// `${type_name}|${file}` → present when `file` locally declares a
    /// class/interface/struct/type/module named `type_name` (the same anchor
    /// check `build_cha_context` already computes locally for
    /// `cha_implementors_by_file`, persisted here for reuse). Distinguishes
    /// "the caller's file has its OWN local `type_name` to check against"
    /// (trust `cha_new_expression_types_by_file` alone, even when it says
    /// no) from "the caller's file has no local anchor at all" (fall back to
    /// the bare, collision-prone `cha_new_expression_types` — the same
    /// accepted limitation `cha_implementors_by_file` already has when no
    /// local declaration exists).
    cha_declared_type_names_by_file: HashSet<String>,
}

impl<'a> EdgeContext<'a> {
    fn new(
        all_nodes: &'a [NodeInfo],
        builtin_receivers: &'a [String],
        files: &'a [FileEdgeInput],
        extra_invoked_property_names: &[String],
        correlated_property_sites: HashSet<String>,
        correlation_enabled: bool,
    ) -> Self {
        let mut nodes_by_name: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
        let mut nodes_by_name_and_file: HashMap<(&str, &str), Vec<&NodeInfo>> = HashMap::new();
        for node in all_nodes {
            nodes_by_name.entry(&node.name).or_default().push(node);
            nodes_by_name_and_file
                .entry((&node.name, &node.file))
                .or_default()
                .push(node);
        }
        let builtin_set: HashSet<&str> = builtin_receivers.iter().map(|s| s.as_str()).collect();
        let receiver_kinds: HashSet<&str> = ["class", "struct", "interface", "type", "module"]
            .iter()
            .copied()
            .collect();
        let cha = build_cha_context(files);
        let (
            cha_instantiated_types,
            cha_new_expression_types,
            cha_new_expression_types_by_file,
            cha_declared_type_names_by_file,
        ) = collect_cha_instantiated_types(files);
        Self {
            nodes_by_name,
            nodes_by_name_and_file,
            builtin_set,
            receiver_kinds,
            invoked_property_names: collect_invoked_property_names(
                files,
                extra_invoked_property_names,
            ),
            computed_dispatch_table_evidence: collect_computed_dispatch_table_evidence(files),
            correlated_property_sites,
            non_escaping_sites: collect_non_escaping_sites(files),
            correlation_enabled,
            cha_implementors: cha.implementors,
            cha_implementors_by_file: cha.implementors_by_file,
            cha_parents: cha.parents,
            cha_parents_by_file: cha.parents_by_file,
            cha_instantiated_types,
            cha_new_expression_types,
            cha_new_expression_types_by_file,
            cha_declared_type_names_by_file,
        }
    }
}

/// Output of [`build_cha_context`] — mirrors `ChaContext` in `cha.ts`.
struct ChaBuildOutput<'a> {
    implementors: HashMap<&'a str, Vec<&'a str>>,
    implementors_by_file: HashMap<String, Vec<&'a str>>,
    parents: HashMap<&'a str, &'a str>,
    parents_by_file: HashMap<String, &'a str>,
}

/// Build the CHA implementors/parents maps: interface/class name → concrete
/// classes that implement or extend it (`implementors`), class name → direct
/// parent (`parents`), and the file-scoped variant of `implementors`
/// (`implementors_by_file`). Both `implements` and `extends` relationships
/// feed the same `implementors` map (an abstract base class dispatches to its
/// subclasses exactly like an interface dispatches to its implementors) so a
/// multi-level hierarchy (`IFoo` → `AbstractFoo` → `ConcreteFoo`) is
/// BFS-reachable in one structure. Mirrors `recordImplements`/`recordExtends`
/// in `cha.ts`'s `buildChaContext`.
///
/// `implementors_by_file` is populated only when the child's own file ALSO
/// locally declares a class/interface named `parent` — the child's heritage
/// reference most plausibly means that co-located declaration, not an
/// unrelated same-named one elsewhere (issue #2237). `parents` is bare-name,
/// first-write-wins — used only by `resolve_method_via_ancestors`'s walk from
/// an already-disambiguated concrete class, not for `this`/`self`/`super`
/// dispatch (handled separately by `runPostNativeThisDispatch`).
fn build_cha_context<'a>(files: &'a [FileEdgeInput]) -> ChaBuildOutput<'a> {
    let mut implementors: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut implementors_by_file: HashMap<String, Vec<&str>> = HashMap::new();
    let mut parents: HashMap<&str, &str> = HashMap::new();
    let mut parents_by_file: HashMap<String, &str> = HashMap::new();

    for file in files {
        // `file.classes` only lists class RELATIONS (entries with an
        // extends/implements clause) — a bare `interface Handler {}` with no
        // heritage never appears there, so a same-file-anchor check against
        // it alone would miss the exact "plain interface, no relation"
        // shape that's the whole point of the collision this map protects
        // against (#2237). `file.definitions` covers every declared symbol
        // regardless of heritage; filtering to receiver-like kinds mirrors
        // `EdgeContext::receiver_kinds`'s own literal set.
        let local_names: HashSet<&str> = file
            .definitions
            .iter()
            .filter(|d| {
                matches!(
                    d.kind.as_str(),
                    "class" | "struct" | "interface" | "type" | "module"
                )
            })
            .map(|d| d.name.as_str())
            .collect();
        for cls in &file.classes {
            if let Some(ref parent) = cls.implements {
                let list = implementors.entry(parent.as_str()).or_default();
                if !list.contains(&cls.name.as_str()) {
                    list.push(&cls.name);
                }
                if local_names.contains(parent.as_str()) {
                    add_to_file_scoped(&mut implementors_by_file, parent, &file.file, &cls.name);
                }
            }
            if let Some(ref parent) = cls.extends {
                parents.entry(cls.name.as_str()).or_insert(parent.as_str());
                parents_by_file.insert(format!("{}|{}", cls.name, file.file), parent.as_str());
                let list = implementors.entry(parent.as_str()).or_default();
                if !list.contains(&cls.name.as_str()) {
                    list.push(&cls.name);
                }
                if local_names.contains(parent.as_str()) {
                    add_to_file_scoped(&mut implementors_by_file, parent, &file.file, &cls.name);
                }
            }
        }
    }
    ChaBuildOutput {
        implementors,
        implementors_by_file,
        parents,
        parents_by_file,
    }
}

fn add_to_file_scoped<'a>(
    implementors_by_file: &mut HashMap<String, Vec<&'a str>>,
    parent: &str,
    file: &str,
    child: &'a str,
) {
    let key = format!("{}|{}", parent, file);
    let list = implementors_by_file.entry(key).or_default();
    if !list.contains(&child) {
        list.push(child);
    }
}

/// RTA: collect instantiated class names from every file, unioning two
/// sources — mirrors `collectInstantiatedTypes` in `cha.ts` exactly:
/// (a) the dedicated `new_expressions` list (issue #2346): every constructor
/// type name that appears in ANY `new X()` expression in the file, regardless
/// of assignment shape (object-literal property value, bare non-`this.`
/// assignment, etc.) — no confidence threshold applies to this source, same
/// as the TS side; and
/// (b) the typeMap fallback: high-confidence (>= 0.9) entries only
/// (constructor-confidence 1.0 and type-annotation-confidence 0.9 entries
/// both qualify) — covers instantiation evidence inferred indirectly (e.g.
/// cross-file return-type propagation) that never produces a literal
/// `new X()` in this file.
///
/// Returns `(instantiated, new_expression_only, new_expression_only_by_file,
/// declared_type_names_by_file)`. The second set is the STRICT subset
/// sourced from (a) alone, excluding the weaker (b) type-annotation
/// heuristic. `resolve_cha_dispatch`'s receiver-own-type check (#2348) needs
/// this stricter signal: unlike a subclass BFS hit (where the weaker, merged
/// `instantiated` set was already the trusted bar before this fix),
/// re-opening the receiver's OWN qualified method — which the earlier gated
/// qualified-lookup tier already tried and rejected on proximity grounds —
/// must not be justified by a MERE type annotation (e.g. a `db:
/// SomeInterface` parameter), or every distant interface/abstract method
/// would wrongly gain a "calls" edge whenever ANY concrete subclass
/// elsewhere also happens to override the same method name (regression
/// caught by
/// `cha_typed_dispatch_fallback_resolves_distant_interface_implementation`).
///
/// The third and fourth sets (Greptile review, PR #2494) additionally break
/// (a) and the local-declaration anchor check down PER FILE — see
/// `EdgeContext::cha_new_expression_types_by_file`'s and
/// `EdgeContext::cha_declared_type_names_by_file`'s doc comments for how
/// `resolve_cha_dispatch` combines them to disambiguate two unrelated files
/// that happen to declare the same bare class name. The local-declaration
/// filter mirrors `build_cha_context`'s own `local_names` computation
/// exactly (kept as a separate pass here rather than merged into that
/// function's loop, since this function already has its own single pass
/// over `files` for an unrelated purpose).
fn collect_cha_instantiated_types(
    files: &[FileEdgeInput],
) -> (
    HashSet<&str>,
    HashSet<&str>,
    HashSet<String>,
    HashSet<String>,
) {
    let mut instantiated = HashSet::new();
    let mut new_expression_only = HashSet::new();
    let mut new_expression_only_by_file = HashSet::new();
    let mut declared_type_names_by_file = HashSet::new();
    for file in files {
        let local_names: HashSet<&str> = file
            .definitions
            .iter()
            .filter(|d| {
                matches!(
                    d.kind.as_str(),
                    "class" | "struct" | "interface" | "type" | "module"
                )
            })
            .map(|d| d.name.as_str())
            .collect();
        for name in &local_names {
            declared_type_names_by_file.insert(format!("{}|{}", name, file.file));
        }
        if let Some(new_expressions) = &file.new_expressions {
            for type_name in new_expressions {
                instantiated.insert(type_name.as_str());
                new_expression_only.insert(type_name.as_str());
                new_expression_only_by_file.insert(format!("{}|{}", type_name, file.file));
            }
        }
        for tm in &file.type_map {
            if tm.confidence >= 0.9 {
                instantiated.insert(tm.type_name.as_str());
            }
        }
    }
    (
        instantiated,
        new_expression_only,
        new_expression_only_by_file,
        declared_type_names_by_file,
    )
}

/// Resolve `${method_name}` on `cls` or, if `cls` inherits it without
/// overriding, the nearest ancestor (via `ctx.cha_parents`) that actually
/// declares it. A direct qualified lookup alone (`${cls}.${method_name}`)
/// misses whenever `cls` is instantiated but doesn't override the dispatched
/// method — the method node is registered under the declaring ANCESTOR's
/// qualified name, not `cls`'s (issue #2237). Mirrors
/// `resolveMethodViaAncestors` in `cha.ts`.
/// `cls_file`, when known (propagated from a file-scoped BFS hop in
/// `resolve_cha_dispatch`), is used to prefer a same-file qualified-method
/// lookup and a same-file parent-edge lookup at each step — otherwise an
/// unrelated file's identically-named class (with its own identically-named
/// method, or its own different parent chain) can still leak in even after
/// `resolve_cha_dispatch` has correctly scoped which concrete class to walk
/// from (Greptile review finding on PR #2399). Each step falls back to the
/// bare/global lookup when the scoped one finds nothing — never a regression
/// versus the pre-fix behavior. The ancestor's own file is not generally
/// knowable (it may be an unrelated imported base), so `cls_file` is carried
/// forward as an optimistic guess for the next hop only when a same-file
/// parent edge was actually found; otherwise it is cleared to `None`.
fn resolve_method_via_ancestors<'a>(
    ctx: &EdgeContext<'a>,
    cls: &'a str,
    cls_file: Option<&str>,
    method_name: &str,
) -> Vec<&'a NodeInfo> {
    let mut current = Some(cls);
    let mut current_file = cls_file;
    let mut visited: HashSet<&str> = HashSet::new();
    while let Some(cur) = current {
        if !visited.insert(cur) {
            break;
        }
        let qualified = format!("{}.{}", cur, method_name);
        if let Some(found) = ctx.nodes_by_name.get(qualified.as_str()) {
            let scoped_methods: Vec<&'a NodeInfo> = current_file
                .map(|f| {
                    found
                        .iter()
                        .copied()
                        .filter(|n| n.kind == "method" && n.file == f)
                        .collect()
                })
                .unwrap_or_default();
            let methods = if !scoped_methods.is_empty() {
                scoped_methods
            } else {
                found
                    .iter()
                    .copied()
                    .filter(|n| n.kind == "method")
                    .collect()
            };
            if !methods.is_empty() {
                return methods;
            }
        }
        let scoped_parent = current_file.and_then(|f| {
            ctx.cha_parents_by_file
                .get(&format!("{}|{}", cur, f))
                .copied()
        });
        let next_file = if scoped_parent.is_some() {
            current_file
        } else {
            None
        };
        current = scoped_parent.or_else(|| ctx.cha_parents.get(cur).copied());
        current_file = next_file;
    }
    Vec::new()
}

/// CHA + RTA: given a receiver's resolved type name (interface or class),
/// return all concrete method implementations reachable via the class
/// hierarchy, filtered to types that are actually instantiated somewhere in
/// the project (RTA). BFS over the implementors map so multi-level
/// hierarchies (`IFoo` → `AbstractFoo` → `ConcreteFoo`) transparently skip
/// non-instantiated intermediate classes while still reaching their
/// instantiated concrete subclasses. When an instantiated class inherits the
/// dispatched method rather than overriding it, `resolve_method_via_ancestors`
/// walks up to find the declaring ancestor instead of missing the edge
/// entirely (#2237). No confidence filtering is applied here; callers use the
/// flat `CHA_TYPED_DISPATCH_CONFIDENCE` for any edge built from this tier's
/// results (file proximity is not meaningful for virtual dispatch).
///
/// At every BFS level (not just the root), when the current node's file is
/// known, this prefers `ctx.cha_implementors_by_file` over the bare
/// (project-wide) `cha_implementors` map — disambiguating two unrelated
/// files that each declare their own same-named interface/base class
/// (#2237; mirrors `resolveChaTargets`'s identical scoping in `cha.ts` — see
/// that function's doc comment for the full rationale and non-regression
/// guarantee). The starting node's file is `caller_file` (when provided); a
/// discovered child's file is known ONLY when its parent was found via the
/// scoped bucket — `cha_implementors_by_file` is populated exactly when the
/// child's own file also locally declares that parent, so the child is
/// *guaranteed* to live in that same file.
///
/// The receiver's own declared type (`type_name`) is a valid dispatch target
/// too, not just its subclasses. Previously this function only walked
/// `cha_implementors`/`cha_implementors_by_file` starting FROM `type_name` to
/// find children — it never checked whether `type_name` itself is
/// instantiated. When the receiver's own type is instantiated directly and
/// ALSO has an unrelated subclass overriding the same method (even a
/// test-file-local one), the base type's own method was silently dropped
/// from the result set while the unrelated subclass's override leaked in
/// instead (#2348). Resolving `type_name` via the same
/// `resolve_method_via_ancestors` helper used for children fixes this
/// symmetrically — a duplicate resolution of an already-correctly-resolved
/// edge is a no-op thanks to the caller's `seen_call_edges` dedup, so this
/// can only add a missing edge, never introduce a wrong one.
///
/// This root-type check deliberately uses `ctx.cha_new_expression_types`
/// (STRICT: literal `new X()` evidence only) rather than the merged
/// `ctx.cha_instantiated_types` (which also credits a bare high-confidence
/// type-annotation, e.g. a `db: SomeInterface` parameter, as "instantiated").
/// A child's BFS hit can safely trust the weaker merged signal because it is
/// additionally gated by actually walking the class hierarchy to reach that
/// child in the first place; the root has no such gate — `type_name` here is
/// exactly what the earlier, proximity-gated qualified lookup already tried
/// (and rejected) one tier up, so re-admitting it ungated on nothing more
/// than a type annotation would wrongly resurrect a distant interface's own
/// (bodyless) method purely because some unrelated concrete subclass happens
/// to override the same method name (regression caught by
/// `cha_typed_dispatch_fallback_resolves_distant_interface_implementation`).
///
/// `ctx.cha_new_expression_types` is STILL a bare, project-wide set, though
/// (Greptile review, PR #2494): two unrelated files can each declare their
/// own unrelated class with the same bare name (e.g. both name a class
/// `Handler`), and if only ONE of them is ever instantiated, a bare
/// `cha_new_expression_types.contains(type_name)` can't tell them apart — it
/// would treat that as proof THIS caller's `Handler` was instantiated too,
/// and `resolve_method_via_ancestors`'s own bare/global fallback could then
/// resolve to the OTHER file's `Handler.method`. So the check below prefers
/// the file-scoped `cha_new_expression_types_by_file` whenever `caller_file`
/// itself locally declares `type_name` (`cha_declared_type_names_by_file` —
/// the same anchor `cha_implementors_by_file` uses) — in that case a scoped
/// miss is trusted as an authoritative "not instantiated (in THIS file's
/// sense of `type_name`)", never falling through to the bare set. Only when
/// `caller_file` has no such local anchor at all (imports `type_name` from
/// elsewhere, or `caller_file` is unknown) does this fall back to the bare,
/// collision-prone `cha_new_expression_types` — the same accepted limitation
/// `cha_implementors_by_file` already has for that exact situation.
///
/// `type_name` is deliberately NOT given an explicit `'a` bound here: at one
/// call site (the inline-new-expression branch of `resolve_call_targets_core`)
/// it can be a reference into a locally-computed `String` that does not live
/// as long as `'a`. `resolve_method_via_ancestors` requires `cls: &'a str`,
/// so the root-type check below re-looks-up the matching interned key
/// straight out of `ctx.cha_new_expression_types` (which is genuinely `&'a
/// str`) via `HashSet::get`, rather than passing `type_name` itself.
fn resolve_cha_dispatch<'a>(
    ctx: &EdgeContext<'a>,
    type_name: &str,
    method_name: &str,
    caller_file: Option<&str>,
) -> Vec<&'a NodeInfo> {
    let mut results: Vec<&'a NodeInfo> = Vec::new();
    let mut queue: VecDeque<(&str, Option<&str>)> = VecDeque::from([(type_name, caller_file)]);
    let mut visited: HashSet<&str> = HashSet::new();
    visited.insert(type_name);

    let has_local_declaration = caller_file
        .map(|f| {
            ctx.cha_declared_type_names_by_file
                .contains(&format!("{}|{}", type_name, f))
        })
        .unwrap_or(false);
    let is_root_instantiated = if has_local_declaration {
        caller_file
            .map(|f| {
                ctx.cha_new_expression_types_by_file
                    .contains(&format!("{}|{}", type_name, f))
            })
            .unwrap_or(false)
    } else {
        ctx.cha_new_expression_types.contains(type_name)
    };
    if is_root_instantiated {
        if let Some(&interned_type_name) = ctx.cha_new_expression_types.get(type_name) {
            results.extend(resolve_method_via_ancestors(
                ctx,
                interned_type_name,
                caller_file,
                method_name,
            ));
        }
    }

    while let Some((current, current_file)) = queue.pop_front() {
        let scoped = current_file.and_then(|f| {
            ctx.cha_implementors_by_file
                .get(&format!("{}|{}", current, f))
        });
        let children = match scoped {
            Some(list) => list,
            None => match ctx.cha_implementors.get(current) {
                Some(list) => list,
                None => continue,
            },
        };
        let child_file = if scoped.is_some() { current_file } else { None };
        for &cls in children {
            if visited.contains(cls) {
                continue;
            }
            visited.insert(cls);

            if ctx.cha_instantiated_types.contains(cls) {
                results.extend(resolve_method_via_ancestors(
                    ctx,
                    cls,
                    child_file,
                    method_name,
                ));
            }

            // Always traverse children — non-instantiated classes may have
            // instantiated subclasses.
            queue.push_back((cls, child_file));
        }
    }

    results
}

/// Additive typed-receiver CHA dispatch expansion (issue #2139). Mirrors the
/// typed-receiver branch of `emitChaCallEdgesForCall` in `build-edges.ts`
/// exactly: unlike tier 3.7 inside `resolve_call_targets` above (which only
/// fires when the whole mutually-exclusive resolution cascade already found
/// nothing), this runs unconditionally for every receiver call, additive to
/// whatever the cascade already resolved.
///
/// That distinction is the actual bug this closes: an earlier cascade tier
/// (e.g. import-aware resolution, which matches `call.name` regardless of
/// receiver) can return a target and short-circuit the whole cascade before
/// tier 3.7 ever runs — so a genuinely interface-typed, multi-implementer
/// receiver dispatch (`repo.getClassHierarchy()` where `getClassHierarchy`
/// is *also* an importable free function) never reached CHA resolution at
/// all. WASM has no such gap because `emitChaCallEdgesForCall` is called as
/// an unconditional additive step (Step 6 of `buildFileCallEdges`), not a
/// last-resort fallback tier.
///
/// `this`/`self`/`super` dispatch is intentionally excluded — that's handled
/// separately (and already correctly) by `runPostNativeThisDispatch`
/// (native-orchestrator.ts); mixing the two would risk duplicate or
/// conflicting edges for the same call site.
#[allow(clippy::too_many_arguments)]
fn emit_cha_dispatch_edges(
    ctx: &EdgeContext,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &str,
    caller_file: &str,
    type_map: &HashMap<&str, (&str, f64)>,
    seen_edges: &mut HashSet<u64>,
    pts_edge_map: &HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    let Some(ref receiver) = call.receiver else {
        return;
    };
    if ctx.builtin_set.contains(receiver.as_str())
        || receiver == "this"
        || receiver == "self"
        || receiver == "super"
    {
        return;
    }

    // Function-scoped key checked before the bare key, same as
    // emit_receiver_edge/resolve_call_targets_core — otherwise a same-named
    // local/parameter in a DIFFERENT function can still leak its (wrong)
    // hierarchy into this call's additive CHA expansion (#2235 follow-up).
    let scoped_key = if caller_name.is_empty() {
        None
    } else {
        Some(format!("{}::{}", caller_name, receiver))
    };
    let type_entry = scoped_key
        .as_deref()
        .and_then(|k| type_map.get(k))
        .or_else(|| type_map.get(receiver.as_str()));
    let Some(&(type_name, _)) = type_entry else {
        return;
    };

    for t in resolve_cha_dispatch(ctx, type_name, call.name.as_str(), Some(caller_file)) {
        let edge_key = ((caller_id as u64) << 32) | (t.id as u64);
        if t.id != caller_id
            && !seen_edges.contains(&edge_key)
            && !pts_edge_map.contains_key(&edge_key)
        {
            seen_edges.insert(edge_key);
            edges.push(ComputedEdge {
                source_id: caller_id,
                target_id: t.id,
                kind: "calls".to_string(),
                confidence: CHA_TYPED_DISPATCH_CONFIDENCE,
                dynamic: 0,
                dynamic_kind: None,
                technique: Some("cha".to_string()),
            });
        }
    }
}

/// Collect the set of property/method names ever invoked via member-call
/// syntax (`x.name(...)`) across every file currently being processed —
/// regardless of whether the receiver `x` itself resolves to anything.
///
/// Used as the "one hop further" liveness check for object-literal-property
/// value-refs (#1895): a function referenced as `{ resolve: someFn }` should
/// only be credited with a `calls` edge from that reference when something,
/// somewhere, actually invokes a `.resolve(...)`-shaped call — otherwise the
/// property is wired up but never read, and `someFn` is genuinely dead.
///
/// Scope matches whatever `files` the caller passes to `build_call_edges`,
/// unioned with `extra` (#2087) — durable per-file evidence persisted into
/// `invoked_property_names` from a prior build pass, letting a scoped
/// incremental build see evidence contributed by a file it isn't currently
/// reprocessing. `files` alone is exact on a full build (it IS the whole
/// codebase) and narrower on an incremental one (just the changed file(s) —
/// a cross-file consumer added in an untouched file won't be seen without
/// `extra`) — the same scoping trade-off already accepted elsewhere in this
/// codebase's incremental classification (`has_active_file_siblings` and
/// exported-via-reexport both recompute from the affected file set only, not
/// the whole graph, in `graph/classifiers/roles.rs`'s incremental path —
/// median fan-in/out is a separate case, deliberately kept as a whole-graph
/// statistic even on the incremental path, for classification-threshold
/// consistency). Mirrors `collectInvokedPropertyNames` in
/// `src/domain/graph/builder/call-resolver.ts`.
///
/// Excludes `dynamic_kind: "value-ref"` calls (issue #2260): those carry a
/// `receiver` of their own now (the dispatch-table's name, set by
/// `handle_object_literal_pair_value_ref` — used for the computed-access
/// liveness pathway, see `computed_dispatch_table_evidence`), but a
/// value-ref call is itself a bare VALUE reference, never a real
/// invocation — crediting its `name` (the referenced function's own
/// identifier) here would pollute this set with a name that was never
/// actually invoked via member-call syntax.
fn collect_invoked_property_names(files: &[FileEdgeInput], extra: &[String]) -> HashSet<String> {
    let mut names = HashSet::new();
    for file in files {
        for call in &file.calls {
            if call.receiver.is_some() && call.dynamic_kind.as_deref() != Some("value-ref") {
                names.insert(call.name.clone());
            }
        }
    }
    for name in extra {
        names.insert(name.clone());
    }
    names
}

/// Aggregate table names (issue #2260) with confirmed LOCAL computed-
/// Scope key for #2260's computed-dispatch-table evidence set:
/// `${file}::${tableName}`. A bare table name would let two unrelated files
/// that each declare a same-named table (e.g. `HANDLERS`) share liveness —
/// one file's confirmed computed-invocation evidence would wrongly credit
/// the other file's same-named-but-unrelated table (Greptile review, PR
/// #2445) — so every lookup/insert into that set must go through this key,
/// mirroring this same struct's `cha_implementors_by_file`/
/// `cha_parents_by_file` cross-file disambiguation convention (#2237) and
/// the TypeScript-side `computedDispatchTableEvidenceKey` in
/// `stages/build-edges.ts`.
fn computed_dispatch_table_evidence_key(file: &str, table_name: &str) -> String {
    format!("{file}::{table_name}")
}

fn has_invocation_evidence(
    call: &CallInfo,
    rel_path: &str,
    ctx: &EdgeContext<'_>,
    key_expr: &str,
) -> bool {
    let site_key = call
        .object_literal_site
        .as_deref()
        .map(|site| object_literal_site_key(rel_path, site));
    let local_closed = site_key
        .as_ref()
        .is_some_and(|k| ctx.non_escaping_sites.contains(k));
    if ctx.correlation_enabled && local_closed {
        if let Some(site_key) = site_key.as_deref() {
            if ctx
                .correlated_property_sites
                .contains(&correlated_evidence_key(site_key, key_expr))
            {
                return true;
            }
        }
    } else if ctx.invoked_property_names.contains(key_expr) {
        return true;
    }
    call.receiver.as_deref().is_some_and(|r| {
        ctx.computed_dispatch_table_evidence
            .contains(&computed_dispatch_table_evidence_key(rel_path, r))
    })
}

/// invocation evidence across every file in this build pass — mirrors
/// `computedDispatchTableEvidence`'s aggregation in
/// `src/domain/graph/builder/stages/build-edges.ts`. Each file's own list
/// is populated by `handle_computed_dispatch_table_evidence` in
/// `extractors/javascript.rs` (native-parsed) or by
/// `collectComputedDispatchTableEvidence` in `extractors/javascript.ts`
/// (WASM-parsed, threaded through `FileEdgeInput` via NAPI). No persisted-
/// table union (unlike `collect_invoked_property_names`'s `extra` param) —
/// the table+consumer for this idiom are typically same-file, so this
/// narrower, in-memory-only scope is accepted for now; a cross-file case
/// missed on a scoped incremental build recovers on the next full build.
fn collect_non_escaping_sites(files: &[FileEdgeInput]) -> HashSet<String> {
    let mut sites = HashSet::new();
    for file in files {
        if let Some(list) = &file.object_literal_sites {
            for site in list {
                if !site.escapes {
                    sites.insert(object_literal_site_key(&file.file, &site.site));
                }
            }
        }
    }
    sites
}

fn candidate_scopes_for(caller_name: &str) -> Vec<String> {
    let scoped = if caller_name.is_empty() {
        "<module>".to_string()
    } else {
        caller_name.to_string()
    };
    let mut scopes = vec![scoped];
    if let Some(idx) = caller_name.rfind('.') {
        scopes.push(caller_name[idx + 1..].to_string());
    }
    scopes.push("<module>".to_string());
    scopes.sort();
    scopes.dedup();
    scopes
}

/// Per-file points-to maps plus `${siteKey}|${name}` keys for this pass (#2088).
///
/// Mirrors `prepareInvokedPropertySiteResolution` in `build-edges.ts`: the
/// Andersen solver runs once per file and the maps are reused for both
/// `invoked_property_sites` persistence and call-edge emission. Computing
/// them separately (persist, then `EdgeContext`, then `process_file`) was
/// three solver passes per file on the native orchestrator path.
pub(crate) struct InvokedPropertySitePrep {
    pub sites_by_file: HashMap<String, HashSet<String>>,
    pub pts_maps_by_file: HashMap<String, HashMap<String, HashSet<String>>>,
}

/// #2088 pass 1: per-file pts maps + correlated keys. Used by the native
/// orchestrator to persist `invoked_property_sites` and by `build_call_edges`
/// / `build_call_edges_prepared` to emit T1 evidence without re-solving.
pub(crate) fn prepare_invoked_property_site_resolution(
    files: &[FileEdgeInput],
    all_nodes: &[NodeInfo],
    max_iterations: u32,
) -> InvokedPropertySitePrep {
    let mut nodes_by_file: HashMap<&str, Vec<&NodeInfo>> = HashMap::new();
    for node in all_nodes {
        nodes_by_file
            .entry(node.file.as_str())
            .or_default()
            .push(node);
    }

    let mut sites_by_file: HashMap<String, HashSet<String>> = HashMap::new();
    let mut pts_maps_by_file: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
    for file in files {
        let imported_names: HashMap<&str, &str> = file
            .imported_names
            .iter()
            .map(|im| (im.name.as_str(), im.file.as_str()))
            .collect();
        let Some(pts) = build_pts_map_for_file(file, &imported_names, max_iterations) else {
            continue;
        };
        let file_nodes: &[&NodeInfo] = nodes_by_file
            .get(file.file.as_str())
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        let defs_with_ids: Vec<DefWithId> = file
            .definitions
            .iter()
            .map(|d| {
                let node_id = file_nodes
                    .iter()
                    .find(|n| n.name == d.name && n.kind == d.kind && n.line == d.line)
                    .map(|n| n.id);
                DefWithId {
                    name: &d.name,
                    kind: &d.kind,
                    line: d.line,
                    end_line: d.end_line.unwrap_or(u32::MAX),
                    node_id,
                }
            })
            .collect();
        let mut keys = HashSet::new();
        for call in &file.calls {
            if call.receiver.is_none() || call.dynamic_kind.as_deref() == Some("value-ref") {
                continue;
            }
            let Some(receiver) = call.receiver.as_deref() else {
                continue;
            };
            let (_, caller_name, _) =
                find_enclosing_caller(&defs_with_ids, call.line, file.file_node_id);
            for scope in candidate_scopes_for(caller_name) {
                for site_key in resolve_sites_via_points_to(&format!("{scope}::{receiver}"), &pts) {
                    keys.insert(correlated_evidence_key(site_key, &call.name));
                }
            }
            for site_key in resolve_sites_via_points_to(receiver, &pts) {
                keys.insert(correlated_evidence_key(site_key, &call.name));
            }
        }
        if !keys.is_empty() {
            sites_by_file.insert(file.file.clone(), keys);
        }
        pts_maps_by_file.insert(file.file.clone(), pts);
    }
    InvokedPropertySitePrep {
        sites_by_file,
        pts_maps_by_file,
    }
}

fn union_invoked_property_sites(
    extra: &[String],
    sites_by_file: &HashMap<String, HashSet<String>>,
) -> HashSet<String> {
    let mut keys = HashSet::new();
    for extra_key in extra {
        keys.insert(extra_key.clone());
    }
    for file_keys in sites_by_file.values() {
        keys.extend(file_keys.iter().cloned());
    }
    keys
}

fn collect_computed_dispatch_table_evidence(files: &[FileEdgeInput]) -> HashSet<String> {
    let mut names = HashSet::new();
    for file in files {
        if let Some(evidence) = &file.computed_dispatch_table_evidence {
            for name in evidence {
                names.insert(computed_dispatch_table_evidence_key(&file.file, name));
            }
        }
    }
    names
}

// ── Phase 8.3: points-to analysis ─────────────────────────────────────────

/// Default maximum fixed-point iterations for the pts solver — mirrors
/// `MAX_SOLVER_ITERATIONS` in `src/domain/graph/resolver/points-to.ts` and
/// `DEFAULTS.analysis.pointsToMaxIterations` in `src/infrastructure/config.ts`.
/// `build_call_edges()` now receives the resolved value as an explicit
/// `max_iterations` parameter (threaded from `BuildConfig.analysis.points_to_max_iterations`
/// on the native-first pipeline path, or from `ctx.config.analysis.pointsToMaxIterations`
/// via the napi call on the JS-orchestrated per-stage path); production code no
/// longer references this constant directly, so it is `#[cfg(test)]`-gated —
/// it remains only as the fallback default used directly by unit tests below.
#[cfg(test)]
const MAX_SOLVER_ITERATIONS: u32 = 50;

/// Per-file points-to binding inputs, borrowed from a `FileEdgeInput`.
/// `fn_ref_bindings` must already include the `fn::this → ctx` conversions
/// from `this_call_bindings` (see `process_file`).
struct PtsBindings<'a> {
    fn_ref_bindings: &'a [FnRefBinding],
    param_bindings: &'a [ParamBinding],
    array_elem_bindings: &'a [ArrayElemBinding],
    spread_arg_bindings: &'a [SpreadArgBinding],
    for_of_bindings: &'a [ForOfBinding],
    array_callback_bindings: &'a [ArrayCallbackBinding],
    object_rest_param_bindings: &'a [ObjectRestParamBinding],
    object_prop_bindings: &'a [ObjectPropBinding],
}

/// Build a per-file points-to map.  Mirrors `buildPointsToMap` in
/// `src/domain/graph/resolver/points-to.ts` (full Phase 8.3–8.3f model).
///
/// Seeds every locally-defined callable and every imported name as pointing
/// to itself, generates inclusion constraints (`pts(lhs) ⊇ pts(rhsKey)`)
/// from every binding kind, then solves by fixed-point iteration.
///
/// `max_iterations` caps the fixed-point loop below — resolved from
/// `CodegraphConfig.analysis.pointsToMaxIterations` by the caller (mirrors
/// the `maxIterations` parameter of the TS `buildPointsToMap`).
const OBJLIT_PTS_PREFIX: &str = "objlit@";

fn object_literal_site_key(rel_path: &str, site: &str) -> String {
    format!("{OBJLIT_PTS_PREFIX}{rel_path}#{site}")
}

fn correlated_evidence_key(site_key: &str, property_name: &str) -> String {
    format!("{site_key}|{property_name}")
}

#[allow(clippy::too_many_arguments)]
fn build_points_to_map(
    bindings: &PtsBindings,
    def_names: &HashSet<&str>,
    imported_names: &HashMap<&str, &str>,
    definition_params: &HashMap<&str, Vec<&str>>,
    max_iterations: u32,
    rel_path: &str,
    object_literal_sites: &[crate::types::ObjectLiteralSite],
    call_assignments: &[crate::types::NativeCallAssignment],
) -> HashMap<String, HashSet<String>> {
    let mut pts: HashMap<String, HashSet<String>> = HashMap::new();
    for name in def_names {
        pts.entry(name.to_string())
            .or_default()
            .insert(name.to_string());
    }
    for name in imported_names.keys() {
        pts.entry(name.to_string())
            .or_default()
            .insert(name.to_string());
    }

    // Constraint list: pts(lhs) ⊇ pts(rhsKey). Member-expression rhs keys are
    // composite ("obj.method") and only flow when a prior seed exists — safe.
    let mut constraints: Vec<(String, String)> = bindings
        .fn_ref_bindings
        .iter()
        .map(|b| {
            let rhs_key = match &b.rhs_receiver {
                Some(recv) => format!("{}.{}", recv, b.rhs),
                None => b.rhs.clone(),
            };
            (b.lhs.clone(), rhs_key)
        })
        .collect();

    // Phase 8.3c: parameter-flow constraints — `f(x)` at argIndex i adds
    // pts(f::param_i) ⊇ pts(x). Keys are scoped "callee::paramName" to prevent
    // collisions between same-named params across functions in one file.
    for pb in bindings.param_bindings {
        if let Some(params) = definition_params.get(pb.callee.as_str()) {
            if let Some(param_name) = params.get(pb.arg_index as usize) {
                constraints.push((
                    format!("{}::{}", pb.callee, param_name),
                    pb.arg_name.clone(),
                ));
            }
        }
    }

    // Phase 8.3e: array-element bindings — seed per-index entries, wildcard
    // `arr[*]` collects all elements via constraints.
    for ab in bindings.array_elem_bindings {
        let elem_key = format!("{}[{}]", ab.array_name, ab.index);
        pts.entry(elem_key.clone())
            .or_default()
            .insert(ab.elem_name.clone());
        constraints.push((format!("{}[*]", ab.array_name), elem_key));
    }

    // Phase 8.3e: spread-argument constraints — `f(...arr)` maps known array
    // elements onto parameter slots; unknown sizes fall back to the wildcard.
    if !bindings.spread_arg_bindings.is_empty() {
        let mut array_max_index: HashMap<&str, i64> = HashMap::new();
        for ab in bindings.array_elem_bindings {
            let cur = array_max_index.entry(ab.array_name.as_str()).or_insert(-1);
            if i64::from(ab.index) > *cur {
                *cur = i64::from(ab.index);
            }
        }
        for sb in bindings.spread_arg_bindings {
            let Some(params) = definition_params.get(sb.callee.as_str()) else {
                continue;
            };
            let max_idx = array_max_index
                .get(sb.array_name.as_str())
                .copied()
                .unwrap_or(-1);
            // Safety: the cast to usize is only reached inside the `max_idx >= 0` guard,
            // so max_idx is non-negative here and cannot wrap to usize::MAX.
            if max_idx >= 0 {
                for i in 0..=(max_idx as usize) {
                    let param_idx = sb.start_index as usize + i;
                    let Some(param) = params.get(param_idx) else {
                        break;
                    };
                    constraints.push((
                        format!("{}::{}", sb.callee, param),
                        format!("{}[{}]", sb.array_name, i),
                    ));
                }
            } else {
                for param in params.iter().skip(sb.start_index as usize) {
                    constraints.push((
                        format!("{}::{}", sb.callee, param),
                        format!("{}[*]", sb.array_name),
                    ));
                }
            }
        }
    }

    // Phase 8.3e: for-of constraints — `for (const x of arr)` inside `outer`
    // adds pts(outer::x) ⊇ pts(arr[*]).
    for fb in bindings.for_of_bindings {
        constraints.push((
            format!("{}::{}", fb.enclosing_func, fb.var_name),
            format!("{}[*]", fb.source_name),
        ));
    }

    // Phase 8.3e: Array.from(source, cb) — pts(cb::param0) ⊇ pts(source[*]).
    for cb in bindings.array_callback_bindings {
        if let Some(param0) = definition_params
            .get(cb.callee_name.as_str())
            .and_then(|p| p.first())
        {
            constraints.push((
                format!("{}::{}", cb.callee_name, param0),
                format!("{}[*]", cb.source_name),
            ));
        }
    }

    // Phase 8.3f: object-rest dispatch — `function f({ ...rest })` + `f(obj)` +
    // `const obj = { prop: fn }` seeds pts("rest.prop") = {"fn"}.
    if !bindings.object_rest_param_bindings.is_empty()
        && !bindings.object_prop_bindings.is_empty()
        && !bindings.param_bindings.is_empty()
    {
        let mut param_by_callee_idx: HashMap<(&str, u32), Vec<&str>> = HashMap::new();
        for pb in bindings.param_bindings {
            param_by_callee_idx
                .entry((pb.callee.as_str(), pb.arg_index))
                .or_default()
                .push(pb.arg_name.as_str());
        }
        let mut props_by_object: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
        for ob in bindings.object_prop_bindings {
            props_by_object
                .entry(ob.object_name.as_str())
                .or_default()
                .push((ob.prop_name.as_str(), ob.value_name.as_str()));
        }
        for rb in bindings.object_rest_param_bindings {
            let Some(arg_names) = param_by_callee_idx.get(&(rb.callee.as_str(), rb.arg_index))
            else {
                continue;
            };
            for arg_name in arg_names {
                let Some(props) = props_by_object.get(arg_name) else {
                    continue;
                };
                for (prop_name, value_name) in props {
                    if !def_names.contains(value_name) && !imported_names.contains_key(value_name) {
                        continue;
                    }
                    pts.entry(format!("{}.{}", rb.rest_name, prop_name))
                        .or_default()
                        .insert((*value_name).to_string());
                }
            }
        }
    }

    for site in object_literal_sites {
        let site_key = object_literal_site_key(rel_path, &site.site);
        pts.entry(site_key.clone())
            .or_default()
            .insert(site_key.clone());
        if let Some(owner) = &site.owner {
            constraints.push((owner.clone(), site_key));
        }
    }
    for ca in call_assignments {
        let return_key = format!("{}::return", ca.callee_name);
        if pts.contains_key(&return_key) || constraints.iter().any(|(lhs, _)| lhs == &return_key) {
            constraints.push((ca.var_name.clone(), return_key));
        }
    }

    if constraints.is_empty() {
        return pts;
    }

    // Fixed-point iteration: propagate pts sets until no new information flows.
    for _ in 0..max_iterations {
        let mut changed = false;
        for (lhs, rhs_key) in &constraints {
            let rhs_pts: Option<Vec<String>> = pts
                .get(rhs_key.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.iter().cloned().collect());
            if let Some(targets) = rhs_pts {
                let entry = pts.entry(lhs.clone()).or_default();
                for t in targets {
                    if entry.insert(t) {
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    pts
}

/// Return the concrete targets `call_name` flows to, excluding self-references.
/// Mirrors `resolveViaPointsTo` in `src/domain/graph/resolver/points-to.ts`.
fn resolve_via_points_to<'a>(
    call_name: &str,
    pts: &'a HashMap<String, HashSet<String>>,
) -> Vec<&'a str> {
    match pts.get(call_name) {
        None => vec![],
        Some(targets) => targets
            .iter()
            .filter(|t| t.as_str() != call_name && !t.starts_with(OBJLIT_PTS_PREFIX))
            .map(|t| t.as_str())
            .collect(),
    }
}

fn resolve_sites_via_points_to<'a>(
    var_name: &str,
    pts: &'a HashMap<String, HashSet<String>>,
) -> Vec<&'a str> {
    match pts.get(var_name) {
        None => vec![],
        Some(targets) => targets
            .iter()
            .filter(|t| t.starts_with(OBJLIT_PTS_PREFIX))
            .map(|t| t.as_str())
            .collect(),
    }
}

/// Per-call-site inputs for `emit_pts_alias_edges`.
/// Groups the lookup parameters so the function stays within the argument-count limit.
struct PtsAliasCtx<'a> {
    pts: &'a HashMap<String, HashSet<String>>,
    lookup_name: &'a str,
    call_line: u32,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    rel_path: &'a str,
    imported_names: &'a HashMap<&'a str, &'a str>,
    imported_original_names: &'a HashMap<&'a str, &'a str>,
    namespace_imports: &'a HashMap<&'a str, &'a str>,
    type_map: &'a HashMap<&'a str, (&'a str, f64)>,
}

/// Resolve each pts alias of `lookup_name` and emit hop-penalised call edges.
/// Shared by the no-receiver gate and the receiver-key (`rest.prop()`) fallback;
/// mirrors the alias-emission loops in buildFileCallEdges (build-edges.ts).
fn emit_pts_alias_edges<'a>(
    ctx: &EdgeContext<'a>,
    alias_ctx: &PtsAliasCtx<'_>,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    for alias in resolve_via_points_to(alias_ctx.lookup_name, alias_ctx.pts) {
        let alias_imported_from = alias_ctx.imported_names.get(alias).copied();
        let alias_call = CallInfo {
            name: alias.to_string(),
            line: alias_ctx.call_line,
            dynamic: Some(true),
            receiver: None,
            dynamic_kind: None,
            key_expr: None,
            accessor_read: None,
            object_literal_site: None,
        };
        // The CHA typed-dispatch fallback (#1949) only fires for a genuine
        // receiver; `alias_call` is always receiver-less (an alias name
        // resolved via points-to), so this override is structurally always
        // `None` here — discarded rather than threaded further.
        let mut alias_confidence_override: Option<f64> = None;
        let mut alias_targets = resolve_call_targets(
            ctx,
            &alias_call,
            alias_ctx.rel_path,
            alias_imported_from,
            alias_ctx.type_map,
            alias_ctx.caller_name,
            alias_ctx.imported_names,
            alias_ctx.imported_original_names,
            alias_ctx.namespace_imports,
            &mut alias_confidence_override,
            None,
        );
        sort_targets_by_confidence(
            &mut alias_targets,
            alias_ctx.rel_path,
            alias_imported_from,
            alias_confidence_override,
        );
        for t in &alias_targets {
            let edge_key = ((alias_ctx.caller_id as u64) << 32) | (t.id as u64);
            if t.id != alias_ctx.caller_id
                && !seen_edges.contains(&edge_key)
                && !pts_edge_map.contains_key(&edge_key)
            {
                let conf =
                    resolve::compute_confidence(alias_ctx.rel_path, &t.file, alias_imported_from)
                        - PROPAGATION_HOP_PENALTY;
                if conf > 0.0 {
                    pts_edge_map.insert(edge_key, edges.len());
                    edges.push(ComputedEdge {
                        source_id: alias_ctx.caller_id,
                        target_id: t.id,
                        kind: "calls".to_string(),
                        confidence: conf,
                        dynamic: alias_ctx.is_dynamic,
                        dynamic_kind: None,
                        // Alias-resolved edge (#1996) — mirrors the WASM/JS inline
                        // path's 'points-to' tag for the same semantic case.
                        technique: Some("points-to".to_string()),
                    });
                }
            }
        }
    }
}

/// Build call, receiver, extends, and implements edges in Rust.
///
/// Mirrors the algorithm in builder.js `buildEdges` transaction (call edges
/// portion). Import edges are handled separately in JS.
///
/// `max_iterations` caps the Phase 8.3 points-to solver's fixed-point loop —
/// callers pass `ctx.config.analysis.pointsToMaxIterations` (resolved from
/// `.codegraphrc.json`, defaulting to `DEFAULTS.analysis.pointsToMaxIterations`).
///
/// `extra_invoked_property_names` (#2087) is durable cross-pass
/// invoked-property-name evidence from the `invoked_property_names` table —
/// callers on a scoped incremental build (where `files` is narrower than the
/// whole codebase) should pass every name persisted for files NOT in this
/// pass, so the #1895 liveness check doesn't lose evidence contributed by an
/// untouched consumer. `None`/empty is correct for a full build, where
/// `files` already covers everything.
#[napi]
pub fn build_call_edges(
    files: Vec<FileEdgeInput>,
    all_nodes: Vec<NodeInfo>,
    builtin_receivers: Vec<String>,
    max_iterations: u32,
    extra_invoked_property_names: Option<Vec<String>>,
    extra_invoked_property_sites: Option<Vec<String>>,
    correlation_enabled: Option<bool>,
) -> Vec<ComputedEdge> {
    let prep = prepare_invoked_property_site_resolution(&files, &all_nodes, max_iterations);
    build_call_edges_prepared(
        files,
        all_nodes,
        builtin_receivers,
        extra_invoked_property_names,
        extra_invoked_property_sites,
        correlation_enabled,
        prep,
    )
}

/// Call-edge emission with a precomputed pts-map / correlated-site prep.
///
/// The native orchestrator persists `prep.sites_by_file` then calls this so
/// the Andersen solver does not run a second (or third) time. The NAPI
/// `build_call_edges` wrapper prepares internally for JS-orchestrated tests
/// and the per-stage native path.
pub(crate) fn build_call_edges_prepared(
    files: Vec<FileEdgeInput>,
    all_nodes: Vec<NodeInfo>,
    builtin_receivers: Vec<String>,
    extra_invoked_property_names: Option<Vec<String>>,
    extra_invoked_property_sites: Option<Vec<String>>,
    correlation_enabled: Option<bool>,
    mut prep: InvokedPropertySitePrep,
) -> Vec<ComputedEdge> {
    let extra_names = extra_invoked_property_names.unwrap_or_default();
    let extra_sites = extra_invoked_property_sites.unwrap_or_default();
    let correlated = union_invoked_property_sites(&extra_sites, &prep.sites_by_file);
    let ctx = EdgeContext::new(
        &all_nodes,
        &builtin_receivers,
        &files,
        &extra_names,
        correlated,
        correlation_enabled.unwrap_or(true),
    );
    let mut edges = Vec::new();

    for file_input in &files {
        let cached_pts = prep.pts_maps_by_file.remove(&file_input.file);
        process_file(&ctx, file_input, &all_nodes, &mut edges, cached_pts);
    }

    edges
}

/// Per-file lookup structures built once and shared by the call/receiver/hierarchy
/// edge emission loops. Encapsulates what was formerly the setup block of `process_file`.
struct FileContext<'a> {
    rel_path: &'a str,
    file_node_id: u32,
    imported_names: HashMap<&'a str, &'a str>,
    /// Local import alias -> original exported name, for renamed specifiers
    /// (`import { X as Y }`) only — entries where local === original are
    /// omitted. Consulted by `resolve_call_targets` so a call to the local
    /// alias resolves against the correct exported symbol (#1730).
    imported_original_names: HashMap<&'a str, &'a str>,
    /// Local binding -> module file, for bindings that name a module rather
    /// than a symbol (Python's `import lib as L`, `from pkg import submod`).
    /// Lets `resolve_call_targets` read `L.f()` as "f, declared in that
    /// module" instead of resolving it to nothing (#2387).
    namespace_imports: HashMap<&'a str, &'a str>,
    type_map: HashMap<&'a str, (&'a str, f64)>,
    defs_with_ids: Vec<DefWithId<'a>>,
    pts_map: Option<HashMap<String, HashSet<String>>>,
    /// lhs names from the *raw* fnRefBindings only (thisCall conversions are
    /// scoped keys and never flat-matched). Used for case-(c) pts gate.
    fn_ref_binding_lhs: HashSet<&'a str>,
}

/// Build the per-file type map from the input's type_map entries.
/// Keeps the highest-confidence entry per name (first-wins on tie), matching
/// the JS `setTypeMapEntry` behaviour.
fn build_type_map(file_input: &FileEdgeInput) -> HashMap<&str, (&str, f64)> {
    let mut type_map: HashMap<&str, (&str, f64)> = HashMap::new();
    for tm in &file_input.type_map {
        let entry = type_map.entry(tm.name.as_str());
        match entry {
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert((tm.type_name.as_str(), tm.confidence));
            }
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if tm.confidence > e.get().1 {
                    e.insert((tm.type_name.as_str(), tm.confidence));
                }
            }
        }
    }
    type_map
}

/// Build the points-to map for a file.
///
/// Constructs the `PtsBindings` from `file_input`, merges `this_call_bindings`
/// into scoped `fn::this → ctx` fnRefBindings, builds `def_names` and
/// `definition_params`, then delegates to `build_points_to_map`.
/// Returns `None` when the file has no pts inputs (fast path).
///
/// Mirrors `buildPointsToMapForFile` in `src/domain/graph/resolver/points-to.ts`.
fn build_pts_map_for_file(
    file_input: &FileEdgeInput,
    imported_names: &HashMap<&str, &str>,
    max_iterations: u32,
) -> Option<HashMap<String, HashSet<String>>> {
    let raw_fn_ref: &[FnRefBinding] = file_input.fn_ref_bindings.as_deref().unwrap_or(&[]);
    let this_calls: &[ThisCallBinding] = file_input.this_call_bindings.as_deref().unwrap_or(&[]);
    let bindings = PtsBindings {
        fn_ref_bindings: raw_fn_ref,
        param_bindings: file_input.param_bindings.as_deref().unwrap_or(&[]),
        array_elem_bindings: file_input.array_elem_bindings.as_deref().unwrap_or(&[]),
        spread_arg_bindings: file_input.spread_arg_bindings.as_deref().unwrap_or(&[]),
        for_of_bindings: file_input.for_of_bindings.as_deref().unwrap_or(&[]),
        array_callback_bindings: file_input.array_callback_bindings.as_deref().unwrap_or(&[]),
        object_rest_param_bindings: file_input
            .object_rest_param_bindings
            .as_deref()
            .unwrap_or(&[]),
        object_prop_bindings: file_input.object_prop_bindings.as_deref().unwrap_or(&[]),
    };
    let has_object_literal_sites = file_input
        .object_literal_sites
        .as_ref()
        .is_some_and(|s| !s.is_empty());
    let has_pts_inputs = !bindings.fn_ref_bindings.is_empty()
        || !bindings.param_bindings.is_empty()
        || !bindings.array_elem_bindings.is_empty()
        || !bindings.spread_arg_bindings.is_empty()
        || !bindings.for_of_bindings.is_empty()
        || !bindings.array_callback_bindings.is_empty()
        || !bindings.object_rest_param_bindings.is_empty()
        || !bindings.object_prop_bindings.is_empty()
        || !this_calls.is_empty()
        || has_object_literal_sites;
    if !has_pts_inputs {
        return None;
    }

    let def_names: HashSet<&str> = file_input
        .definitions
        .iter()
        .filter(|d| d.kind == "function" || d.kind == "method")
        .map(|d| d.name.as_str())
        .collect();
    // First-wins on duplicate names — mirrors buildDefinitionParamsMap.
    let mut definition_params: HashMap<&str, Vec<&str>> = HashMap::new();
    for d in &file_input.definitions {
        if d.kind != "function" && d.kind != "method" {
            continue;
        }
        let Some(params) = d.params.as_ref().filter(|p| !p.is_empty()) else {
            continue;
        };
        definition_params
            .entry(d.name.as_str())
            .or_insert_with(|| params.iter().map(|s| s.as_str()).collect());
    }

    // Convert thisCallBindings into scoped fnRefBindings (`fn::this → ctx`) so
    // `this()` calls inside `fn` resolve via the scoped key `fn::this`.
    // The merged vec must outlive the PtsBindings borrow — stored here.
    let merged_fn_ref: Vec<FnRefBinding>;
    let final_bindings = if this_calls.is_empty() {
        bindings
    } else {
        let mut merged = raw_fn_ref.to_vec();
        merged.extend(this_calls.iter().map(|b| FnRefBinding {
            lhs: format!("{}::this", b.callee),
            rhs: b.this_arg.clone(),
            rhs_receiver: None,
        }));
        merged_fn_ref = merged;
        PtsBindings {
            fn_ref_bindings: &merged_fn_ref,
            ..bindings
        }
    };

    Some(build_points_to_map(
        &final_bindings,
        &def_names,
        imported_names,
        &definition_params,
        max_iterations,
        &file_input.file,
        file_input.object_literal_sites.as_deref().unwrap_or(&[]),
        file_input.call_assignments.as_deref().unwrap_or(&[]),
    ))
}

/// Build all per-file lookup structures needed for edge emission.
///
/// `pts_map` is the Andersen result for this file, computed once by
/// `prepare_invoked_property_site_resolution` and moved in here so
/// `process_file` does not re-solve.
fn build_file_context<'a>(
    file_input: &'a FileEdgeInput,
    all_nodes: &'a [NodeInfo],
    pts_map: Option<HashMap<String, HashSet<String>>>,
) -> FileContext<'a> {
    let rel_path = file_input.file.as_str();
    let imported_names: HashMap<&str, &str> = file_input
        .imported_names
        .iter()
        .map(|im| (im.name.as_str(), im.file.as_str()))
        .collect();
    let imported_original_names: HashMap<&str, &str> = file_input
        .imported_names
        .iter()
        .filter_map(|im| im.imported.as_deref().map(|orig| (im.name.as_str(), orig)))
        .collect();
    let namespace_imports: HashMap<&str, &str> = file_input
        .imported_names
        .iter()
        .filter(|im| im.namespace.unwrap_or(false))
        .map(|im| (im.name.as_str(), im.file.as_str()))
        .collect();
    let type_map = build_type_map(file_input);
    let file_nodes: Vec<&NodeInfo> = all_nodes.iter().filter(|n| n.file == rel_path).collect();
    let defs_with_ids: Vec<DefWithId> = file_input
        .definitions
        .iter()
        .map(|d| {
            let node_id = file_nodes
                .iter()
                .find(|n| n.name == d.name && n.kind == d.kind && n.line == d.line)
                .map(|n| n.id);
            DefWithId {
                name: &d.name,
                kind: &d.kind,
                line: d.line,
                end_line: d.end_line.unwrap_or(u32::MAX),
                node_id,
            }
        })
        .collect();
    let raw_fn_ref: &[FnRefBinding] = file_input.fn_ref_bindings.as_deref().unwrap_or(&[]);
    // Case (c) flat-key gate set: lhs names from the *raw* fnRefBindings only
    // (thisCall conversions are scoped keys and never flat-matched).
    let fn_ref_binding_lhs: HashSet<&str> = raw_fn_ref.iter().map(|b| b.lhs.as_str()).collect();
    FileContext {
        rel_path,
        file_node_id: file_input.file_node_id,
        imported_names,
        imported_original_names,
        namespace_imports,
        type_map,
        defs_with_ids,
        pts_map,
        fn_ref_binding_lhs,
    }
}

/// Resolve and emit pts-alias edges for a no-receiver unresolved call.
///
/// Implements the four-case gate from buildFileCallEdges (build-edges.ts):
///   (a) dynamic alias calls — flat `call.name` lookup;
///   (b) parameter / this-rebinding / for-of variable calls — scoped key
///       `caller::name`, with the `<module>::name` sentinel for top-level for-of loops;
///   (c) module-level alias bindings (`const f = handler`, `f = fn.bind(ctx)`)
///       — flat key, gated on fnRefBindingLhs so self-seeded local definitions never fire.
/// Confidence is penalised by one hop to reflect the indirection.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_no_receiver_pts_edges<'a>(
    ctx: &EdgeContext<'a>,
    fc: &FileContext<'a>,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    let pts = match fc.pts_map.as_ref() {
        Some(p) => p,
        None => return,
    };
    let is_dyn_call = call.dynamic.unwrap_or(false);
    let scoped_key = if caller_name.is_empty() {
        None
    } else {
        Some(format!("{}::{}", caller_name, call.name)).filter(|k| pts.contains_key(k.as_str()))
    };
    let module_key = if caller_name.is_empty() {
        Some(format!("<module>::{}", call.name)).filter(|k| pts.contains_key(k.as_str()))
    } else {
        None
    };
    let flat_ok = !is_dyn_call
        && fc.fn_ref_binding_lhs.contains(call.name.as_str())
        && pts.contains_key(call.name.as_str());
    let lookup_name: Option<String> = if is_dyn_call {
        Some(call.name.clone())
    } else if let Some(k) = scoped_key {
        Some(k)
    } else if let Some(k) = module_key {
        Some(k)
    } else if flat_ok {
        Some(call.name.clone())
    } else {
        None
    };
    if let Some(lookup_name) = lookup_name {
        emit_pts_alias_edges(
            ctx,
            &PtsAliasCtx {
                pts,
                lookup_name: &lookup_name,
                call_line: call.line,
                caller_id,
                caller_name,
                is_dynamic,
                rel_path: fc.rel_path,
                imported_names: &fc.imported_names,
                imported_original_names: &fc.imported_original_names,
                namespace_imports: &fc.namespace_imports,
                type_map: &fc.type_map,
            },
            seen_edges,
            pts_edge_map,
            edges,
        );
    }
}

/// Resolve and emit pts-alias edges for a receiver call via object-rest bindings.
///
/// Phase 8.3f: `rest.prop()` resolves when pts["rest.prop"] was seeded by the
/// rest-dispatch chain. Builtin receivers are already skipped at the call-loop top.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_receiver_pts_edges<'a>(
    ctx: &EdgeContext<'a>,
    fc: &FileContext<'a>,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &'a str,
    is_dynamic: u32,
    seen_edges: &HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    let (receiver, pts) = match (call.receiver.as_deref(), fc.pts_map.as_ref()) {
        (Some(r), Some(p)) => (r, p),
        _ => return,
    };
    if receiver == "this" || receiver == "self" || receiver == "super" {
        return;
    }
    let receiver_key = format!("{}.{}", receiver, call.name);
    if !pts.contains_key(receiver_key.as_str()) {
        return;
    }
    emit_pts_alias_edges(
        ctx,
        &PtsAliasCtx {
            pts,
            lookup_name: &receiver_key,
            call_line: call.line,
            caller_id,
            caller_name,
            is_dynamic,
            rel_path: fc.rel_path,
            imported_names: &fc.imported_names,
            imported_original_names: &fc.imported_original_names,
            namespace_imports: &fc.namespace_imports,
            type_map: &fc.type_map,
        },
        seen_edges,
        pts_edge_map,
        edges,
    );
}

/// Process a single file: build per-file lookup context and emit call/receiver/hierarchy edges.
fn process_file<'a>(
    ctx: &EdgeContext<'a>,
    file_input: &'a FileEdgeInput,
    all_nodes: &'a [NodeInfo],
    edges: &mut Vec<ComputedEdge>,
    pts_map: Option<HashMap<String, HashSet<String>>>,
) {
    let fc = build_file_context(file_input, all_nodes, pts_map);

    // Phase 8.3: tracks pts-resolved edges separately from seen_edges so that a
    // subsequent direct call to the same caller→target pair can upgrade confidence
    // in-place rather than being silently dropped by the dedup guard.
    // Mirrors `ptsEdgeRows` in `src/domain/graph/builder/stages/build-edges.ts`.
    // Key: edge_key (same as seen_edges). Value: index into `edges` vec.
    let mut seen_edges: HashSet<u64> = HashSet::new();
    let mut pts_edge_map: HashMap<u64, usize> = HashMap::new();
    // Separate dedup set for sink edges: (caller_id, file_node_id, dynamic_kind).
    // Uses the full kind string rather than the first byte to avoid collisions between
    // kinds that share a prefix (e.g. "computed-key" and "computed-literal" both start with b'c').
    let mut seen_sink_edges: HashSet<(u32, u32, String)> = HashSet::new();

    for call in &file_input.calls {
        if let Some(ref receiver) = call.receiver {
            if ctx.builtin_set.contains(receiver.as_str()) {
                continue;
            }
        }

        let (caller_id, caller_name, enclosing_class_hint) =
            find_enclosing_caller(&fc.defs_with_ids, call.line, fc.file_node_id);
        let is_dynamic = if call.dynamic.unwrap_or(false) {
            1u32
        } else {
            0u32
        };
        let imported_from = fc.imported_names.get(call.name.as_str()).copied();

        // Out-param set by the CHA typed-dispatch fallback (#1949) when it
        // resolves a virtual-dispatch target that the proximity-gated
        // interface lookup missed — see `resolve_call_targets` doc comment.
        let mut confidence_override: Option<f64> = None;
        let mut targets = resolve_call_targets(
            ctx,
            call,
            fc.rel_path,
            imported_from,
            &fc.type_map,
            caller_name,
            &fc.imported_names,
            &fc.imported_original_names,
            &fc.namespace_imports,
            &mut confidence_override,
            enclosing_class_hint,
        );
        // #1771/#1784: value-ref references (object-literal property values,
        // Lua builtin reassignment, `instanceof ClassName`) resolve against
        // function/method/class-kind targets only. A bare identifier in one
        // of these positions is as likely to be a plain data reference
        // (`{ name: SOME_CONSTANT }`) as a real function/class, so drop any
        // other-kind match rather than fabricating a "calls" edge to a
        // constant. `class` was added because `instanceof`'s right operand
        // is always a class/constructor (#1784). The filter is keyed on
        // `dynamic_kind`, not on which site produced the call, so the #1771
        // object-literal and #1776 Lua sites also gain class-kind
        // resolution as a side effect — not because either idiom commonly
        // names a class. Applied once here (after all resolve_call_targets
        // tiers), mirroring the `dynamicKind === 'value-ref'` filter in
        // resolveFallbackTargets (stages/build-edges.ts).
        if call.dynamic_kind.as_deref() == Some("value-ref") {
            targets.retain(|t| t.kind == "function" || t.kind == "method" || t.kind == "class");
            // #1895: object-literal-property value-refs (key_expr set — see
            // handle_object_literal_pair_value_ref / shorthand handler)
            // additionally require independent evidence that the property is
            // actually invoked somewhere (`x.key_expr(...)`) — merely being
            // wired into an object literal is not liveness. instanceof/Lua
            // value-refs never set key_expr, so they are unaffected.
            //
            // #2260: OR, the property's own dispatch table (`call.receiver`
            // — the table's variable name, set by
            // handle_object_literal_pair_value_ref) has confirmed COMPUTED-
            // access invocation evidence (`const handler =
            // TABLE[computedExpr]; ...; handler(...)`) — a computed key
            // can't name this specific property statically, so that
            // evidence is credited to the whole table rather than per-key.
            if let Some(key_expr) = call.key_expr.as_deref() {
                if !has_invocation_evidence(call, fc.rel_path, ctx, key_expr) {
                    targets.clear();
                }
            }
        }
        sort_targets_by_confidence(
            &mut targets,
            fc.rel_path,
            imported_from,
            confidence_override,
        );
        emit_call_edges(
            &targets,
            caller_id,
            is_dynamic,
            fc.rel_path,
            imported_from,
            confidence_override,
            &mut seen_edges,
            &mut pts_edge_map,
            edges,
        );

        // #2139: additive typed-receiver CHA dispatch — see doc comment on
        // emit_cha_dispatch_edges for why this must be unconditional rather
        // than folded into resolve_call_targets' mutually-exclusive cascade.
        emit_cha_dispatch_edges(
            ctx,
            call,
            caller_id,
            caller_name,
            fc.rel_path,
            &fc.type_map,
            &mut seen_edges,
            &pts_edge_map,
            edges,
        );

        if targets.is_empty() && call.receiver.is_none() {
            emit_no_receiver_pts_edges(
                ctx,
                &fc,
                call,
                caller_id,
                caller_name,
                is_dynamic,
                &seen_edges,
                &mut pts_edge_map,
                edges,
            );
        }

        if targets.is_empty() {
            emit_receiver_pts_edges(
                ctx,
                &fc,
                call,
                caller_id,
                caller_name,
                is_dynamic,
                &seen_edges,
                &mut pts_edge_map,
                edges,
            );
        }

        emit_receiver_edge(
            ctx,
            call,
            caller_id,
            caller_name,
            fc.rel_path,
            &fc.type_map,
            &fc.imported_names,
            &mut seen_edges,
            edges,
        );

        // Sink edge: flag-only dynamic calls with no resolved target are emitted as
        // a (caller → file_node) edge at confidence=0.0 with dynamic_kind set.
        // This makes them queryable (`codegraph roles --dynamic`) instead of silent drops.
        // Mirrors TS `FLAG_ONLY_DYNAMIC_KINDS` (shared/kinds.ts) — keep both lists in
        // sync; a kind missing here silently drops the sink edge WASM still emits
        // (issue #2413: `reflection` — a `.call`/`.apply`/`.bind` invocation whose
        // wrapped function doesn't resolve — was missing from this list).
        if targets.is_empty() {
            if let Some(ref dk) = call.dynamic_kind {
                if dk == "eval"
                    || dk == "computed-key"
                    || dk == "reflection"
                    || dk == "unresolved-dynamic"
                {
                    let sink_key = (caller_id, fc.file_node_id, dk.clone());
                    if !seen_sink_edges.contains(&sink_key) {
                        seen_sink_edges.insert(sink_key);
                        edges.push(ComputedEdge {
                            source_id: caller_id,
                            target_id: fc.file_node_id,
                            kind: "calls".to_string(),
                            confidence: 0.0,
                            dynamic: 1,
                            dynamic_kind: Some(dk.clone()),
                            technique: None,
                        });
                    }
                }
            }
        }
    }

    emit_hierarchy_edges(
        ctx,
        file_input,
        fc.rel_path,
        &fc.imported_names,
        &fc.imported_original_names,
        edges,
    );
}

/// Callable definition kinds — only function/method bodies act as enclosing
/// caller scopes.  Variable/constant bindings are a lower-priority fallback
/// tier for top-level bindings like Haskell `main = do …` (kind `variable`).
/// Mirrors `CALLABLE_KINDS` / `TOP_LEVEL_BINDING_KINDS` in call-resolver.ts.
fn is_callable_kind(kind: &str) -> bool {
    kind == "function" || kind == "method"
}

fn is_top_level_binding_kind(kind: &str) -> bool {
    kind == "variable" || kind == "constant"
}

/// True when `name` is a synthetic framework-dispatch placeholder
/// (`route:`/`event:`/`command:`-prefixed). Mirrors `isFrameworkEntryName`
/// in call-resolver.ts.
fn is_framework_entry_name(name: &str) -> bool {
    FRAMEWORK_ENTRY_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Find the narrowest enclosing definition for a call at the given line.
///
/// Two-pass strategy:
///   Pass 1 — narrowest enclosing function/method.  Local variable declarations
///             inside a function body must not shadow the enclosing function.
///   Pass 2 — widest (outermost) enclosing variable/constant binding.  Used as
///             fallback when no function/method encloses the call (e.g. Haskell
///             top-level `main = do …` is a `bind` node with kind `variable`).
///
/// Tie-breaking in Pass 1: when two callable definitions have the same span,
/// prefer the bare (unqualified) name over the dot-containing qualified name.
/// Object-literal methods are extracted twice by the Rust extractor — once as
/// `o1.f(function)` from `extract_object_literal_functions` (called eagerly
/// inside `handle_var_decl`) and once as `f(method)` from `handle_method_def`
/// (called later during the child walk). The WASM extractor emits `f(method)`
/// first (query captures run before the walk-phase `extractObjectLiteralFunctions`),
/// so WASM's strict-less-than tie-break naturally picks the bare name.
/// Applying the same preference here aligns native attribution with WASM and with
/// the jelly-micro ground-truth expected-edges (which use bare `f`/`g` names).
/// Names with angle brackets (e.g. `B.<static:36:2>`) are synthetic static-block
/// nodes excluded from the bare-preference rule.
///
/// Returns `(caller_id, caller_name, enclosing_class_hint)` — `caller_name`
/// is `""` when the call falls back to file scope. `enclosing_class_hint`
/// (issue #2259) is set ONLY when the attributed caller is itself a
/// synthetic framework-dispatch placeholder (`route:`/`event:`/`command:`-
/// prefixed) — such a placeholder has no class/`this` context of its own
/// (e.g. `event:${eventName}` for an EventEmitter `.on('event', callback)`
/// registration, when that callback is lexically nested inside a real class
/// method: `w.on('message', (msg) => this.onMessage(msg))`), so
/// `this.onMessage` could never resolve using ONLY the caller's own name.
/// The hint supplies the nearest REAL enclosing method's class as a
/// resolution-only fallback (see `find_enclosing_class_hint`) — it does NOT
/// change which node the call's edge is sourced from, so flow/sequence
/// traversal starting from the synthetic entry point still sees the
/// callback's own calls (Greptile review, PR #2444).
fn find_enclosing_caller<'a>(
    defs: &[DefWithId<'a>],
    call_line: u32,
    file_node_id: u32,
) -> (u32, &'a str, Option<&'a str>) {
    let mut fn_caller_id: Option<u32> = None;
    let mut fn_caller_name = "";
    let mut fn_caller_span = u32::MAX;

    // For variable/constant bindings we pick the WIDEST span (outermost binding),
    // not the narrowest, so that nested `let` bindings inside `main`'s do-block
    // do not shadow `main` itself.  The outermost enclosing variable is the
    // "function-like" top-level binding (e.g. Haskell `main = do …`).
    // var_caller_span starts at 0 — any real spanning binding has span >= 0
    // and we overwrite only when span is strictly greater.
    let mut var_caller_id: Option<u32> = None;
    let mut var_caller_name = "";
    // Using i64 so the initial sentinel (-1) is always beaten by a real span (>= 0).
    let mut var_caller_span: i64 = -1;

    for def in defs {
        if def.line <= call_line && call_line <= def.end_line {
            let span = def.end_line.saturating_sub(def.line);
            if is_callable_kind(def.kind) {
                // On a strict span improvement always take the new candidate.
                // On a tie, prefer bare names over qualified names so native matches WASM:
                // both pick `f(method)` over `o1.f(function)` when an object-literal method
                // is extracted under both names at the same line. Synthetic angle-bracket
                // nodes (e.g. `B.<static:36:2>`) are excluded on both sides of the comparison.
                let is_improvement = span < fn_caller_span;
                let is_tie_prefer_bare = span == fn_caller_span
                    && !def.name.contains('.')
                    && !def.name.contains('<')
                    && fn_caller_name.contains('.')
                    && !fn_caller_name.contains('<');
                if is_improvement || is_tie_prefer_bare {
                    if let Some(id) = def.node_id {
                        fn_caller_id = Some(id);
                        fn_caller_name = def.name;
                        fn_caller_span = span;
                    }
                }
            } else if is_top_level_binding_kind(def.kind) && (span as i64) > var_caller_span {
                if let Some(id) = def.node_id {
                    var_caller_id = Some(id);
                    var_caller_name = def.name;
                    var_caller_span = span as i64;
                }
            }
        }
    }

    // Prefer function/method over variable/constant binding.
    if let Some(id) = fn_caller_id {
        let enclosing_class_hint = if is_framework_entry_name(fn_caller_name) {
            find_enclosing_class_hint(defs, call_line)
        } else {
            None
        };
        return (id, fn_caller_name, enclosing_class_hint);
    }
    if let Some(id) = var_caller_id {
        return (id, var_caller_name, None);
    }
    (file_node_id, "", None)
}

/// Find the class context of the nearest enclosing REAL (non-synthetic)
/// method for `call_line`, for use ONLY as a `this`/`self`/`super`
/// resolution fallback — see `find_enclosing_caller`'s doc comment. Picks
/// the NARROWEST enclosing real method (like `find_enclosing_caller`
/// itself), so a callback nested inside nested classes/methods resolves
/// against the innermost one — the correct `this` binding at that point.
/// Mirrors `findEnclosingClassHint` in call-resolver.ts.
fn find_enclosing_class_hint<'a>(defs: &[DefWithId<'a>], call_line: u32) -> Option<&'a str> {
    let mut best: Option<&'a str> = None;
    let mut best_span = u32::MAX;
    for def in defs {
        if def.kind != "method" || is_framework_entry_name(def.name) {
            continue;
        }
        if def.line > call_line || call_line > def.end_line {
            continue;
        }
        let Some(dot_idx) = def.name.rfind('.') else {
            continue;
        };
        if dot_idx == 0 {
            continue;
        }
        let span = def.end_line.saturating_sub(def.line);
        if span < best_span {
            best = Some(&def.name[..dot_idx]);
            best_span = span;
        }
    }
    best
}

/// Step 2 of the scoped (this/self/super or no-receiver) fallback: exact global
/// name lookup. Mirrors `resolveExactGlobalMatch` in
/// `src/domain/graph/resolver/strategy.ts`.
///
/// A bare/this/self/super call carries no type qualifier, so `nodes_by_name`
/// can return every same-named symbol in the codebase, filtered only by the
/// loose directory-proximity confidence threshold. Returning all of them
/// turns a single real call site into N-1 false `calls` edges (#1863). Only
/// a single highest-confidence candidate is trustworthy — a tie at the top
/// confidence (e.g. several files at the same directory depth from the
/// caller) is genuinely ambiguous and returns nothing, letting the caller
/// fall through to the narrower same-class-sibling fallback.
///
/// A `this`/`self`/`super` call is additionally restricted to callable kinds
/// (`is_callable_kind`): such a call is logically "invoke a member of the
/// current instance", which a class/interface/struct/etc. declaration can
/// never satisfy, so an unrelated same-named type declaration must never
/// substitute for a real callable target just because no other candidate
/// exists (#1888). A genuinely bare call (no receiver at all) is left
/// unfiltered — at this layer it is indistinguishable from a `new
/// ClassName()` constructor invocation, which legitimately targets a
/// class-kind definition.
fn resolve_exact_global_match<'a>(
    ctx: &EdgeContext<'a>,
    call_name: &str,
    rel_path: &str,
    receiver: Option<&str>,
) -> Vec<&'a NodeInfo> {
    let scored: Vec<(&'a NodeInfo, f64)> = ctx
        .nodes_by_name
        .get(call_name)
        .map(|v| {
            v.iter()
                .filter(|&&n| receiver.is_none() || is_callable_kind(&n.kind))
                .map(|&n| (n, resolve::compute_confidence(rel_path, &n.file, None)))
                .filter(|&(_, confidence)| confidence >= 0.5)
                .collect()
        })
        .unwrap_or_default();
    if scored.is_empty() {
        return Vec::new();
    }

    let best_confidence = scored
        .iter()
        .map(|&(_, confidence)| confidence)
        .fold(f64::MIN, f64::max);
    let best: Vec<&'a NodeInfo> = scored
        .iter()
        .filter(|&&(_, confidence)| confidence == best_confidence)
        .map(|&(n, _)| n)
        .collect();
    if best.len() == 1 {
        best
    } else {
        Vec::new()
    }
}

/// Reconcile a same-file bare-name match against a type-aware receiver match
/// (#2025). Prefers the type-aware result UNLESS it's simply a different node
/// representation of the exact declaration the bare match already found.
/// Same file + line alone is NOT sufficient to prove that: two wholly
/// unrelated declarations can coincidentally share one physical source line
/// (e.g. `function method() {} class Widget { method() {} }` written on one
/// line), and file+line-only comparison would incorrectly treat the
/// type-aware `Widget.method` match as "the same declaration" as the
/// unrelated bare `method` and keep the wrong one.
///
/// The only *intentional* same-file-and-line double-representation in the
/// codebase is #1517's computed-key object-literal methods, extracted by
/// `extract_object_literal_functions`/`extractObjectLiteralFunctions`: a bare
/// node (kind `method`) and a qualified `obj.method` node (kind `function`)
/// are pushed from the identical AST node, in that exact kind pairing.
/// Requiring that specific pairing — not just matching coordinates —
/// distinguishes the deliberate #1517 duplicate from a coincidental same-line
/// collision between two real, distinct declarations. Mirrors the same
/// reconciliation in `resolveCallTargets` (call-resolver.ts).
///
/// When every type-aware match does pair up with a bare `method` node this
/// way, resolves to exactly those paired bare nodes — NOT `bare` wholesale.
/// `bare` can contain additional, wholly unrelated same-named nodes elsewhere
/// in the file (a second collision independent of the #1517 pairing);
/// returning it wholesale would attach a bogus extra `calls` edge to that
/// unrelated declaration (review finding on #2227).
fn prefer_type_aware_over_bare<'a>(
    bare: &[&'a NodeInfo],
    type_aware: Vec<&'a NodeInfo>,
) -> Vec<&'a NodeInfo> {
    if bare.is_empty() {
        return type_aware;
    }
    let bare_methods_by_location: HashMap<(&str, u32), &'a NodeInfo> = bare
        .iter()
        .filter(|n| n.kind == "method")
        .map(|&n| ((n.file.as_str(), n.line), n))
        .collect();
    let mut paired_bare: Vec<&'a NodeInfo> = Vec::new();
    let is_same_declaration = type_aware.iter().all(|n| {
        if n.kind != "function" {
            return false;
        }
        match bare_methods_by_location.get(&(n.file.as_str(), n.line)) {
            Some(&paired) => {
                paired_bare.push(paired);
                true
            }
            None => false,
        }
    });
    if is_same_declaration {
        paired_bare.sort_by_key(|n| n.id);
        paired_bare.dedup_by_key(|n| n.id);
        paired_bare
    } else {
        type_aware
    }
}

/// Multi-strategy call target resolution: import-aware → same-file → type-aware → scoped.
/// `caller_name` is the enclosing function/method name (e.g. `"Shape.describe"`) used to scope
/// `this`/`self`/`super` dispatch to the caller's own class before falling back to a broader scan.
/// Mirrors `resolveCallTargets` / `resolveByMethodOrGlobal` in call-resolver.ts.
///
/// Thin wrapper around `resolve_call_targets_core`: additionally attaches
/// constructor-call attribution (#1892) for bare (no-receiver) calls — see
/// `attach_constructor_targets`. Split out because the core resolver has many
/// early-return tiers, so a single post-processing pass at the call site is
/// simpler than threading the augmentation through every tier.
///
/// `confidence_override` is an out-param (mirrors the `&mut` accumulator
/// pattern used elsewhere in this module): left untouched (`None`) by every
/// tier except the CHA fallback (#1949), which sets it to
/// `Some(CHA_TYPED_DISPATCH_CONFIDENCE)` when it fires. Callers must use this
/// value instead of `resolve::compute_confidence` for the returned targets
/// when it is `Some` — file proximity is not meaningful for virtual dispatch
/// confidence. An out-param (rather than widening every one of
/// `resolve_call_targets_core`'s ~15 early returns to a tuple) keeps the
/// blast radius of this change small in a function shared by all 34
/// supported languages.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical call-resolution path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn resolve_call_targets<'a>(
    ctx: &EdgeContext<'a>,
    call: &CallInfo,
    rel_path: &str,
    imported_from: Option<&str>,
    type_map: &HashMap<&str, (&str, f64)>,
    caller_name: &str,
    imported_names: &HashMap<&str, &str>,
    imported_original_names: &HashMap<&str, &str>,
    namespace_imports: &HashMap<&str, &str>,
    confidence_override: &mut Option<f64>,
    enclosing_class_hint: Option<&str>,
) -> Vec<&'a NodeInfo> {
    let targets = resolve_call_targets_core(
        ctx,
        call,
        rel_path,
        imported_from,
        type_map,
        caller_name,
        imported_names,
        imported_original_names,
        namespace_imports,
        confidence_override,
        enclosing_class_hint,
    );
    if call.receiver.is_some() {
        return targets;
    }
    let class_name = imported_original_names
        .get(call.name.as_str())
        .copied()
        .unwrap_or(call.name.as_str());
    attach_constructor_targets(ctx, targets, class_name)
}

/// True when `caller_name`'s class-name prefix is a real class/struct/
/// interface/etc.-kind declaration in the same file — i.e. a `super` call
/// inside it is syntactically guaranteed to have a real `extends` target
/// `resolve_method_via_ancestors`' CHA ancestor walk can verify (issue
/// #2244). False for an object-literal method using dynamic prototype
/// linkage (`Object.setPrototypeOf`, `obj.__proto__ = ...`) — those have no
/// static `extends` clause for CHA to check at all, so the bare/global
/// fallback remains the only signal available and must still apply.
/// Mirrors call-resolver.ts's callerHasRealClassAncestor.
fn caller_has_real_class_ancestor(ctx: &EdgeContext, caller_name: &str, rel_path: &str) -> bool {
    let Some(dot_idx) = caller_name.rfind('.') else {
        return false;
    };
    if dot_idx == 0 {
        return false;
    }
    let caller_class = &caller_name[..dot_idx];
    ctx.nodes_by_name_and_file
        .get(&(caller_class, rel_path))
        .is_some_and(|v| {
            v.iter()
                .any(|n| ctx.receiver_kinds.contains(n.kind.as_str()))
        })
}

/// Core multi-strategy call target resolution — see `resolve_call_targets` for
/// the public entry point (which additionally applies constructor attribution).
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical call-resolution path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn resolve_call_targets_core<'a>(
    ctx: &EdgeContext<'a>,
    call: &CallInfo,
    rel_path: &str,
    imported_from: Option<&str>,
    type_map: &HashMap<&str, (&str, f64)>,
    caller_name: &str,
    imported_names: &HashMap<&str, &str>,
    imported_original_names: &HashMap<&str, &str>,
    namespace_imports: &HashMap<&str, &str>,
    confidence_override: &mut Option<f64>,
    enclosing_class_hint: Option<&str>,
) -> Vec<&'a NodeInfo> {
    // Flagged dynamic calls use synthetic names like "<dynamic:eval>". Short-circuit
    // so they never accidentally match a real symbol via name lookup.
    if call.name.starts_with("<dynamic:") {
        return vec![];
    }

    // #2030: a property-read call tagged with the accessor kind it needs
    // carries its *resolved class name* as `receiver` (see
    // handle_accessor_property_read in extractors/javascript.rs) — resolve
    // directly against the qualified `receiver.name`, filtered to the DB's
    // `accessor_kind` column. Deliberately bypasses the rest of this
    // function's directory-proximity confidence scoring: kind-plus-exact-
    // qualified-name match is a strictly stronger disambiguator than
    // proximity (proximity exists only to arbitrate when nothing stronger is
    // available — see resolve_exact_global_match for that precedent), and a
    // real cross-file accessor can legitimately live many directories away
    // from the read site. An unconfirmed candidate is dropped outright —
    // never falls through to the general cascade below, which could
    // otherwise resolve to an unrelated same-named non-accessor method/field,
    // the exact false-positive class #1893's same-file registry was designed
    // to prevent. Mirrors resolveCallTargets in call-resolver.ts.
    if let Some(ref needed_kind) = call.accessor_read {
        let Some(receiver) = call.receiver.as_deref() else {
            return vec![];
        };
        // The resolved class name can itself be a renamed import binding
        // (`import { Original as Alias }` — the extractor's type_map only
        // knows the local alias), so de-alias before building the qualified
        // lookup key exactly like the general cascade below does (#1730).
        let dealiased_class_name = imported_original_names
            .get(receiver)
            .copied()
            .unwrap_or(receiver);
        let qualified = format!("{}.{}", dealiased_class_name, call.name);
        // When the class is a known import, commit to the specific file it
        // resolves to rather than falling through to the unscoped global
        // lookup below — otherwise an unrelated same-qualified-name accessor
        // in a completely different file could "confirm" a read it has
        // nothing to do with, whenever two files coincidentally declare the
        // same class+property name pair. This scoped result is authoritative:
        // an empty (or wrong-kind) match here means "no", not "keep looking
        // elsewhere" — the unscoped global fallback below is reserved for
        // when the class isn't a known import in this file at all (e.g. an
        // ambient/global type).
        //
        // `imported_names` is keyed by the *local* binding as written in this
        // file's own import statement (`receiver` — e.g. "Alias" for
        // `import { Original as Alias }`), not the de-aliased original name —
        // looking it up under `dealiased_class_name` would always miss for a
        // renamed import and silently fall through to the unscoped lookup
        // this whole branch exists to avoid.
        if let Some(accessor_imported_from) = imported_names.get(receiver) {
            return ctx
                .nodes_by_name_and_file
                .get(&(qualified.as_str(), *accessor_imported_from))
                .map(|v| {
                    v.iter()
                        .filter(|n| n.accessor_kind.as_deref() == Some(needed_kind.as_str()))
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
        }
        return ctx
            .nodes_by_name
            .get(qualified.as_str())
            .map(|v| {
                v.iter()
                    .filter(|n| n.accessor_kind.as_deref() == Some(needed_kind.as_str()))
                    .copied()
                    .collect()
            })
            .unwrap_or_default();
    }

    // A call through a module namespace binding (`import lib as L; L.f()`,
    // `from pkg import submod; submod.f()`) names a module, not a value, so
    // the target is simply `call.name` as declared in that module's file.
    // Resolved ahead of the general cascade because the cascade has nothing to
    // work with here: `call.name` is not itself an imported binding, and the
    // receiver has no type to look up — which is why every such call
    // previously resolved to nothing and left the callee reported as dead
    // (#2387).
    //
    // Scoped to the module's own file and authoritative: a miss means the
    // module does not declare that name, not "keep looking". Falling through
    // would let an unrelated same-named function elsewhere in the project
    // claim the call. Mirrors resolveCallTargets in call-resolver.ts.
    if let Some(receiver) = call.receiver.as_deref() {
        if let Some(namespace_file) = namespace_imports.get(receiver) {
            return ctx
                .nodes_by_name_and_file
                .get(&(call.name.as_str(), *namespace_file))
                .map(|v| v.to_vec())
                .unwrap_or_default();
        }
    }

    // When the call site uses a renamed import binding (`import { X as Y }`),
    // the imported file's actual symbol is declared under the *original* name
    // (X) — look that up instead of the local alias the call site wrote (#1730).
    let target_name = imported_original_names
        .get(call.name.as_str())
        .copied()
        .unwrap_or(call.name.as_str());

    // 1. Import-aware resolution
    if let Some(imp_file) = imported_from {
        let targets = ctx
            .nodes_by_name_and_file
            .get(&(target_name, imp_file))
            .cloned()
            .unwrap_or_default();
        if !targets.is_empty() {
            return targets;
        }
    }

    // RES-4: Kotlin member callable reference — `Greeter::greet` emits
    // { name: 'greet', receiver: 'Greeter', dynamicKind: 'reflection' }.
    // A plain same-file lookup of 'greet' finds the top-level free function
    // before the qualified form is tried.  Match the WASM pre-qualified pass:
    // when dynamicKind='reflection', receiver is set, and no keyExpr, try the
    // qualified `{Receiver}.{name}` form first (mirrors the RES-4 pre-pass in
    // `resolveFallbackTargets` in build-edges.ts).
    if call.dynamic_kind.as_deref() == Some("reflection")
        && call.receiver.is_some()
        && call.key_expr.is_none()
        && !is_module_scoped_language(rel_path)
    {
        let receiver = call.receiver.as_deref().unwrap();
        let qualified = format!("{}.{}", receiver, call.name);
        let pre_qualified: Vec<&NodeInfo> = ctx
            .nodes_by_name_and_file
            .get(&(qualified.as_str(), rel_path))
            .map(|v| {
                v.iter()
                    .filter(|n| n.kind == "method" || n.kind == "function")
                    .copied()
                    .collect()
            })
            .unwrap_or_default();
        if !pre_qualified.is_empty() {
            return pre_qualified;
        }
    }

    // 2. Same-file resolution. A receiver — concrete (`obj.x()`) or
    // `this`/`self`/`super` — means the call is logically "invoke a member of
    // some instance", which a class/interface/struct/etc. declaration can
    // never satisfy; restrict those to definitively callable kinds
    // (`is_callable_kind`) so an unrelated same-file type declaration that
    // merely shares the call's name can never pre-empt a legitimate target
    // that a more specific resolution tier (receiver typing, the
    // Object.defineProperty accessor fallback, etc.) would otherwise find. A
    // genuinely bare call (no receiver at all) is left unfiltered: at this
    // layer it is indistinguishable from a `new ClassName()` constructor
    // invocation, which legitimately targets a class-kind definition —
    // kind-filtering it would break constructor-call resolution (#1888).
    // Mirrors resolveCallTargets in call-resolver.ts.
    // `super` inside a REAL class is excluded from the bare same-file
    // lookup entirely (issue #2244) — a coincidentally same-named same-file
    // declaration has no static relationship to the caller's real ancestor
    // and must never satisfy super/super.method(); only
    // resolve_method_via_ancestors' CHA ancestor walk (run as a post-pass)
    // can verify that relationship. See caller_has_real_class_ancestor for
    // why this does NOT apply to a non-class caller.
    let bare_matches = if call.receiver.as_deref() == Some("super")
        && caller_has_real_class_ancestor(ctx, caller_name, rel_path)
    {
        Vec::new()
    } else {
        ctx.nodes_by_name_and_file
            .get(&(call.name.as_str(), rel_path))
            .cloned()
            .unwrap_or_default()
    };
    let bare_targets: Vec<&NodeInfo> = if call.receiver.is_some() {
        bare_matches
            .into_iter()
            .filter(|n| is_callable_kind(&n.kind))
            .collect()
    } else {
        bare_matches
    };
    let has_concrete_receiver = call
        .receiver
        .as_deref()
        .is_some_and(|r| r != "this" && r != "self" && r != "super");
    // A concrete-receiver call still needs type-aware confirmation even when
    // the kind-filtered bare lookup already found something: the bare lookup
    // only rules out non-callable kinds (#1888), not a coincidentally
    // same-named function/method elsewhere in the file that has no static
    // relationship to the receiver at all (#2025) — e.g. an unrelated
    // top-level `function method()` pre-empting `obj.method()` when `obj`'s
    // type resolves to a class that also declares `method`. Fall through to
    // step 3 (type-aware resolution) instead of returning immediately;
    // `prefer_type_aware_over_bare` reconciles the two afterward.
    if !bare_targets.is_empty() && !has_concrete_receiver {
        return bare_targets;
    }

    // 3. Type-aware resolution via receiver → type map.
    // Strips "this."/"self." prefix so `this.repo.method()` / `self.repo.method()`
    // resolves via typeMap["repo"] or typeMap["this.repo"] (both seeded by the
    // class-field extractor — the Rust extractor seeds "StructName.repo", #1876).
    if let Some(ref receiver) = call.receiver {
        let effective_receiver = strip_instance_prefix(receiver);
        // Phase 8.3f: callee-scoped rest-param key (`callee::restName`) avoids
        // same-name rest-binding collisions across functions in the same file (#1358).
        let rest_param_key = format!("{}::{}", caller_name, effective_receiver);
        // Class-scoped key (`ClassName.prop`) seeded by `this.prop = new Ctor()` and
        // field annotations — prevents false edges when multiple classes define the same
        // property name (issues #1323, #1458). Consulted first for `this.`/`self.` receivers
        // so bare fallback keys (confidence 0.6) don't shadow the correct per-class entry.
        let class_scoped_key = if effective_receiver != receiver.as_str() && !caller_name.is_empty()
        {
            caller_name
                .rfind('.')
                .map(|dot| format!("{}.{}", &caller_name[..dot], effective_receiver))
        } else {
            None
        };
        // Function-scoped key (`callerName::name`) is consulted before the bare
        // fallback keys below so a same-named local/parameter/rest-binding in a
        // DIFFERENT function in this file can't shadow the correct entry for the
        // function actually making this call (Phase 8.3f rest-param collision,
        // #1358; generalized to plain locals/parameters, #2235).
        let type_lookup = class_scoped_key
            .as_deref()
            .and_then(|k| type_map.get(k))
            .or_else(|| {
                if caller_name.is_empty() {
                    None
                } else {
                    type_map.get(rest_param_key.as_str())
                }
            })
            .or_else(|| type_map.get(effective_receiver))
            .or_else(|| type_map.get(receiver.as_str()));
        // Inline new-expression receiver: `(new Foo).bar()` — extract the constructor name
        // when no typeMap entry exists for the complex receiver expression.
        // Mirrors the regex `/^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/` in call-resolver.ts.
        let inline_new_type = if type_lookup.is_none() {
            extract_inline_new_type(receiver)
        } else {
            None
        };
        // Use typeMap-resolved type or inline-new-extracted type, whichever is available.
        let resolved_type = type_lookup.map(|&(t, _)| t).or(inline_new_type.as_deref());
        if let Some(type_name) = resolved_type {
            // The resolved type name can itself be a renamed import binding
            // (e.g. `import { Foo as Bar } from './x'; const y = new Bar();
            // y.method()` seeds typeMap['y'] = 'Bar') — de-alias before
            // building the qualified lookup key, since the symbol table
            // stores definitions under the declared name (`Foo.method`),
            // not the local alias (#1825).
            let type_name = imported_original_names
                .get(type_name)
                .copied()
                .unwrap_or(type_name);
            let qualified = format!("{}.{}", type_name, call.name);
            let typed: Vec<&NodeInfo> = ctx
                .nodes_by_name
                .get(qualified.as_str())
                .map(|v| {
                    v.iter()
                        .filter(|n| {
                            n.kind == "method"
                                && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                        })
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
            if !typed.is_empty() {
                return prefer_type_aware_over_bare(&bare_targets, typed);
            }
            // Prototype alias: `Foo.prototype.bar = identifier` seeds typeMap['Foo.bar'] = identifier.
            // After the direct method lookup misses (no definition emitted for this method),
            // check if the typeMap holds an alias to a standalone function.
            // Mirrors the protoAlias fallback in resolveByMethodOrGlobal in call-resolver.ts.
            if let Some(&(proto_target, _)) = type_map.get(qualified.as_str()) {
                let resolved: Vec<&NodeInfo> = ctx
                    .nodes_by_name
                    .get(proto_target)
                    .map(|v| {
                        v.iter()
                            .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                            .copied()
                            .collect()
                    })
                    .unwrap_or_default();
                if !resolved.is_empty() {
                    return prefer_type_aware_over_bare(&bare_targets, resolved);
                }
            }

            // 3.7. Native CHA typed-dispatch fallback (#1949). The direct
            // qualified lookup above (`typed`) only accepts a target when
            // `computeConfidence(rel_path, targetFile) >= 0.5` — a proximity
            // check that fails whenever the interface/abstract type
            // declaration lives many directories away from the caller (e.g.
            // an interface in a shared `types.ts` implemented by a class deep
            // in a subdirectory). WASM never has this gap because its CHA
            // post-pass (`resolveChaTargets` in `cha.ts`) resolves typed
            // receiver dispatch unconditionally, independent of that
            // proximity gate — "file proximity is not meaningful for virtual
            // dispatch confidence" (see `CHA_TYPED_DISPATCH_CONFIDENCE`).
            // Tried only here — after the interface-qualified lookup and its
            // prototype-alias fallback both found nothing — and only for a
            // genuine receiver (`this`/`self`/`super` dispatch is handled
            // separately by `runPostNativeThisDispatch`).
            if has_concrete_receiver {
                let cha_targets =
                    resolve_cha_dispatch(ctx, type_name, call.name.as_str(), Some(rel_path));
                if !cha_targets.is_empty() {
                    *confidence_override = Some(CHA_TYPED_DISPATCH_CONFIDENCE);
                    return prefer_type_aware_over_bare(&bare_targets, cha_targets);
                }
            }
        }
        // 3.5. Direct qualified method lookup: ClassName.staticMethod() or ClassName.instanceMethod()
        // when the receiver is a class name with no typeMap entry. Handles static method calls
        // like `Validators.IsValidEmail()` where the receiver IS the class.
        // Matches both "method" and "function" kinds to cover field-initializer synthetic defs.
        // ORDER: must run before composite pts lookup (3.6) to match WASM call-resolver.ts ordering.
        // Guard: skip when inline_new_type is Some — mirrors TS `!typeName` which is false when the
        // inline-new regex extracted a type (e.g. `(new Foo).bar()` → typeName='Foo' → skip).
        if type_lookup.is_none() && inline_new_type.is_none() {
            // The receiver itself can be a renamed import binding (`import {
            // NamespaceObj as NsAlias } from './helpers.js'; NsAlias.doThing()`)
            // — de-alias before building the qualified lookup key, since the
            // symbol table stores the object literal under its declared name
            // (`NamespaceObj.doThing`), not the importing file's local alias (#1825).
            let dealiased_receiver = imported_original_names
                .get(effective_receiver)
                .copied()
                .unwrap_or(effective_receiver);
            let qualified = format!("{}.{}", dealiased_receiver, call.name);
            let direct: Vec<&NodeInfo> = ctx
                .nodes_by_name
                .get(qualified.as_str())
                .map(|v| {
                    v.iter()
                        .filter(|n| {
                            (n.kind == "method" || n.kind == "function")
                                && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                        })
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
            if !direct.is_empty() {
                return prefer_type_aware_over_bare(&bare_targets, direct);
            }
        }

        // 3.6. Phase 8.3d: composite pts key — `obj.prop = fn` seeds typeMap['obj.prop']
        let composite_key = format!("{}.{}", receiver, call.name);
        if let Some(&(pts_target, _)) = type_map.get(composite_key.as_str()) {
            let resolved: Vec<&NodeInfo> = ctx
                .nodes_by_name
                .get(pts_target)
                .map(|v| {
                    v.iter()
                        .filter(|n| resolve::compute_confidence(rel_path, &n.file, None) >= 0.5)
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
            if !resolved.is_empty() {
                return prefer_type_aware_over_bare(&bare_targets, resolved);
            }
        }
    }

    // RES-3: reflection with literal method name — JVM getMethod("name") / invokeMethod("name").
    // Java/Scala/Groovy methods are stored as class-qualified names (e.g. Reflection.greet),
    // so a plain lookup of `keyExpr` finds nothing. When dynamicKind='reflection' and keyExpr
    // is set (a string-literal method name was captured), try two qualified forms:
    //   1. typeMap[receiver] → resolvedType → `resolvedType.keyExpr` (type-annotated local)
    //   2. callerName class prefix → `CallerClass.keyExpr` (same-class sibling — covers Groovy
    //      obj.invokeMethod and Java/Scala clazz.getMethod where the class is the caller's own)
    // Scoped to non-JS/TS files to avoid interfering with the JS reflection path.
    // Mirrors `resolveFallbackTargets` RES-3 block in `src/domain/graph/builder/stages/build-edges.ts`.
    if call.dynamic_kind.as_deref() == Some("reflection")
        && call.key_expr.is_some()
        && call.receiver.is_some()
        && !is_module_scoped_language(rel_path)
    {
        let key_expr = call.key_expr.as_deref().unwrap();
        let receiver = call.receiver.as_deref().unwrap();

        // RES-3.1: typeMap[receiver] → resolvedType.keyExpr
        if let Some(&(resolved_type, _)) = type_map.get(receiver) {
            let qualified = format!("{}.{}", resolved_type, key_expr);
            let typed: Vec<&NodeInfo> = ctx
                .nodes_by_name
                .get(qualified.as_str())
                .map(|v| {
                    v.iter()
                        .filter(|n| {
                            (n.kind == "method" || n.kind == "function")
                                && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                        })
                        .copied()
                        .collect()
                })
                .unwrap_or_default();
            if !typed.is_empty() {
                return prefer_type_aware_over_bare(&bare_targets, typed);
            }
        }

        // RES-3.2: callerName class prefix → CallerClass.keyExpr
        if !caller_name.is_empty() {
            if let Some(last_dot) = caller_name.rfind('.') {
                let seg_start = caller_name[..last_dot]
                    .rfind('.')
                    .map(|p| p + 1)
                    .unwrap_or(0);
                let caller_class = &caller_name[seg_start..last_dot];
                let qualified = format!("{}.{}", caller_class, key_expr);
                let class_scoped: Vec<&NodeInfo> = ctx
                    .nodes_by_name
                    .get(qualified.as_str())
                    .map(|v| {
                        v.iter()
                            .filter(|n| {
                                (n.kind == "method" || n.kind == "function")
                                    && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                            })
                            .copied()
                            .collect()
                    })
                    .unwrap_or_default();
                if !class_scoped.is_empty() {
                    return prefer_type_aware_over_bare(&bare_targets, class_scoped);
                }
            }
        }
    }

    // Neither the type-aware receiver tiers above nor the RES-3 reflection
    // tier found anything more specific than the deferred kind-filtered bare
    // match (#2025) — fall back to it now.
    if !bare_targets.is_empty() {
        return bare_targets;
    }

    // 4. Scoped fallback (this/self, no receiver, or a super call whose
    // caller isn't a real class). `super` inside a real class is excluded
    // (issue #2244) — mirrors resolveByMethodOrGlobal's early return in
    // call-resolver.ts: none of the tiers below (accessor this-dispatch,
    // exact-name global match, class-scoped exact lookup) verify any
    // relationship to the caller's real ancestor, so they must never
    // resolve such a super call — only resolve_method_via_ancestors' CHA
    // ancestor walk can. See caller_has_real_class_ancestor for why this
    // does NOT apply to a non-class caller (object-literal dynamic
    // prototype linkage).
    if call.receiver.is_none()
        || call.receiver.as_deref() == Some("this")
        || call.receiver.as_deref() == Some("self")
        || (call.receiver.as_deref() == Some("super")
            && !caller_has_real_class_ancestor(ctx, caller_name, rel_path))
    {
        // Phase 8.3f: accessor this-dispatch via Object.defineProperty.
        // When a plain function (no class prefix in caller_name) is registered as a get/set
        // accessor for `obj`, typeMap seeds 'callerName:this' = 'obj'. Resolve this.method()
        // via typeMap['obj.method'] → the concrete definition. Runs before the broad exact-name
        // lookup to avoid false positives from unrelated same-file definitions.
        if call.receiver.as_deref() == Some("this")
            && !caller_name.is_empty()
            && !caller_name.contains('.')
        {
            let accessor_key = format!("{}:this", caller_name);
            if let Some(&(obj_name, _)) = type_map.get(accessor_key.as_str()) {
                let obj_method_key = format!("{}.{}", obj_name, call.name);
                if let Some(&(target_fn, _)) = type_map.get(obj_method_key.as_str()) {
                    let accessor_resolved: Vec<&NodeInfo> = ctx
                        .nodes_by_name
                        .get(target_fn)
                        .map(|v| {
                            v.iter()
                                .filter(|n| {
                                    resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                                })
                                .copied()
                                .collect()
                        })
                        .unwrap_or_default();
                    if !accessor_resolved.is_empty() {
                        return accessor_resolved;
                    }
                }
            }
        }

        // First try exact name match (e.g. an unqualified function named "area").
        let exact =
            resolve_exact_global_match(ctx, call.name.as_str(), rel_path, call.receiver.as_deref());
        if !exact.is_empty() {
            return exact;
        }

        // Class-scoped exact lookup: prefer `ClassName.method` when the caller is a qualified
        // method (e.g. `this.area()` or plain `area()` in `Shape.describe` → try `Shape.area`).
        // Covers both this/self/super dispatch AND no-receiver static sibling calls (e.g.
        // `IsValidEmail()` inside `Validators.ValidateUser` → `Validators.IsValidEmail`).
        // This avoids false edges to unrelated classes that happen to have a method with the
        // same name in the same file.
        //
        // For JS/TS, bare (no-receiver) calls are module-scoped — there is no implicit class
        // binding. Skip the same-class fallback for bare calls in those languages to prevent
        // false positives (e.g. `flush()` inside `Processor.run` must not resolve to
        // `Processor.flush`). this/self/super calls are unaffected.
        //
        // `enclosing_class_hint` (issue #2259) is consulted ONLY when `caller_name` itself has
        // no dot to derive a class from — e.g. the caller is a synthetic framework-dispatch
        // placeholder (`event:${event_name}` for an EventEmitter `.on('event', callback)`
        // registration; see `find_enclosing_class_hint`) with no class context of its own, even
        // though the callback is lexically nested inside a real class method. The callback's
        // calls-edge still sources from the synthetic placeholder unchanged (so flow/sequence
        // traversal starting from that entry point keeps working) — this hint only supplies the
        // class needed to resolve `this`/`self` here.
        let is_bare_call = call.receiver.is_none();
        if !(caller_name.is_empty() || is_bare_call && is_module_scoped_language(rel_path)) {
            let class_prefix = if let Some(dot_idx) = caller_name.rfind('.') {
                // Extract only the segment immediately before the method name so that
                // 'Namespace.ClassName.method' yields 'ClassName', not 'Namespace.ClassName'.
                // Symbols are stored under their bare class name, not their qualified path.
                let seg_start = caller_name[..dot_idx]
                    .rfind('.')
                    .map(|p| p + 1)
                    .unwrap_or(0);
                Some(&caller_name[seg_start..dot_idx])
            } else {
                enclosing_class_hint
            };
            if let Some(class_prefix) = class_prefix {
                let qualified = format!("{}.{}", class_prefix, call.name);
                let class_scoped: Vec<&NodeInfo> = ctx
                    .nodes_by_name
                    .get(qualified.as_str())
                    .map(|v| {
                        v.iter()
                            .filter(|n| {
                                n.kind == "method"
                                    && resolve::compute_confidence(rel_path, &n.file, None) >= 0.5
                            })
                            .copied()
                            .collect()
                    })
                    .unwrap_or_default();
                if !class_scoped.is_empty() {
                    return class_scoped;
                }
            }
        }

        // No equivalent step exists in the WASM/TS engine's resolveByGlobal
        // (src/domain/graph/resolver/strategy.ts) — removed a native-only
        // "same-file suffix scan" fallback here (#1999). Verified via a direct
        // native-vs-native (fallback enabled vs disabled) build comparison
        // across every tests/benchmarks/resolution/fixtures/<lang> project:
        // zero edge differences in any of the 34 language fixtures, meaning
        // steps 1-3 above already find everything real code needs; this tier
        // never actually fired. Removed rather than ported to keep both
        // engines' resolveByGlobal cascades identical per this repo's
        // dual-engine parity requirement.
        return exact; // empty
    }

    Vec::new()
}

// ── Constructor-call attribution (#1892) ──────────────────────────────────

/// Per-language constructor method identifier, keyed by file extension. Used
/// to build the qualified `ClassName.<ctorLocalName>` lookup key that
/// attributes a `new ClassName()` (or bare `ClassName()`, for the keyword-less
/// languages below) call site to the class's own constructor **method**,
/// rather than only the class declaration node it already resolves to.
/// Returns `None` when the extension is unrecognised (or has no extension at
/// all). For Java/C#/Dart/Groovy the constructor's own identifier equals the
/// class name (`class Foo { Foo(...) {} }`), so those arms return
/// `class_name` itself rather than a fixed keyword. Mirrors
/// `CONSTRUCTOR_LOCAL_NAME_BY_EXTENSION` in strategy.ts.
///
/// Deliberately excludes languages whose extractor does not emit an explicit
/// constructor definition at all (Kotlin, Swift, Scala) or does not track
/// object-construction call sites at all (C++) — for those, the class-node
/// edge already produced by `resolve_call_targets_core` is the only
/// attribution possible.
fn constructor_local_name<'b>(file: &str, class_name: &'b str) -> Option<&'b str> {
    let ext = file.rsplit_once('.').map(|(_, e)| e)?;
    match ext {
        "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" | "cts" => Some("constructor"),
        "py" | "pyi" => Some("__init__"),
        "php" | "phtml" => Some("__construct"),
        "java" | "cs" | "dart" | "groovy" | "gvy" => Some(class_name),
        _ => None,
    }
}

/// Resolve the constructor **method** node for a class target, if the class
/// declares one explicitly. Scoped to the class's own file (`file`) so an
/// unrelated same-named constructor elsewhere can never match.
fn resolve_constructor_target<'a>(
    ctx: &EdgeContext<'a>,
    file: &str,
    class_name: &str,
) -> Option<&'a NodeInfo> {
    let local_name = constructor_local_name(file, class_name)?;
    let qualified = format!("{}.{}", class_name, local_name);
    ctx.nodes_by_name_and_file
        .get(&(qualified.as_str(), file))
        .and_then(|v| v.iter().find(|n| n.kind == "method"))
        .copied()
}

/// Additive constructor-call attribution: for every `class`-kind target in
/// `targets`, also resolve that class's own constructor method (if one is
/// explicitly declared) and append it. Mirrors `attachConstructorTargets` in
/// strategy.ts.
///
/// Additive, not a replacement: the class-node target is always left standing
/// — the DB-driven RTA fallback (incremental rebuilds, see `cha.ts`'s
/// `buildChaContextFromDb`) reads instantiation evidence from `calls` edges
/// targeting class-kind nodes, and a class with no explicit constructor
/// legitimately has nothing else to attribute the call to.
fn attach_constructor_targets<'a>(
    ctx: &EdgeContext<'a>,
    mut targets: Vec<&'a NodeInfo>,
    class_name: &str,
) -> Vec<&'a NodeInfo> {
    let mut seen_ids: HashSet<u32> = targets.iter().map(|t| t.id).collect();
    let mut extra = Vec::new();
    for target in &targets {
        if target.kind != "class" {
            continue;
        }
        if let Some(ctor) = resolve_constructor_target(ctx, target.file.as_str(), class_name) {
            if seen_ids.insert(ctor.id) {
                extra.push(ctor);
            }
        }
    }
    targets.extend(extra);
    targets
}

/// Languages where bare `foo()` calls inside a class method are lexically scoped
/// to the module, not the class — there is no implicit this/class binding.
/// Mirrors `MODULE_SCOPED_BARE_CALL_EXTENSIONS` in call-resolver.ts.
fn is_module_scoped_language(rel_path: &str) -> bool {
    match rel_path.rsplit_once('.') {
        Some((_, ext)) => matches!(
            ext,
            "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "mts" | "cts"
        ),
        None => false,
    }
}

/// Instance-reference prefixes that qualify a receiver chain as "this object's
/// own field" (`this.repo`, `self.repo`) — `this` for JS/TS/Java/C#-family
/// languages, `self` for Python/Rust/Swift-family languages. Stripped the same
/// way so `X.repo.method()` resolves via type_map["repo"] regardless of which
/// keyword the source language uses. Mirrors `stripInstancePrefix` in
/// strategy.ts (#1876).
fn strip_instance_prefix(receiver: &str) -> &str {
    receiver
        .strip_prefix("this.")
        .or_else(|| receiver.strip_prefix("self."))
        .unwrap_or(receiver)
}

/// Extract the constructor name from an inline `new` receiver expression.
///
/// Mirrors the regex `/^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/` used in call-resolver.ts.
/// Handles `(new Foo)` and `(new Foo('arg'))` receivers that arise when the call site
/// is `(new Foo).method()` without a named variable binding.
///
/// Only extracts names that start with an uppercase letter, `_`, or `$` to avoid
/// false positives on plain lowercase constructor calls (rare but present in legacy code).
fn extract_inline_new_type(receiver: &str) -> Option<String> {
    let s = receiver.strip_prefix('(').unwrap_or(receiver).trim_start();
    let s = s.strip_prefix("new")?;
    if !s.starts_with(|c: char| c.is_whitespace()) {
        return None;
    }
    let s = s.trim_start();
    let end = s
        .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '$')
        .unwrap_or(s.len());
    let name = &s[..end];
    if name.is_empty() {
        return None;
    }
    let first = name.chars().next()?;
    if first.is_uppercase() || first == '_' || first == '$' {
        Some(name.to_string())
    } else {
        None
    }
}

/// Sort targets by confidence descending. `confidence_override` (#1949) skips
/// sorting entirely when set — CHA-fallback targets all share the same flat
/// confidence, so relative order is meaningless.
fn sort_targets_by_confidence(
    targets: &mut Vec<&NodeInfo>,
    rel_path: &str,
    imported_from: Option<&str>,
    confidence_override: Option<f64>,
) {
    if confidence_override.is_none() && targets.len() > 1 {
        targets.sort_by(|a, b| {
            let conf_a = resolve::compute_confidence(rel_path, &a.file, imported_from);
            let conf_b = resolve::compute_confidence(rel_path, &b.file, imported_from);
            conf_b
                .partial_cmp(&conf_a)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

/// Emit call edges from caller to resolved targets (deduped). When
/// `confidence_override` is set (#1949 CHA typed-dispatch fallback), every
/// target uses that flat confidence instead of `resolve::compute_confidence`
/// — file proximity is not meaningful for virtual dispatch confidence.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_call_edges(
    targets: &[&NodeInfo],
    caller_id: u32,
    is_dynamic: u32,
    rel_path: &str,
    imported_from: Option<&str>,
    confidence_override: Option<f64>,
    seen_edges: &mut HashSet<u64>,
    pts_edge_map: &mut HashMap<u64, usize>,
    edges: &mut Vec<ComputedEdge>,
) {
    for t in targets {
        let edge_key = ((caller_id as u64) << 32) | (t.id as u64);
        if t.id != caller_id && !seen_edges.contains(&edge_key) {
            let confidence = confidence_override
                .unwrap_or_else(|| resolve::compute_confidence(rel_path, &t.file, imported_from));
            if let Some(&pts_idx) = pts_edge_map.get(&edge_key) {
                // A pts-resolved edge already exists for this caller→target pair with a
                // penalised confidence. Upgrade it to the direct-call confidence in-place,
                // then promote to seen_edges so no further processing is needed.
                // Mirrors the ptsEdgeRows upgrade path in build-edges.ts, including the
                // technique relabel from 'points-to' to 'ts-native' (#1996).
                if let Some(pts_row) = edges.get_mut(pts_idx) {
                    pts_row.confidence = confidence;
                    pts_row.dynamic = is_dynamic; // direct call overrides alias dynamic flag
                    pts_row.technique = Some("ts-native".to_string());
                }
                pts_edge_map.remove(&edge_key);
                seen_edges.insert(edge_key);
            } else {
                seen_edges.insert(edge_key);
                edges.push(ComputedEdge {
                    source_id: caller_id,
                    target_id: t.id,
                    kind: "calls".to_string(),
                    confidence,
                    dynamic: is_dynamic,
                    dynamic_kind: None,
                    technique: None,
                });
            }
        }
    }
}

/// Emit a receiver edge from caller to the receiver's type node (if applicable).
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_receiver_edge(
    ctx: &EdgeContext,
    call: &CallInfo,
    caller_id: u32,
    caller_name: &str,
    rel_path: &str,
    type_map: &HashMap<&str, (&str, f64)>,
    imported_names: &HashMap<&str, &str>,
    seen_edges: &mut HashSet<u64>,
    edges: &mut Vec<ComputedEdge>,
) {
    let Some(ref receiver) = call.receiver else {
        return;
    };
    if ctx.builtin_set.contains(receiver.as_str())
        || receiver == "this"
        || receiver == "self"
        || receiver == "super"
    {
        return;
    }

    // Function-scoped key (`callerName::receiver`) checked before the bare key
    // so a same-named local/parameter in a DIFFERENT function in this file
    // can't shadow the entry seeded for the function actually making this
    // call (#2235; mirrors resolveReceiverEdge in call-resolver.ts).
    let scoped_key = if caller_name.is_empty() {
        None
    } else {
        Some(format!("{}::{}", caller_name, receiver))
    };
    let type_entry = scoped_key
        .as_deref()
        .and_then(|k| type_map.get(k))
        .or_else(|| type_map.get(receiver.as_str()));
    let effective_receiver = type_entry.map(|&(t, _)| t).unwrap_or(receiver.as_str());

    // Block global fallback only when the same-file node is a local definition,
    // not when it's an import artifact (e.g. `const { C } = require(…)` seeds a
    // kind="function" node in the importer but the real class lives elsewhere).
    // A locally-defined `function C(){}` owns the name — no cross-file class
    // should shadow it (issue #1539).  Mirror of JS resolveReceiverEdge logic.
    let samefile_all: Vec<&NodeInfo> = ctx
        .nodes_by_name_and_file
        .get(&(effective_receiver, rel_path))
        .cloned()
        .unwrap_or_default();
    let is_local_definition =
        !samefile_all.is_empty() && !imported_names.contains_key(effective_receiver);
    let samefile_candidates: Vec<&NodeInfo> = samefile_all
        .iter()
        .copied()
        .filter(|n| ctx.receiver_kinds.contains(n.kind.as_str()))
        .collect();
    let receiver_nodes: Vec<&NodeInfo> = if is_local_definition {
        samefile_candidates
    } else {
        // Fall back to any cross-file class/struct/interface candidate.
        // Cross-language candidates are never legitimate receiver targets
        // (#1783) — a `new Foo()` in one language can't statically resolve to
        // an unrelated same-named class in another. Mirrors JS resolveReceiverEdge.
        ctx.nodes_by_name
            .get(effective_receiver)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|n| {
                ctx.receiver_kinds.contains(n.kind.as_str())
                    && resolve::is_same_language_family(rel_path, &n.file)
            })
            .collect()
    };

    if let Some(recv_target) = receiver_nodes.first() {
        // High bit separates receiver keys from call keys (matches JS recv| prefix)
        let recv_key = (1u64 << 63) | ((caller_id as u64) << 32) | (recv_target.id as u64);
        if !seen_edges.contains(&recv_key) {
            seen_edges.insert(recv_key);
            // Use the stored typeMap confidence when the receiver was type-resolved,
            // mirroring `typeConfidence ?? (typeName ? 0.9 : 0.7)` in resolveReceiverEdge.
            let confidence = type_entry.map(|&(_, c)| c).unwrap_or(0.7);
            edges.push(ComputedEdge {
                source_id: caller_id,
                target_id: recv_target.id,
                kind: "receiver".to_string(),
                confidence,
                dynamic: 0,
                dynamic_kind: None,
                technique: None,
            });
        }
    }
}

/// Resolve extends/implements target candidates for a class hierarchy edge.
///
/// Mirrors the JS `resolveHierarchyTargets` in `call-resolver.ts` (#1812):
/// a bare heritage-clause name previously matched every same-named node in
/// the graph regardless of file or language, producing false cross-file
/// (even cross-language) hierarchy edges for common type names. Priority:
/// 1. Same-file declaration, when `name` is not itself an import artifact.
/// 2. The file's actually-resolved import for `name` (barrel-traced). For a
///    renamed import (`import { Base as MyBase }`), the imported file stores
///    the symbol under its original exported name, not the local alias — so
///    `imported_original_name` resolves `MyBase` back to `Base` before the
///    lookup, mirroring `resolve_call_targets` (#1730).
/// 3. Last resort: a same-language-family global-by-name match (#1783),
///    first candidate only — a heritage clause names exactly one type.
fn resolve_hierarchy_targets<'a>(
    ctx: &EdgeContext<'a>,
    name: &str,
    rel_path: &str,
    imported_names: &HashMap<&str, &str>,
    target_kinds: &[&str],
    imported_original_names: &HashMap<&str, &str>,
) -> Vec<&'a NodeInfo> {
    let samefile_all: Vec<&NodeInfo> = ctx
        .nodes_by_name_and_file
        .get(&(name, rel_path))
        .cloned()
        .unwrap_or_default();
    let is_local_definition = !samefile_all.is_empty() && !imported_names.contains_key(name);
    if is_local_definition {
        return samefile_all
            .into_iter()
            .filter(|n| target_kinds.contains(&n.kind.as_str()))
            .collect();
    }

    if let Some(imported_from) = imported_names.get(name) {
        let target_name = imported_original_names.get(name).copied().unwrap_or(name);
        let imported_candidates: Vec<&NodeInfo> = ctx
            .nodes_by_name_and_file
            .get(&(target_name, *imported_from))
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|n| target_kinds.contains(&n.kind.as_str()))
            .collect();
        if !imported_candidates.is_empty() {
            return imported_candidates;
        }
    }

    ctx.nodes_by_name
        .get(name)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|n| {
            target_kinds.contains(&n.kind.as_str())
                && resolve::is_same_language_family(rel_path, &n.file)
        })
        .take(1)
        .collect()
}

/// Emit extends and implements edges for class hierarchy declarations.
fn emit_hierarchy_edges(
    ctx: &EdgeContext,
    file_input: &FileEdgeInput,
    rel_path: &str,
    imported_names: &HashMap<&str, &str>,
    imported_original_names: &HashMap<&str, &str>,
    edges: &mut Vec<ComputedEdge>,
) {
    for cls in &file_input.classes {
        let source_row = ctx
            .nodes_by_name_and_file
            .get(&(cls.name.as_str(), rel_path))
            .and_then(|v| {
                v.iter()
                    .find(|n| HIERARCHY_SOURCE_KINDS.contains(&n.kind.as_str()))
            });

        let Some(source) = source_row else { continue };

        if let Some(ref extends_name) = cls.extends {
            let targets = resolve_hierarchy_targets(
                ctx,
                extends_name,
                rel_path,
                imported_names,
                EXTENDS_TARGET_KINDS,
                imported_original_names,
            );
            for t in targets {
                edges.push(ComputedEdge {
                    source_id: source.id,
                    target_id: t.id,
                    kind: "extends".to_string(),
                    confidence: 1.0,
                    dynamic: 0,
                    dynamic_kind: None,
                    technique: None,
                });
            }
        }
        if let Some(ref implements_name) = cls.implements {
            let targets = resolve_hierarchy_targets(
                ctx,
                implements_name,
                rel_path,
                imported_names,
                IMPLEMENTS_TARGET_KINDS,
                imported_original_names,
            );
            for t in targets {
                edges.push(ComputedEdge {
                    source_id: source.id,
                    target_id: t.id,
                    kind: "implements".to_string(),
                    confidence: 1.0,
                    dynamic: 0,
                    dynamic_kind: None,
                    technique: None,
                });
            }
        }
    }
}

// ── Import edges (native) ──────────────────────────────────────────────

#[napi(object)]
pub struct ImportInfo {
    pub source: String,
    pub names: Vec<String>,
    pub reexport: bool,
    #[napi(js_name = "typeOnly")]
    pub type_only: bool,
    #[napi(js_name = "dynamicImport")]
    pub dynamic_import: bool,
    #[napi(js_name = "wildcardReexport")]
    pub wildcard_reexport: bool,
    /// Local names (subset of `names`) marked type-only via an inline
    /// per-specifier `type`/`typeof` modifier (`import { type X }`), as
    /// distinct from a whole-statement `import type { X }` (already covered
    /// by `type_only`, #1813).
    #[napi(js_name = "typeOnlyNames")]
    pub type_only_names: Vec<String>,
    /// `{ local, imported }` pairs for `import { X as Y }` specifiers —
    /// mirrors `Import.renamedImports` (#1730). Without this, symbol-level
    /// lookups in `emit_named_symbol_edges`/`emit_barrel_through_edges` would
    /// search the target file for the local (post-rename) name instead of
    /// the name actually declared there, silently failing to find it (#1847).
    #[napi(js_name = "renamedImports")]
    pub renamed_imports: Vec<RenamedImport>,
}

impl ImportNameSource for ImportInfo {
    fn names(&self) -> &[String] {
        &self.names
    }
    fn renamed_imports(&self) -> &[RenamedImport] {
        &self.renamed_imports
    }
    fn is_type_only(&self) -> bool {
        self.type_only
    }
    fn type_only_names(&self) -> &[String] {
        &self.type_only_names
    }
}

#[napi(object)]
pub struct ImportEdgeFileInput {
    pub file: String,
    #[napi(js_name = "fileNodeId")]
    pub file_node_id: u32,
    #[napi(js_name = "isBarrelOnly")]
    pub is_barrel_only: bool,
    pub imports: Vec<ImportInfo>,
    #[napi(js_name = "definitionNames")]
    pub definition_names: Vec<String>,
}

#[napi(object)]
pub struct ReexportEntryInput {
    pub source: String,
    pub names: Vec<String>,
    #[napi(js_name = "wildcardReexport")]
    pub wildcard_reexport: bool,
    /// `{ local, imported }` pairs for `export { X as Y } from …` specifiers
    /// within this entry — see `barrel_resolution::ReexportRef::renames` (#1823).
    #[napi(ts_type = "RenamedImport[] | undefined")]
    pub renames: Option<Vec<RenamedImport>>,
}

#[napi(object)]
pub struct FileReexports {
    pub file: String,
    pub reexports: Vec<ReexportEntryInput>,
}

#[napi(object)]
pub struct FileNodeEntry {
    pub file: String,
    #[napi(js_name = "nodeId")]
    pub node_id: u32,
}

#[napi(object)]
pub struct ResolvedImportEntry {
    pub key: String,
    #[napi(js_name = "resolvedPath")]
    pub resolved_path: String,
}

/// A symbol node entry for type-only import resolution.
/// Maps (name, file) → (nodeId, kind) so the native engine can create
/// symbol-level `imports-type` edges (parity with the JS `buildImportEdges`
/// path) — `kind` lets it also credit plain imports of TypeScript
/// interface/type-alias declarations, not just `import type` statements
/// (#1833).
#[napi(object)]
pub struct SymbolNodeEntry {
    pub name: String,
    pub file: String,
    #[napi(js_name = "nodeId")]
    pub node_id: u32,
    pub kind: String,
}

/// Shared lookup context for import edge building.
struct ImportEdgeContext<'a> {
    resolved: HashMap<&'a str, &'a str>,
    reexport_map: HashMap<&'a str, &'a [ReexportEntryInput]>,
    file_node_map: HashMap<&'a str, u32>,
    barrel_set: HashSet<&'a str>,
    file_defs: HashMap<&'a str, HashSet<&'a str>>,
    /// Symbol node lookup: (name, file) → (node ID, kind).
    /// Used to create symbol-level `imports-type` edges for type-only imports,
    /// and — via `kind` — for plain imports resolving to a TypeScript
    /// interface/type-alias declaration (#1833).
    ///
    /// Owned keys (rather than `&'a str`) because a barrel-rename lookup key
    /// (#1823) is a freshly-resolved name that doesn't borrow from `'a` input
    /// data.
    symbol_node_map: HashMap<(String, String), (u32, String)>,
}

impl<'a> ImportEdgeContext<'a> {
    fn new(
        resolved_imports: &'a [ResolvedImportEntry],
        file_reexports: &'a [FileReexports],
        file_node_ids: &'a [FileNodeEntry],
        barrel_files: &'a [String],
        files: &'a [ImportEdgeFileInput],
        symbol_nodes: &'a [SymbolNodeEntry],
    ) -> Self {
        let mut resolved = HashMap::with_capacity(resolved_imports.len());
        for ri in resolved_imports {
            resolved.insert(ri.key.as_str(), ri.resolved_path.as_str());
        }

        let mut reexport_map: HashMap<&str, &[ReexportEntryInput]> =
            HashMap::with_capacity(file_reexports.len());
        for fr in file_reexports {
            reexport_map.insert(fr.file.as_str(), fr.reexports.as_slice());
        }

        let mut file_node_map = HashMap::with_capacity(file_node_ids.len());
        for entry in file_node_ids {
            file_node_map.insert(entry.file.as_str(), entry.node_id);
        }

        let barrel_set: HashSet<&str> = barrel_files.iter().map(|s| s.as_str()).collect();

        let mut file_defs: HashMap<&str, HashSet<&str>> = HashMap::with_capacity(files.len());
        for f in files {
            let defs: HashSet<&str> = f.definition_names.iter().map(|s| s.as_str()).collect();
            file_defs.insert(f.file.as_str(), defs);
        }

        let mut symbol_node_map = HashMap::with_capacity(symbol_nodes.len());
        for entry in symbol_nodes {
            symbol_node_map.insert(
                (entry.name.clone(), entry.file.clone()),
                (entry.node_id, entry.kind.clone()),
            );
        }

        Self {
            resolved,
            reexport_map,
            file_node_map,
            barrel_set,
            file_defs,
            symbol_node_map,
        }
    }
}

impl<'a> BarrelContext for ImportEdgeContext<'a> {
    fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>> {
        self.reexport_map.get(barrel_path).map(|entries| {
            entries
                .iter()
                .map(|re| ReexportRef {
                    source: re.source.as_str(),
                    names: &re.names,
                    wildcard_reexport: re.wildcard_reexport,
                    renames: re.renames.as_deref().unwrap_or(&[]),
                })
                .collect()
        })
    }

    fn has_definition(&self, file_path: &str, symbol: &str) -> bool {
        self.file_defs
            .get(file_path)
            .is_some_and(|defs| defs.contains(symbol))
    }
}

/// Build import and barrel-through edges in Rust.
///
/// Mirrors `buildImportEdges()` + `buildBarrelEdges()` in build-edges.ts.
/// All import paths must be pre-resolved on the JS side before calling.
#[napi]
pub fn build_import_edges(
    files: Vec<ImportEdgeFileInput>,
    resolved_imports: Vec<ResolvedImportEntry>,
    file_reexports: Vec<FileReexports>,
    file_node_ids: Vec<FileNodeEntry>,
    barrel_files: Vec<String>,
    root_dir: String,
    #[napi(ts_arg_type = "SymbolNodeEntry[] | undefined")] symbol_nodes: Option<
        Vec<SymbolNodeEntry>,
    >,
) -> Vec<ComputedEdge> {
    let empty_symbols = Vec::new();
    let symbols_ref = symbol_nodes.as_deref().unwrap_or(&empty_symbols);
    let ctx = ImportEdgeContext::new(
        &resolved_imports,
        &file_reexports,
        &file_node_ids,
        &barrel_files,
        &files,
        symbols_ref,
    );

    let mut edges = Vec::new();
    let normalized_root = root_dir.replace('\\', "/");
    for file_input in &files {
        let abs_file = format!("{normalized_root}/{}", file_input.file);
        for imp in &file_input.imports {
            process_single_import(&mut edges, file_input, imp, &abs_file, &ctx);
        }
    }
    edges
}

// ── build_import_edges helpers ──────────────────────────────────────────

/// Classify an import into its edge kind: reexports / imports-type /
/// dynamic-imports / imports. Mirrors the JS classifier in `build-edges.ts`.
fn classify_import_edge_kind(imp: &ImportInfo) -> &'static str {
    if imp.reexport {
        "reexports"
    } else if imp.type_only {
        "imports-type"
    } else if imp.dynamic_import {
        "dynamic-imports"
    } else {
        "imports"
    }
}

/// True for a named (non-wildcard) re-export — `export { X } from 'Y'` or
/// `export { X as Z } from 'Y'`. Wildcard re-exports (`export * from 'Y'`)
/// carry no specific names, so they're excluded here and handled instead by
/// the file-level `reexports` edge + the query layer's full-export fallback.
fn is_named_reexport(imp: &ImportInfo) -> bool {
    imp.reexport && !imp.wildcard_reexport
}

/// True for a genuine wildcard re-export (`export * from 'Y'`). Emitted as a
/// distinct file-level marker edge (`reexports-wildcard`) alongside the
/// generic `reexports` edge so the query layer can tell a target reached
/// only by named specifiers apart from one that's also reached by a
/// wildcard — even when a *different* statement in the same file names
/// specific symbols from that exact target (#1849 review).
fn is_wildcard_reexport(imp: &ImportInfo) -> bool {
    imp.reexport && imp.wildcard_reexport
}

/// For a `type` import or a named re-export targeting a barrel or resolved
/// file, emit one symbol-level edge per named symbol so the target symbols
/// receive fan-in credit and aren't misclassified as dead code
/// (`imports-type`, #1724), or so `codegraph exports` can report the
/// precise re-export surface instead of the target's full export list
/// (`reexports`, #1742). `kind` selects which edge kind to emit.
///
/// For `kind == "imports-type"`, a specifier gets an edge when either it's
/// actually marked type-only (whole-statement or inline per-specifier,
/// #1813 — a mixed `import { value, type Foo }` must not credit `value` on
/// this basis alone), or the resolved target is a TypeScript
/// interface/type-alias declaration (`is_type_erased_import_target`) — those
/// kinds are erased before runtime, so a plain `import { Foo } from 'y'` (no
/// `type` keyword) is the only consumption signal `codegraph exports` can
/// observe for them (#1833).
///
/// Looks up each specifier's *original* declared name via `import_name_pairs`
/// rather than the local (possibly renamed) binding — for `export { X as Z }`
/// this is already `X` (`imp.names` holds the original for export
/// specifiers), but for a renamed value/type import (`import type { X as Y }`)
/// the original name only exists in `imp.renamed_imports`; searching under the
/// local alias `Y` would never find a match in the target file (#1847). The
/// emitted edge (and downstream `reexportedSymbols` entry) is reported under
/// the symbol's own declared name in both cases, not the local/barrel alias.
///
/// When `resolved_path` is itself a barrel that renamed the requested name
/// further down its own reexport chain (`export { X as Y } from …`),
/// `resolve_barrel_export` reports the name actually declared in the
/// resolved file — which may differ from `original` — so the lookup below
/// must use that reported name, not `original`, against the barrel target
/// (#1823).
fn emit_named_symbol_edges(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    resolved_path: &str,
    kind: &str,
    ctx: &ImportEdgeContext,
) {
    if ctx.symbol_node_map.is_empty() {
        return;
    }
    for (_local, original, type_only) in import_name_pairs(imp) {
        let barrel_target = if ctx.barrel_set.contains(resolved_path) {
            let mut visited = HashSet::new();
            barrel_resolution::resolve_barrel_export(ctx, resolved_path, &original, &mut visited)
        } else {
            None
        };
        let (target_name, target_file) = match &barrel_target {
            Some(resolved)
                if ctx
                    .symbol_node_map
                    .contains_key(&(resolved.name.clone(), resolved.file.clone())) =>
            {
                (resolved.name.clone(), resolved.file.clone())
            }
            _ => (original, resolved_path.to_string()),
        };
        let Some((id, sym_kind)) = ctx.symbol_node_map.get(&(target_name, target_file.clone()))
        else {
            continue;
        };
        if kind == "imports-type"
            && !type_only
            && !crate::shared::constants::is_type_erased_import_target(sym_kind, &target_file)
        {
            continue;
        }
        edges.push(ComputedEdge {
            source_id: file_input.file_node_id,
            target_id: *id,
            kind: kind.to_string(),
            confidence: 1.0,
            dynamic: 0,
            dynamic_kind: None,
            technique: None,
        });
    }
}

/// For a non-reexport import targeting a barrel file, walk the barrel
/// chain for each named symbol and emit a barrel-through edge to the
/// ultimate definition file. Deduplicates target files via
/// `resolved_sources`.
fn emit_barrel_through_edges(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    resolved_path: &str,
    edge_kind: &str,
    ctx: &ImportEdgeContext,
) {
    if imp.reexport || !ctx.barrel_set.contains(resolved_path) {
        return;
    }
    let barrel_kind = match edge_kind {
        "imports-type" => "imports-type",
        "dynamic-imports" => "dynamic-imports",
        _ => "imports",
    };
    let mut resolved_sources: HashSet<String> = HashSet::new();
    for (_local, original, _type_only) in import_name_pairs(imp) {
        let mut visited = HashSet::new();
        let actual =
            barrel_resolution::resolve_barrel_export(ctx, resolved_path, &original, &mut visited);
        let actual_source = match actual {
            Some(resolved) => resolved.file,
            None => continue,
        };
        if actual_source == resolved_path || resolved_sources.contains(&actual_source) {
            continue;
        }
        if let Some(&actual_node_id) = ctx.file_node_map.get(actual_source.as_str()) {
            edges.push(ComputedEdge {
                source_id: file_input.file_node_id,
                target_id: actual_node_id,
                kind: barrel_kind.to_string(),
                confidence: 0.9,
                dynamic: 0,
                dynamic_kind: None,
                technique: None,
            });
        }
        resolved_sources.insert(actual_source);
    }
}

/// Process a single import from a file, emitting the primary file-to-file
/// edge plus any type-symbol and barrel-through edges.
fn process_single_import(
    edges: &mut Vec<ComputedEdge>,
    file_input: &ImportEdgeFileInput,
    imp: &ImportInfo,
    abs_file: &str,
    ctx: &ImportEdgeContext,
) {
    if file_input.is_barrel_only && !imp.reexport {
        return;
    }
    let resolve_key = format!("{abs_file}|{}", imp.source);
    let resolved_path = match ctx.resolved.get(resolve_key.as_str()) {
        Some(p) => *p,
        None => return,
    };
    let target_node_id = match ctx.file_node_map.get(resolved_path) {
        Some(id) => *id,
        None => return,
    };
    let edge_kind = classify_import_edge_kind(imp);
    edges.push(ComputedEdge {
        source_id: file_input.file_node_id,
        target_id: target_node_id,
        kind: edge_kind.to_string(),
        confidence: 1.0,
        dynamic: 0,
        dynamic_kind: None,
        technique: None,
    });
    // Always attempted (not just for `import type`/inline-`type` specifiers) —
    // emit_named_symbol_edges also credits plain specifiers that resolve to a
    // TypeScript interface/type-alias declaration (#1833).
    if !imp.reexport {
        emit_named_symbol_edges(edges, file_input, imp, resolved_path, "imports-type", ctx);
    }
    if is_named_reexport(imp) {
        emit_named_symbol_edges(edges, file_input, imp, resolved_path, "reexports", ctx);
    } else if is_wildcard_reexport(imp) {
        edges.push(ComputedEdge {
            source_id: file_input.file_node_id,
            target_id: target_node_id,
            kind: "reexports-wildcard".to_string(),
            confidence: 1.0,
            dynamic: 0,
            dynamic_kind: None,
            technique: None,
        });
    }
    emit_barrel_through_edges(edges, file_input, imp, resolved_path, edge_kind, ctx);
}

#[cfg(test)]
mod import_edge_tests {
    use super::*;

    fn make_file(
        file: &str,
        node_id: u32,
        imports: Vec<ImportInfo>,
        defs: Vec<&str>,
    ) -> ImportEdgeFileInput {
        ImportEdgeFileInput {
            file: file.to_string(),
            file_node_id: node_id,
            is_barrel_only: false,
            imports,
            definition_names: defs.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    fn make_import(
        source: &str,
        names: Vec<&str>,
        reexport: bool,
        type_only: bool,
        dynamic: bool,
    ) -> ImportInfo {
        ImportInfo {
            source: source.to_string(),
            names: names.into_iter().map(|s| s.to_string()).collect(),
            reexport,
            type_only,
            dynamic_import: dynamic,
            wildcard_reexport: false,
            type_only_names: vec![],
            renamed_imports: vec![],
        }
    }

    /// A mixed import (`import { value, type Foo } from 'src'`) where only
    /// `type_only_names` carries the inline-modifier names (#1813).
    fn make_import_with_type_only_names(
        source: &str,
        names: Vec<&str>,
        type_only_names: Vec<&str>,
    ) -> ImportInfo {
        ImportInfo {
            source: source.to_string(),
            names: names.into_iter().map(|s| s.to_string()).collect(),
            reexport: false,
            type_only: false,
            dynamic_import: false,
            wildcard_reexport: false,
            type_only_names: type_only_names.into_iter().map(|s| s.to_string()).collect(),
            renamed_imports: vec![],
        }
    }

    /// A renamed import (`import { X as Y } from 'src'`, optionally `import
    /// type`) — `names` carries the local (post-rename) binding `Y`, and
    /// `renamed_imports` maps it back to the original declared name `X`
    /// (#1730, #1847).
    fn make_import_with_renames(
        source: &str,
        names: Vec<&str>,
        renames: Vec<(&str, &str)>,
        type_only: bool,
    ) -> ImportInfo {
        ImportInfo {
            source: source.to_string(),
            names: names.into_iter().map(|s| s.to_string()).collect(),
            reexport: false,
            type_only,
            dynamic_import: false,
            wildcard_reexport: false,
            type_only_names: vec![],
            renamed_imports: renames
                .into_iter()
                .map(|(local, imported)| RenamedImport {
                    local: local.to_string(),
                    imported: imported.to_string(),
                })
                .collect(),
        }
    }

    fn make_resolved(from_abs: &str, source: &str, resolved: &str) -> ResolvedImportEntry {
        ResolvedImportEntry {
            key: format!("{}|{}", from_abs, source),
            resolved_path: resolved.to_string(),
        }
    }

    fn make_node_entry(file: &str, id: u32) -> FileNodeEntry {
        FileNodeEntry {
            file: file.to_string(),
            node_id: id,
        }
    }

    #[test]
    fn basic_import_edge() {
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./utils", vec!["foo"], false, false, false)],
            vec!["main"],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./utils", "src/utils.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].source_id, 1);
        assert_eq!(edges[0].target_id, 2);
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[0].confidence, 1.0);
    }

    #[test]
    fn reexport_edge() {
        let files = vec![make_file(
            "src/index.ts",
            1,
            vec![make_import("./utils", vec!["foo"], true, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved(
            "/root/src/index.ts",
            "./utils",
            "src/utils.ts",
        )];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "reexports");
    }

    #[test]
    fn named_reexport_emits_symbol_level_edge() {
        // `export { foo } from './utils'` in src/index.ts, where `foo` is a
        // specific symbol defined in src/utils.ts. Alongside the file-level
        // `reexports` edge, a symbol-level `reexports` edge should point at
        // `foo`'s own node — not at every export of utils.ts (#1742).
        let files = vec![make_file(
            "src/index.ts",
            1,
            vec![make_import("./utils", vec!["foo"], true, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved(
            "/root/src/index.ts",
            "./utils",
            "src/utils.ts",
        )];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "foo".to_string(),
            file: "src/utils.ts".to_string(),
            node_id: 99,
            kind: "function".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        // File-level edge: index.ts -> utils.ts file node.
        assert_eq!(edges[0].kind, "reexports");
        assert_eq!(edges[0].target_id, 2);
        // Symbol-level edge: index.ts -> foo's own node.
        assert_eq!(edges[1].kind, "reexports");
        assert_eq!(edges[1].target_id, 99);
    }

    #[test]
    fn wildcard_reexport_emits_no_symbol_level_edge() {
        // `export * from './utils'` carries no specific names, so no
        // symbol-level edge is emitted. It does get the dedicated
        // `reexports-wildcard` file-level marker (alongside the generic
        // `reexports` edge) so the query layer can always apply full-export
        // semantics for genuine wildcards, even when a *different* statement
        // to the same target also names specific symbols (#1849 review).
        let files = vec![make_file(
            "src/index.ts",
            1,
            vec![ImportInfo {
                source: "./utils".to_string(),
                names: vec![],
                reexport: true,
                type_only: false,
                dynamic_import: false,
                wildcard_reexport: true,
                type_only_names: vec![],
                renamed_imports: vec![],
            }],
            vec![],
        )];
        let resolved = vec![make_resolved(
            "/root/src/index.ts",
            "./utils",
            "src/utils.ts",
        )];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "foo".to_string(),
            file: "src/utils.ts".to_string(),
            node_id: 99,
            kind: "function".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, "reexports");
        assert_eq!(edges[0].target_id, 2);
        assert_eq!(edges[1].kind, "reexports-wildcard");
        assert_eq!(edges[1].target_id, 2);
    }

    #[test]
    fn named_and_wildcard_reexport_of_same_target_both_marked() {
        // `export { foo } from './utils'` AND `export * from './utils'` in
        // the same file, both targeting utils.ts. The wildcard's full-export
        // semantics must stay independently signalled (via the dedicated
        // `reexports-wildcard` marker) rather than being suppressed by the
        // named specifier's symbol-level edge — otherwise the query layer
        // would report only `foo` and silently drop every other export of
        // utils.ts that the wildcard was meant to surface (#1849 review).
        let files = vec![make_file(
            "src/index.ts",
            1,
            vec![
                make_import("./utils", vec!["foo"], true, false, false),
                ImportInfo {
                    source: "./utils".to_string(),
                    names: vec![],
                    reexport: true,
                    type_only: false,
                    dynamic_import: false,
                    wildcard_reexport: true,
                    type_only_names: vec![],
                    renamed_imports: vec![],
                },
            ],
            vec![],
        )];
        let resolved = vec![make_resolved(
            "/root/src/index.ts",
            "./utils",
            "src/utils.ts",
        )];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "foo".to_string(),
            file: "src/utils.ts".to_string(),
            node_id: 99,
            kind: "function".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 4);
        // Named statement: file-level `reexports` + symbol-level `reexports` to foo.
        assert_eq!(edges[0].kind, "reexports");
        assert_eq!(edges[0].target_id, 2);
        assert_eq!(edges[1].kind, "reexports");
        assert_eq!(edges[1].target_id, 99);
        // Wildcard statement: file-level `reexports` + the `reexports-wildcard` marker.
        assert_eq!(edges[2].kind, "reexports");
        assert_eq!(edges[2].target_id, 2);
        assert_eq!(edges[3].kind, "reexports-wildcard");
        assert_eq!(edges[3].target_id, 2);
    }

    #[test]
    fn renamed_reexport_resolves_original_name() {
        // `export { foo as bar } from './utils'` — the JS extractor stores
        // the *original* declaration name ("foo") in `names`, not the
        // external alias ("bar"). The symbol-level edge must resolve
        // against foo's own node.
        let files = vec![make_file(
            "src/index.ts",
            1,
            vec![make_import("./utils", vec!["foo"], true, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved(
            "/root/src/index.ts",
            "./utils",
            "src/utils.ts",
        )];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];
        let symbol_nodes = vec![
            SymbolNodeEntry {
                name: "foo".to_string(),
                file: "src/utils.ts".to_string(),
                node_id: 99,
                kind: "function".to_string(),
            },
            // A decoy under the external alias name must NOT be matched.
            SymbolNodeEntry {
                name: "bar".to_string(),
                file: "src/utils.ts".to_string(),
                node_id: 100,
                kind: "function".to_string(),
            },
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].kind, "reexports");
        assert_eq!(edges[1].target_id, 99);
    }

    #[test]
    fn type_only_edge() {
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./types", vec!["MyType"], false, true, false)],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./types", "src/types.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/types.ts", 2),
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "imports-type");
    }

    #[test]
    fn renamed_type_import_resolves_original_name() {
        // `import type { Config as CfgType } from './types'` — `names` holds
        // the local alias "CfgType", but `Config` is the name actually
        // declared in types.ts. The symbol-level `imports-type` edge must
        // resolve against Config's own node, not fail to find "CfgType"
        // there (#1847).
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import_with_renames(
                "./types",
                vec!["CfgType"],
                vec![("CfgType", "Config")],
                true,
            )],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./types", "src/types.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/types.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "Config".to_string(),
            file: "src/types.ts".to_string(),
            node_id: 77,
            kind: "interface".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, "imports-type");
        assert_eq!(edges[0].target_id, 2);
        assert_eq!(edges[1].kind, "imports-type");
        assert_eq!(edges[1].target_id, 77);
    }

    #[test]
    fn renamed_import_through_barrel_resolves_original_name() {
        // `import { Config as CfgType } from './barrel'` where './barrel'
        // does `export { Config } from './types'`. Barrel-through resolution
        // must look up "Config" (the original name) in the barrel's own
        // export map, not the local alias "CfgType", which only exists in
        // app.ts (#1847).
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import_with_renames(
                    "./barrel",
                    vec!["CfgType"],
                    vec![("CfgType", "Config")],
                    false,
                )],
                vec![],
            ),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/types.ts", 20, vec![], vec!["Config"]),
        ];
        let resolved = vec![make_resolved(
            "/root/src/app.ts",
            "./barrel",
            "src/barrel.ts",
        )];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/types.ts".to_string(),
                names: vec!["Config".to_string()],
                wildcard_reexport: false,
                renames: None,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/types.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 2);
        // First: direct import to the barrel.
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[0].target_id, 10);
        // Second: barrel-through to the actual source (types.ts), resolved
        // via the original name "Config", not the local alias "CfgType".
        assert_eq!(edges[1].kind, "imports");
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
    }

    #[test]
    fn mixed_import_inline_type_modifier_credits_only_flagged_name() {
        // `import { value, type Foo } from './mixed'` — only `Foo` carries
        // the inline per-specifier `type` modifier, so only `Foo` should get
        // a symbol-level `imports-type` edge; `value` must not (#1813). The
        // file-level edge stays `imports` since the statement as a whole
        // isn't fully type-only.
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import_with_type_only_names(
                "./mixed",
                vec!["value", "Foo"],
                vec!["Foo"],
            )],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./mixed", "src/mixed.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/mixed.ts", 2),
        ];
        let symbol_nodes = vec![
            SymbolNodeEntry {
                name: "Foo".to_string(),
                file: "src/mixed.ts".to_string(),
                node_id: 50,
                kind: "function".to_string(),
            },
            SymbolNodeEntry {
                name: "value".to_string(),
                file: "src/mixed.ts".to_string(),
                node_id: 51,
                kind: "function".to_string(),
            },
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[1].kind, "imports-type");
        assert_eq!(edges[1].target_id, 50);
    }

    #[test]
    fn plain_import_of_ts_interface_credits_imports_type_edge() {
        // `import { Foo } from './types'` — no `type` keyword — where `Foo`
        // is a TypeScript interface. Interfaces are erased before runtime, so
        // this plain import is the only observable consumption signal
        // `codegraph exports` can rely on; it must be credited exactly like
        // `import type { Foo }` would be (#1833).
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./types", vec!["Foo"], false, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./types", "src/types.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/types.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "Foo".to_string(),
            file: "src/types.ts".to_string(),
            node_id: 50,
            kind: "interface".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[1].kind, "imports-type");
        assert_eq!(edges[1].target_id, 50);
    }

    #[test]
    fn plain_import_of_ts_value_symbol_gets_no_symbol_level_edge() {
        // `import { helper } from './utils'` where `helper` is a plain
        // function (not an interface/type alias). Consumption credit for a
        // value symbol must still come exclusively from a real `calls` edge
        // — merely importing it must not fabricate one (#1833 must not
        // regress the existing value-import behaviour).
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./utils", vec!["helper"], false, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./utils", "src/utils.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/utils.ts", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "helper".to_string(),
            file: "src/utils.ts".to_string(),
            node_id: 50,
            kind: "function".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "imports");
    }

    #[test]
    fn plain_import_of_non_typescript_interface_gets_no_symbol_level_edge() {
        // A plain import resolving to an 'interface'-kind node in a
        // non-TypeScript file (e.g. a Go `type ... interface {}`) must not be
        // credited by this heuristic — those kinds are runtime-observable in
        // other languages, so crediting on mere import would mask genuinely
        // dead code instead of fixing a false positive (#1833 is scoped to
        // TypeScript's compile-time-only interfaces/type aliases).
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./iface", vec!["Reader"], false, false, false)],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./iface", "src/iface.go")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/iface.go", 2),
        ];
        let symbol_nodes = vec![SymbolNodeEntry {
            name: "Reader".to_string(),
            file: "src/iface.go".to_string(),
            node_id: 50,
            kind: "interface".to_string(),
        }];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            Some(symbol_nodes),
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "imports");
    }

    #[test]
    fn dynamic_import_edge() {
        let files = vec![make_file(
            "src/app.ts",
            1,
            vec![make_import("./lazy", vec!["Lazy"], false, false, true)],
            vec![],
        )];
        let resolved = vec![make_resolved("/root/src/app.ts", "./lazy", "src/lazy.ts")];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/lazy.ts", 2),
        ];

        let edges = build_import_edges(
            files,
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "dynamic-imports");
    }

    #[test]
    fn barrel_only_skips_non_reexport() {
        let mut file = make_file(
            "src/index.ts",
            1,
            vec![
                make_import("./a", vec!["a"], false, false, false),
                make_import("./b", vec!["b"], true, false, false),
            ],
            vec![],
        );
        file.is_barrel_only = true;
        let resolved = vec![
            make_resolved("/root/src/index.ts", "./a", "src/a.ts"),
            make_resolved("/root/src/index.ts", "./b", "src/b.ts"),
        ];
        let node_ids = vec![
            make_node_entry("src/index.ts", 1),
            make_node_entry("src/a.ts", 2),
            make_node_entry("src/b.ts", 3),
        ];

        let edges = build_import_edges(
            vec![file],
            resolved,
            vec![],
            node_ids,
            vec![],
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "reexports");
        assert_eq!(edges[0].target_id, 3);
    }

    #[test]
    fn barrel_resolution_simple() {
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import("./index", vec!["foo"], false, false, false)],
                vec!["main"],
            ),
            make_file("src/index.ts", 10, vec![], vec![]),
            make_file("src/utils.ts", 20, vec![], vec!["foo"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./index", "src/index.ts")];
        let reexports = vec![FileReexports {
            file: "src/index.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/utils.ts".to_string(),
                names: vec!["foo".to_string()],
                wildcard_reexport: false,
                renames: None,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/index.ts", 10),
            make_node_entry("src/utils.ts", 20),
        ];
        let barrels = vec!["src/index.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 2);
        // First: direct import to barrel
        assert_eq!(edges[0].target_id, 10);
        assert_eq!(edges[0].confidence, 1.0);
        // Second: barrel-through to actual source
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
        assert_eq!(edges[1].kind, "imports");
    }

    #[test]
    fn barrel_chain_two_levels() {
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import("./index", vec!["deep"], false, false, false)],
                vec![],
            ),
            make_file("src/index.ts", 10, vec![], vec![]),
            make_file("src/mid.ts", 20, vec![], vec![]),
            make_file("src/deep.ts", 30, vec![], vec!["deep"]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./index", "src/index.ts")];
        let reexports = vec![
            FileReexports {
                file: "src/index.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/mid.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                    renames: None,
                }],
            },
            FileReexports {
                file: "src/mid.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/deep.ts".to_string(),
                    names: vec!["deep".to_string()],
                    wildcard_reexport: false,
                    renames: None,
                }],
            },
        ];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/index.ts", 10),
            make_node_entry("src/deep.ts", 30),
        ];
        let barrels = vec!["src/index.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].target_id, 30);
        assert_eq!(edges[1].confidence, 0.9);
    }

    #[test]
    fn barrel_cycle_detection() {
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import("./a", vec!["x"], false, false, false)],
                vec![],
            ),
            make_file("src/a.ts", 10, vec![], vec![]),
            make_file("src/b.ts", 20, vec![], vec![]),
        ];
        let resolved = vec![make_resolved("/root/src/app.ts", "./a", "src/a.ts")];
        let reexports = vec![
            FileReexports {
                file: "src/a.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/b.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                    renames: None,
                }],
            },
            FileReexports {
                file: "src/b.ts".to_string(),
                reexports: vec![ReexportEntryInput {
                    source: "src/a.ts".to_string(),
                    names: vec![],
                    wildcard_reexport: true,
                    renames: None,
                }],
            },
        ];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/a.ts", 10),
        ];
        let barrels = vec!["src/a.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        // Only the direct import edge, no barrel-through (cycle prevents resolution)
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].target_id, 10);
    }

    #[test]
    fn wildcard_reexport_resolution() {
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import("./barrel", vec!["helper"], false, false, false)],
                vec![],
            ),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/helpers.ts", 20, vec![], vec!["helper"]),
        ];
        let resolved = vec![make_resolved(
            "/root/src/app.ts",
            "./barrel",
            "src/barrel.ts",
        )];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/helpers.ts".to_string(),
                names: vec![],
                wildcard_reexport: true,
                renames: None,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/helpers.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
    }

    #[test]
    fn dedup_barrel_sources() {
        // Two names from same barrel both resolve to the same actual source
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import("./barrel", vec!["a", "b"], false, false, false)],
                vec![],
            ),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/real.ts", 20, vec![], vec!["a", "b"]),
        ];
        let resolved = vec![make_resolved(
            "/root/src/app.ts",
            "./barrel",
            "src/barrel.ts",
        )];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/real.ts".to_string(),
                names: vec!["a".to_string(), "b".to_string()],
                wildcard_reexport: false,
                renames: None,
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/real.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        // 1 direct import + 1 barrel-through (deduped, not 2)
        assert_eq!(edges.len(), 2);
    }

    /// `export { realName as friendlyName } from './underlying'` — a consumer
    /// importing the barrel's external name `friendlyName` must produce a
    /// barrel-through edge to `underlying.ts`, the file that actually
    /// declares `realName` (#1823).
    #[test]
    fn renamed_barrel_reexport_resolution() {
        let files = vec![
            make_file(
                "src/app.ts",
                1,
                vec![make_import(
                    "./barrel",
                    vec!["friendlyName"],
                    false,
                    false,
                    false,
                )],
                vec![],
            ),
            make_file("src/barrel.ts", 10, vec![], vec![]),
            make_file("src/underlying.ts", 20, vec![], vec!["realName"]),
        ];
        let resolved = vec![make_resolved(
            "/root/src/app.ts",
            "./barrel",
            "src/barrel.ts",
        )];
        let reexports = vec![FileReexports {
            file: "src/barrel.ts".to_string(),
            reexports: vec![ReexportEntryInput {
                source: "src/underlying.ts".to_string(),
                names: vec!["realName".to_string()],
                wildcard_reexport: false,
                renames: Some(vec![RenamedImport {
                    local: "friendlyName".to_string(),
                    imported: "realName".to_string(),
                }]),
            }],
        }];
        let node_ids = vec![
            make_node_entry("src/app.ts", 1),
            make_node_entry("src/barrel.ts", 10),
            make_node_entry("src/underlying.ts", 20),
        ];
        let barrels = vec!["src/barrel.ts".to_string()];

        let edges = build_import_edges(
            files,
            resolved,
            reexports,
            node_ids,
            barrels,
            "/root".to_string(),
            None,
        );
        assert_eq!(edges.len(), 2);
        // Barrel-through edge resolves through the rename to underlying.ts.
        assert_eq!(edges[1].target_id, 20);
        assert_eq!(edges[1].confidence, 0.9);
        assert_eq!(edges[1].kind, "imports");
    }
}

#[cfg(test)]
mod call_edge_tests {
    use super::*;

    fn node(id: u32, name: &str, kind: &str, file: &str, line: u32) -> NodeInfo {
        NodeInfo {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            file: file.to_string(),
            line,
            accessor_kind: None,
        }
    }

    /// Like [`node`], but with an explicit `accessor_kind` — for #2030 tests.
    fn accessor_node(
        id: u32,
        name: &str,
        kind: &str,
        file: &str,
        line: u32,
        accessor_kind: &str,
    ) -> NodeInfo {
        NodeInfo {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            file: file.to_string(),
            line,
            accessor_kind: Some(accessor_kind.to_string()),
        }
    }

    fn def(name: &str, kind: &str, line: u32, end_line: u32) -> DefInfo {
        DefInfo {
            name: name.to_string(),
            kind: kind.to_string(),
            line,
            end_line: Some(end_line),
            params: None,
        }
    }

    fn call(name: &str, line: u32, receiver: Option<&str>) -> CallInfo {
        CallInfo {
            name: name.to_string(),
            line,
            dynamic: None,
            receiver: receiver.map(|s| s.to_string()),
            dynamic_kind: None,
            key_expr: None,
            accessor_read: None,
            object_literal_site: None,
        }
    }

    /// Like [`call`], but tagged with `accessor_read` — for #2030 tests.
    fn accessor_call(name: &str, line: u32, receiver: &str, accessor_read: &str) -> CallInfo {
        CallInfo {
            name: name.to_string(),
            line,
            dynamic: None,
            receiver: Some(receiver.to_string()),
            dynamic_kind: None,
            key_expr: None,
            accessor_read: Some(accessor_read.to_string()),
            object_literal_site: None,
        }
    }

    fn type_map_entry(name: &str, type_name: &str, confidence: f64) -> TypeMapInput {
        TypeMapInput {
            name: name.to_string(),
            type_name: type_name.to_string(),
            confidence,
        }
    }

    fn class_info(name: &str, extends: Option<&str>, implements: Option<&str>) -> ClassInfo {
        ClassInfo {
            name: name.to_string(),
            extends: extends.map(|s| s.to_string()),
            implements: implements.map(|s| s.to_string()),
        }
    }

    fn make_file(
        file: &str,
        file_node_id: u32,
        defs: Vec<DefInfo>,
        calls: Vec<CallInfo>,
        type_map: Vec<TypeMapInput>,
        classes: Vec<ClassInfo>,
    ) -> FileEdgeInput {
        FileEdgeInput {
            file: file.to_string(),
            file_node_id,
            definitions: defs,
            calls,
            imported_names: vec![],
            classes,
            type_map,
            fn_ref_bindings: None,
            param_bindings: None,
            this_call_bindings: None,
            array_elem_bindings: None,
            spread_arg_bindings: None,
            for_of_bindings: None,
            array_callback_bindings: None,
            object_rest_param_bindings: None,
            object_prop_bindings: None,
            computed_dispatch_table_evidence: None,
            new_expressions: None,
            object_literal_sites: None,
            call_assignments: None,
        }
    }

    /// Mirrors the sample-project scenario: `const calc = new Calculator()` then
    /// `calc.compute(5, 6)` inside `main`. The native engine must emit a
    /// `receiver` edge from `main` → `Calculator`.
    #[test]
    fn receiver_edge_via_type_map() {
        let all_nodes = vec![
            node(1, "main", "function", "index.js", 3),
            node(2, "Calculator", "class", "utils.js", 1),
            node(3, "compute", "method", "utils.js", 3),
        ];

        let files = vec![make_file(
            "index.js",
            /* file_node_id */ 10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 1.0)],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "expected a receiver edge but got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        let re = receiver_edge.unwrap();
        assert_eq!(
            re.source_id, 1,
            "receiver edge source should be main (id=1)"
        );
        assert_eq!(
            re.target_id, 2,
            "receiver edge target should be Calculator (id=2)"
        );
    }

    // ── Cross-file ES6 accessor property-read resolution (#2030) ───────────

    /// The issue's own repro shape: a property-read call tagged
    /// `accessor_read: "get"` with `receiver` set to the *resolved class
    /// name* (not a variable) must resolve to the matching accessor node
    /// even when it lives many directories away from the caller — the
    /// directory-proximity confidence gate the rest of the cascade relies on
    /// must NOT apply here.
    #[test]
    fn cross_file_accessor_read_resolves_across_distant_directories() {
        let all_nodes = vec![
            node(1, "useRepo", "function", "src/features/sequence.js", 1),
            accessor_node(
                2,
                "SqliteRepository.db",
                "method",
                "src/db/repository/sqlite.js",
                3,
                "get",
            ),
        ];
        let files = vec![make_file(
            "src/features/sequence.js",
            10,
            vec![def("useRepo", "function", 1, 3)],
            vec![accessor_call("db", 2, "SqliteRepository", "get")],
            vec![],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let call_edge = edges.iter().find(|e| e.kind == "calls");
        assert!(
            call_edge.is_some(),
            "expected a calls edge to the cross-file accessor; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        let ce = call_edge.unwrap();
        assert_eq!(ce.source_id, 1);
        assert_eq!(ce.target_id, 2);
    }

    /// A plain (non-accessor) method sharing the exact qualified name must
    /// NOT be matched by an `accessor_read`-tagged call — the whole point of
    /// #2030's DB `accessor_kind` column is to rule this false positive out,
    /// which #1893's same-file-only registry couldn't do across files.
    #[test]
    fn cross_file_accessor_read_does_not_match_plain_method_of_same_name() {
        let all_nodes = vec![
            node(1, "useThing", "function", "consumer.js", 1),
            node(2, "Thing.value", "method", "thing.js", 3), // plain method, accessor_kind = None
        ];
        let files = vec![make_file(
            "consumer.js",
            10,
            vec![def("useThing", "function", 1, 3)],
            vec![accessor_call("value", 2, "Thing", "get")],
            vec![],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            !edges.iter().any(|e| e.kind == "calls"),
            "an accessor-read call must never resolve to a plain (non-accessor) method; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// When a property declares both a getter and setter (two distinct
    /// nodes sharing the same qualified name, one accessor_kind="get" and
    /// the other "set"), an accessor_read-tagged call must resolve to
    /// exactly the one matching its own needed kind — never both, never the
    /// wrong one.
    #[test]
    fn cross_file_accessor_read_disambiguates_get_and_set_pair() {
        let all_nodes = vec![
            node(1, "useToggle", "function", "consumer.js", 1),
            accessor_node(2, "Toggle.flag", "method", "toggle.js", 3, "get"),
            accessor_node(3, "Toggle.flag", "method", "toggle.js", 6, "set"),
        ];
        let files = vec![make_file(
            "consumer.js",
            10,
            vec![def("useToggle", "function", 1, 3)],
            vec![accessor_call("flag", 2, "Toggle", "set")],
            vec![],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let call_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert_eq!(
            call_edges.len(),
            1,
            "expected exactly one calls edge (to the setter only); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            call_edges[0].target_id, 3,
            "expected the setter (id=3), not the getter"
        );
    }

    /// Regression for #2030's Greptile review finding: the resolved class
    /// name on an accessor-read-tagged call can itself be a renamed import
    /// binding (`import { SqliteRepository as SR } from './sqlite-repository.js'`),
    /// so `call.receiver` is the local alias 'SR' — the accessor is
    /// persisted under the real declared name. Must de-alias before the
    /// qualified lookup, mirroring #1730's general-cascade de-aliasing.
    #[test]
    fn cross_file_accessor_read_dealiases_renamed_import_binding() {
        // A competing unrelated node with the identical qualified name in a
        // different file is included deliberately: `imported_names` is keyed
        // by the *local alias* ('SR'), not the de-aliased original
        // ('SqliteRepository') — an earlier version of this fix looked it up
        // under the de-aliased name, always missed, and silently fell through
        // to the unscoped global lookup, which would have returned this
        // unrelated node too (masked in a single-candidate test).
        let all_nodes = vec![
            node(1, "useRepo", "function", "consumer.js", 1),
            accessor_node(
                2,
                "SqliteRepository.db",
                "method",
                "sqlite-repository.js",
                3,
                "get",
            ),
            accessor_node(
                3,
                "SqliteRepository.db",
                "method",
                "unrelated-other-file.js",
                9,
                "get",
            ),
        ];
        let mut file = make_file(
            "consumer.js",
            10,
            vec![def("useRepo", "function", 1, 3)],
            vec![accessor_call("db", 2, "SR", "get")],
            vec![],
            vec![],
        );
        file.imported_names = vec![ImportedName {
            name: "SR".to_string(),
            file: "sqlite-repository.js".to_string(),
            imported: Some("SqliteRepository".to_string()),
            namespace: None,
        }];

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let call_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert_eq!(
            call_edges.len(),
            1,
            "expected exactly one calls edge (to the aliased import's own file); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            call_edges[0].target_id, 2,
            "expected the imported file's node (id=2), not the unrelated one (id=3)"
        );
    }

    /// Regression for #2030's Greptile review finding: when the resolved
    /// class name is a known import, resolution must commit to that specific
    /// file rather than falling through to the unscoped global name map —
    /// otherwise an unrelated file that happens to declare the same
    /// `ClassName.prop` accessor (same kind) would also match.
    #[test]
    fn cross_file_accessor_read_prefers_imported_file_over_unrelated_same_named_global_match() {
        let all_nodes = vec![
            node(1, "useRepo", "function", "consumer.js", 1),
            accessor_node(
                2,
                "SqliteRepository.db",
                "method",
                "sqlite-repository.js",
                3,
                "get",
            ),
            accessor_node(
                3,
                "SqliteRepository.db",
                "method",
                "unrelated-other-file.js",
                9,
                "get",
            ),
        ];
        let mut file = make_file(
            "consumer.js",
            10,
            vec![def("useRepo", "function", 1, 3)],
            vec![accessor_call("db", 2, "SqliteRepository", "get")],
            vec![],
            vec![],
        );
        file.imported_names = vec![ImportedName {
            name: "SqliteRepository".to_string(),
            file: "sqlite-repository.js".to_string(),
            imported: None,
            namespace: None,
        }];

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let call_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert_eq!(
            call_edges.len(),
            1,
            "expected exactly one calls edge (to the imported file's accessor only); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            call_edges[0].target_id, 2,
            "expected the imported file's node (id=2), not the unrelated one (id=3)"
        );
    }

    /// Companion to the above: when the imported file's own accessor doesn't
    /// match the needed kind, the call must be dropped outright — never fall
    /// back to an unrelated global match of the right kind in a different
    /// file, even though one exists.
    #[test]
    fn cross_file_accessor_read_drops_when_imported_file_kind_mismatches_without_global_fallback() {
        let all_nodes = vec![
            node(1, "useRepo", "function", "consumer.js", 1),
            accessor_node(
                2,
                "SqliteRepository.db",
                "method",
                "sqlite-repository.js",
                3,
                "set",
            ),
            accessor_node(
                3,
                "SqliteRepository.db",
                "method",
                "unrelated-other-file.js",
                9,
                "get",
            ),
        ];
        let mut file = make_file(
            "consumer.js",
            10,
            vec![def("useRepo", "function", 1, 3)],
            vec![accessor_call("db", 2, "SqliteRepository", "get")],
            vec![],
            vec![],
        );
        file.imported_names = vec![ImportedName {
            name: "SqliteRepository".to_string(),
            file: "sqlite-repository.js".to_string(),
            imported: None,
            namespace: None,
        }];

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            !edges.iter().any(|e| e.kind == "calls"),
            "expected no calls edge — the imported file has only a setter, and the unrelated global getter must not be used as a fallback; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Issue #1895: an object-literal-property value-ref call whose property
    /// key (`key_expr`) is never independently confirmed to be invoked
    /// anywhere (`x.resolve(...)`) must NOT produce a `calls` edge — merely
    /// being wired into the object literal is not liveness. A sibling
    /// property whose key IS invoked elsewhere (`table.reject(...)`) keeps
    /// its edge.
    #[test]
    fn value_ref_edge_requires_key_invoked_elsewhere() {
        let all_nodes = vec![
            node(1, "makeTable", "function", "factory.js", 1),
            node(2, "neverRead", "function", "factory.js", 2),
            node(3, "isRead", "function", "factory.js", 3),
            node(4, "run", "function", "consumer.js", 1),
        ];

        let mut resolve_call = call("neverRead", 5, None);
        resolve_call.dynamic = Some(true);
        resolve_call.dynamic_kind = Some("value-ref".to_string());
        resolve_call.key_expr = Some("resolve".to_string());

        let mut reject_call = call("isRead", 6, None);
        reject_call.dynamic = Some(true);
        reject_call.dynamic_kind = Some("value-ref".to_string());
        reject_call.key_expr = Some("reject".to_string());

        let factory_file = make_file(
            "factory.js",
            10,
            vec![def("makeTable", "function", 1, 8)],
            vec![resolve_call, reject_call],
            vec![],
            vec![],
        );

        // Evidence that `.reject(...)` is genuinely invoked somewhere, but
        // `.resolve(...)` never is.
        let consumer_file = make_file(
            "consumer.js",
            20,
            vec![def("run", "function", 1, 3)],
            vec![call("reject", 2, Some("table"))],
            vec![],
            vec![],
        );

        let edges = build_call_edges(
            vec![factory_file, consumer_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let calls_never_read = edges.iter().any(|e| e.kind == "calls" && e.target_id == 2);
        let calls_is_read = edges.iter().any(|e| e.kind == "calls" && e.target_id == 3);
        assert!(
            !calls_never_read,
            "expected no calls edge to neverRead (key 'resolve' never invoked); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert!(
            calls_is_read,
            "expected a calls edge to isRead (key 'reject' invoked in consumer.js); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Regression: when the same file has a `kind="function"` node for the
    /// effective receiver created by a destructured import (e.g.
    /// `const { Calculator } = require('./utils')`), that import artifact must
    /// NOT block the fallback to the global class node in another file.
    /// The import must be listed in `imported_names` so the resolver knows it
    /// is an import artifact, not a local function-constructor definition.
    #[test]
    fn receiver_edge_imported_function_node_falls_through_to_global_class() {
        let all_nodes = vec![
            node(1, "main", "function", "index.js", 3),
            // Destructured import `const { Calculator } = require('./utils')` → kind "function" in index.js
            node(4, "Calculator", "function", "index.js", 1),
            node(2, "Calculator", "class", "utils.js", 1),
            node(3, "compute", "method", "utils.js", 3),
        ];

        let mut file = make_file(
            "index.js",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 1.0)],
            vec![],
        );
        // Mark `Calculator` as an imported name so the resolver treats the
        // same-file kind="function" node as an import artifact and falls through.
        file.imported_names = vec![ImportedName {
            name: "Calculator".to_string(),
            file: "utils.js".to_string(),
            imported: None,
            namespace: None,
        }];

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "imported 'function' node must not block fallback to global class; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        let re = receiver_edge.unwrap();
        assert_eq!(
            re.target_id, 2,
            "receiver edge must point to Calculator class (id=2), not import artifact (id=4)"
        );
    }

    /// Issue #1539: `function C(){}` (function constructor) in the same file as
    /// `var v = new C(); v.foo()` must block the global fallback to any cross-file
    /// class `C`.  A locally-defined function constructor owns the name in its
    /// file — no cross-file class should win over it.
    #[test]
    fn receiver_edge_local_function_ctor_blocks_global_class() {
        let all_nodes = vec![
            node(1, "C", "function", "prototypes.js", 1), // local function constructor
            node(2, "C.foo", "method", "prototypes.js", 3),
            node(3, "C", "class", "classes.js", 1), // cross-file class with same name
        ];

        // No imported_names — `C` is locally defined.
        let files = vec![make_file(
            "prototypes.js",
            10,
            vec![def("C", "function", 1, 2)],
            vec![call("foo", 8, Some("v"))],
            vec![type_map_entry("v", "C", 1.0)],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_none(),
            "local function constructor must block global class fallback — no receiver edge expected; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Issue #1783: the global (cross-file) receiver fallback had no
    /// language-consistency check at all, so `Widget.render()` in a Python
    /// caller with no same-file `Widget` definition could resolve to an
    /// unrelated same-named class declared in a JS file purely by name.
    #[test]
    fn receiver_edge_rejects_cross_language_match() {
        let all_nodes = vec![
            node(1, "main", "function", "widget.py", 3),
            node(2, "Widget", "class", "widget.js", 1),
        ];

        let files = vec![make_file(
            "widget.py",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("render", 7, Some("Widget"))],
            vec![],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_none(),
            "a Python caller must not resolve a receiver edge to an unrelated same-named JS class; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    /// Same-language global receiver fallback must still work after the
    /// #1783 language-scoping fix — only cross-language candidates are rejected.
    #[test]
    fn receiver_edge_still_resolves_same_language_cross_file_match() {
        let all_nodes = vec![
            node(1, "main", "function", "widget.py", 3),
            node(2, "Widget", "class", "widget_impl.py", 1),
        ];

        let files = vec![make_file(
            "widget.py",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("render", 7, Some("Widget"))],
            vec![],
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "same-language cross-file receiver fallback must still resolve; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert_eq!(receiver_edge.unwrap().target_id, 2);
    }

    /// Issue #1453: `this.logger.error()` inside `UserService.create` where the
    /// constructor seeded the class-scoped key `UserService.logger → Logger`.
    /// The resolver must fall back to the `ClassName.prop` typeMap key (#1323).
    #[test]
    fn class_scoped_type_map_key_resolves_this_prop_receiver() {
        let all_nodes = vec![
            node(1, "UserService.create", "method", "svc.js", 10),
            node(2, "Logger.error", "method", "logger.js", 5),
            node(3, "Logger", "class", "logger.js", 1),
        ];
        let files = vec![make_file(
            "svc.js",
            10,
            vec![def("UserService.create", "method", 10, 20)],
            vec![call("error", 15, Some("this.logger"))],
            vec![type_map_entry("UserService.logger", "Logger", 1.0)],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            edges
                .iter()
                .any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected calls edge UserService.create → Logger.error; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Phase 8.3f (#1358): callee-scoped rest-param key `callee::restName` must
    /// be consulted when the bare receiver has no typeMap entry.
    #[test]
    fn rest_param_scoped_type_map_key() {
        let all_nodes = vec![
            node(1, "useRest", "function", "a.js", 1),
            node(2, "E4.e4", "method", "a.js", 30),
        ];
        let files = vec![make_file(
            "a.js",
            10,
            vec![def("useRest", "function", 1, 10)],
            vec![call("e4", 5, Some("eerest"))],
            vec![type_map_entry("useRest::eerest", "E4", 0.85)],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            edges
                .iter()
                .any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected calls edge useRest → E4.e4 via rest-param key; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Bare (no-receiver) calls in JS/TS are module-scoped: `flush()` inside
    /// `Processor.run` must NOT resolve to `Processor.flush` (#1422 parity).
    #[test]
    fn bare_call_in_js_skips_same_class_fallback() {
        let all_nodes = vec![
            node(1, "Processor.run", "method", "proc.js", 10),
            node(2, "Processor.flush", "method", "proc.js", 30),
        ];
        let files = vec![make_file(
            "proc.js",
            10,
            vec![def("Processor.run", "method", 10, 20)],
            vec![call("flush", 15, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            !edges
                .iter()
                .any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "bare call must not resolve to same-class sibling in a module-scoped language"
        );
    }

    /// In class-scoped languages (e.g. C#), bare sibling calls DO resolve:
    /// `IsValidEmail()` inside `Validators.ValidateUser` → `Validators.IsValidEmail`.
    #[test]
    fn bare_call_in_class_scoped_language_resolves_sibling() {
        let all_nodes = vec![
            node(1, "Validators.ValidateUser", "method", "v.cs", 10),
            node(2, "Validators.IsValidEmail", "method", "v.cs", 30),
        ];
        let files = vec![make_file(
            "v.cs",
            10,
            vec![def("Validators.ValidateUser", "method", 10, 20)],
            vec![call("IsValidEmail", 15, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            edges
                .iter()
                .any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "bare sibling call must resolve in a class-scoped language; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// `self.area()` inside a namespace-qualified method `Geo.Shape.describe`
    /// must resolve via the bare class segment (`Shape.area`), not the full
    /// prefix (`Geo.Shape.area`) — symbols are stored under their bare class name.
    #[test]
    fn class_scoped_fallback_uses_segment_before_method() {
        let all_nodes = vec![
            node(1, "Geo.Shape.describe", "method", "s.py", 10),
            node(2, "Shape.area", "method", "s.py", 30),
        ];
        let files = vec![make_file(
            "s.py",
            10,
            vec![def("Geo.Shape.describe", "method", 10, 20)],
            vec![call("area", 15, Some("self"))],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            edges
                .iter()
                .any(|e| e.kind == "calls" && e.source_id == 1 && e.target_id == 2),
            "expected Geo.Shape.describe → Shape.area via bare class segment; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Issue #1863: several same-named object-literal `close() {}` methods
    /// scattered under sibling directories two levels below the caller all
    /// score the same 0.5 "grandparent proximity" confidence. A bare `close()`
    /// call must not fan out into a `calls` edge to every one of them — a
    /// genuine top-confidence tie is ambiguous and must resolve to nothing.
    #[test]
    fn global_fallback_tie_does_not_fan_out() {
        let all_nodes = vec![
            node(1, "caller", "function", "src/presentation/caller.ts", 3),
            node(2, "close", "method", "src/db/connection.ts", 10),
            node(3, "close", "method", "src/domain/target2.ts", 20),
            node(4, "close", "method", "src/features/target3.ts", 30),
        ];
        let files = vec![make_file(
            "src/presentation/caller.ts",
            10,
            vec![def("caller", "function", 3, 8)],
            vec![call("close", 5, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        assert!(
            !edges.iter().any(|e| e.kind == "calls" && e.source_id == 1),
            "ambiguous same-confidence candidates must not fan out into calls edges; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Companion to `global_fallback_tie_does_not_fan_out`: when one candidate
    /// has a strictly higher confidence than the rest, the clear single winner
    /// must still resolve — only genuine top-confidence ties are dropped.
    #[test]
    fn global_fallback_resolves_unambiguous_best_match() {
        let all_nodes = vec![
            node(1, "caller", "function", "src/presentation/caller.ts", 3),
            // Same directory as the caller → confidence 0.7, the clear winner.
            node(2, "close", "method", "src/presentation/sibling.ts", 10),
            // Two directories away → confidence 0.5, tied with each other but not with node 2.
            node(3, "close", "method", "src/domain/target2.ts", 20),
            node(4, "close", "method", "src/features/target3.ts", 30),
        ];
        let files = vec![make_file(
            "src/presentation/caller.ts",
            10,
            vec![def("caller", "function", 3, 8)],
            vec![call("close", 5, None)],
            vec![],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        let call_edges: Vec<_> = edges
            .iter()
            .filter(|e| e.kind == "calls" && e.source_id == 1)
            .collect();
        assert_eq!(
            call_edges.len(),
            1,
            "expected exactly one calls edge (the unambiguous best match); got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            call_edges[0].target_id, 2,
            "expected the same-directory candidate to win"
        );
    }

    /// Receiver-edge confidence must propagate the stored typeMap confidence
    /// (e.g. 0.85 from a pts property-write) instead of a flat 0.9 — mirrors
    /// `typeConfidence ?? (typeName ? 0.9 : 0.7)` in resolveReceiverEdge.
    #[test]
    fn receiver_edge_uses_stored_type_map_confidence() {
        let all_nodes = vec![
            node(1, "main", "function", "index.js", 3),
            node(2, "Calculator", "class", "utils.js", 1),
            node(3, "Calculator.compute", "method", "utils.js", 3),
        ];
        let files = vec![make_file(
            "index.js",
            10,
            vec![def("main", "function", 3, 8)],
            vec![call("compute", 7, Some("calc"))],
            vec![type_map_entry("calc", "Calculator", 0.85)],
            vec![],
        )];
        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );
        let re = edges
            .iter()
            .find(|e| e.kind == "receiver")
            .expect("receiver edge");
        assert!(
            (re.confidence - 0.85).abs() < 1e-9,
            "expected stored confidence 0.85, got {}",
            re.confidence
        );
    }

    /// When the receiver name is already a class (not a variable), the edge
    /// should still be emitted using the raw receiver name as lookup key.
    #[test]
    fn receiver_edge_direct_class_name() {
        let all_nodes = vec![
            node(1, "main", "function", "index.js", 1),
            node(2, "Calculator", "class", "utils.js", 1),
        ];

        let files = vec![make_file(
            "index.js",
            10,
            vec![def("main", "function", 1, 5)],
            vec![call("compute", 3, Some("Calculator"))],
            vec![], // no typeMap — receiver IS the class name
            vec![],
        )];

        let edges = build_call_edges(
            files,
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let receiver_edge = edges.iter().find(|e| e.kind == "receiver");
        assert!(
            receiver_edge.is_some(),
            "expected receiver edge for direct class-name receiver"
        );
        assert_eq!(receiver_edge.unwrap().target_id, 2);
    }

    // ── CHA typed-dispatch fallback (#1949) ─────────────────────────────────
    //
    // Reproduces the exact pattern isolated on this repo's own dogfooding
    // build: a caller holds a parameter typed as an interface (via typeMap)
    // declared many directories away (e.g. a shared `types.ts`), and calls a
    // method on it. The interface's own qualified method node fails the
    // proximity gate (`computeConfidence >= 0.5`) at that distance in BOTH
    // engines, but WASM's unconditional CHA post-pass still resolves the
    // call to the concrete implementing class's own method — native
    // previously had no equivalent and produced no edge at all.

    #[test]
    fn cha_typed_dispatch_fallback_resolves_distant_interface_implementation() {
        let all_nodes = vec![
            node(
                1,
                "main",
                "function",
                "src/domain/graph/builder/helpers.ts",
                1,
            ),
            node(
                2,
                "BetterSqlite3Database.prepare",
                "method",
                "src/types.ts",
                5,
            ),
            node(
                3,
                "NativeDbProxy",
                "class",
                "src/domain/graph/builder/native-db-proxy.ts",
                1,
            ),
            node(
                4,
                "NativeDbProxy.prepare",
                "method",
                "src/domain/graph/builder/native-db-proxy.ts",
                8,
            ),
        ];

        let caller_file = make_file(
            "src/domain/graph/builder/helpers.ts",
            10,
            vec![def("main", "function", 1, 10)],
            vec![call("prepare", 5, Some("db"))],
            // `db: BetterSqlite3Database` parameter — type-annotation confidence 0.9.
            vec![type_map_entry("db", "BetterSqlite3Database", 0.9)],
            vec![],
        );
        let impl_file = make_file(
            "src/domain/graph/builder/native-db-proxy.ts",
            20,
            vec![],
            vec![],
            // RTA evidence: `new NativeDbProxy(...)` somewhere — constructor confidence 1.0.
            vec![type_map_entry("proxy", "NativeDbProxy", 1.0)],
            vec![class_info(
                "NativeDbProxy",
                None,
                Some("BetterSqlite3Database"),
            )],
        );

        let edges = build_call_edges(
            vec![caller_file, impl_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        // The interface's own qualified method (id 2) must NOT receive an edge —
        // computeConfidence(helpers.ts, types.ts) is well below the 0.5 gate.
        let to_interface = edges.iter().any(|e| e.kind == "calls" && e.target_id == 2);
        assert!(
            !to_interface,
            "did not expect a calls edge to the interface method node"
        );

        // The concrete implementation's own method (id 4) must receive the edge instead.
        let to_impl = edges.iter().find(|e| e.kind == "calls" && e.target_id == 4);
        assert!(
            to_impl.is_some(),
            "expected a CHA-fallback calls edge to NativeDbProxy.prepare; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id, e.confidence))
                .collect::<Vec<_>>()
        );
        let edge = to_impl.unwrap();
        assert_eq!(edge.source_id, 1);
        assert!(
            (edge.confidence - CHA_TYPED_DISPATCH_CONFIDENCE).abs() < 1e-9,
            "expected flat CHA_TYPED_DISPATCH_CONFIDENCE ({}), got {}",
            CHA_TYPED_DISPATCH_CONFIDENCE,
            edge.confidence
        );
    }

    /// RTA must still filter out implementors that are never instantiated
    /// anywhere in the project — mirrors `resolveChaTargets`'s strict RTA gate
    /// in `cha.ts`. Same shape as the previous test, but with no
    /// constructor-confidence typeMap entry for `NativeDbProxy` anywhere.
    #[test]
    fn cha_typed_dispatch_fallback_respects_rta_filter() {
        let all_nodes = vec![
            node(
                1,
                "main",
                "function",
                "src/domain/graph/builder/helpers.ts",
                1,
            ),
            node(
                2,
                "BetterSqlite3Database.prepare",
                "method",
                "src/types.ts",
                5,
            ),
            node(
                3,
                "NativeDbProxy",
                "class",
                "src/domain/graph/builder/native-db-proxy.ts",
                1,
            ),
            node(
                4,
                "NativeDbProxy.prepare",
                "method",
                "src/domain/graph/builder/native-db-proxy.ts",
                8,
            ),
        ];

        let caller_file = make_file(
            "src/domain/graph/builder/helpers.ts",
            10,
            vec![def("main", "function", 1, 10)],
            vec![call("prepare", 5, Some("db"))],
            vec![type_map_entry("db", "BetterSqlite3Database", 0.9)],
            vec![],
        );
        let impl_file = make_file(
            "src/domain/graph/builder/native-db-proxy.ts",
            20,
            vec![],
            vec![],
            vec![], // no RTA evidence for NativeDbProxy anywhere
            vec![class_info(
                "NativeDbProxy",
                None,
                Some("BetterSqlite3Database"),
            )],
        );

        let edges = build_call_edges(
            vec![caller_file, impl_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let calls_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert!(
            calls_edges.is_empty(),
            "expected no calls edge when the implementor has no RTA evidence; got: {:?}",
            calls_edges
                .iter()
                .map(|e| (e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// #2348 root-type check, cross-file same-name collision (Greptile review
    /// on PR #2494): `src/domain/mod_a.ts` declares its OWN `Handler` class
    /// AND instantiates it (`new_expressions` contains `Handler`).
    /// `tests/unit/mod_b.ts` independently declares an UNRELATED `Handler`
    /// with no `method` of its own, and never instantiates it anywhere.
    /// Only mod_a's `Handler.method` exists under the bare qualified name
    /// "Handler.method" project-wide. `useHandler` (in mod_b.ts) calls
    /// `h.method()` on a parameter typed `Handler` — since mod_b.ts is far
    /// enough from mod_a.ts that the proximity-gated qualified lookup (tier
    /// 3, `typed`) rejects the cross-file match, resolution falls through to
    /// the CHA fallback this test is guarding. Before the file-scoped fix,
    /// the bare (project-wide) `cha_new_expression_types.contains("Handler")`
    /// would have been true purely because of mod_a's UNRELATED instance,
    /// wrongly admitting an edge to mod_a's `Handler.method` for a caller
    /// whose own (never-instantiated) `Handler` has nothing to do with it.
    #[test]
    fn resolve_cha_dispatch_root_check_does_not_leak_across_same_named_unrelated_classes() {
        let all_nodes = vec![
            node(1, "useHandler", "function", "tests/unit/mod_b.ts", 5),
            node(2, "Handler", "class", "src/domain/mod_a.ts", 1),
            node(3, "Handler.method", "method", "src/domain/mod_a.ts", 2),
            node(4, "Handler", "class", "tests/unit/mod_b.ts", 1),
        ];

        let mut mod_a = make_file(
            "src/domain/mod_a.ts",
            10,
            vec![def("Handler", "class", 1, 3)],
            vec![],
            vec![],
            vec![],
        );
        mod_a.new_expressions = Some(vec!["Handler".to_string()]);

        let mod_b = make_file(
            "tests/unit/mod_b.ts",
            20,
            vec![
                def("Handler", "class", 1, 2),
                def("useHandler", "function", 5, 8),
            ],
            vec![call("method", 6, Some("h"))],
            vec![type_map_entry("h", "Handler", 0.9)],
            vec![],
        );

        let edges = build_call_edges(
            vec![mod_a, mod_b],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let calls_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert!(
            calls_edges.iter().all(|e| e.target_id != 3),
            "expected no calls edge to mod_a's unrelated Handler.method; got: {:?}",
            calls_edges
                .iter()
                .map(|e| (e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// #2139: CHA dispatch is additive, not a last-resort fallback — when the
    /// interface's own qualified method already passes the proximity gate
    /// (tier 3, `typed`), the caller still ALSO gets a CHA-expanded edge to
    /// every instantiated concrete implementer (`emit_cha_dispatch_edges`,
    /// run unconditionally from `process_file`). This mirrors WASM's actual
    /// behavior exactly — `emitChaCallEdgesForCall` in build-edges.ts runs as
    /// an unconditional Step 6 regardless of what the earlier cascade
    /// resolved, verified empirically against `resolveViaRepo` in this same
    /// repo (both engines emit the direct `Repository.findNodeById` hit AND
    /// the three `{InMemory,Native,Sqlite}Repository.findNodeById` CHA
    /// edges). Before #2139 this test asserted the opposite (mutually
    /// exclusive) — that assumption was never actually WASM-parity-correct.
    #[test]
    fn cha_typed_dispatch_fallback_does_not_override_successful_proximity_lookup() {
        let all_nodes = vec![
            node(
                1,
                "main",
                "function",
                "src/domain/graph/builder/helpers.ts",
                1,
            ),
            node(
                2,
                "ILocal.run",
                "method",
                "src/domain/graph/builder/types.ts",
                5,
            ),
            node(
                3,
                "LocalImpl",
                "class",
                "src/domain/graph/builder/local-impl.ts",
                1,
            ),
            node(
                4,
                "LocalImpl.run",
                "method",
                "src/domain/graph/builder/local-impl.ts",
                8,
            ),
        ];

        let caller_file = make_file(
            "src/domain/graph/builder/helpers.ts",
            10,
            vec![def("main", "function", 1, 10)],
            vec![call("run", 5, Some("svc"))],
            vec![type_map_entry("svc", "ILocal", 0.9)],
            vec![],
        );
        let impl_file = make_file(
            "src/domain/graph/builder/local-impl.ts",
            20,
            vec![],
            vec![],
            vec![type_map_entry("impl", "LocalImpl", 1.0)],
            vec![class_info("LocalImpl", None, Some("ILocal"))],
        );

        let edges = build_call_edges(
            vec![caller_file, impl_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let calls_edges: Vec<_> = edges.iter().filter(|e| e.kind == "calls").collect();
        assert_eq!(
            calls_edges.len(),
            2,
            "expected both the direct interface hit AND the additive CHA-expanded edge; got: {:?}",
            calls_edges
                .iter()
                .map(|e| (e.source_id, e.target_id, e.confidence))
                .collect::<Vec<_>>()
        );

        let direct = calls_edges
            .iter()
            .find(|e| e.target_id == 2)
            .expect("expected the interface method (same-dir proximity hit)");
        assert!(
            (direct.confidence - CHA_TYPED_DISPATCH_CONFIDENCE).abs() > 1e-9,
            "expected proximity-based confidence on the direct hit, not the flat CHA_TYPED_DISPATCH_CONFIDENCE"
        );

        let cha = calls_edges
            .iter()
            .find(|e| e.target_id == 4)
            .expect("expected the additive CHA-expanded edge to LocalImpl.run");
        assert!(
            (cha.confidence - CHA_TYPED_DISPATCH_CONFIDENCE).abs() < 1e-9,
            "expected the flat CHA_TYPED_DISPATCH_CONFIDENCE on the CHA-expanded edge"
        );
    }

    /// BFS must transparently skip a non-instantiated abstract intermediate
    /// class to reach an instantiated concrete grandchild — mirrors
    /// `resolveChaTargets`'s multi-level hierarchy handling in `cha.ts`.
    #[test]
    fn cha_typed_dispatch_fallback_bfs_reaches_through_abstract_intermediate() {
        let all_nodes = vec![
            node(
                1,
                "main",
                "function",
                "src/domain/graph/builder/helpers.ts",
                1,
            ),
            node(2, "IWorker.doWork", "method", "src/types.ts", 5),
            node(
                3,
                "AbstractWorker",
                "class",
                "src/domain/graph/builder/worker-base.ts",
                1,
            ),
            node(
                4,
                "RealWorker",
                "class",
                "src/domain/graph/builder/real-worker.ts",
                1,
            ),
            node(
                5,
                "RealWorker.doWork",
                "method",
                "src/domain/graph/builder/real-worker.ts",
                8,
            ),
        ];

        let caller_file = make_file(
            "src/domain/graph/builder/helpers.ts",
            10,
            vec![def("main", "function", 1, 10)],
            vec![call("doWork", 5, Some("worker"))],
            vec![type_map_entry("worker", "IWorker", 0.9)],
            vec![],
        );
        // AbstractWorker implements IWorker but is never itself instantiated.
        let base_file = make_file(
            "src/domain/graph/builder/worker-base.ts",
            20,
            vec![],
            vec![],
            vec![],
            vec![class_info("AbstractWorker", None, Some("IWorker"))],
        );
        // RealWorker extends AbstractWorker and IS instantiated.
        let real_file = make_file(
            "src/domain/graph/builder/real-worker.ts",
            30,
            vec![],
            vec![],
            vec![type_map_entry("w", "RealWorker", 1.0)],
            vec![class_info("RealWorker", Some("AbstractWorker"), None)],
        );

        let edges = build_call_edges(
            vec![caller_file, base_file, real_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let to_real = edges.iter().find(|e| e.kind == "calls" && e.target_id == 5);
        assert!(
            to_real.is_some(),
            "expected BFS to reach RealWorker.doWork through the non-instantiated AbstractWorker; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    // ── CHA implementor collision + inherited-method walk (issue #2237) ────

    /// Two files each declare their own UNRELATED `Handler` interface + a
    /// concrete implementer of the same name pattern — dispatching from the
    /// caller's own file must reach only its own co-located implementer, not
    /// the other file's unrelated same-named `Handler`'s implementer.
    #[test]
    fn cha_dispatch_does_not_merge_two_unrelated_same_named_interfaces() {
        let all_nodes = vec![
            node(1, "main", "function", "src/mod1/caller.ts", 1),
            node(2, "HandlerA.run", "method", "src/mod1/caller.ts", 5),
            node(3, "HandlerB.run", "method", "src/mod2/other.ts", 5),
        ];

        let caller_file = make_file(
            "src/mod1/caller.ts",
            10,
            // `Handler` (a bare interface with no heritage of its own) must
            // still appear in `definitions` — mirrors real extraction, where
            // `classes` only lists RELATIONS (entries with extends/implements),
            // never a plain interface/class declaration on its own (#2237).
            vec![
                def("main", "function", 1, 10),
                def("Handler", "interface", 2, 2),
            ],
            vec![call("run", 3, Some("h"))],
            vec![
                type_map_entry("h", "Handler", 0.9),
                type_map_entry("a", "HandlerA", 1.0),
            ],
            vec![class_info("HandlerA", None, Some("Handler"))],
        );
        let other_file = make_file(
            "src/mod2/other.ts",
            20,
            vec![def("Handler", "interface", 2, 2)],
            vec![],
            vec![type_map_entry("b", "HandlerB", 1.0)],
            vec![class_info("HandlerB", None, Some("Handler"))],
        );

        let edges = build_call_edges(
            vec![caller_file, other_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let to_a = edges.iter().any(|e| e.kind == "calls" && e.target_id == 2);
        let to_b = edges.iter().any(|e| e.kind == "calls" && e.target_id == 3);
        assert!(
            to_a,
            "expected a calls edge to HandlerA.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert!(
            !to_b,
            "did not expect a calls edge to the unrelated file's HandlerB.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// An instantiated concrete class that inherits the dispatched method
    /// from an ancestor without overriding it must still resolve to that
    /// ancestor's declaration — a direct qualified lookup on the concrete
    /// class alone would miss entirely.
    #[test]
    fn cha_dispatch_walks_up_to_declaring_ancestor_for_inherited_method() {
        let all_nodes = vec![
            node(1, "main", "function", "src/caller.ts", 1),
            node(2, "AbstractHandler.run", "method", "src/abstract.ts", 3),
        ];

        let caller_file = make_file(
            "src/caller.ts",
            10,
            vec![def("main", "function", 1, 10)],
            vec![call("run", 3, Some("h"))],
            vec![type_map_entry("h", "IHandler", 0.9)],
            vec![class_info("IHandler", None, None)],
        );
        let abstract_file = make_file(
            "src/abstract.ts",
            20,
            vec![],
            vec![],
            vec![],
            vec![class_info("AbstractHandler", None, Some("IHandler"))],
        );
        let concrete_file = make_file(
            "src/concrete.ts",
            30,
            vec![],
            vec![],
            // Only ConcreteHandler is instantiated — AbstractHandler never is.
            vec![type_map_entry("c", "ConcreteHandler", 1.0)],
            vec![class_info("ConcreteHandler", Some("AbstractHandler"), None)],
        );

        let edges = build_call_edges(
            vec![caller_file, abstract_file, concrete_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let to_abstract = edges.iter().find(|e| e.kind == "calls" && e.target_id == 2);
        assert!(
            to_abstract.is_some(),
            "expected the inherited method walk to reach AbstractHandler.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Greptile review finding on PR #2399: both file1 and file2
    /// independently declare their own HandlerA implementing their own
    /// (unrelated) Handler interface, each with its own `run` method.
    /// Scoping the root to file1 must also carry that file identity into
    /// the qualified-method lookup — otherwise `nodes_by_name["HandlerA.run"]`
    /// returns both files' methods.
    #[test]
    fn cha_dispatch_preserves_file_identity_through_method_lookup() {
        let all_nodes = vec![
            node(1, "main", "function", "src/mod1/caller.ts", 1),
            node(2, "HandlerA.run", "method", "src/mod1/caller.ts", 5),
            node(3, "HandlerA.run", "method", "src/mod2/other.ts", 5),
        ];

        let caller_file = make_file(
            "src/mod1/caller.ts",
            10,
            vec![
                def("main", "function", 1, 10),
                def("Handler", "interface", 2, 2),
            ],
            vec![call("run", 3, Some("h"))],
            vec![
                type_map_entry("h", "Handler", 0.9),
                type_map_entry("a", "HandlerA", 1.0),
            ],
            vec![class_info("HandlerA", None, Some("Handler"))],
        );
        let other_file = make_file(
            "src/mod2/other.ts",
            20,
            vec![def("Handler", "interface", 2, 2)],
            vec![],
            vec![type_map_entry("a2", "HandlerA", 1.0)],
            vec![class_info("HandlerA", None, Some("Handler"))],
        );

        let edges = build_call_edges(
            vec![caller_file, other_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let to_own = edges.iter().any(|e| e.kind == "calls" && e.target_id == 2);
        let to_other = edges.iter().any(|e| e.kind == "calls" && e.target_id == 3);
        assert!(
            to_own,
            "expected a calls edge to mod1's own HandlerA.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert!(
            !to_other,
            "did not expect a calls edge to the unrelated file's HandlerA.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
    }

    /// Greptile review finding on PR #2399: file1's ConcreteHandler extends
    /// RealBase; an unrelated file2 also declares its own ConcreteHandler
    /// extending a different OtherBase, recorded FIRST (file2 appears before
    /// file1 in the input vec) so the bare `parents` map's first-write-wins
    /// entry deliberately points the wrong way. The file-scoped
    /// `parents_by_file` entry for file1 must still win.
    #[test]
    fn cha_dispatch_preserves_file_identity_through_ancestor_walk() {
        let all_nodes = vec![
            node(1, "main", "function", "src/mod1/caller.ts", 1),
            node(2, "RealBase.run", "method", "src/mod1/base.ts", 3),
            node(3, "OtherBase.run", "method", "src/mod2/other.ts", 3),
        ];

        // Recorded FIRST so the bare (first-write-wins) `parents` map's
        // ConcreteHandler entry deliberately points the wrong way.
        let other_file = make_file(
            "src/mod2/other.ts",
            20,
            vec![],
            vec![],
            vec![],
            vec![class_info("ConcreteHandler", Some("OtherBase"), None)],
        );
        // file1's OWN ConcreteHandler: implements Handler (reachable from the
        // BFS root) AND extends RealBase (its real ancestor) — a single
        // declaration, exactly as real extraction would record it.
        let caller_file = make_file(
            "src/mod1/caller.ts",
            10,
            vec![
                def("main", "function", 1, 10),
                def("Handler", "interface", 2, 2),
            ],
            vec![call("run", 3, Some("h"))],
            vec![
                type_map_entry("h", "Handler", 0.9),
                type_map_entry("c", "ConcreteHandler", 1.0),
            ],
            vec![class_info(
                "ConcreteHandler",
                Some("RealBase"),
                Some("Handler"),
            )],
        );

        let edges = build_call_edges(
            vec![other_file, caller_file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let to_real = edges.iter().any(|e| e.kind == "calls" && e.target_id == 2);
        let to_wrong = edges.iter().any(|e| e.kind == "calls" && e.target_id == 3);
        assert!(
            to_real,
            "expected the ancestor walk to reach file1's own RealBase.run; got: {:?}",
            edges
                .iter()
                .map(|e| (&e.kind, e.source_id, e.target_id))
                .collect::<Vec<_>>()
        );
        assert!(
            !to_wrong,
            "did not expect the ancestor walk to cross into the unrelated file's OtherBase.run; got: {:?}",
            edges.iter().map(|e| (&e.kind, e.source_id, e.target_id)).collect::<Vec<_>>()
        );
    }

    // ── Points-to constraint solver (parity with buildPointsToMap) ──────────

    fn def_with_params(name: &str, line: u32, end_line: u32, params: &[&str]) -> DefInfo {
        DefInfo {
            name: name.to_string(),
            kind: "function".to_string(),
            line,
            end_line: Some(end_line),
            params: Some(params.iter().map(|s| s.to_string()).collect()),
        }
    }

    /// `hof(target)` + `cb()` inside `hof(cb)` must emit hof→target via the
    /// param-flow constraint `hof::cb ⊇ target`.
    #[test]
    fn pts_param_flow_resolves_callback_through_parameter() {
        let all_nodes = vec![
            node(1, "hof", "function", "lib.js", 1),
            node(2, "target", "function", "lib.js", 5),
            node(3, "main", "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![
                def_with_params("hof", 1, 3, &["cb"]),
                def("target", "function", 5, 6),
                def("main", "function", 8, 10),
            ],
            vec![call("cb", 2, None), call("hof", 9, None)],
            vec![],
            vec![],
        );
        file.param_bindings = Some(vec![ParamBinding {
            callee: "hof".to_string(),
            arg_index: 0,
            arg_name: "target".to_string(),
        }]);

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge hof→target; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 3 && e.target_id == 1 && e.kind == "calls"),
            "expected direct edge main→hof; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
    }

    /// #1996: an alias/points-to-resolved call edge must carry the
    /// engine-agnostic `technique: "points-to"` label at insert time — not
    /// left untagged for the generic `'ts-native'` backfill to swallow, which
    /// would make it indistinguishable from a direct-resolution edge (unlike
    /// the WASM/JS inline path, which already tags this case 'points-to').
    #[test]
    fn pts_alias_edge_is_tagged_points_to_technique() {
        let all_nodes = vec![
            node(1, "hof", "function", "lib.js", 1),
            node(2, "target", "function", "lib.js", 5),
            node(3, "main", "function", "lib.js", 8),
        ];
        let file = {
            let mut f = make_file(
                "lib.js",
                10,
                vec![
                    def_with_params("hof", 1, 3, &["cb"]),
                    def("target", "function", 5, 6),
                    def("main", "function", 8, 10),
                ],
                vec![call("cb", 2, None), call("hof", 9, None)],
                vec![],
                vec![],
            );
            f.param_bindings = Some(vec![ParamBinding {
                callee: "hof".to_string(),
                arg_index: 0,
                arg_name: "target".to_string(),
            }]);
            f
        };

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let pts_edge = edges
            .iter()
            .find(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls")
            .expect("expected pts edge hof→target");
        assert_eq!(
            pts_edge.technique.as_deref(),
            Some("points-to"),
            "pts-resolved edge must be tagged 'points-to', got {:?}",
            pts_edge.technique
        );
    }

    /// #1996: when a direct call to the same target the pts fallback already
    /// resolved is also present, the pts edge's technique must be relabeled
    /// 'ts-native' in place (the direct resolution supersedes the alias
    /// resolution), mirroring the WASM/JS `ptsEdgeRows` upgrade path exactly.
    #[test]
    fn pts_alias_edge_technique_upgraded_to_ts_native_on_direct_call() {
        let all_nodes = vec![
            node(1, "hof", "function", "lib.js", 1),
            node(2, "target", "function", "lib.js", 6),
            node(3, "main", "function", "lib.js", 9),
        ];
        let file = {
            let mut f = make_file(
                "lib.js",
                11,
                vec![
                    def_with_params("hof", 1, 4, &["cb"]),
                    def("target", "function", 6, 7),
                    def("main", "function", 9, 11),
                ],
                vec![
                    // pts fallback: cb() resolves to target via the param binding.
                    call("cb", 2, None),
                    // Direct call to the same target from within hof — must
                    // upgrade the pts edge's technique from 'points-to' to
                    // 'ts-native' in place rather than inserting a duplicate.
                    call("target", 3, None),
                    call("hof", 10, None),
                ],
                vec![],
                vec![],
            );
            f.param_bindings = Some(vec![ParamBinding {
                callee: "hof".to_string(),
                arg_index: 0,
                arg_name: "target".to_string(),
            }]);
            f
        };

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        let hof_to_target: Vec<_> = edges
            .iter()
            .filter(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls")
            .collect();
        assert_eq!(
            hof_to_target.len(),
            1,
            "expected exactly one hof→target edge (upgraded in place, not duplicated); got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind, &e.technique))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            hof_to_target[0].technique.as_deref(),
            Some("ts-native"),
            "direct call must upgrade the pts edge's technique to 'ts-native', got {:?}",
            hof_to_target[0].technique
        );
    }

    /// `invoker.call(handler, 10)` + `this()` inside `invoker` must emit
    /// invoker→handler via the thisCallBinding conversion `invoker::this ⊇ handler`.
    #[test]
    fn pts_this_call_binding_resolves_this_invocation() {
        let all_nodes = vec![
            node(1, "invoker", "function", "lib.js", 1),
            node(2, "handler", "function", "lib.js", 5),
            node(3, "runCallThis", "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![
                def("invoker", "function", 1, 3),
                def("handler", "function", 5, 6),
                def("runCallThis", "function", 8, 10),
            ],
            vec![
                // this() inside invoker
                call("this", 2, None),
                // invoker.call(handler, 10) — extractor emits dynamic call to invoker
                CallInfo {
                    name: "invoker".to_string(),
                    line: 9,
                    dynamic: Some(true),
                    receiver: None,
                    dynamic_kind: None,
                    key_expr: None,
                    accessor_read: None,
                    object_literal_site: None,
                },
            ],
            vec![],
            vec![],
        );
        file.this_call_bindings = Some(vec![ThisCallBinding {
            callee: "invoker".to_string(),
            this_arg: "handler".to_string(),
        }]);

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge invoker→handler; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 3 && e.target_id == 1 && e.kind == "calls"),
            "expected direct edge runCallThis→invoker; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
    }

    /// for-of over a function array: `for (const cb of arr) cb()` must emit
    /// iterPlain→forOf1 and iterPlain→forOf2 through the wildcard constraint
    /// `iterPlain::cb ⊇ arr[*]`.
    #[test]
    fn pts_for_of_over_array_elements_resolves_all_elements() {
        let all_nodes = vec![
            node(1, "forOf1", "function", "for-of.js", 1),
            node(2, "forOf2", "function", "for-of.js", 3),
            node(3, "iterPlain", "function", "for-of.js", 6),
        ];
        let mut file = make_file(
            "for-of.js",
            10,
            vec![
                def("forOf1", "function", 1, 2),
                def("forOf2", "function", 3, 4),
                def("iterPlain", "function", 6, 9),
            ],
            vec![call("cb", 8, None)],
            vec![],
            vec![],
        );
        file.array_elem_bindings = Some(vec![
            ArrayElemBinding {
                array_name: "arr".to_string(),
                index: 0,
                elem_name: "forOf1".to_string(),
            },
            ArrayElemBinding {
                array_name: "arr".to_string(),
                index: 1,
                elem_name: "forOf2".to_string(),
            },
        ]);
        file.for_of_bindings = Some(vec![ForOfBinding {
            var_name: "cb".to_string(),
            source_name: "arr".to_string(),
            enclosing_func: "iterPlain".to_string(),
        }]);

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        for target in [1u32, 2u32] {
            assert!(
                edges
                    .iter()
                    .any(|e| e.source_id == 3 && e.target_id == target && e.kind == "calls"),
                "expected pts edge iterPlain→node{}; got: {:?}",
                target,
                edges
                    .iter()
                    .map(|e| (e.source_id, e.target_id, &e.kind))
                    .collect::<Vec<_>>()
            );
        }
    }

    /// Object-rest dispatch: `f3(obj)` where `obj = {{ e4 }}` and `f3({{...rest}})`
    /// calls `rest.e4()` — resolves via the seeded pts key `rest.e4`.
    #[test]
    fn pts_object_rest_receiver_call_resolves_via_seeded_prop() {
        let all_nodes = vec![
            node(1, "f3", "function", "lib.js", 1),
            node(2, "e4", "function", "other.js", 1),
            node(3, "main", "function", "lib.js", 8),
        ];
        let mut file = make_file(
            "lib.js",
            10,
            vec![def("f3", "function", 1, 3), def("main", "function", 8, 10)],
            vec![
                // eerest.e4() inside f3
                CallInfo {
                    name: "e4".to_string(),
                    line: 2,
                    dynamic: None,
                    receiver: Some("eerest".to_string()),
                    dynamic_kind: None,
                    key_expr: None,
                    accessor_read: None,
                    object_literal_site: None,
                },
                call("f3", 9, None),
            ],
            vec![],
            vec![],
        );
        file.imported_names = vec![ImportedName {
            name: "e4".to_string(),
            file: "other.js".to_string(),
            imported: None,
            namespace: None,
        }];
        file.param_bindings = Some(vec![ParamBinding {
            callee: "f3".to_string(),
            arg_index: 0,
            arg_name: "obj".to_string(),
        }]);
        file.object_rest_param_bindings = Some(vec![ObjectRestParamBinding {
            callee: "f3".to_string(),
            rest_name: "eerest".to_string(),
            arg_index: 0,
        }]);
        file.object_prop_bindings = Some(vec![ObjectPropBinding {
            object_name: "obj".to_string(),
            prop_name: "e4".to_string(),
            value_name: "e4".to_string(),
        }]);

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge f3→e4 via rest receiver; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
    }

    /// Spread dispatch: `callAll(...fns)` with `fns = [x, y]` flows the array
    /// elements into callAll's parameters positionally.
    #[test]
    fn pts_spread_args_flow_array_elements_into_params() {
        let all_nodes = vec![
            node(1, "callAll", "function", "spread.js", 1),
            node(2, "x", "function", "spread.js", 5),
            node(3, "y", "function", "spread.js", 6),
            node(4, "main", "function", "spread.js", 8),
        ];
        let mut file = make_file(
            "spread.js",
            10,
            vec![
                def_with_params("callAll", 1, 3, &["a", "b"]),
                def("x", "function", 5, 5),
                def("y", "function", 6, 6),
                def("main", "function", 8, 10),
            ],
            vec![
                call("a", 2, None),
                call("b", 2, None),
                call("callAll", 9, None),
            ],
            vec![],
            vec![],
        );
        file.array_elem_bindings = Some(vec![
            ArrayElemBinding {
                array_name: "fns".to_string(),
                index: 0,
                elem_name: "x".to_string(),
            },
            ArrayElemBinding {
                array_name: "fns".to_string(),
                index: 1,
                elem_name: "y".to_string(),
            },
        ]);
        file.spread_arg_bindings = Some(vec![SpreadArgBinding {
            callee: "callAll".to_string(),
            array_name: "fns".to_string(),
            start_index: 0,
        }]);

        let edges = build_call_edges(
            vec![file],
            all_nodes,
            vec![],
            MAX_SOLVER_ITERATIONS,
            None,
            None,
            None,
        );

        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 1 && e.target_id == 2 && e.kind == "calls"),
            "expected pts edge callAll→x; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
        assert!(
            edges
                .iter()
                .any(|e| e.source_id == 1 && e.target_id == 3 && e.kind == "calls"),
            "expected pts edge callAll→y; got: {:?}",
            edges
                .iter()
                .map(|e| (e.source_id, e.target_id, &e.kind))
                .collect::<Vec<_>>()
        );
    }

    /// Regression for issue #1753: the points-to solver's fixed-point loop must
    /// honor the caller-supplied `max_iterations` rather than a hardcoded value.
    /// Mirrors the equivalent TS-side test in `tests/unit/points-to.test.ts`.
    ///
    /// Builds an 8-hop alias chain `a0=a1, a1=a2, ..., a6=a7, a7=handler` in this
    /// exact (declaration) order. `build_points_to_map` processes constraints in
    /// array order each pass, so a single hop propagates per iteration, moving
    /// from the tail of the array backward to the front — resolving `a0`
    /// requires exactly `chain_len` (8) iterations.
    #[test]
    fn max_iterations_caps_alias_chain_convergence() {
        let chain_len: u32 = 8;
        let mut fn_ref_bindings: Vec<FnRefBinding> = (0..chain_len - 1)
            .map(|i| FnRefBinding {
                lhs: format!("a{i}"),
                rhs: format!("a{}", i + 1),
                rhs_receiver: None,
            })
            .collect();
        fn_ref_bindings.push(FnRefBinding {
            lhs: format!("a{}", chain_len - 1),
            rhs: "handler".to_string(),
            rhs_receiver: None,
        });

        let def_names: HashSet<&str> = ["handler"].into_iter().collect();
        let imported_names: HashMap<&str, &str> = HashMap::new();
        let definition_params: HashMap<&str, Vec<&str>> = HashMap::new();
        let bindings = PtsBindings {
            fn_ref_bindings: &fn_ref_bindings,
            param_bindings: &[],
            array_elem_bindings: &[],
            spread_arg_bindings: &[],
            for_of_bindings: &[],
            array_callback_bindings: &[],
            object_rest_param_bindings: &[],
            object_prop_bindings: &[],
        };

        // A cap well below the chain length must not converge for a0.
        let pts_low = build_points_to_map(
            &bindings,
            &def_names,
            &imported_names,
            &definition_params,
            3,
            "",
            &[],
            &[],
        );
        assert!(
            resolve_via_points_to("a0", &pts_low).is_empty(),
            "expected a0 to NOT resolve with max_iterations=3 (chain needs {chain_len})"
        );

        // A cap at the chain length must fully converge for a0.
        let pts_high = build_points_to_map(
            &bindings,
            &def_names,
            &imported_names,
            &definition_params,
            chain_len,
            "",
            &[],
            &[],
        );
        assert_eq!(
            resolve_via_points_to("a0", &pts_high),
            vec!["handler"],
            "expected a0 to resolve to handler with max_iterations={chain_len}"
        );
    }
}

#[cfg(test)]
mod inline_new_type_tests {
    use super::extract_inline_new_type;

    #[test]
    fn parens_new_uppercase() {
        assert_eq!(
            extract_inline_new_type("(new Foo)"),
            Some("Foo".to_string())
        );
    }

    #[test]
    fn parens_new_with_args() {
        // (new Foo('arg')) — parens and constructor args
        assert_eq!(
            extract_inline_new_type("(new Foo('arg'))"),
            Some("Foo".to_string())
        );
    }

    #[test]
    fn no_parens_new_uppercase() {
        assert_eq!(extract_inline_new_type("new Bar"), Some("Bar".to_string()));
    }

    #[test]
    fn underscore_prefix_accepted() {
        assert_eq!(
            extract_inline_new_type("new _Factory"),
            Some("_Factory".to_string())
        );
    }

    #[test]
    fn dollar_prefix_accepted() {
        assert_eq!(
            extract_inline_new_type("new $Service"),
            Some("$Service".to_string())
        );
    }

    #[test]
    fn lowercase_constructor_rejected() {
        // `new foo()` — lowercase, should return None to avoid false positives
        assert_eq!(extract_inline_new_type("new foo"), None);
    }

    #[test]
    fn not_a_new_expression() {
        // plain receiver name — no `new` keyword
        assert_eq!(extract_inline_new_type("myVar"), None);
    }

    #[test]
    fn new_without_whitespace_is_not_new_keyword() {
        // `newFoo` — not a `new` keyword, just an identifier
        assert_eq!(extract_inline_new_type("newFoo"), None);
    }
}
