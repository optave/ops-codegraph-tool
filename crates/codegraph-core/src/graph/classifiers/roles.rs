//! Native role classification via rusqlite.
//!
//! Replaces the JS `classifyNodeRolesFull` / `classifyNodeRolesIncremental`
//! functions: runs fan-in/fan-out queries, computes medians, classifies roles,
//! and batch-updates nodes — all in a single Rust function with one DB
//! connection, eliminating JS<->SQLite round-trips.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::Connection;

// ── Constants ────────────────────────────────────────────────────────

const FRAMEWORK_ENTRY_PREFIXES: &[&str] = &["route:", "event:", "command:"];

const LEAF_KINDS: &[&str] = &["parameter", "property", "constant"];

/// Type definition kinds consumed via type annotations and struct literals, not calls.
/// These never get inbound call edges by design — no call edge is emitted for type usage.
/// If the same file has active callables, these types are almost certainly live.
const TYPE_DEF_KINDS: &[&str] = &["struct", "enum", "trait", "type", "interface", "record"];

/// All kinds that are consumed via references or type-annotations rather than call edges.
/// Equals `TYPE_DEF_KINDS` ∪ `{"constant"}`.
/// Used by `compute_active_files` to exclude annotation-only nodes when deciding whether
/// a file has any actively-called symbols — mirrors `ANNOTATION_ONLY_KINDS` in the TS classifier.
const ANNOTATION_ONLY_KINDS: &[&str] =
    &["constant", "struct", "enum", "trait", "type", "interface", "record"];

/// Path patterns indicating framework-dispatched entry points (matches JS
/// `ENTRY_PATH_PATTERNS` in `graph/classifiers/roles.ts`).
const ENTRY_PATH_PATTERNS: &[&str] = &[
    "cli/commands/",
    "cli\\commands\\",
    "mcp/",
    "mcp\\",
    "routes/",
    "routes\\",
    "route/",
    "route\\",
    "handlers/",
    "handlers\\",
    "handler/",
    "handler\\",
    "middleware/",
    "middleware\\",
];

/// Well-known Commander.js dispatch method names.
/// When a method with one of these names lives in a file matching
/// ENTRY_PATH_PATTERNS it is the actual framework entry point — not merely a
/// candidate — so it is classified as `entry` rather than `dead-entry`.
/// Mirrors `COMMANDER_DISPATCH_NAMES` in `graph/classifiers/roles.ts`.
const COMMANDER_DISPATCH_NAMES: &[&str] = &["execute", "validate"];

const TEST_FILE_PATTERNS: &[&str] = &[
    "%.test.%",
    "%.spec.%",
    "%__test__%",
    "%__tests__%",
    "%.stories.%",
];

// ── Output types ─────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct RoleSummary {
    pub entry: u32,
    pub core: u32,
    pub utility: u32,
    pub adapter: u32,
    pub dead: u32,
    #[napi(js_name = "deadLeaf")]
    pub dead_leaf: u32,
    #[napi(js_name = "deadEntry")]
    pub dead_entry: u32,
    #[napi(js_name = "deadFfi")]
    pub dead_ffi: u32,
    #[napi(js_name = "deadUnresolved")]
    pub dead_unresolved: u32,
    #[napi(js_name = "testOnly")]
    pub test_only: u32,
    pub leaf: u32,
}

// ── Public napi entry points ─────────────────────────────────────────

// NOTE: The standalone `classify_roles_full` and `classify_roles_incremental`
// napi exports were removed in Phase 6.17. All callers now use the corresponding
// NativeDatabase methods which reuse the persistent connection, eliminating the
// double-connection antipattern.

// ── Shared helpers ───────────────────────────────────────────────────

fn median(sorted: &[u32]) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0
    } else {
        sorted[mid] as f64
    }
}

/// Compute, per file, the set of symbol names that are `TYPE_DEF_KINDS`-kind
/// declarations (interface/type/struct/enum/trait/record). Mirrors JS
/// `computeTypeDefNamesByFile` in `graph/classifiers/roles.ts`.
fn compute_type_def_names_by_file(
    rows: &[(i64, String, String, String, u32, u32)],
) -> HashMap<String, std::collections::HashSet<String>> {
    let mut by_file: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for (_id, name, kind, file, _fan_in, _fan_out) in rows {
        if TYPE_DEF_KINDS.iter().any(|k| *k == kind.as_str()) {
            by_file
                .entry(file.clone())
                .or_default()
                .insert(name.clone());
        }
    }
    by_file
}

