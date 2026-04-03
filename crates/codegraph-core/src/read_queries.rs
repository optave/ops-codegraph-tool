//! Read query methods on NativeDatabase — implements all 40 Repository read operations.
//!
//! Uses a second `#[napi] impl NativeDatabase` block (Rust allows multiple impl blocks).
//! All methods use `conn.prepare_cached()` for automatic statement caching.

use std::collections::{HashSet, VecDeque};

use napi_derive::napi;
use rusqlite::params;

use crate::native_db::{has_table, NativeDatabase};
use crate::read_types::*;

// ── Helpers ─────────────────────────────────────────────────────────────

/// Escape LIKE wildcards. Mirrors `escapeLike()` in `src/db/query-builder.ts`.
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' | '_' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Build test-file exclusion clauses for a column.
fn test_filter_clauses(column: &str) -> String {
    format!(
        "AND {col} NOT LIKE '%.test.%' \
         AND {col} NOT LIKE '%.spec.%' \
         AND {col} NOT LIKE '%__test__%' \
         AND {col} NOT LIKE '%__tests__%' \
         AND {col} NOT LIKE '%.stories.%'",
        col = column,
    )
}

/// Read a full NativeNodeRow from a rusqlite Row by column name.
fn read_node_row(row: &rusqlite::Row) -> rusqlite::Result<NativeNodeRow> {
    Ok(NativeNodeRow {
        id: row.get("id")?,
        name: row.get("name")?,
        kind: row.get("kind")?,
        file: row.get("file")?,
        line: row.get("line")?,
        end_line: row.get("end_line")?,
        parent_id: row.get("parent_id")?,
        exported: row.get("exported")?,
        qualified_name: row.get("qualified_name")?,
        scope: row.get("scope")?,
        visibility: row.get("visibility")?,
        role: row.get("role")?,
    })
}

// ── Constants ───────────────────────────────────────────────────────────

const CORE_SYMBOL_KINDS: &[&str] = &[
    "function",
    "method",
    "class",
    "interface",
    "type",
    "struct",
    "enum",
    "trait",
    "record",
    "module",
];

const EVERY_SYMBOL_KIND: &[&str] = &[
    "function",
    "method",
    "class",
    "interface",
    "type",
    "struct",
    "enum",
    "trait",
    "record",
    "module",
    "parameter",
    "property",
    "constant",
];

const VALID_ROLES: &[&str] = &[
    "entry",
    "core",
    "utility",
    "adapter",
    "dead",
    "test-only",
    "leaf",
    "dead-leaf",
    "dead-entry",
    "dead-ffi",
    "dead-unresolved",
];

// ── Query Methods ───────────────────────────────────────────────────────

#[napi]
impl NativeDatabase {
    // ── Batch 1: Counters + Single-Row Lookups ──────────────────────────

