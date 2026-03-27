//! Native role classification via rusqlite.
//!
//! Replaces the JS `classifyNodeRolesFull` / `classifyNodeRolesIncremental`
//! functions: runs fan-in/fan-out queries, computes medians, classifies roles,
//! and batch-updates nodes — all in a single Rust function with one DB
//! connection, eliminating JS<->SQLite round-trips.

use std::collections::HashMap;

use napi_derive::napi;
use rusqlite::{Connection, OpenFlags};

// ── Constants ────────────────────────────────────────────────────────

const FRAMEWORK_ENTRY_PREFIXES: &[&str] = &["route:", "event:", "command:"];

const LEAF_KINDS: &[&str] = &["parameter", "property", "constant"];

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

/// Full role classification: queries all nodes, computes fan-in/fan-out,
/// classifies roles, and batch-updates the `role` column.
/// Returns a summary of role counts, or null on failure.
#[napi]
pub fn classify_roles_full(db_path: String) -> Option<RoleSummary> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = Connection::open_with_flags(&db_path, flags).ok()?;
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
    do_classify_full(&mut conn).ok()
}

/// Incremental role classification: only reclassifies nodes from changed files
/// plus their immediate edge neighbours.
/// Returns a summary of role counts for the affected nodes, or null on failure.
#[napi]
pub fn classify_roles_incremental(
    db_path: String,
    changed_files: Vec<String>,
) -> Option<RoleSummary> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = Connection::open_with_flags(&db_path, flags).ok()?;
    let _ = conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
    do_classify_incremental(&mut conn, &changed_files).ok()
}

// ── Shared helpers ───────────────────────────────────────────────────

fn median(sorted: &[u32]) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) / 2
    } else {
        sorted[mid]
    }
}

/// Dead sub-role classification matching JS `classifyDeadSubRole`.
fn classify_dead_sub_role(name: &str, kind: &str, file: &str) -> &'static str {
    // Leaf kinds
    if LEAF_KINDS.iter().any(|k| *k == kind) {
        return "dead-leaf";
    }
    // FFI boundary
    let ffi_exts = [".rs", ".c", ".cpp", ".h", ".go", ".java", ".cs"];
    if ffi_exts.iter().any(|ext| file.ends_with(ext)) {
        return "dead-ffi";
    }
    // Framework entry points
    if FRAMEWORK_ENTRY_PREFIXES
        .iter()
        .any(|p| name.starts_with(p))
    {
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
    median_fan_in: u32,
    median_fan_out: u32,
) -> &'static str {
    // Framework entry
    if FRAMEWORK_ENTRY_PREFIXES
        .iter()
        .any(|p| name.starts_with(p))
    {
        return "entry";
    }

    if fan_in == 0 && !is_exported {
        // Test-only check: if node has test fan-in but zero total fan-in it's
        // classified in the dead sub-role path (JS mirrors this)
        return classify_dead_sub_role(name, kind, file);
    }

    if fan_in == 0 && is_exported {
        return "entry";
    }

    // Test-only: has callers but all are in test files
    if fan_in > 0 && production_fan_in == 0 {
        return "test-only";
    }

    let high_in = fan_in >= median_fan_in && fan_in > 0;
    let high_out = fan_out >= median_fan_out && fan_out > 0;

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