/// True when `name`/`kind` is a `method`/`property` member of an interface/type
/// declared in the same file — e.g. TS `interface Foo { bar: string }` extracts
/// `bar` as a top-level `method`-kind definition named `Foo.bar` (#1723). Every
/// language extractor qualifies interface/type members as `Owner.member`
/// (mirroring class method qualification), so the owner name is recovered from
/// the prefix before the first `.` and looked up against same-file
/// `TYPE_DEF_KINDS` declarations. Class methods use the identical `Owner.member`
/// convention but are unaffected here because `class` is not in `TYPE_DEF_KINDS`
/// — they remain subject to normal dead-code detection.
///
/// These members can never gain inbound call edges by construction, so a
/// `fan_in == 0` reading carries zero dead-code signal for them, unlike a real
/// function/method where it does. Mirrors JS `isTypeDeclarationMember`.
fn is_type_declaration_member(
    name: &str,
    kind: &str,
    file: &str,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
) -> bool {
    if kind != "method" && kind != "property" {
        return false;
    }
    let Some(dot_idx) = name.find('.') else {
        return false;
    };
    let owner_name = &name[..dot_idx];
    type_def_names_by_file
        .get(file)
        .is_some_and(|names| names.contains(owner_name))
}

/// Dead sub-role classification matching JS `classifyDeadSubRole`.
fn classify_dead_sub_role(_name: &str, kind: &str, file: &str) -> &'static str {
    // Leaf kinds
    if LEAF_KINDS.iter().any(|k| *k == kind) {
        return "dead-leaf";
    }
    // FFI boundary (checked before dead-entry — an FFI boundary is a more
    // fundamental classification than a path-based hint, matching JS priority)
    let ffi_exts = [".rs", ".c", ".cpp", ".h", ".go", ".java", ".cs"];
    if ffi_exts.iter().any(|ext| file.ends_with(ext)) {
        return "dead-ffi";
    }
    // Framework-dispatched entry points (CLI commands, MCP tools, routes)
    if ENTRY_PATH_PATTERNS.iter().any(|p| file.contains(p)) {
        return "dead-entry";
    }
    "dead-unresolved"
}

/// Classify a single node into a role.
#[allow(clippy::too_many_arguments)]
fn classify_node(
    name: &str,
    kind: &str,
    file: &str,
    fan_in: u32,
    fan_out: u32,
    is_exported: bool,
    production_fan_in: u32,
    has_active_file_siblings: bool,
    is_type_member: bool,
    median_fan_in: f64,
    median_fan_out: f64,
) -> &'static str {
    // Interface/type members (#1723) — never subject to call-graph dead-code
    // detection, regardless of fan-in/fan-out/export status.
    if is_type_member {
        return "leaf";
    }

    // Framework entry
    if FRAMEWORK_ENTRY_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return "entry";
    }

    if fan_in == 0 && !is_exported {
        // Well-known Commander.js dispatch methods (execute, validate) in framework
        // directories are confirmed entry points, not candidates. Promote them to
        // `entry` so they don't appear in `--role dead` output.
        if COMMANDER_DISPATCH_NAMES.iter().any(|n| *n == name)
            && ENTRY_PATH_PATTERNS.iter().any(|p| file.contains(p))
        {
            return "entry";
        }
        if has_active_file_siblings {
            // Constants consumed via identifier reference (not calls) have no
            // inbound call edges. If the same file has active callables, the
            // constant is almost certainly used locally — classify as leaf.
            if kind == "constant" {
                return "leaf";
            }
            // Type definitions (struct, enum, trait, type, interface, record) are
            // consumed via type annotations and struct literals — not calls — so they
            // never get inbound call edges. If the same file has active callables,
            // these types are almost certainly live — classify as leaf.
            if TYPE_DEF_KINDS.iter().any(|k| *k == kind) {
                return "leaf";
            }
            // Methods implementing interfaces are dispatched via conditional property
            // access e.g. `if (v.enterFunction) v.enterFunction(...)`. Codegraph
            // resolves the call to the property accessor rather than to the concrete
            // method implementation, so the method has no inbound call edge. We
            // require `fan_out > 0` as evidence of non-triviality, mirroring the
            // function case — trivially-inert dead helper methods remain visible.
            if kind == "method" && fan_out > 0 {
                return "leaf";
            }
            // Functions referenced as logical-or fallback defaults — e.g.
            // `const fn = options._fetchLatest || fetchLatestVersion` — appear as
            // value references, not call sites, so no call edge is produced. We
            // require `fan_out > 0` as evidence that the function is non-trivial
            // (i.e. it calls something), ruling out truly inert dead helpers.
            //
            // NOTE (#1771): this used to also be the only thing rescuing functions
            // referenced as object-literal property values (dispatch tables, e.g.
            // `{ resolve: someFunction }`) — and only by coincidence, for whichever
            // of those functions happened to have fan_out > 0 themselves. That
            // pattern now gets a real `calls` edge (dynamic_kind "value-ref") at
            // extraction time, so it no longer depends on this heuristic. Kept
            // here as a fallback for value-reference shapes that still produce no
            // edge at all — the logical-or default above, and others (ternary
            // defaults, array-of-functions elements, default parameter values)
            // that aren't extracted as edges yet.
            if kind == "function" && fan_out > 0 {
                return "leaf";
            }
        }
        return classify_dead_sub_role(name, kind, file);
    }

    if fan_in == 0 && is_exported {
        // Exported, zero fan-in. A genuine entry point (CLI command handler,
        // exported API function called from outside the codebase, ESM loader
        // hook, MCP tool handler, etc.) is always a function or method. Every
        // other exported kind (interface/type/constant/class) is a live,
        // intentional part of the public surface — but a data shape or config
        // value, not something invoked from outside the codebase — so it's
        // `leaf`: never `dead-*` (#1583) and never `entry` (#1780), regardless
        // of whether the file has other active siblings. Mirrors JS
        // `classifyNodeRole`.
        return if kind == "function" || kind == "method" {
            "entry"
        } else {
            "leaf"
        };
    }

    // Test-only: has callers but all are in test files
    if fan_in > 0 && production_fan_in == 0 && !is_exported {
        return "test-only";
    }

    let high_in = fan_in as f64 >= median_fan_in && fan_in > 0;
    let high_out = fan_out as f64 >= median_fan_out && fan_out > 0;

    if high_in && !high_out {
        "core"
    } else if high_in && high_out {
        "utility"
    } else if !high_in && high_out {
        "adapter"
    } else {
        "leaf"
    }
}