    /// Count total nodes.
    #[napi]
    pub fn count_nodes(&self) -> napi::Result<i32> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT COUNT(*) FROM nodes")
            .map_err(|e| napi::Error::from_reason(format!("count_nodes prepare: {e}")))?;
        stmt.query_row([], |row| row.get::<_, i32>(0))
            .map_err(|e| napi::Error::from_reason(format!("count_nodes: {e}")))
    }

    /// Count total edges.
    #[napi]
    pub fn count_edges(&self) -> napi::Result<i32> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT COUNT(*) FROM edges")
            .map_err(|e| napi::Error::from_reason(format!("count_edges prepare: {e}")))?;
        stmt.query_row([], |row| row.get::<_, i32>(0))
            .map_err(|e| napi::Error::from_reason(format!("count_edges: {e}")))
    }

    /// Count distinct files.
    #[napi]
    pub fn count_files(&self) -> napi::Result<i32> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT COUNT(DISTINCT file) FROM nodes")
            .map_err(|e| napi::Error::from_reason(format!("count_files prepare: {e}")))?;
        stmt.query_row([], |row| row.get::<_, i32>(0))
            .map_err(|e| napi::Error::from_reason(format!("count_files: {e}")))
    }

    /// Find a single node by ID. Returns null if not found.
    #[napi]
    pub fn find_node_by_id(&self, id: i32) -> napi::Result<Option<NativeNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT * FROM nodes WHERE id = ?1")
            .map_err(|e| napi::Error::from_reason(format!("find_node_by_id prepare: {e}")))?;
        match stmt.query_row(params![id], read_node_row) {
            Ok(row) => Ok(Some(row)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!("find_node_by_id: {e}"))),
        }
    }

    /// Look up a node's ID by (name, kind, file, line). Returns null if not found.
    #[napi]
    pub fn get_node_id(
        &self,
        name: String,
        kind: String,
        file: String,
        line: i32,
    ) -> napi::Result<Option<i32>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT id FROM nodes WHERE name = ?1 AND kind = ?2 AND file = ?3 AND line = ?4",
            )
            .map_err(|e| napi::Error::from_reason(format!("get_node_id prepare: {e}")))?;
        match stmt.query_row(params![name, kind, file, line], |row| row.get::<_, i32>(0)) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!("get_node_id: {e}"))),
        }
    }

    /// Look up a function/method node's ID.
    #[napi]
    pub fn get_function_node_id(
        &self,
        name: String,
        file: String,
        line: i32,
    ) -> napi::Result<Option<i32>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT id FROM nodes WHERE name = ?1 AND kind IN ('function','method') AND file = ?2 AND line = ?3",
            )
            .map_err(|e| napi::Error::from_reason(format!("get_function_node_id prepare: {e}")))?;
        match stmt.query_row(params![name, file, line], |row| row.get::<_, i32>(0)) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!(
                "get_function_node_id: {e}"
            ))),
        }
    }

    /// Bulk-fetch node IDs for a file.
    #[napi]
    pub fn bulk_node_ids_by_file(&self, file: String) -> napi::Result<Vec<NativeNodeIdRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT id, name, kind, line FROM nodes WHERE file = ?1")
            .map_err(|e| napi::Error::from_reason(format!("bulk_node_ids_by_file prepare: {e}")))?;
        let rows = stmt
            .query_map(params![file], |row| {
                Ok(NativeNodeIdRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    line: row.get("line")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("bulk_node_ids_by_file: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("bulk_node_ids_by_file collect: {e}")))
    }

    /// Find child nodes of a parent.
    #[napi]
    pub fn find_node_children(&self, parent_id: i32) -> napi::Result<Vec<NativeChildNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT name, kind, line, end_line, qualified_name, scope, visibility \
                 FROM nodes WHERE parent_id = ?1 ORDER BY line",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_node_children prepare: {e}")))?;
        let rows = stmt
            .query_map(params![parent_id], |row| {
                Ok(NativeChildNodeRow {
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    line: row.get("line")?,
                    end_line: row.get("end_line")?,
                    qualified_name: row.get("qualified_name")?,
                    scope: row.get("scope")?,
                    visibility: row.get("visibility")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_node_children: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_node_children collect: {e}")))
    }

    // ── Batch 2: Node List Queries ──────────────────────────────────────

    /// Find non-file nodes for a file path, ordered by line.
    #[napi]
    pub fn find_nodes_by_file(&self, file: String) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT * FROM nodes WHERE file = ?1 AND kind != 'file' ORDER BY line",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_file prepare: {e}")))?;
        let rows = stmt
            .query_map(params![file], read_node_row)
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_file: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_file collect: {e}")))
    }

    /// Find file-kind nodes matching a LIKE pattern.
    #[napi]
    pub fn find_file_nodes(&self, file_like: String) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT * FROM nodes WHERE file LIKE ?1 AND kind = 'file'")
            .map_err(|e| napi::Error::from_reason(format!("find_file_nodes prepare: {e}")))?;
        let rows = stmt
            .query_map(params![file_like], read_node_row)
            .map_err(|e| napi::Error::from_reason(format!("find_file_nodes: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_file_nodes collect: {e}")))
    }

    /// Find nodes by scope with optional kind and file filters.
    #[napi]
    pub fn find_nodes_by_scope(
        &self,
        scope_name: String,
        kind: Option<String>,
        file: Option<String>,
    ) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;

        let mut sql = "SELECT * FROM nodes WHERE scope = ?1".to_string();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(scope_name)];
        let mut idx = 2;

        if let Some(ref k) = kind {
            sql.push_str(&format!(" AND kind = ?{idx}"));
            param_values.push(Box::new(k.clone()));
            idx += 1;
        }
        if let Some(ref f) = file {
            sql.push_str(&format!(" AND file LIKE ?{idx} ESCAPE '\\'"));
            param_values.push(Box::new(format!("%{}%", escape_like(f))));
        }
        sql.push_str(" ORDER BY file, line");

        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_scope prepare: {e}")))?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), read_node_row)
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_scope: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_nodes_by_scope collect: {e}")))
    }

    /// Find nodes by qualified name with optional file filter.
    #[napi]
    pub fn find_node_by_qualified_name(
        &self,
        qualified_name: String,
        file: Option<String>,
    ) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;

        if let Some(ref f) = file {
            let pattern = format!("%{}%", escape_like(f));
            let mut stmt = conn
                .prepare_cached(
                    "SELECT * FROM nodes WHERE qualified_name = ?1 AND file LIKE ?2 ESCAPE '\\' ORDER BY file, line",
                )
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "find_node_by_qualified_name prepare: {e}"
                    ))
                })?;
            let rows = stmt
                .query_map(params![qualified_name, pattern], read_node_row)
                .map_err(|e| {
                    napi::Error::from_reason(format!("find_node_by_qualified_name: {e}"))
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                napi::Error::from_reason(format!("find_node_by_qualified_name collect: {e}"))
            })
        } else {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT * FROM nodes WHERE qualified_name = ?1 ORDER BY file, line",
                )
                .map_err(|e| {
                    napi::Error::from_reason(format!(
                        "find_node_by_qualified_name prepare: {e}"
                    ))
                })?;
            let rows = stmt
                .query_map(params![qualified_name], read_node_row)
                .map_err(|e| {
                    napi::Error::from_reason(format!("find_node_by_qualified_name: {e}"))
                })?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| {
                napi::Error::from_reason(format!("find_node_by_qualified_name collect: {e}"))
            })
        }
    }

    /// Find nodes matching a name pattern with fan-in count.
    #[napi]
    pub fn find_nodes_with_fan_in(
        &self,
        name_pattern: String,
        kinds: Option<Vec<String>>,
        file: Option<String>,
    ) -> napi::Result<Vec<NativeNodeRowWithFanIn>> {
        let conn = self.conn()?;

        let mut sql = String::from(
            "SELECT n.*, COALESCE(fi.cnt, 0) AS fan_in \
             FROM nodes n \
             LEFT JOIN (SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id) fi ON fi.target_id = n.id \
             WHERE n.name LIKE ?1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> =
            vec![Box::new(name_pattern)];
        let mut idx = 2;

        if let Some(ref ks) = kinds {
            if !ks.is_empty() {
                let placeholders: Vec<String> =
                    ks.iter().enumerate().map(|(i, _)| format!("?{}", idx + i)).collect();
                sql.push_str(&format!(" AND n.kind IN ({})", placeholders.join(", ")));
                for k in ks {
                    param_values.push(Box::new(k.clone()));
                }
                idx += ks.len();
            }
        }
        if let Some(ref f) = file {
            sql.push_str(&format!(" AND n.file LIKE ?{idx} ESCAPE '\\'"));
            param_values.push(Box::new(format!("%{}%", escape_like(f))));
        }

        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_with_fan_in prepare: {e}"))
            })?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok(NativeNodeRowWithFanIn {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: row.get("end_line")?,
                    parent_id: row.get("parent_id")?,
                    exported: row.get("exported")?,
                    qualified_name: row.get("qualified_name")?,
                    scope: row.get("scope")?,
                    visibility: row.get("visibility")?,
                    role: row.get("role")?,
                    fan_in: row.get("fan_in")?,
                })
            })
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_with_fan_in: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_with_fan_in collect: {e}"))
            })
    }

    /// Fetch nodes for triage scoring.
    #[napi]
    pub fn find_nodes_for_triage(
        &self,
        kind: Option<String>,
        role: Option<String>,
        file: Option<String>,
        no_tests: Option<bool>,
    ) -> napi::Result<Vec<NativeTriageNodeRow>> {
        // Validate kind
        if let Some(ref k) = kind {
            if !EVERY_SYMBOL_KIND.contains(&k.as_str()) {
                return Err(napi::Error::from_reason(format!(
                    "Invalid kind: {k} (expected one of {})",
                    EVERY_SYMBOL_KIND.join(", ")
                )));
            }
        }
        // Validate role
        if let Some(ref r) = role {
            if !VALID_ROLES.contains(&r.as_str()) {
                return Err(napi::Error::from_reason(format!(
                    "Invalid role: {r} (expected one of {})",
                    VALID_ROLES.join(", ")
                )));
            }
        }

        let conn = self.conn()?;

        let kinds_to_use: Vec<&str> = match kind {
            Some(ref k) => vec![k.as_str()],
            None => vec!["function", "method", "class"],
        };
        let kind_placeholders: Vec<String> = kinds_to_use
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect();

        let mut sql = format!(
            "SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line, \
                    n.parent_id, n.exported, n.qualified_name, n.scope, n.visibility, n.role, \
                    COALESCE(fi.cnt, 0) AS fan_in, \
                    COALESCE(fc.cognitive, 0) AS cognitive, \
                    COALESCE(fc.maintainability_index, 0) AS mi, \
                    COALESCE(fc.cyclomatic, 0) AS cyclomatic, \
                    COALESCE(fc.max_nesting, 0) AS max_nesting, \
                    COALESCE(fcc.commit_count, 0) AS churn \
             FROM nodes n \
             LEFT JOIN (SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id) fi ON fi.target_id = n.id \
             LEFT JOIN function_complexity fc ON fc.node_id = n.id \
             LEFT JOIN file_commit_counts fcc ON n.file = fcc.file \
             WHERE n.kind IN ({kinds})",
            kinds = kind_placeholders.join(", "),
        );

        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        for k in &kinds_to_use {
            param_values.push(Box::new(k.to_string()));
        }
        let mut idx = kinds_to_use.len() + 1;

        if no_tests.unwrap_or(false) {
            sql.push_str(&format!(" {}", test_filter_clauses("n.file")));
        }
        if let Some(ref f) = file {
            sql.push_str(&format!(" AND n.file LIKE ?{idx} ESCAPE '\\'"));
            param_values.push(Box::new(format!("%{}%", escape_like(f))));
            idx += 1;
        }
        if let Some(ref r) = role {
            if r == "dead" {
                sql.push_str(&format!(" AND n.role LIKE ?{idx}"));
                param_values.push(Box::new("dead%".to_string()));
            } else {
                sql.push_str(&format!(" AND n.role = ?{idx}"));
                param_values.push(Box::new(r.clone()));
            }
        }
        sql.push_str(" ORDER BY n.file, n.line");

        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_for_triage prepare: {e}"))
            })?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), |row| {
                Ok(NativeTriageNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: row.get("end_line")?,
                    parent_id: row.get("parent_id")?,
                    exported: row.get("exported")?,
                    qualified_name: row.get("qualified_name")?,
                    scope: row.get("scope")?,
                    visibility: row.get("visibility")?,
                    role: row.get("role")?,
                    fan_in: row.get("fan_in")?,
                    cognitive: row.get("cognitive")?,
                    mi: row.get("mi")?,
                    cyclomatic: row.get("cyclomatic")?,
                    max_nesting: row.get("max_nesting")?,
                    churn: row.get("churn")?,
                })
            })
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_for_triage: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_nodes_for_triage collect: {e}"))
            })
    }

    /// List function/method/class nodes.
    #[napi]
    pub fn list_function_nodes(
        &self,
        file: Option<String>,
        pattern: Option<String>,
        no_tests: Option<bool>,
    ) -> napi::Result<Vec<NativeNodeRow>> {
        self.query_function_nodes(file, pattern, no_tests)
    }

    /// Same as list_function_nodes (TS wraps result as iterator).
    #[napi]
    pub fn iterate_function_nodes(
        &self,
        file: Option<String>,
        pattern: Option<String>,
        no_tests: Option<bool>,
    ) -> napi::Result<Vec<NativeNodeRow>> {
        self.query_function_nodes(file, pattern, no_tests)
    }

    // ── Batch 3: Edge Queries ───────────────────────────────────────────

    /// Find all callees of a node (outgoing 'calls' edges).
    #[napi]
    pub fn find_callees(&self, node_id: i32) -> napi::Result<Vec<NativeRelatedNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line, n.end_line \
                 FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1 AND e.kind = 'calls'",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_callees prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeRelatedNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: row.get("end_line")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_callees: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_callees collect: {e}")))
    }

    /// Find all callers of a node (incoming 'calls' edges).
    #[napi]
    pub fn find_callers(&self, node_id: i32) -> napi::Result<Vec<NativeRelatedNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.id, n.name, n.kind, n.file, n.line \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind = 'calls'",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_callers prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeRelatedNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: None,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_callers: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_callers collect: {e}")))
    }

    /// Find distinct callers of a node.
    #[napi]
    pub fn find_distinct_callers(&self, node_id: i32) -> napi::Result<Vec<NativeRelatedNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind = 'calls'",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_distinct_callers prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeRelatedNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: None,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_distinct_callers: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_distinct_callers collect: {e}"))
            })
    }

    /// Find all outgoing edges with edge kind.
    #[napi]
    pub fn find_all_outgoing_edges(
        &self,
        node_id: i32,
    ) -> napi::Result<Vec<NativeAdjacentEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.name, n.kind, n.file, n.line, e.kind AS edge_kind \
                 FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_outgoing_edges prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeAdjacentEdgeRow {
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    edge_kind: row.get("edge_kind")?,
                })
            })
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_outgoing_edges: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_outgoing_edges collect: {e}"))
            })
    }

    /// Find all incoming edges with edge kind.
    #[napi]
    pub fn find_all_incoming_edges(
        &self,
        node_id: i32,
    ) -> napi::Result<Vec<NativeAdjacentEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.name, n.kind, n.file, n.line, e.kind AS edge_kind \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_incoming_edges prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeAdjacentEdgeRow {
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    edge_kind: row.get("edge_kind")?,
                })
            })
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_incoming_edges: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_all_incoming_edges collect: {e}"))
            })
    }

    /// Get distinct callee names for a node.
    #[napi]
    pub fn find_callee_names(&self, node_id: i32) -> napi::Result<Vec<String>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.name \
                 FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1 AND e.kind = 'calls' \
                 ORDER BY n.name",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_callee_names prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| row.get::<_, String>(0))
            .map_err(|e| napi::Error::from_reason(format!("find_callee_names: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_callee_names collect: {e}")))
    }

    /// Get distinct caller names for a node.
    #[napi]
    pub fn find_caller_names(&self, node_id: i32) -> napi::Result<Vec<String>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.name \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind = 'calls' \
                 ORDER BY n.name",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_caller_names prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| row.get::<_, String>(0))
            .map_err(|e| napi::Error::from_reason(format!("find_caller_names: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_caller_names collect: {e}")))
    }

    /// Find outgoing import edges.
    #[napi]
    pub fn find_import_targets(&self, node_id: i32) -> napi::Result<Vec<NativeImportEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.file, e.kind AS edge_kind \
                 FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1 AND e.kind IN ('imports', 'imports-type')",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_import_targets prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeImportEdgeRow {
                    file: row.get("file")?,
                    edge_kind: row.get("edge_kind")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_import_targets: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_import_targets collect: {e}")))
    }

    /// Find incoming import edges.
    #[napi]
    pub fn find_import_sources(&self, node_id: i32) -> napi::Result<Vec<NativeImportEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.file, e.kind AS edge_kind \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind IN ('imports', 'imports-type')",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_import_sources prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeImportEdgeRow {
                    file: row.get("file")?,
                    edge_kind: row.get("edge_kind")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_import_sources: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_import_sources collect: {e}")))
    }

    /// Find nodes that import a given node.
    #[napi]
    pub fn find_import_dependents(&self, node_id: i32) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT n.* FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind IN ('imports', 'imports-type')",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_import_dependents prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![node_id], read_node_row)
            .map_err(|e| napi::Error::from_reason(format!("find_import_dependents: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_import_dependents collect: {e}"))
            })
    }

    /// Get IDs of symbols in a file called from other files.
    #[napi]
    pub fn find_cross_file_call_targets(&self, file: String) -> napi::Result<Vec<i32>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT e.target_id FROM edges e \
                 JOIN nodes caller ON e.source_id = caller.id \
                 JOIN nodes target ON e.target_id = target.id \
                 WHERE target.file = ?1 AND caller.file != ?2 AND e.kind = 'calls'",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_cross_file_call_targets prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![file, file], |row| row.get::<_, i32>(0))
            .map_err(|e| {
                napi::Error::from_reason(format!("find_cross_file_call_targets: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_cross_file_call_targets collect: {e}"))
            })
    }

    /// Count callers in a different file than the target.
    #[napi]
    pub fn count_cross_file_callers(&self, node_id: i32, file: String) -> napi::Result<i32> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT COUNT(*) FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind = 'calls' AND n.file != ?2",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("count_cross_file_callers prepare: {e}"))
            })?;
        stmt.query_row(params![node_id, file], |row| row.get::<_, i32>(0))
            .map_err(|e| napi::Error::from_reason(format!("count_cross_file_callers: {e}")))
    }

    /// Get all ancestor class IDs via extends edges (BFS).
    #[napi]
    pub fn get_class_hierarchy(&self, class_node_id: i32) -> napi::Result<Vec<i32>> {
        let conn = self.conn()?;
        let mut ancestors = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(class_node_id);

        let mut stmt = conn
            .prepare_cached(
                "SELECT n.id FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1 AND e.kind = 'extends'",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("get_class_hierarchy prepare: {e}"))
            })?;

        while let Some(current) = queue.pop_front() {
            let parents: Vec<i32> = stmt
                .query_map(params![current], |row| row.get::<_, i32>(0))
                .map_err(|e| {
                    napi::Error::from_reason(format!("get_class_hierarchy query: {e}"))
                })?
                .filter_map(|r| r.ok())
                .collect();
            for p in parents {
                if ancestors.insert(p) {
                    queue.push_back(p);
                }
            }
        }
        Ok(ancestors.into_iter().collect())
    }

    /// Find implementors of an interface/trait.
    #[napi]
    pub fn find_implementors(&self, node_id: i32) -> napi::Result<Vec<NativeRelatedNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line \
                 FROM edges e JOIN nodes n ON e.source_id = n.id \
                 WHERE e.target_id = ?1 AND e.kind = 'implements'",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_implementors prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeRelatedNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: None,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_implementors: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_implementors collect: {e}")))
    }

    /// Find interfaces/traits that a class/struct implements.
    #[napi]
    pub fn find_interfaces(&self, node_id: i32) -> napi::Result<Vec<NativeRelatedNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line \
                 FROM edges e JOIN nodes n ON e.target_id = n.id \
                 WHERE e.source_id = ?1 AND e.kind = 'implements'",
            )
            .map_err(|e| napi::Error::from_reason(format!("find_interfaces prepare: {e}")))?;
        let rows = stmt
            .query_map(params![node_id], |row| {
                Ok(NativeRelatedNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                    line: row.get("line")?,
                    end_line: None,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("find_interfaces: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("find_interfaces collect: {e}")))
    }

    /// Find intra-file call edges.
    #[napi]
    pub fn find_intra_file_call_edges(
        &self,
        file: String,
    ) -> napi::Result<Vec<NativeIntraFileCallEdge>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT caller.name AS caller_name, callee.name AS callee_name \
                 FROM edges e \
                 JOIN nodes caller ON e.source_id = caller.id \
                 JOIN nodes callee ON e.target_id = callee.id \
                 WHERE caller.file = ?1 AND callee.file = ?2 AND e.kind = 'calls' \
                 ORDER BY caller.line",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("find_intra_file_call_edges prepare: {e}"))
            })?;
        let rows = stmt
            .query_map(params![file, file], |row| {
                Ok(NativeIntraFileCallEdge {
                    caller_name: row.get("caller_name")?,
                    callee_name: row.get("callee_name")?,
                })
            })
            .map_err(|e| {
                napi::Error::from_reason(format!("find_intra_file_call_edges: {e}"))
            })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("find_intra_file_call_edges collect: {e}"))
            })
    }

    // ── Batch 4: Graph-Read + Table Checks ──────────────────────────────

    /// Get callable nodes (all core symbol kinds).
    #[napi]
    pub fn get_callable_nodes(&self) -> napi::Result<Vec<NativeCallableNodeRow>> {
        let conn = self.conn()?;
        // Build static IN clause from CORE_SYMBOL_KINDS
        let kinds_sql: String = CORE_SYMBOL_KINDS
            .iter()
            .map(|k| format!("'{k}'"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, name, kind, file FROM nodes WHERE kind IN ({kinds_sql})"
        );
        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| napi::Error::from_reason(format!("get_callable_nodes prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NativeCallableNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    kind: row.get("kind")?,
                    file: row.get("file")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("get_callable_nodes: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("get_callable_nodes collect: {e}")))
    }

    /// Get all 'calls' edges.
    #[napi]
    pub fn get_call_edges(&self) -> napi::Result<Vec<NativeCallEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT source_id, target_id, confidence FROM edges WHERE kind = 'calls'",
            )
            .map_err(|e| napi::Error::from_reason(format!("get_call_edges prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NativeCallEdgeRow {
                    source_id: row.get("source_id")?,
                    target_id: row.get("target_id")?,
                    confidence: row.get("confidence")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("get_call_edges: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("get_call_edges collect: {e}")))
    }

    /// Get all file-kind nodes.
    #[napi]
    pub fn get_file_nodes_all(&self) -> napi::Result<Vec<NativeFileNodeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached("SELECT id, name, file FROM nodes WHERE kind = 'file'")
            .map_err(|e| napi::Error::from_reason(format!("get_file_nodes_all prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NativeFileNodeRow {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    file: row.get("file")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("get_file_nodes_all: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("get_file_nodes_all collect: {e}")))
    }

    /// Get all import edges.
    #[napi]
    pub fn get_import_edges(&self) -> napi::Result<Vec<NativeImportGraphEdgeRow>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT source_id, target_id FROM edges WHERE kind IN ('imports','imports-type')",
            )
            .map_err(|e| napi::Error::from_reason(format!("get_import_edges prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(NativeImportGraphEdgeRow {
                    source_id: row.get("source_id")?,
                    target_id: row.get("target_id")?,
                })
            })
            .map_err(|e| napi::Error::from_reason(format!("get_import_edges: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("get_import_edges collect: {e}")))
    }

    /// Check whether CFG tables exist.
    #[napi]
    pub fn has_cfg_tables(&self) -> napi::Result<bool> {
        let conn = self.conn()?;
        match conn.prepare("SELECT 1 FROM cfg_blocks LIMIT 0") {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(e) => Err(napi::Error::from_reason(format!("has_cfg_tables: {e}"))),
        }
    }

    /// Check whether embeddings table has data.
    #[napi]
    pub fn has_embeddings(&self) -> napi::Result<bool> {
        let conn = self.conn()?;
        match conn
            .prepare("SELECT 1 FROM embeddings LIMIT 1")
            .and_then(|mut stmt| stmt.query_row([], |_| Ok(())))
        {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(napi::Error::from_reason(format!("has_embeddings: {e}"))),
        }
    }

    /// Check whether the graph contains any 'implements' edges.
    #[napi]
    pub fn has_implements_edges(&self) -> napi::Result<bool> {
        let conn = self.conn()?;
        match conn
            .prepare("SELECT 1 FROM edges WHERE kind = 'implements' LIMIT 1")
            .and_then(|mut stmt| stmt.query_row([], |_| Ok(())))
        {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(napi::Error::from_reason(format!("has_implements_edges: {e}"))),
        }
    }

    /// Check whether the co_changes table exists and has data.
    #[napi]
    pub fn has_co_changes_table(&self) -> napi::Result<bool> {
        let conn = self.conn()?;
        match conn
            .prepare("SELECT 1 FROM co_changes LIMIT 1")
            .and_then(|mut stmt| stmt.query_row([], |_| Ok(())))
        {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(napi::Error::from_reason(format!("has_co_changes_table: {e}"))),
        }
    }

    /// Look up the stored content hash for a single file.
    #[napi]
    pub fn get_file_hash(&self, file: String) -> napi::Result<Option<String>> {
        let conn = self.conn()?;
        match conn
            .prepare_cached("SELECT hash FROM file_hashes WHERE file = ?1")
            .and_then(|mut stmt| stmt.query_row(rusqlite::params![file], |row| row.get::<_, String>(0)))
        {
            Ok(hash) => Ok(Some(hash)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!("get_file_hash: {e}"))),
        }
    }

    /// Check whether dataflow table exists and has data.
    #[napi]
    pub fn has_dataflow_table(&self) -> napi::Result<bool> {
        let conn = self.conn()?;
        match conn
            .prepare("SELECT COUNT(*) FROM dataflow")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i32>(0)))
        {
            Ok(c) => Ok(c > 0),
            Err(rusqlite::Error::SqliteFailure(_, _)) => Ok(false),
            Err(e) => Err(napi::Error::from_reason(format!("has_dataflow_table: {e}"))),
        }
    }

    /// Get complexity metrics for a node.
    #[napi]
    pub fn get_complexity_for_node(
        &self,
        node_id: i32,
    ) -> napi::Result<Option<NativeComplexityMetrics>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume \
                 FROM function_complexity WHERE node_id = ?1",
            )
            .map_err(|e| {
                napi::Error::from_reason(format!("get_complexity_for_node prepare: {e}"))
            })?;
        match stmt.query_row(params![node_id], |row| {
            Ok(NativeComplexityMetrics {
                cognitive: row.get("cognitive")?,
                cyclomatic: row.get("cyclomatic")?,
                max_nesting: row.get("max_nesting")?,
                maintainability_index: row.get("maintainability_index")?,
                halstead_volume: row.get("halstead_volume")?,
            })
        }) {
            Ok(m) => Ok(Some(m)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(napi::Error::from_reason(format!(
                "get_complexity_for_node: {e}"
            ))),
        }
    }
}

// ── Private helper methods ──────────────────────────────────────────────

impl NativeDatabase {
    /// Shared implementation for list_function_nodes / iterate_function_nodes.
    fn query_function_nodes(
        &self,
        file: Option<String>,
        pattern: Option<String>,
        no_tests: Option<bool>,
    ) -> napi::Result<Vec<NativeNodeRow>> {
        let conn = self.conn()?;

        let mut sql = String::from(
            "SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line, \
                    n.parent_id, n.exported, n.qualified_name, n.scope, n.visibility, n.role \
             FROM nodes n \
             WHERE n.kind IN ('function', 'method', 'class')",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1;

        if let Some(ref f) = file {
            sql.push_str(&format!(" AND n.file LIKE ?{idx} ESCAPE '\\'"));
            param_values.push(Box::new(format!("%{}%", escape_like(f))));
            idx += 1;
        }
        if let Some(ref p) = pattern {
            sql.push_str(&format!(" AND n.name LIKE ?{idx} ESCAPE '\\'"));
            param_values.push(Box::new(format!("%{}%", escape_like(p))));
            idx += 1;
        }
        let _ = idx; // suppress unused warning
        if no_tests.unwrap_or(false) {
            sql.push_str(&format!(" {}", test_filter_clauses("n.file")));
        }
        sql.push_str(" ORDER BY n.file, n.line");

        let mut stmt = conn
            .prepare_cached(&sql)
            .map_err(|e| {
                napi::Error::from_reason(format!("query_function_nodes prepare: {e}"))
            })?;
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(params_ref.as_slice(), read_node_row)
            .map_err(|e| napi::Error::from_reason(format!("query_function_nodes: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                napi::Error::from_reason(format!("query_function_nodes collect: {e}"))
            })
    }

}

// ── Batched query methods ──────────────────────────────────────────────

#[napi]
impl NativeDatabase {
    /// Get all graph statistics in a single napi call.
    /// Replaces ~11 separate queries in module-map.ts `statsData()`.
    #[napi]
    pub fn get_graph_stats(&self, no_tests: bool) -> napi::Result<GraphStats> {
        let conn = self.conn()?;
        let tf = if no_tests {
            test_filter_clauses("file")
        } else {
            String::new()
        };
        let tf_n = if no_tests {
            test_filter_clauses("n.file")
        } else {
            String::new()
        };

        // ── Node counts by kind ────────────────────────────────────
        let nodes_by_kind = {
            let sql = format!(
                "SELECT kind, COUNT(*) as c FROM nodes WHERE 1=1 {} GROUP BY kind",
                tf
            );
            let mut stmt = conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats nodes_by_kind: {e}")))?;
            let rows = stmt.query_map([], |row| {
                Ok(KindCount {
                    kind: row.get::<_, String>(0)?,
                    count: row.get::<_, i32>(1)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats nodes_by_kind query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats nodes_by_kind collect: {e}")))?
        };
        let total_nodes: i32 = nodes_by_kind.iter().map(|k| k.count).sum();

        // ── Edge counts by kind ────────────────────────────────────
        let edges_by_kind = {
            let sql = if no_tests {
                format!(
                    "SELECT e.kind, COUNT(*) as c FROM edges e \
                     JOIN nodes ns ON e.source_id = ns.id \
                     JOIN nodes nt ON e.target_id = nt.id \
                     WHERE 1=1 {} {} GROUP BY e.kind",
                    test_filter_clauses("ns.file"),
                    test_filter_clauses("nt.file"),
                )
            } else {
                "SELECT kind, COUNT(*) as c FROM edges GROUP BY kind".to_string()
            };
            let mut stmt = conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats edges_by_kind: {e}")))?;
            let rows = stmt.query_map([], |row| {
                Ok(KindCount {
                    kind: row.get::<_, String>(0)?,
                    count: row.get::<_, i32>(1)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats edges_by_kind query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats edges_by_kind collect: {e}")))?
        };
        let total_edges: i32 = edges_by_kind.iter().map(|k| k.count).sum();

        // ── Role counts ────────────────────────────────────────────
        let role_counts = {
            let sql = format!(
                "SELECT role, COUNT(*) as c FROM nodes WHERE role IS NOT NULL {} GROUP BY role",
                tf
            );
            let mut stmt = conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats role_counts: {e}")))?;
            let rows = stmt.query_map([], |row| {
                Ok(RoleCount {
                    role: row.get::<_, String>(0)?,
                    count: row.get::<_, i32>(1)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats role_counts query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats role_counts collect: {e}")))?
        };

        // ── Quality metrics ────────────────────────────────────────
        let callable_total: i32 = {
            let sql = format!(
                "SELECT COUNT(*) FROM nodes WHERE kind IN ('function', 'method') {}",
                tf
            );
            conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats callable_total: {e}")))?
                .query_row([], |row| row.get(0))
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats callable_total query: {e}")))?
        };
        let callable_with_callers: i32 = {
            let sql = format!(
                "SELECT COUNT(DISTINCT e.target_id) FROM edges e \
                 JOIN nodes n ON e.target_id = n.id \
                 WHERE e.kind = 'calls' AND n.kind IN ('function', 'method') {}",
                tf_n
            );
            conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats callable_with_callers: {e}")))?
                .query_row([], |row| row.get(0))
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats callable_with_callers query: {e}")))?
        };
        let call_edges: i32 = conn
            .prepare_cached("SELECT COUNT(*) FROM edges WHERE kind = 'calls'")
            .map_err(|e| napi::Error::from_reason(format!("get_graph_stats call_edges: {e}")))?
            .query_row([], |row| row.get(0))
            .map_err(|e| napi::Error::from_reason(format!("get_graph_stats call_edges query: {e}")))?;
        let high_conf_call_edges: i32 = conn
            .prepare_cached("SELECT COUNT(*) FROM edges WHERE kind = 'calls' AND confidence >= 0.7")
            .map_err(|e| napi::Error::from_reason(format!("get_graph_stats high_conf: {e}")))?
            .query_row([], |row| row.get(0))
            .map_err(|e| napi::Error::from_reason(format!("get_graph_stats high_conf query: {e}")))?;

        // ── Hotspots (top 5 files by coupling) ─────────────────────
        let hotspots = {
            let sql = format!(
                "SELECT n.file, \
                 (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as fan_in, \
                 (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as fan_out \
                 FROM nodes n WHERE n.kind = 'file' {} \
                 ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id) \
                        + (SELECT COUNT(*) FROM edges WHERE source_id = n.id) DESC \
                 LIMIT 5",
                tf_n
            );
            let mut stmt = conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats hotspots: {e}")))?;
            let rows = stmt.query_map([], |row| {
                Ok(FileHotspot {
                    file: row.get(0)?,
                    fan_in: row.get(1)?,
                    fan_out: row.get(2)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats hotspots query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats hotspots collect: {e}")))?
        };

        // ── Complexity summary ─────────────────────────────────────
        let complexity = if has_table(conn, "function_complexity") {
            let sql = format!(
                "SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index \
                 FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id \
                 WHERE n.kind IN ('function','method') {}",
                tf_n
            );
            let mut stmt = conn.prepare_cached(&sql)
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats complexity: {e}")))?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, i32>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, f64>(3).unwrap_or(0.0),
                ))
            }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats complexity query: {e}")))?;
            let data: Vec<(i32, i32, i32, f64)> = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats complexity collect: {e}")))?;
            if data.is_empty() {
                None
            } else {
                let n = data.len() as f64;
                let sum_cog: i32 = data.iter().map(|d| d.0).sum();
                let sum_cyc: i32 = data.iter().map(|d| d.1).sum();
                let max_cog = data.iter().map(|d| d.0).max().unwrap_or(0);
                let max_cyc = data.iter().map(|d| d.1).max().unwrap_or(0);
                let sum_mi: f64 = data.iter().map(|d| d.3).sum();
                let min_mi = data.iter().map(|d| d.3).fold(f64::INFINITY, f64::min);
                Some(ComplexitySummary {
                    analyzed: data.len() as i32,
                    avg_cognitive: (sum_cog as f64 / n * 10.0).round() / 10.0,
                    avg_cyclomatic: (sum_cyc as f64 / n * 10.0).round() / 10.0,
                    max_cognitive: max_cog,
                    max_cyclomatic: max_cyc,
                    avg_mi: (sum_mi / n * 10.0).round() / 10.0,
                    min_mi: (min_mi * 10.0).round() / 10.0,
                })
            }
        } else {
            None
        };

        // ── Embeddings info ────────────────────────────────────────
        let embeddings = if has_table(conn, "embeddings") {
            let count: i32 = conn
                .prepare_cached("SELECT COUNT(*) FROM embeddings")
                .map_err(|e| napi::Error::from_reason(format!("get_graph_stats embeddings: {e}")))?
                .query_row([], |row| row.get(0))
                .unwrap_or(0);
            if count > 0 && has_table(conn, "embedding_meta") {
                let mut model: Option<String> = None;
                let mut dim: Option<i32> = None;
                let mut built_at: Option<String> = None;
                let mut stmt = conn
                    .prepare_cached("SELECT key, value FROM embedding_meta")
                    .map_err(|e| napi::Error::from_reason(format!("get_graph_stats embedding_meta: {e}")))?;
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }).map_err(|e| napi::Error::from_reason(format!("get_graph_stats embedding_meta query: {e}")))?;
                for row in rows {
                    if let Ok((k, v)) = row {
                        match k.as_str() {
                            "model" => model = Some(v),
                            "dim" => dim = v.parse().ok(),
                            "built_at" => built_at = Some(v),
                            _ => {}
                        }
                    }
                }
                Some(EmbeddingInfo { count, model, dim, built_at })
            } else if count > 0 {
                Some(EmbeddingInfo { count, model: None, dim: None, built_at: None })
            } else {
                None
            }
        } else {
            None
        };

        Ok(GraphStats {
            total_nodes,
            total_edges,
            nodes_by_kind,
            edges_by_kind,
            role_counts,
            quality: QualityMetrics {
                callable_total,
                callable_with_callers,
                call_edges,
                high_conf_call_edges,
            },
            hotspots,
            complexity,
            embeddings,
        })
    }

    /// Get all 6 directional dataflow edge sets for a node in a single napi call.
    /// Replaces 6 separate db.prepare() calls in dataflow.ts `dataflowData()`.
    #[napi]
    pub fn get_dataflow_edges(&self, node_id: i32) -> napi::Result<DataflowEdgesResult> {
        let conn = self.conn()?;

        if !has_table(conn, "dataflow") {
            return Ok(DataflowEdgesResult {
                flows_to_out: vec![],
                flows_to_in: vec![],
                returns_out: vec![],
                returns_in: vec![],
                mutates_out: vec![],
                mutates_in: vec![],
            });
        }

        fn query_outgoing(
            conn: &rusqlite::Connection,
            node_id: i32,
            kind: &str,
        ) -> napi::Result<Vec<DataflowQueryEdge>> {
            let sql = "SELECT n.name, n.kind, n.file, d.line, d.param_index, d.expression, d.confidence \
                 FROM dataflow d JOIN nodes n ON d.target_id = n.id \
                 WHERE d.source_id = ?1 AND d.kind = ?2";
            let mut stmt = conn.prepare_cached(sql)
                .map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges out {kind}: {e}")))?;
            let rows = stmt.query_map(params![node_id, kind], |row: &rusqlite::Row| {
                Ok(DataflowQueryEdge {
                    name: row.get(0)?,
                    kind: row.get(1)?,
                    file: row.get(2)?,
                    line: row.get(3)?,
                    param_index: row.get(4)?,
                    expression: row.get(5)?,
                    confidence: row.get(6)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges out {kind} query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges out {kind} collect: {e}")))
        }

        fn query_incoming(
            conn: &rusqlite::Connection,
            node_id: i32,
            kind: &str,
        ) -> napi::Result<Vec<DataflowQueryEdge>> {
            let sql = "SELECT n.name, n.kind, n.file, d.line, d.param_index, d.expression, d.confidence \
                 FROM dataflow d JOIN nodes n ON d.source_id = n.id \
                 WHERE d.target_id = ?1 AND d.kind = ?2";
            let mut stmt = conn.prepare_cached(sql)
                .map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges in {kind}: {e}")))?;
            let rows = stmt.query_map(params![node_id, kind], |row: &rusqlite::Row| {
                Ok(DataflowQueryEdge {
                    name: row.get(0)?,
                    kind: row.get(1)?,
                    file: row.get(2)?,
                    line: row.get(3)?,
                    param_index: row.get(4)?,
                    expression: row.get(5)?,
                    confidence: row.get(6)?,
                })
            }).map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges in {kind} query: {e}")))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| napi::Error::from_reason(format!("get_dataflow_edges in {kind} collect: {e}")))
        }

        Ok(DataflowEdgesResult {
            flows_to_out: query_outgoing(conn, node_id, "flows_to")?,
            flows_to_in: query_incoming(conn, node_id, "flows_to")?,
            returns_out: query_outgoing(conn, node_id, "returns")?,
            returns_in: query_incoming(conn, node_id, "returns")?,
            mutates_out: query_outgoing(conn, node_id, "mutates")?,
            mutates_in: query_incoming(conn, node_id, "mutates")?,
        })
    }

    /// Get hotspot rows for a given metric, kind, and limit in a single napi call.
    /// Replaces 4 eagerly-prepared queries in structure-query.ts `hotspotsData()`.
    #[napi]
    pub fn get_hotspots(
        &self,
        kind: String,
        metric: String,
        no_tests: bool,
        limit: i32,
    ) -> napi::Result<Vec<NativeHotspotRow>> {
        let conn = self.conn()?;

        if !has_table(conn, "node_metrics") {
            return Ok(vec![]);
        }

        let test_filter = if no_tests && kind == "file" {
            test_filter_clauses("n.name")
        } else {
            String::new()
        };

        let order_by = match metric.as_str() {
            "fan-out" => "nm.fan_out DESC NULLS LAST",
            "density" => "nm.symbol_count DESC NULLS LAST",
            "coupling" => "(COALESCE(nm.fan_in, 0) + COALESCE(nm.fan_out, 0)) DESC NULLS LAST",
            _ => "nm.fan_in DESC NULLS LAST", // default: fan-in
        };

        let sql = format!(
            "SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, \
             nm.export_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count \
             FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id \
             WHERE n.kind = ?1 {} ORDER BY {} LIMIT ?2",
            test_filter, order_by
        );

        let mut stmt = conn.prepare_cached(&sql)
            .map_err(|e| napi::Error::from_reason(format!("get_hotspots: {e}")))?;
        let rows = stmt.query_map(params![kind, limit], |row| {
            Ok(NativeHotspotRow {
                name: row.get(0)?,
                kind: row.get(1)?,
                line_count: row.get(2)?,
                symbol_count: row.get(3)?,
                import_count: row.get(4)?,
                export_count: row.get(5)?,
                fan_in: row.get(6)?,
                fan_out: row.get(7)?,
                cohesion: row.get(8)?,
                file_count: row.get(9)?,
            })
        }).map_err(|e| napi::Error::from_reason(format!("get_hotspots query: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| napi::Error::from_reason(format!("get_hotspots collect: {e}")))
    }

    /// Batch fan-in/fan-out metrics for multiple node IDs in a single napi call.
    /// Replaces N*2 queries in branch-compare.ts `loadSymbolsFromDb()`.
    #[napi]
    pub fn batch_fan_metrics(&self, node_ids: Vec<i32>) -> napi::Result<Vec<FanMetric>> {
        let conn = self.conn()?;

        let mut fan_in_stmt = conn
            .prepare_cached("SELECT COUNT(*) FROM edges WHERE target_id = ?1 AND kind = 'calls'")
            .map_err(|e| napi::Error::from_reason(format!("batch_fan_metrics fan_in prepare: {e}")))?;
        let mut fan_out_stmt = conn
            .prepare_cached("SELECT COUNT(*) FROM edges WHERE source_id = ?1 AND kind = 'calls'")
            .map_err(|e| napi::Error::from_reason(format!("batch_fan_metrics fan_out prepare: {e}")))?;

        let mut results = Vec::with_capacity(node_ids.len());
        for &nid in &node_ids {
            let fan_in: i32 = fan_in_stmt
                .query_row(params![nid], |row| row.get(0))
                .map_err(|e| napi::Error::from_reason(format!("batch_fan_metrics fan_in query nid={nid}: {e}")))?;
            let fan_out: i32 = fan_out_stmt
                .query_row(params![nid], |row| row.get(0))
                .map_err(|e| napi::Error::from_reason(format!("batch_fan_metrics fan_out query nid={nid}: {e}")))?;
            results.push(FanMetric {
                node_id: nid,
                fan_in,
                fan_out,
            });
        }

        Ok(results)
    }
}