fn do_classify_full(conn: &mut Connection) -> rusqlite::Result<RoleSummary> {
    let tx = conn.transaction()?;
    let mut summary = RoleSummary::default();

    // 1. Leaf kinds → dead-leaf (skip expensive fan-in/fan-out JOINs)
    let leaf_ids: Vec<i64> = {
        let mut stmt =
            tx.prepare("SELECT id FROM nodes WHERE kind IN ('parameter', 'property')")?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 2. Fan-in/fan-out for callable nodes
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(
            "SELECT n.id, n.name, n.kind, n.file,
                COALESCE(fi.cnt, 0) AS fan_in,
                COALESCE(fo.cnt, 0) AS fan_out
             FROM nodes n
             LEFT JOIN (
                SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id
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

    // 3. Exported IDs (cross-file callers)
    let exported_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare(
            "SELECT DISTINCT e.target_id
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             JOIN nodes target ON e.target_id = target.id
             WHERE e.kind = 'calls' AND caller.file != target.file",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 4. Production fan-in (excluding test files)
    let prod_fan_in: HashMap<i64, u32> = {
        let test_filter = TEST_FILE_PATTERNS
            .iter()
            .map(|p| format!("AND caller.file NOT LIKE '{}'", p))
            .collect::<Vec<_>>()
            .join(" ");
        let sql = format!(
            "SELECT e.target_id, COUNT(*) AS cnt
             FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             WHERE e.kind = 'calls' {}
             GROUP BY e.target_id",
            test_filter
        );
        let mut stmt = tx.prepare(&sql)?;
        let mapped = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, u32>(1)?)))?;
        mapped.filter_map(|r| r.ok()).collect()
    };

    // 5. Compute medians from non-zero values
    let mut fan_in_vals: Vec<u32> = rows.iter().map(|r| r.4).filter(|&v| v > 0).collect();
    let mut fan_out_vals: Vec<u32> = rows.iter().map(|r| r.5).filter(|&v| v > 0).collect();
    fan_in_vals.sort_unstable();
    fan_out_vals.sort_unstable();
    let median_fan_in = median(&fan_in_vals);
    let median_fan_out = median(&fan_out_vals);

    // 6. Classify and collect IDs by role
    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    if !leaf_ids.is_empty() {
        summary.dead += leaf_ids.len() as u32;
        summary.dead_leaf += leaf_ids.len() as u32;
        ids_by_role.insert("dead-leaf", leaf_ids);
    }

    for (id, name, kind, file, fan_in, fan_out) in &rows {
        let is_exported = exported_ids.contains(id);
        let prod_fi = prod_fan_in.get(id).copied().unwrap_or(0);
        let role = classify_node(
            name,
            kind,
            file,
            *fan_in,
            *fan_out,
            is_exported,
            prod_fi,
            median_fan_in,
            median_fan_out,
        );
        increment_summary(&mut summary, role);
        ids_by_role.entry(role).or_default().push(*id);
    }

    // 7. Batch UPDATE: reset all roles then set per-role
    tx.execute("UPDATE nodes SET role = NULL", [])?;
    batch_update_roles(&tx, &ids_by_role)?;

    tx.commit()?;
    Ok(summary)
}

// ── Incremental classification ───────────────────────────────────────

fn do_classify_incremental(
    conn: &mut Connection,
    changed_files: &[String],
) -> rusqlite::Result<RoleSummary> {
    let tx = conn.transaction()?;
    let mut summary = RoleSummary::default();

    // Build placeholders for changed files
    let seed_ph: String = changed_files.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // Expand affected set: include edge neighbours
    let neighbour_sql = format!(
        "SELECT DISTINCT n2.file FROM edges e
         JOIN nodes n1 ON (e.source_id = n1.id OR e.target_id = n1.id)
         JOIN nodes n2 ON (e.source_id = n2.id OR e.target_id = n2.id)
         WHERE e.kind = 'calls'
           AND n1.file IN ({})
           AND n2.file NOT IN ({})
           AND n2.kind NOT IN ('file', 'directory')",
        seed_ph, seed_ph
    );
    let neighbour_files: Vec<String> = {
        let mut stmt = tx.prepare(&neighbour_sql)?;
        // Bind changed_files twice (for both IN clauses)
        let mut idx = 1;
        for f in changed_files {
            stmt.raw_bind_parameter(idx, f.as_str())?;
            idx += 1;
        }
        for f in changed_files {
            stmt.raw_bind_parameter(idx, f.as_str())?;
            idx += 1;
        }
        let rows = stmt.raw_query();
        let mut result = Vec::new();
        let mut rows = rows;
        while let Some(row) = rows.next()? {
            result.push(row.get::<_, String>(0)?);
        }
        result
    };

    let mut all_affected: Vec<&str> = changed_files.iter().map(|s| s.as_str()).collect();
    for f in &neighbour_files {
        all_affected.push(f.as_str());
    }
    let affected_ph: String = all_affected.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // 1. Global medians from edge distribution
    let median_fan_in = {
        let mut stmt = tx.prepare(
            "SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id",
        )?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };
    let median_fan_out = {
        let mut stmt = tx.prepare(
            "SELECT COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY source_id",
        )?;
        let mut vals: Vec<u32> = stmt
            .query_map([], |row| row.get::<_, u32>(0))?
            .filter_map(|r| r.ok())
            .collect();
        vals.sort_unstable();
        median(&vals)
    };

    // 2a. Leaf kinds in affected files
    let leaf_sql = format!(
        "SELECT id FROM nodes WHERE kind IN ('parameter', 'property') AND file IN ({})",
        affected_ph
    );
    let leaf_ids: Vec<i64> = {
        let mut stmt = tx.prepare(&leaf_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut rows = stmt.raw_query();
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(row.get::<_, i64>(0)?);
        }
        result
    };

    // 2b. Callable nodes with correlated subquery fan-in/fan-out
    let rows_sql = format!(
        "SELECT n.id, n.name, n.kind, n.file,
            (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND target_id = n.id) AS fan_in,
            (SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND source_id = n.id) AS fan_out
         FROM nodes n
         WHERE n.kind NOT IN ('file', 'directory', 'parameter', 'property')
           AND n.file IN ({})",
        affected_ph
    );
    let rows: Vec<(i64, String, String, String, u32, u32)> = {
        let mut stmt = tx.prepare(&rows_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
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

    if rows.is_empty() && leaf_ids.is_empty() {
        tx.commit()?;
        return Ok(summary);
    }

    // 3. Exported IDs for affected nodes
    let exported_sql = format!(
        "SELECT DISTINCT e.target_id
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind = 'calls' AND caller.file != target.file
           AND target.file IN ({})",
        affected_ph
    );
    let exported_ids: std::collections::HashSet<i64> = {
        let mut stmt = tx.prepare(&exported_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut qrows = stmt.raw_query();
        let mut result = std::collections::HashSet::new();
        while let Some(row) = qrows.next()? {
            result.insert(row.get::<_, i64>(0)?);
        }
        result
    };

    // 4. Production fan-in for affected nodes
    let test_filter = TEST_FILE_PATTERNS
        .iter()
        .map(|p| format!("AND caller.file NOT LIKE '{}'", p))
        .collect::<Vec<_>>()
        .join(" ");
    let prod_sql = format!(
        "SELECT e.target_id, COUNT(*) AS cnt
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes target ON e.target_id = target.id
         WHERE e.kind = 'calls'
           AND target.file IN ({})
           {}
         GROUP BY e.target_id",
        affected_ph, test_filter
    );
    let prod_fan_in: HashMap<i64, u32> = {
        let mut stmt = tx.prepare(&prod_sql)?;
        for (i, f) in all_affected.iter().enumerate() {
            stmt.raw_bind_parameter(i + 1, *f)?;
        }
        let mut qrows = stmt.raw_query();
        let mut result = HashMap::new();
        while let Some(row) = qrows.next()? {
            result.insert(row.get::<_, i64>(0)?, row.get::<_, u32>(1)?);
        }
        result
    };

    // 5. Classify
    let mut ids_by_role: HashMap<&str, Vec<i64>> = HashMap::new();

    if !leaf_ids.is_empty() {
        summary.dead += leaf_ids.len() as u32;
        summary.dead_leaf += leaf_ids.len() as u32;
        ids_by_role.insert("dead-leaf", leaf_ids);
    }

    for (id, name, kind, file, fan_in, fan_out) in &rows {
        let is_exported = exported_ids.contains(id);
        let prod_fi = prod_fan_in.get(id).copied().unwrap_or(0);
        let role = classify_node(
            name,
            kind,
            file,
            *fan_in,
            *fan_out,
            is_exported,
            prod_fi,
            median_fan_in,
            median_fan_out,
        );
        increment_summary(&mut summary, role);
        ids_by_role.entry(role).or_default().push(*id);
    }

    // 6. Reset roles for affected files only, then update
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