fn increment_summary(summary: &mut RoleSummary, role: &str) {
    match role {
        "entry" => summary.entry += 1,
        "core" => summary.core += 1,
        "utility" => summary.utility += 1,
        "adapter" => summary.adapter += 1,
        "leaf" => summary.leaf += 1,
        "test-only" => summary.test_only += 1,
        "dead-leaf" => {
            summary.dead += 1;
            summary.dead_leaf += 1;
        }
        "dead-ffi" => {
            summary.dead += 1;
            summary.dead_ffi += 1;
        }
        "dead-entry" => {
            summary.dead += 1;
            summary.dead_entry += 1;
        }
        "dead-unresolved" => {
            summary.dead += 1;
            summary.dead_unresolved += 1;
        }
        _ => summary.leaf += 1,
    }
}

/// Batch UPDATE nodes SET role = ? WHERE id IN (...) using chunked statements.
fn batch_update_roles(
    tx: &rusqlite::Transaction,
    ids_by_role: &HashMap<&str, Vec<i64>>,
) -> rusqlite::Result<()> {
    const CHUNK: usize = 500;

    for (role, ids) in ids_by_role {
        for chunk in ids.chunks(CHUNK) {
            let placeholders: String = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE nodes SET role = ?1 WHERE id IN ({})", placeholders);
            let mut stmt = tx.prepare_cached(&sql)?;
            // Bind role as param 1, then each id
            stmt.raw_bind_parameter(1, *role)?;
            for (i, id) in chunk.iter().enumerate() {
                stmt.raw_bind_parameter(i + 2, *id)?;
            }
            stmt.raw_execute()?;
        }
    }
    Ok(())
}

// ── Full classification ──────────────────────────────────────────────

