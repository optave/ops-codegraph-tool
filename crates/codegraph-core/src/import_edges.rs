//! Import edge building and barrel file resolution.
//!
//! Ports the import-edge construction from `build-edges.ts:buildImportEdges()`,
//! the barrel detection from `resolve-imports.ts:isBarrelFile()`, and the
//! recursive barrel export resolution from `resolveBarrelExport()`.

use crate::barrel_resolution::{self, BarrelContext, ReexportRef};
use crate::import_resolution;
use crate::types::{FileSymbols, PathAliases};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// A resolved reexport entry for a barrel file.
#[derive(Debug, Clone)]
pub struct ReexportEntry {
    pub source: String,
    pub names: Vec<String>,
    pub wildcard_reexport: bool,
}

/// Context for import edge building — holds resolved imports, reexport map, and file symbols.
pub struct ImportEdgeContext {
    /// Map of "absFile|importSource" -> resolved relative path.
    pub batch_resolved: HashMap<String, String>,
    /// Map of relPath -> reexport entries.
    pub reexport_map: HashMap<String, Vec<ReexportEntry>>,
    /// Set of files that are barrel-only (reexport count >= definition count).
    pub barrel_only_files: HashSet<String>,
    /// Parsed symbols per relative path.
    pub file_symbols: HashMap<String, FileSymbols>,
    /// Root directory.
    pub root_dir: String,
    /// Path aliases.
    pub aliases: PathAliases,
    /// All known file paths (for resolution).
    pub known_files: HashSet<String>,
}

/// An edge to insert into the database.
#[derive(Debug, Clone)]
pub struct EdgeRow {
    pub source_id: i64,
    pub target_id: i64,
    pub kind: String,
    pub confidence: f64,
    pub dynamic: i32,
}

impl ImportEdgeContext {
    /// Resolve an import source to a relative path, using batch cache first.
    pub fn get_resolved(&self, abs_file: &str, import_source: &str) -> String {
        // Normalize to forward slashes so cache keys match across platforms (#826).
        let normalized = abs_file.replace('\\', "/");
        let key = format!("{normalized}|{import_source}");
        if let Some(hit) = self.batch_resolved.get(&key) {
            return hit.clone();
        }
        import_resolution::resolve_import_path(
            abs_file,
            import_source,
            &self.root_dir,
            &self.aliases,
        )
    }

    /// Check if a file is a barrel file (reexport count >= definition count).
    pub fn is_barrel_file(&self, rel_path: &str) -> bool {
        let symbols = match self.file_symbols.get(rel_path) {
            Some(s) => s,
            None => return false,
        };
        let reexport_count = symbols
            .imports
            .iter()
            .filter(|imp| imp.reexport.unwrap_or(false))
            .count();
        if reexport_count == 0 {
            return false;
        }
        reexport_count >= symbols.definitions.len()
    }

    /// Recursively resolve a barrel export to its actual source file.
    ///
    /// Delegates to the shared [`barrel_resolution::resolve_barrel_export`] algorithm.
    pub fn resolve_barrel_export(
        &self,
        barrel_path: &str,
        symbol_name: &str,
        visited: &mut HashSet<String>,
    ) -> Option<String> {
        barrel_resolution::resolve_barrel_export(self, barrel_path, symbol_name, visited)
    }
}

impl BarrelContext for ImportEdgeContext {
    fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>> {
        self.reexport_map.get(barrel_path).map(|entries| {
            entries
                .iter()
                .map(|re| ReexportRef {
                    source: re.source.as_str(),
                    names: &re.names,
                    wildcard_reexport: re.wildcard_reexport,
                })
                .collect()
        })
    }

    fn has_definition(&self, file_path: &str, symbol: &str) -> bool {
        self.file_symbols
            .get(file_path)
            .map_or(false, |s| s.definitions.iter().any(|d| d.name == symbol))
    }
}

/// Build the reexport map from parsed file symbols.
pub fn build_reexport_map(ctx: &ImportEdgeContext) -> HashMap<String, Vec<ReexportEntry>> {
    let mut reexport_map = HashMap::new();
    for (rel_path, symbols) in &ctx.file_symbols {
        let reexports: Vec<&crate::types::Import> = symbols
            .imports
            .iter()
            .filter(|imp| imp.reexport.unwrap_or(false))
            .collect();

        if !reexports.is_empty() {
            let abs_file = Path::new(&ctx.root_dir).join(rel_path);
            let abs_str = abs_file.to_str().unwrap_or("");
            let entries: Vec<ReexportEntry> = reexports
                .iter()
                .map(|imp| ReexportEntry {
                    source: ctx.get_resolved(abs_str, &imp.source),
                    names: imp.names.clone(),
                    wildcard_reexport: imp.wildcard_reexport.unwrap_or(false),
                })
                .collect();
            reexport_map.insert(rel_path.clone(), entries);
        }
    }
    reexport_map
}

