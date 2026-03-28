//! Read query methods on NativeDatabase — implements all 40 Repository read operations.
//!
//! Uses a second `#[napi] impl NativeDatabase` block (Rust allows multiple impl blocks).
//! All methods use `conn.prepare_cached()` for automatic statement caching.

use std::collections::{HashSet, VecDeque};

use napi_derive::napi;
use rusqlite::params;

use crate::native_db::NativeDatabase;
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
            Err(_) => Ok(false),
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
            Err(_) => Ok(false),
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
            Err(_) => Ok(false),
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