pub(crate) fn do_classify_full(conn: &Connection) -> rusqlite::Result<RoleSummary> {
    let tx = conn.unchecked_transaction()?;
    let mut summary = RoleSummary::default();

    // 1. Property kind (class/struct fields) -> dead-leaf.
    // `parameter` is deliberately NOT included here (#1723): a parameter's liveness
    // is a local dataflow question, not a call-graph reachability question, so
    // "no incoming call edges" carries zero dead-code signal for it. Parameters are
    // also excluded from the main rows query below, so they never receive a role
    // at all — the same treatment as `file`/`directory` nodes.
    let leaf_ids: Vec<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM nodes WHERE kind = 'property'")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 2. Fan-in/fan-out for callable nodes (uses JOIN approach for full scan)
    //    Fan-in includes 'imports-type' edges to match JS classification.
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(
            "SELECT n.id, n.name, n.kind, n.file,
                COALESCE(fi.cnt, 0) AS fan_in,
                COALESCE(fo.cnt, 0) AS fan_out
             FROM nodes n
             LEFT JOIN (
                SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind IN ('calls', 'imports-type') GROUP BY target_id
             ) fi ON n.id = fi.target_id
             LEFT JOIN (
                SELECT source_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id
             ) fo ON n.id = fo.source_id
             WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')",
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
            ))
        })?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    if rows.is_empty() && leaf_ids.is_empty() {
        tx.commit()?;
        return Ok(summary);
    }

    // 3. Exported IDs (cross-file callers including imports-type)
    let mut exported_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT e.target_id
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             JOIN nodes target ON e.target_id = target.id
             WHERE e.kind IN ('calls', 'imports-type') AND caller.file != target.file",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 3b. Mark symbols as exported when their files are targets of reexport edges
    // from production-reachable barrels (traces through multi-level chains) (#837).
    //
    // The recursive CTE works in two stages:
    //   Base case: find all file nodes directly imported by production (non-test) files.
    //   Recursive step: follow 'reexports' edges outward to discover barrel chains
    //     (e.g. index.ts re-exports from internal.ts which re-exports from core.ts).
    // Then: any symbol whose file is a reexport target of a prod-reachable barrel
    // is considered exported (prevents false dead-code classification).
    //
    // `method` is excluded (#1780): a `reexports` edge only ever concerns
    // top-level module bindings (functions, classes, types, constants, ...) —
    // a class/interface method can never be an independently re-exportable
    // binding on its own, so inheriting "exported" status from a co-located
    // top-level re-export is a category error. Without this exclusion, e.g. an
    // abstract base class's zero-fan-in method declarations were promoted to
    // `entry` merely because some other symbol in the same file was re-exported
    // through a barrel.
    {
        let sql = format!(
            "WITH RECURSIVE prod_reachable(file_id) AS (
                SELECT DISTINCT e.target_id
                FROM edges e
                JOIN nodes src ON e.source_id = src.id
                WHERE e.kind IN ('imports', 'dynamic-imports', 'imports-type')
                  AND src.kind = 'file'
                  {}
                UNION
                SELECT e.target_id
                FROM edges e
                JOIN prod_reachable pr ON e.source_id = pr.file_id
                WHERE e.kind = 'reexports'
              )
              SELECT DISTINCT n.id
              FROM nodes n
              JOIN nodes f ON f.file = n.file AND f.kind = 'file'
              WHERE f.id IN (
                SELECT e.target_id FROM edges e
                WHERE e.kind = 'reexports'
                  AND e.source_id IN (SELECT file_id FROM prod_reachable)
              )
              AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')",
            test_file_filter_col("src.file")
        );
        let mut stmt = tx.prepare(&sql)?;
        let reexport_rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in reexport_rows.flatten() {
            exported_ids.insert(r);
        }
    }

    // 3c. Mark symbols with exported=1 as exported — the extractor sets this flag when the
    // author writes `export interface Foo { }` / `export type Bar = ...` / `export function`.
    // Cross-file edge inference misses these when the symbol is only used as a type annotation
    // within the same file (no calls/imports-type edge is produced for same-file type usage).
    // This fixes false dead-unresolved classification for exported interfaces (#1583).
    {
        let mut stmt = tx.prepare(
            "SELECT id FROM nodes
             WHERE exported = 1
               AND kind NOT IN ('file', 'directory', 'parameter', 'property')",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in rows.flatten() {
            exported_ids.insert(r);
        }
    }

    // 4. Production fan-in (excluding test files, including imports-type)
    let prod_fan_in: HashMap<i64, u32> = {
        let sql = format!(
            "SELECT e.target_id, COUNT(*) AS cnt
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             WHERE e.kind IN ('calls', 'imports-type') {}
             GROUP BY e.target_id",
            test_file_filter()
        );
        let mut stmt = tx.prepare(&sql)?;
        let mapped =
            stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u32>(1)?)))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    // 5. Compute medians from non-zero values
    let mut fan_in_vals: Vec<u32> = rows.iter().map(|r| r.4).filter(|&v| v > 0).collect();
    let mut fan_out_vals: Vec<u32> = rows.iter().map(|r| r.5).filter(|&v| v > 0).collect();
    fan_in_vals.sort_unstable();
    fan_out_vals.sort_unstable();
    let median_fan_in = median(&fan_in_vals);
    let median_fan_out = median(&fan_out_vals);

    // 5b. Compute active files (files with non-constant callables connected to the graph)
    let (active_files, called_active_files) = compute_active_files(&rows);

    // 5c. Compute interface/type owner names per file (#1723) — used to recognize
    // method/property members of type-level declarations, which must never be
    // judged dead by call-graph reachability.
    let type_def_names_by_file = compute_type_def_names_by_file(&rows);

    // 6. Classify and collect IDs by role
    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    if !leaf_ids.is_empty() {
        summary.dead += leaf_ids.len() as u32;
        summary.dead_leaf += leaf_ids.len() as u32;
        ids_by_role.insert("dead-leaf", leaf_ids);
    }

    classify_rows(
        &rows,
        &exported_ids,
        &prod_fan_in,
        &active_files,
        &called_active_files,
        &type_def_names_by_file,
        median_fan_in,
        median_fan_out,
        &mut ids_by_role,
        &mut summary,
    );

    // 7. Batch UPDATE: reset all roles then set per-role
    tx.execute("UPDATE nodes SET role = NULL", [])?;
    batch_update_roles(&tx, &ids_by_role)?;

    tx.commit()?;
    Ok(summary)
}