/// Detect barrel-only files (files where reexport count >= definition count).
pub fn detect_barrel_only_files(ctx: &ImportEdgeContext) -> HashSet<String> {
    let mut barrel_only = HashSet::new();
    for rel_path in ctx.file_symbols.keys() {
        if ctx.is_barrel_file(rel_path) {
            barrel_only.insert(rel_path.clone());
        }
    }
    barrel_only
}

/// Load every file node ID into a HashMap in one query — replaces per-import
/// `conn.query_row` lookups that paid the SQLite prepare/execute cycle on each
/// call (#1013).
///
/// Includes the explicit `name = file` predicate that matched the legacy
/// per-row lookup (`WHERE name = ? AND file = ?` with both binds set to
/// `rel_path`). For file-kind nodes `name` and `file` are conventionally
/// identical, but keeping the guard prevents an unrelated row from silently
/// overwriting the map entry for `file`.
fn load_file_node_ids(conn: &Connection) -> HashMap<String, i64> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT file, id FROM nodes WHERE kind = 'file' AND line = 0 AND name = file",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            for r in rows.flatten() {
                map.insert(r.0, r.1);
            }
        }
    }
    map
}

/// Load symbol node IDs for the supplied `(name, file)` pairs in one chunked
/// query. Mirrors the JS `nodesByNameAndFile` lookup map; preserves the
/// first-row semantics of the legacy `LIMIT 1` query by keeping the first ID
/// seen per key.
///
/// The pairs are pre-computed by walking the type-only imports in
/// `ctx.file_symbols`, so we never scan the entire `nodes` table — even on
/// monorepos with 100k+ symbols, only the small slice actually referenced by
/// type-only imports is hit (#1013, #1028 review).
fn load_symbol_node_ids(
    conn: &Connection,
    needed_pairs: &HashSet<(String, String)>,
) -> HashMap<(String, String), i64> {
    let mut map: HashMap<(String, String), i64> = HashMap::new();
    if needed_pairs.is_empty() {
        return map;
    }

    // 332 pairs × 2 params + 1 spare = 665 binds, comfortably under
    // `SQLITE_MAX_VARIABLE_NUMBER`'s legacy 999 default.
    const SYMBOL_LOOKUP_CHUNK: usize = 332;

    let pairs: Vec<&(String, String)> = needed_pairs.iter().collect();
    for chunk in pairs.chunks(SYMBOL_LOOKUP_CHUNK) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let base = i * 2;
                format!("(?{},?{})", base + 1, base + 2)
            })
            .collect();
        let sql = format!(
            "SELECT name, file, id FROM nodes WHERE kind != 'file' AND (name, file) IN ({})",
            placeholders.join(",")
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for (name, file) in chunk {
            params.push(name);
            params.push(file);
        }

        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            }) {
                for r in rows.flatten() {
                    map.entry((r.0, r.1)).or_insert(r.2);
                }
            }
        }
    }
    map
}

