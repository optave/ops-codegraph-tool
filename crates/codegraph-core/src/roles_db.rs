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
fn classify_node(
    name: &str,
    kind: &str,
    file: &str,
    fan_in: u32,
    fan_out: u32,
    is_exported: bool,
    production_fan_in: u32,
    has_active_file_siblings: bool,
    median_fan_in: f64,
    median_fan_out: f64,
) -> &'static str {
    // Framework entry
    if FRAMEWORK_ENTRY_PREFIXES.iter().any(|p| name.starts_with(p)) {
        return "entry";
    }

    if fan_in == 0 && !is_exported {
        // Constants consumed via identifier reference (not calls) have no
        // inbound call edges. If the same file has active callables, the
        // constant is almost certainly used locally — classify as leaf.
        if kind == "constant" && has_active_file_siblings {
            return "leaf";
        }
        return classify_dead_sub_role(name, kind, file);
    }

    if fan_in == 0 && is_exported {
        return "entry";
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

    // 1. Leaf kinds -> dead-leaf
    let leaf_ids: Vec<i64> = {
        let mut stmt =
            tx.prepare("SELECT id FROM nodes WHERE kind IN ('parameter', 'property')")?;
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

    // 3b. Mark symbols as exported when their files are targets of reexports edges
    // from production-reachable barrels (traces through multi-level chains) (#837)
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
              AND n.kind NOT IN ('file', 'directory', 'parameter', 'property')",
            test_file_filter_col("src.file")
        );
        let mut stmt = tx.prepare(&sql)?;
        let reexport_rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for r in reexport_rows.flatten() {
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
    let active_files = compute_active_files(&rows);

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

/// Compute the set of files that have at least one non-constant callable connected to the graph.
/// Constants in these files are likely consumed locally via identifier reference.
fn compute_active_files(rows: &[(i64, String, String, String, u32, u32)]) -> std::collections::HashSet<String> {
    let mut active = std::collections::HashSet::new();
    for (_id, _name, kind, file, fan_in, fan_out) in rows {
        if (*fan_in > 0 || *fan_out > 0) && kind != "constant" {
            active.insert(file.clone());
        }
    }
    active
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
fn classify_rows(
    rows: &[(i64, String, String, String, u32, u32)],
    exported_ids: &std::collections::HashSet<i64>,
    prod_fan_in: &HashMap<i64, u32>,
    active_files: &std::collections::HashSet<String>,
    median_fan_in: f64,
    median_fan_out: f64,
    ids_by_role: &mut HashMap<&'static str, Vec<i64>>,
    summary: &mut RoleSummary,
) {
    for (id, name, kind, file, fan_in, fan_out) in rows {
        let is_exported = exported_ids.contains(id);
        let prod_fi = prod_fan_in.get(id).copied().unwrap_or(0);
        let has_active_siblings = if kind == "constant" {
            active_files.contains(file)
        } else {
            false
        };
        let role = classify_node(
            name,
            kind,
            file,
            *fan_in,
            *fan_out,
            is_exported,
            prod_fi,
            has_active_siblings,
            median_fan_in,
            median_fan_out,
        );
        increment_summary(summary, role);
        ids_by_role.entry(role).or_default().push(*id);
    }
}

/// Find neighbouring files connected by call/imports-type/reexports edges to the changed files.
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
        "SELECT DISTINCT n2.file FROM edges e
         JOIN nodes n1 ON (e.source_id = n1.id OR e.target_id = n1.id)
         JOIN nodes n2 ON (e.source_id = n2.id OR e.target_id = n2.id)
         WHERE e.kind IN ('calls', 'imports-type', 'reexports')
           AND n1.file IN ({})
           AND n2.file NOT IN ({})
           AND n2.kind NOT IN ('file', 'directory')",
        seed_ph, seed_ph
    );
    let mut stmt = tx.prepare(&sql)?;
    let mut idx = 1;
    for f in changed_files {
        stmt.raw_bind_parameter(idx, f.as_str())?;
        idx += 1;
    }
    for f in changed_files {
        stmt.raw_bind_parameter(idx, f.as_str())?;
        idx += 1;
    }
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(row.get::<_, String>(0)?);
    }
    Ok(result)
}

/// Query leaf kind node IDs and callable node rows for a set of files.
fn query_nodes_for_files(
    tx: &rusqlite::Transaction,
    files: &[&str],
) -> rusqlite::Result<(Vec<i64>, Vec<(i64, String, String, String, u32, u32)>)> {
    let ph: String = files.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    let leaf_sql = format!(
        "SELECT id FROM nodes WHERE kind IN ('parameter', 'property') AND file IN ({})",
        ph
    );
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

    // Mark symbols as exported when their files are targets of reexports edges
    // from production-reachable barrels (traces through multi-level chains) (#837)
    {
        let reexport_sql = format!(
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
              AND n.kind NOT IN ('file', 'directory', 'parameter', 'property')
              AND n.file IN ({})",
            test_file_filter_col("src.file"),
            affected_ph
        );
        let mut stmt = tx.prepare(&reexport_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut rrows = stmt.raw_query();
        while let Some(row) = rrows.next()? {
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

    let active_files = compute_active_files(&rows);

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