/// Build the test-file exclusion filter for SQL queries (default column: `caller.file`).
fn test_file_filter() -> String {
    test_file_filter_col("caller.file")
}

/// Build the test-file exclusion filter for an arbitrary column name.
fn test_file_filter_col(column: &str) -> String {
    TEST_FILE_PATTERNS
        .iter()
        .map(|p| format!("AND {} NOT LIKE '{}'", column, p))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Compute two active-files sets from callable rows.
///
/// Returns `(active_files, called_active_files)`:
/// - `active_files`: files with at least one non-annotation-only callable with
///   `fan_in > 0 || fan_out > 0`. Used for annotation-only kinds (constants,
///   type defs) which have no callers by design.
/// - `called_active_files`: files with at least one non-annotation-only callable
///   with `fan_in > 0` (strictly called). Used for method/function kinds to
///   prevent a self-sibling false negative: a function with `fan_in=0, fan_out>0`
///   as the sole callable in its file must NOT count itself as an "active sibling"
///   and thereby promote itself to `leaf`.
fn compute_active_files(rows: &[(i64, String, String, String, u32, u32)]) -> (std::collections::HashSet<String>, std::collections::HashSet<String>) {
    let mut active = std::collections::HashSet::new();
    let mut called_active = std::collections::HashSet::new();
    for (_id, _name, kind, file, fan_in, fan_out) in rows {
        if !ANNOTATION_ONLY_KINDS.iter().any(|k| *k == kind.as_str()) {
            if *fan_in > 0 || *fan_out > 0 {
                active.insert(file.clone());
            }
            if *fan_in > 0 {
                called_active.insert(file.clone());
            }
        }
    }
    (active, called_active)
}

/// Compute global median fan-in and fan-out from the edge distribution.
/// Fan-in includes 'imports-type' edges to match JS classification.
fn compute_global_medians(tx: &rusqlite::Transaction) -> rusqlite::Result<(f64, f64)> {
    let median_fan_in = {
        let mut stmt = tx
            .prepare("SELECT COUNT(*) AS cnt FROM edges WHERE kind IN ('calls', 'imports-type') GROUP BY target_id")?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };
    let median_fan_out = {
        let mut stmt = tx
            .prepare("SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id")?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };
    Ok((median_fan_in, median_fan_out))
}

/// Execute a query with bound file parameters and collect i64 results into a HashSet.
fn query_id_set(
    tx: &rusqlite::Transaction,
    sql: &str,
    files: &[&str],
) -> rusqlite::Result<std::collections::HashSet<i64>> {
    let mut stmt = tx.prepare(sql)?;
    for (i, f) in files.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = std::collections::HashSet::new();
    while let Some(row) = rows.next()? {
        result.insert(row.get::<_, i64>(0)?);
    }
    Ok(result)
}

/// Execute a query with bound file parameters and collect (id, count) into a HashMap.
fn query_id_counts(
    tx: &rusqlite::Transaction,
    sql: &str,
    files: &[&str],
) -> rusqlite::Result<HashMap<i64, u32>> {
    let mut stmt = tx.prepare(sql)?;
    for (i, f) in files.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = HashMap::new();
    while let Some(row) = rows.next()? {
        result.insert(row.get::<_, i64>(0)?, row.get::<_, u32>(1)?);
    }
    Ok(result)
}

/// Classify rows and accumulate into ids_by_role and summary.
#[allow(clippy::too_many_arguments)]
fn classify_rows(
    rows: &[(i64, String, String, String, u32, u32)],
    exported_ids: &std::collections::HashSet<i64>,
    prod_fan_in: &HashMap<i64, u32>,
    active_files: &std::collections::HashSet<String>,
    called_active_files: &std::collections::HashSet<String>,
    type_def_names_by_file: &HashMap<String, std::collections::HashSet<String>>,
    median_fan_in: f64,
    median_fan_out: f64,
    ids_by_role: &mut HashMap<&'static str, Vec<i64>>,
    summary: &mut RoleSummary,
) {
    for (id, name, kind, file, fan_in, fan_out) in rows {
        let is_exported = exported_ids.contains(id);
        let prod_fi = prod_fan_in.get(id).copied().unwrap_or(0);
        let is_annotation_only = kind == "constant"
            || TYPE_DEF_KINDS.iter().any(|k| *k == kind.as_str());
        // Set has_active_siblings for annotation-only kinds AND for method/function —
        // the latter two can have fan_in == 0 due to untraced call-site patterns
        // (interface dispatch, logical-or defaults). The classifier interprets this
        // field differently per kind (see classify_node).
        //
        // IMPORTANT: method/function use called_active_files (fan_in > 0 only) to
        // prevent a self-sibling false negative: a function with fan_in=0, fan_out>0
        // as the sole callable in its file must NOT see its own file as "active" and
        // thereby promote itself to leaf.
        let has_active_siblings = if is_annotation_only {
            active_files.contains(file)
        } else if kind == "method" || kind == "function" {
            called_active_files.contains(file)
        } else {
            false
        };
        let is_type_member = is_type_declaration_member(name, kind, file, type_def_names_by_file);
        let role = classify_node(
            name,
            kind,
            file,
            *fan_in,
            *fan_out,
            is_exported,
            prod_fi,
            has_active_siblings,
            is_type_member,
            median_fan_in,
            median_fan_out,
        );
        increment_summary(summary, role);
        ids_by_role.entry(role).or_default().push(*id);
    }
}

/// Direct barrels: files that directly re-export (one hop) into any of the
/// given target files. Used by `do_classify_incremental`'s scoped
/// alternative to the full `prod_reachable` recursive CTE — see
/// `is_barrel_prod_reachable`.
fn find_direct_reexport_barrels(
    tx: &rusqlite::Transaction,
    affected_ph: &str,
    all_affected: &[&str],
) -> rusqlite::Result<Vec<String>> {
    let sql = format!(
        "SELECT DISTINCT n1.file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'reexports' AND n2.file IN ({affected_ph})"
    );
    let mut stmt = tx.prepare(&sql)?;
    for (i, f) in all_affected.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, *f)?;
    }
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row.get::<_, String>(0)?);
    }
    Ok(result)
}