/// Walk type-only imports in `ctx.file_symbols` and return the distinct
/// `(name, file)` pairs that `build_import_edges` will need to look up.
/// Resolves barrel files the same way the edge-building loop does so the
/// pre-computed set matches the actual lookup keys.
fn collect_type_only_lookup_pairs(ctx: &ImportEdgeContext) -> HashSet<(String, String)> {
    let mut pairs = HashSet::new();
    for (rel_path, symbols) in &ctx.file_symbols {
        let abs_file = Path::new(&ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
        for imp in &symbols.imports {
            if !imp.type_only.unwrap_or(false) {
                continue;
            }
            let resolved_path = ctx.get_resolved(abs_str, &imp.source);
            for name in &imp.names {
                let clean_name = name.strip_prefix("* as ").unwrap_or(name);
                let mut target_file = resolved_path.clone();
                if ctx.is_barrel_file(&resolved_path) {
                    let mut visited = HashSet::new();
                    if let Some(actual) =
                        ctx.resolve_barrel_export(&resolved_path, clean_name, &mut visited)
                    {
                        target_file = actual;
                    }
                }
                pairs.insert((clean_name.to_string(), target_file));
            }
        }
    }
    pairs
}

/// Build import edges from parsed file symbols.
///
/// For each file's imports, resolves the target path and creates edges:
/// - `imports` for regular imports
/// - `imports-type` for type-only imports
/// - `dynamic-imports` for dynamic imports
/// - `reexports` for re-exports
///
/// Also creates barrel-through edges (confidence 0.9) for imports targeting barrel files.
pub fn build_import_edges(conn: &Connection, ctx: &ImportEdgeContext) -> Vec<EdgeRow> {
    let mut edges = Vec::new();

    // Pre-load all file node IDs once. Previously this was N x query_row,
    // each of which ran a fresh sqlite3_prepare/step/finalize cycle (#1013).
    let file_node_ids = load_file_node_ids(conn);
    // Only the symbols actually referenced by type-only imports are needed —
    // skip the lookup entirely when no type-only imports exist (the common
    // case), and otherwise issue a chunked `(name, file) IN (...)` query so
    // memory stays bounded even on large monorepos (#1028 review).
    let needed_symbol_pairs = collect_type_only_lookup_pairs(ctx);
    let symbol_node_ids = if needed_symbol_pairs.is_empty() {
        HashMap::new()
    } else {
        load_symbol_node_ids(conn, &needed_symbol_pairs)
    };

    for (rel_path, symbols) in &ctx.file_symbols {
        let is_barrel_only = ctx.barrel_only_files.contains(rel_path);
        let file_node_id = match file_node_ids.get(rel_path) {
            Some(&id) => id,
            None => continue,
        };

        let abs_file = Path::new(&ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");

        for imp in &symbols.imports {
            let is_reexport = imp.reexport.unwrap_or(false);
            // Barrel-only files: only emit reexport edges, skip regular imports
            if is_barrel_only && !is_reexport {
                continue;
            }

            let resolved_path = ctx.get_resolved(abs_str, &imp.source);
            let target_id = match file_node_ids.get(&resolved_path) {
                Some(&id) => id,
                None => continue,
            };

            let edge_kind = if is_reexport {
                "reexports"
            } else if imp.type_only.unwrap_or(false) {
                "imports-type"
            } else if imp.dynamic_import.unwrap_or(false) {
                "dynamic-imports"
            } else {
                "imports"
            };

            edges.push(EdgeRow {
                source_id: file_node_id,
                target_id,
                kind: edge_kind.to_string(),
                confidence: 1.0,
                dynamic: 0,
            });

            // Type-only imports: create symbol-level edges so the target symbols
            // get fan-in credit and aren't falsely classified as dead code.
            if imp.type_only.unwrap_or(false) {
                for name in &imp.names {
                    let clean_name = name.strip_prefix("* as ").unwrap_or(name);
                    let mut target_file = resolved_path.clone();
                    if ctx.is_barrel_file(&resolved_path) {
                        let mut visited = HashSet::new();
                        if let Some(actual) = ctx.resolve_barrel_export(&resolved_path, clean_name, &mut visited) {
                            target_file = actual;
                        }
                    }
                    if let Some(&sym_id) =
                        symbol_node_ids.get(&(clean_name.to_string(), target_file))
                    {
                        edges.push(EdgeRow {
                            source_id: file_node_id,
                            target_id: sym_id,
                            kind: "imports-type".to_string(),
                            confidence: 1.0,
                            dynamic: 0,
                        });
                    }
                }
            }

            // Build barrel-through edges if the target is a barrel file
            if !is_reexport && ctx.is_barrel_file(&resolved_path) {
                let mut resolved_sources = HashSet::new();
                for name in &imp.names {
                    let clean_name = name.strip_prefix("* as ").unwrap_or(name);
                    let mut visited = HashSet::new();
                    if let Some(actual_source) =
                        ctx.resolve_barrel_export(&resolved_path, clean_name, &mut visited)
                    {
                        if actual_source != resolved_path
                            && resolved_sources.insert(actual_source.clone())
                        {
                            if let Some(&actual_id) = file_node_ids.get(&actual_source) {
                                let through_kind = match edge_kind {
                                    "imports-type" => "imports-type",
                                    "dynamic-imports" => "dynamic-imports",
                                    _ => "imports",
                                };
                                edges.push(EdgeRow {
                                    source_id: file_node_id,
                                    target_id: actual_id,
                                    kind: through_kind.to_string(),
                                    confidence: 0.9,
                                    dynamic: 0,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    edges
}

/// 199 rows × 5 params = 995 bind parameters, safely under the legacy
/// `SQLITE_MAX_VARIABLE_NUMBER` default of 999. Mirrors `edges_db::CHUNK`.
const INSERT_CHUNK: usize = 199;

/// Batch insert edges into the database using multi-row VALUES chunks.
///
/// Replaces the previous one-prepared-statement-per-row pattern that paid a
/// per-edge bind/step/reset cycle. With the chunked path each chunk runs a
/// single VM execution against a freshly prepared statement (#1013).
///
/// Bind/execute errors are surfaced via a stderr warning and the offending
/// chunk is skipped — silently swallowing them previously could produce
/// `NULL` columns in the inserted edge rows.
pub fn insert_edges(conn: &Connection, edges: &[EdgeRow]) {
    if edges.is_empty() {
        return;
    }
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(e) => {
            eprintln!("[codegraph] insert_edges: failed to start transaction: {e}");
            return;
        }
    };

    for chunk in edges.chunks(INSERT_CHUNK) {
        if let Err(e) = insert_edge_chunk(&tx, chunk) {
            eprintln!(
                "[codegraph] insert_edges: skipped chunk of {} rows due to error: {e}",
                chunk.len()
            );
        }
    }
    if let Err(e) = tx.commit() {
        eprintln!("[codegraph] insert_edges: commit failed: {e}");
    }
}

/// Bind and execute a single chunk in its own fallible scope so the caller
/// can log the failure and continue with the next chunk.
///
/// `prepare` (not `prepare_cached`) is used because the SQL string varies
/// with chunk length — caching keyed on dynamic SQL would churn the LRU
/// for every partial trailing chunk and obscure the intent of the cache.
fn insert_edge_chunk(
    tx: &rusqlite::Transaction<'_>,
    chunk: &[EdgeRow],
) -> rusqlite::Result<()> {
    let placeholders: Vec<String> = (0..chunk.len())
        .map(|i| {
            let base = i * 5;
            format!(
                "(?{},?{},?{},?{},?{})",
                base + 1,
                base + 2,
                base + 3,
                base + 4,
                base + 5
            )
        })
        .collect();
    let sql = format!(
        "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES {}",
        placeholders.join(",")
    );
    let mut stmt = tx.prepare(&sql)?;
    for (i, edge) in chunk.iter().enumerate() {
        let base = i * 5;
        stmt.raw_bind_parameter(base + 1, edge.source_id)?;
        stmt.raw_bind_parameter(base + 2, edge.target_id)?;
        stmt.raw_bind_parameter(base + 3, edge.kind.as_str())?;
        stmt.raw_bind_parameter(base + 4, edge.confidence)?;
        stmt.raw_bind_parameter(base + 5, edge.dynamic)?;
    }
    stmt.raw_execute()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Definition, Import};

    fn make_symbols(defs: Vec<&str>, reexport_imports: Vec<&str>) -> FileSymbols {
        FileSymbols {
            file: "test.ts".to_string(),
            definitions: defs
                .into_iter()
                .map(|name| Definition {
                    name: name.to_string(),
                    kind: "function".to_string(),
                    line: 1,
                    end_line: None,
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                })
                .collect(),
            imports: reexport_imports
                .into_iter()
                .map(|src| {
                    let mut imp = Import::new(src.to_string(), vec![], 1);
                    imp.reexport = Some(true);
                    imp.wildcard_reexport = Some(true);
                    imp
                })
                .collect(),
            calls: vec![],
            classes: vec![],
            exports: vec![],
            type_map: vec![],
            ast_nodes: vec![],
            dataflow: None,
            line_count: None,
        }
    }

    #[test]
    fn barrel_detection() {
        let mut file_symbols = HashMap::new();
        // 1 def, 2 reexports → barrel
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec!["helper"], vec!["./a", "./b"]),
        );
        // 3 defs, 1 reexport → not barrel
        file_symbols.insert(
            "src/utils.ts".to_string(),
            make_symbols(vec!["foo", "bar", "baz"], vec!["./c"]),
        );

        let ctx = ImportEdgeContext {
            batch_resolved: HashMap::new(),
            reexport_map: HashMap::new(),
            barrel_only_files: HashSet::new(),
            file_symbols,
            root_dir: "/project".to_string(),
            aliases: PathAliases {
                base_url: None,
                paths: vec![],
            },
            known_files: HashSet::new(),
        };

        assert!(ctx.is_barrel_file("src/index.ts"));
        assert!(!ctx.is_barrel_file("src/utils.ts"));
        assert!(!ctx.is_barrel_file("nonexistent.ts"));
    }
}