/// True when `barrel_file` is production-reachable — i.e. a member of the
/// same `prod_reachable` set `do_classify_full`'s recursive CTE computes
/// globally (a non-test file directly imports it, or reaches it transitively
/// through a chain of `reexports` edges) — but answered for one specific
/// file instead of materializing the whole graph's closure.
///
/// `do_classify_incremental`'s old approach ran that same global CTE (seeded
/// from every non-test file's imports — 442 rows on this repo's own
/// codebase, closing over 703 total) on every incremental role
/// classification, regardless of how few files actually changed. Once
/// `find_neighbour_files` legitimately widens the affected set for a
/// barrel/re-export file (as it must, correctly, since #1849 — see that
/// function's doc comment), this pre-existing global recursion became a
/// major cost: ~18-21ms measured on this repo (#1855), because SQLite's
/// query planner stops being able to short-circuit the CTE once enough
/// affected-file candidates are in play.
///
/// Reachability is symmetric either direction: "is B reachable from any
/// production import" is answered equivalently by walking *backward* from B
/// through `reexports` edges (who re-exports into B, transitively) and
/// checking whether *any* of those backward-ancestors (including B itself)
/// is directly imported by production — bounded by B's own chain depth
/// (typically 1-3 hops) rather than the whole graph. Measured ~1.6ms total
/// (find barrels + per-barrel check + final symbol lookup) for the same
/// probe that cost ~18-21ms via the global closure.
fn is_barrel_prod_reachable(
    tx: &rusqlite::Transaction,
    barrel_file: &str,
) -> rusqlite::Result<bool> {
    // Fast path: barrel_file itself is directly imported by a non-test file
    // (the base case of the original `prod_reachable` definition).
    let direct_sql = format!(
        "SELECT EXISTS(
           SELECT 1 FROM edges e
             JOIN nodes src ON e.source_id = src.id
             JOIN nodes tgt ON e.target_id = tgt.id
           WHERE e.kind IN ('imports', 'dynamic-imports', 'imports-type')
             AND src.kind = 'file' AND tgt.kind = 'file' AND tgt.file = ?1
             {}
         )",
        test_file_filter_col("src.file")
    );
    // prepare_cached: `direct_sql` is the same text on every call (the
    // interpolated test-file filter is a fixed set of LIKE patterns keyed
    // only by column name), so the statement cache turns every call after
    // the first into a lookup instead of a fresh parse/plan — worthwhile
    // even at the small 1-3-barrels-per-build cardinality this runs at.
    let direct: bool = tx
        .prepare_cached(&direct_sql)?
        .query_row(rusqlite::params![barrel_file], |row| row.get(0))?;
    if direct {
        return Ok(true);
    }

    // Slow path: walk `reexports` edges backward from barrel_file (who
    // re-exports INTO barrel_file, transitively) looking for an ancestor
    // that's directly imported by production. `UNION` (not `UNION ALL`)
    // dedupes on `file`, which both bounds the search to barrel_file's own
    // chain and guarantees termination if the chain contains a cycle.
    let backward_sql = format!(
        "WITH RECURSIVE ancestors(file) AS (
           SELECT ?1
           UNION
           SELECT DISTINCT n1.file FROM edges e
             JOIN nodes n1 ON e.source_id = n1.id
             JOIN nodes n2 ON e.target_id = n2.id
             JOIN ancestors a ON n2.file = a.file
           WHERE e.kind = 'reexports'
         )
         SELECT EXISTS(
           SELECT 1 FROM ancestors a
             JOIN nodes af ON af.file = a.file AND af.kind = 'file'
             JOIN edges e2 ON e2.target_id = af.id
             JOIN nodes src2 ON e2.source_id = src2.id
           WHERE e2.kind IN ('imports', 'dynamic-imports', 'imports-type')
             AND src2.kind = 'file'
             {}
         )",
        test_file_filter_col("src2.file")
    );
    tx.prepare_cached(&backward_sql)?
        .query_row(rusqlite::params![barrel_file], |row| row.get(0))
}

/// Find neighbouring files connected by call/imports-type/reexports edges to the changed files.
///
/// Written as a UNION of two directional joins rather than a single
/// OR-based self-join (`JOIN nodes n1 ON (e.source_id = n1.id OR
/// e.target_id = n1.id)`, likewise for `n2`). The OR-join can't be served
/// by an index on either side of the OR, so SQLite falls back to scanning
/// every edge matching `e.kind IN (...)` and probing both endpoints per
/// row. Each directional half below is a plain equi-join on `source_id`/
/// `target_id`, letting the planner drive the scan from
/// `idx_edges_kind_source`/`idx_edges_kind_target` directly. `UNION` (not
/// `UNION ALL`) dedupes the combined result the same way the original
/// query's `DISTINCT` did. Same result set, measured ~2.4x faster
/// (#1855 — this query's cost, compounded by the symbol-level
/// `reexports` edges added in #1849, was a major contributor to the
/// "1-file rebuild" benchmark regression when the changed file is itself a
/// barrel/re-export hub).
fn find_neighbour_files(
    tx: &rusqlite::Transaction,
    changed_files: &[String],
) -> rusqlite::Result<Vec<String>> {
    let seed_ph: String = changed_files
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT n2.file AS file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind IN ('calls', 'imports-type', 'reexports')
             AND n1.file IN ({seed_ph}) AND n2.file NOT IN ({seed_ph})
             AND n2.kind NOT IN ('file', 'directory')
         UNION
         SELECT n1.file AS file FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind IN ('calls', 'imports-type', 'reexports')
             AND n2.file IN ({seed_ph}) AND n1.file NOT IN ({seed_ph})
             AND n1.kind NOT IN ('file', 'directory')"
    );
    let mut stmt = tx.prepare(&sql)?;
    let mut idx = 1;
    // Bound 4 times: (n1 IN, n2 NOT IN) for the first half, then
    // (n2 IN, n1 NOT IN) for the second half.
    for _ in 0..4 {
        for f in changed_files {
            stmt.raw_bind_parameter(idx, f.as_str())?;
            idx += 1;
        }
    }
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row.get::<_, String>(0)?);
    }
    Ok(result)
}

/// Query leaf kind node IDs and callable node rows for a set of files.
/// `parameter` is intentionally excluded from the leaf query (#1723) — see
/// `do_classify_full`'s leaf_ids comment for the rationale.
fn query_nodes_for_files(
    tx: &rusqlite::Transaction,
    files: &[&str],
) -> rusqlite::Result<(Vec<i64>, Vec<(i64, String, String, String, u32, u32)>)> {
    let ph: String = files.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    let leaf_sql = format!("SELECT id FROM nodes WHERE kind = 'property' AND file IN ({})", ph);
    let leaf_ids: Vec<i64> = {
        let mut stmt = tx.prepare(&leaf_sql)?;
        for (i, f) in files.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut rows = stmt.raw_query();
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(row.get::<_, i64>(0)?);
        }
        result
    };

    let rows_sql = format!(
        "SELECT n.id, n.name, n.kind, n.file,
            (SELECT COUNT(*) FROM edges WHERE kind IN ('calls', 'imports-type') AND target_id = n.id) AS fan_in,
            (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND source_id = n.id) AS fan_out
         FROM nodes n
         WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')
           AND n.file IN ({})",
        ph
    );
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(&rows_sql)?;
        for (i, f) in files.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut qrows = stmt.raw_query();
        let mut result = Vec::new();
        while let Some(row) = qrows.next()? {
            result.push((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
            ));
        }
        result
    };

    Ok((leaf_ids, rows))
}

// ── Incremental classification ───────────────────────────────────────

pub(crate) fn do_classify_incremental(
    conn: &Connection,
    changed_files: &[String],
) -> rusqlite::Result<RoleSummary> {
    let tx = conn.unchecked_transaction()?;
    let mut summary = RoleSummary::default();

    let neighbour_files = find_neighbour_files(&tx, changed_files)?;

    let mut all_affected: Vec<&str> = changed_files.iter().map(|s| s.as_str()).collect();
    for f in &neighbour_files {
        all_affected.push(f.as_str());
    }
    let affected_ph: String = all_affected
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");

    let (median_fan_in, median_fan_out) = compute_global_medians(&tx)?;

    let (leaf_ids, rows) = query_nodes_for_files(&tx, &all_affected)?;

    if rows.is_empty() && leaf_ids.is_empty() {
        tx.commit()?;
        return Ok(summary);
    }

    let exported_sql = format!(
        "SELECT DISTINCT e.target_id
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind IN ('calls', 'imports-type') AND caller.file != target.file
           AND target.file IN ({})",
        affected_ph
    );
    let mut exported_ids = query_id_set(&tx, &exported_sql, &all_affected)?;

    // Mark symbols as exported when their files are targets of reexport edges
    // from production-reachable barrels (traces through multi-level chains) (#837).
    //
    // do_classify_full's step 3b answers this by materializing the global
    // `prod_reachable` closure (every file reachable from any production
    // import, extended through reexports chains) because it has no smaller
    // scope to exploit — it's already processing every file. Here, only
    // `all_affected` (the changed files plus their one-hop neighbours) can
    // possibly be reexport targets we care about, so instead: find the
    // small set of barrels that directly reexport into `all_affected`
    // (typically 1-3 files), then answer "is this specific barrel
    // production-reachable" with a backward-scoped check instead of the
    // whole-graph forward closure (see `is_barrel_prod_reachable`).
    //
    // `method` is excluded (#1780) — see the full-classify path for rationale.
    {
        let barrels = find_direct_reexport_barrels(&tx, &affected_ph, &all_affected)?;
        let mut reachable_barrels: Vec<&str> = Vec::with_capacity(barrels.len());
        for b in &barrels {
            if is_barrel_prod_reachable(&tx, b)? {
                reachable_barrels.push(b.as_str());
            }
        }

        if !reachable_barrels.is_empty() {
            let barrel_ph: String =
                reachable_barrels.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT DISTINCT n.id
                 FROM nodes n
                 JOIN nodes f ON f.file = n.file AND f.kind = 'file'
                 JOIN edges e ON e.target_id = f.id
                 JOIN nodes b ON e.source_id = b.id
                 WHERE e.kind = 'reexports' AND b.file IN ({barrel_ph})
                   AND n.kind NOT IN ('file', 'directory', 'parameter', 'property', 'method')
                   AND n.file IN ({affected_ph})"
            );
            let mut stmt = tx.prepare(&sql)?;
            let mut idx = 1;
            for b in &reachable_barrels {
                stmt.raw_bind_parameter(idx, *b)?;
                idx += 1;
            }
            for f in &all_affected {
                stmt.raw_bind_parameter(idx, *f)?;
                idx += 1;
            }
            let mut rrows = stmt.raw_query();
            while let Some(row) = rrows.next()? {
                exported_ids.insert(row.get::<_, i64>(0)?);
            }
        }
    }

    // 3c. Mark symbols with exported=1 as exported — scoped to affected files only.
    // Same rationale as the full-classify path: the extractor's exported flag is
    // authoritative for same-file-only type annotations that produce no edges (#1583).
    {
        let explicit_sql = format!(
            "SELECT id FROM nodes
             WHERE exported = 1
               AND kind NOT IN ('file', 'directory', 'parameter', 'property')
               AND file IN ({})",
            affected_ph
        );
        let mut stmt = tx.prepare(&explicit_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut erows = stmt.raw_query();
        while let Some(row) = erows.next()? {
            exported_ids.insert(row.get::<_, i64>(0)?);
        }
    }

    let prod_sql = format!(
        "SELECT e.target_id, COUNT(*) AS cnt
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind IN ('calls', 'imports-type')
           AND target.file IN ({})
           {}
         GROUP BY e.target_id",
        affected_ph,
        test_file_filter()
    );
    let prod_fan_in = query_id_counts(&tx, &prod_sql, &all_affected)?;

    let (active_files, called_active_files) = compute_active_files(&rows);

    // Compute interface/type owner names per file (#1723) — see do_classify_full.
    let type_def_names_by_file = compute_type_def_names_by_file(&rows);

    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    if !leaf_ids.is_empty() {
        summary.dead += leaf_ids.len() as u32;
        summary.dead_leaf += leaf_ids.len() as u32;
        ids_by_role.insert("dead-leaf", leaf_ids);
    }

    classify_rows(
        &rows,
        &exported_ids,
        &prod_fan_in,
        &active_files,
        &called_active_files,
        &type_def_names_by_file,
        median_fan_in,
        median_fan_out,
        &mut ids_by_role,
        &mut summary,
    );

    // Reset roles for affected files only, then update
    let reset_sql = format!(
        "UPDATE nodes SET role = NULL WHERE file IN ({}) AND kind NOT IN ('file', 'directory')",
        affected_ph
    );
    {
        let mut stmt = tx.prepare(&reset_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        stmt.raw_execute()?;
    }
    batch_update_roles(&tx, &ids_by_role)?;

    tx.commit()?;
    Ok(summary)
}
