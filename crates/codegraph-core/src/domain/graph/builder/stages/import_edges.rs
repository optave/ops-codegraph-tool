//! Import edge building and barrel file resolution.
//!
//! Ports the import-edge construction from `build-edges.ts:buildImportEdges()`,
//! the barrel detection from `resolve-imports.ts:isBarrelFile()`, and the
//! recursive barrel export resolution from `resolveBarrelExport()`.

use crate::domain::graph::builder::barrel_resolution::{self, BarrelContext, ReexportRef};
use crate::domain::graph::resolve;
use crate::types::{FileSymbols, PathAliases, RenamedImport};
use rusqlite::Connection;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// A resolved reexport entry for a barrel file.
#[derive(Debug, Clone)]
pub struct ReexportEntry {
    pub source: String,
    pub names: Vec<String>,
    pub wildcard_reexport: bool,
    /// `{ local, imported }` pairs for `export { X as Y } from …` specifiers
    /// within this entry — see `barrel_resolution::ReexportRef::renames` (#1823).
    pub renames: Vec<RenamedImport>,
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
    pub file_symbols: BTreeMap<String, FileSymbols>,
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
        resolve::resolve_import_path(
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
    ) -> Option<barrel_resolution::BarrelResolution> {
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
                    renames: &re.renames,
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

/// Pairs each locally-bound name from an import statement with its original
/// (pre-rename) exported name — identical to the local name unless the
/// specifier renames a binding (`import { X as Y }`). Barrel tracing and
/// target-file symbol lookups must search using the *original* name — the
/// renamed local alias only exists in the importing file, not in the file
/// being imported from (#1730). Mirrors `importNamePairs` in build-edges.ts.
///
/// Also reports, per name, whether it should be treated as type-only —
/// either because the whole statement is (`import type { X }`) or because
/// this specific specifier carries the inline modifier
/// (`import { type X }`, #1813).
pub(crate) fn import_name_pairs(imp: &crate::types::Import) -> Vec<(String, String, bool)> {
    let mut original_name_for: HashMap<&str, &str> = HashMap::new();
    if let Some(renamed) = &imp.renamed_imports {
        for r in renamed {
            original_name_for.insert(&r.local, &r.imported);
        }
    }
    let statement_type_only = imp.type_only.unwrap_or(false);
    let type_only_names: HashSet<&str> = imp
        .type_only_names
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    imp.names
        .iter()
        .map(|name| {
            let local = name.strip_prefix("* as ").unwrap_or(name);
            let original = original_name_for.get(local).copied().unwrap_or(local);
            let type_only = statement_type_only || type_only_names.contains(local);
            (local.to_string(), original.to_string(), type_only)
        })
        .collect()
}

/// True when an import carries any type-only signal — a whole-statement
/// `import type { X }` or at least one inline per-specifier `type` modifier
/// (`import { type X }`, #1813).
fn has_type_only_names(imp: &crate::types::Import) -> bool {
    imp.type_only.unwrap_or(false)
        || imp
            .type_only_names
            .as_ref()
            .is_some_and(|names| !names.is_empty())
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
                    renames: imp.renamed_imports.clone().unwrap_or_default(),
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

/// True for a named (non-wildcard) re-export — `export { X } from 'Y'` or
/// `export { X as Z } from 'Y'`. Wildcard re-exports (`export * from 'Y'`)
/// carry no specific names, so they're excluded here and handled instead by
/// the file-level `reexports` edge + the query layer's full-export fallback.
fn is_named_reexport(imp: &crate::types::Import) -> bool {
    imp.reexport.unwrap_or(false) && !imp.wildcard_reexport.unwrap_or(false)
}

/// Walk type-only imports and named re-exports in `ctx.file_symbols` and
/// return the distinct `(name, file)` pairs that `build_import_edges` will
/// need to look up. Resolves barrel files the same way the edge-building
/// loop does so the pre-computed set matches the actual lookup keys.
/// Shared by symbol-level `imports-type` (#1724) and `reexports` (#1742)
/// edges — both name specific symbols requiring a (name, file) → node-id
/// lookup.
fn collect_symbol_lookup_pairs(ctx: &ImportEdgeContext) -> HashSet<(String, String)> {
    let mut pairs = HashSet::new();
    for (rel_path, symbols) in &ctx.file_symbols {
        let abs_file = Path::new(&ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
        for imp in &symbols.imports {
            let is_reexport = is_named_reexport(imp);
            if !has_type_only_names(imp) && !is_reexport {
                continue;
            }
            let resolved_path = ctx.get_resolved(abs_str, &imp.source);
            for (_local, original, type_only) in import_name_pairs(imp) {
                if !is_reexport && !type_only {
                    continue;
                }
                let mut target_file = resolved_path.clone();
                let mut target_name = original;
                if ctx.is_barrel_file(&resolved_path) {
                    let mut visited = HashSet::new();
                    if let Some(resolved) =
                        ctx.resolve_barrel_export(&resolved_path, &target_name, &mut visited)
                    {
                        target_file = resolved.file;
                        target_name = resolved.name;
                    }
                }
                pairs.insert((target_name, target_file));
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
/// Classify an `ImportInfo` into the edge kind name used in the edges
/// table: reexports / imports-type / dynamic-imports / imports.
fn classify_import_kind(imp: &crate::types::Import) -> &'static str {
    if imp.reexport.unwrap_or(false) {
        "reexports"
    } else if imp.type_only.unwrap_or(false) {
        "imports-type"
    } else if imp.dynamic_import.unwrap_or(false) {
        "dynamic-imports"
    } else {
        "imports"
    }
}

/// For a `type` import or a named re-export, emit one symbol-level edge per
/// name so the target symbols receive fan-in credit and aren't classified
/// dead (`imports-type`, #1724), or so `codegraph exports` can report the
/// precise re-export surface instead of the target's full export list
/// (`reexports`, #1742). `kind` selects which edge kind to emit.
///
/// For `kind == "imports-type"`, only specifiers actually marked type-only
/// (whole-statement or inline per-specifier, #1813) get an edge — a mixed
/// `import { value, type Foo }` must not credit `value`.
fn emit_named_symbol_rows(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    imp: &crate::types::Import,
    resolved_path: &str,
    kind: &str,
    ctx: &ImportEdgeContext,
    symbol_node_ids: &HashMap<(String, String), i64>,
) {
    for (_local, original, type_only) in import_name_pairs(imp) {
        if kind == "imports-type" && !type_only {
            continue;
        }
        let mut target_file = resolved_path.to_string();
        let mut target_name = original;
        if ctx.is_barrel_file(resolved_path) {
            let mut visited = HashSet::new();
            if let Some(resolved) =
                ctx.resolve_barrel_export(resolved_path, &target_name, &mut visited)
            {
                target_file = resolved.file;
                target_name = resolved.name;
            }
        }
        if let Some(&sym_id) = symbol_node_ids.get(&(target_name, target_file)) {
            edges.push(EdgeRow {
                source_id: file_node_id,
                target_id: sym_id,
                kind: kind.to_string(),
                confidence: 1.0,
                dynamic: 0,
            });
        }
    }
}

/// For a non-reexport import targeting a barrel file, emit `imports`-like
/// edges to each ultimate definition file reached through the barrel chain.
fn emit_barrel_through_rows(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    imp: &crate::types::Import,
    resolved_path: &str,
    edge_kind: &str,
    ctx: &ImportEdgeContext,
    file_node_ids: &HashMap<String, i64>,
) {
    let is_reexport = imp.reexport.unwrap_or(false);
    if is_reexport || !ctx.is_barrel_file(resolved_path) {
        return;
    }
    let through_kind = match edge_kind {
        "imports-type" => "imports-type",
        "dynamic-imports" => "dynamic-imports",
        _ => "imports",
    };
    let mut resolved_sources: HashSet<String> = HashSet::new();
    for (_local, original, _type_only) in import_name_pairs(imp) {
        let mut visited = HashSet::new();
        let actual_source = match ctx.resolve_barrel_export(resolved_path, &original, &mut visited)
        {
            Some(resolved) => resolved.file,
            None => continue,
        };
        if actual_source == resolved_path || !resolved_sources.insert(actual_source.clone()) {
            continue;
        }
        if let Some(&actual_id) = file_node_ids.get(&actual_source) {
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

/// Emit all edges produced by a single import on a single source file.
fn emit_edges_for_import(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    abs_str: &str,
    imp: &crate::types::Import,
    is_barrel_only: bool,
    ctx: &ImportEdgeContext,
    file_node_ids: &HashMap<String, i64>,
    symbol_node_ids: &HashMap<(String, String), i64>,
) {
    let is_reexport = imp.reexport.unwrap_or(false);
    if is_barrel_only && !is_reexport {
        return;
    }
    let resolved_path = ctx.get_resolved(abs_str, &imp.source);
    let target_id = match file_node_ids.get(&resolved_path) {
        Some(&id) => id,
        None => return,
    };
    let edge_kind = classify_import_kind(imp);
    edges.push(EdgeRow {
        source_id: file_node_id,
        target_id,
        kind: edge_kind.to_string(),
        confidence: 1.0,
        dynamic: 0,
    });
    if has_type_only_names(imp) {
        emit_named_symbol_rows(
            edges,
            file_node_id,
            imp,
            &resolved_path,
            "imports-type",
            ctx,
            symbol_node_ids,
        );
    }
    if is_named_reexport(imp) {
        emit_named_symbol_rows(
            edges,
            file_node_id,
            imp,
            &resolved_path,
            "reexports",
            ctx,
            symbol_node_ids,
        );
    }
    emit_barrel_through_rows(
        edges,
        file_node_id,
        imp,
        &resolved_path,
        edge_kind,
        ctx,
        file_node_ids,
    );
}

pub fn build_import_edges(conn: &Connection, ctx: &ImportEdgeContext) -> Vec<EdgeRow> {
    let mut edges = Vec::new();

    let file_node_ids = load_file_node_ids(conn);
    let needed_symbol_pairs = collect_symbol_lookup_pairs(ctx);
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
            // CJS require bindings feed imported_names for receiver-edge resolution
            // but must not produce DB import edges (#1678).
            if imp.cjs_require.unwrap_or(false) { continue; }
            emit_edges_for_import(
                &mut edges,
                file_node_id,
                abs_str,
                imp,
                is_barrel_only,
                ctx,
                &file_node_ids,
                &symbol_node_ids,
            );
        }
    }

    edges
}

/// 199 rows × 5 params = 995 bind parameters, safely under the legacy
/// `SQLITE_MAX_VARIABLE_NUMBER` default of 999. Mirrors `edges::CHUNK`.
const INSERT_CHUNK: usize = 199;

/// Batch insert edges into the database using multi-row VALUES chunks.
///
/// Replaces the previous one-prepared-statement-per-row pattern that paid a
/// per-edge bind/step/reset cycle. With the chunked path each chunk runs a
/// single VM execution against a freshly prepared statement (#1013).
///
/// Every failure mode — transaction-start, a chunk's bind/execute, and
/// commit — is both logged to stderr for immediate diagnosis and returned to
/// the caller as `Err` (#1827). A single malformed chunk still doesn't
/// sacrifice every other edge in the batch: it's skipped so the remaining
/// chunks commit, but the `Err` return means `run_pipeline` finds out the
/// edge set is incomplete instead of reporting a silently "successful"
/// build — which also keeps `file_hashes` from being advanced over
/// incomplete data (#1731).
pub fn insert_edges(conn: &Connection, edges: &[EdgeRow]) -> Result<(), String> {
    if edges.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| {
        let msg = format!("insert_edges: failed to start transaction: {e}");
        eprintln!("[codegraph] {msg}");
        msg
    })?;

    let mut total_chunks = 0usize;
    let mut chunk_failures: Vec<String> = Vec::new();
    for chunk in edges.chunks(INSERT_CHUNK) {
        total_chunks += 1;
        if let Err(e) = insert_edge_chunk(&tx, chunk) {
            let msg = format!("chunk of {} row(s): {e}", chunk.len());
            eprintln!("[codegraph] insert_edges: skipped {msg}");
            chunk_failures.push(msg);
        }
    }

    tx.commit().map_err(|e| {
        let msg = format!("insert_edges: commit failed: {e}");
        eprintln!("[codegraph] {msg}");
        msg
    })?;

    if !chunk_failures.is_empty() {
        return Err(format!(
            "insert_edges: {} of {total_chunks} chunk(s) failed to insert: {}",
            chunk_failures.len(),
            chunk_failures.join("; ")
        ));
    }
    Ok(())
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
            return_type_map: vec![],
            call_assignments: vec![],
            ast_nodes: vec![],
            dataflow: None,
            line_count: None,
            fn_ref_bindings: vec![],
            param_bindings: vec![],
            this_call_bindings: vec![],
            array_elem_bindings: vec![],
            spread_arg_bindings: vec![],
            for_of_bindings: vec![],
            array_callback_bindings: vec![],
            object_rest_param_bindings: vec![],
            object_prop_bindings: vec![],
        }
    }

    #[test]
    fn barrel_detection() {
        let mut file_symbols = BTreeMap::new();
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

    #[test]
    fn import_name_pairs_flags_inline_per_specifier_type_only_names() {
        // `import { value, type Foo } from './mixed'` — only `Foo` carries the
        // inline modifier, so only its pair should report `type_only = true` (#1813).
        let mut imp = Import::new(
            "./mixed".to_string(),
            vec!["value".to_string(), "Foo".to_string()],
            1,
        );
        imp.type_only_names = Some(vec!["Foo".to_string()]);

        let pairs = import_name_pairs(&imp);
        assert_eq!(
            pairs,
            vec![
                ("value".to_string(), "value".to_string(), false),
                ("Foo".to_string(), "Foo".to_string(), true),
            ]
        );
    }

    #[test]
    fn import_name_pairs_whole_statement_type_only_flags_all_names() {
        // `import type { A, B } from './types'` — every name is type-only,
        // regardless of `type_only_names` (which stays unset for this form).
        let mut imp = Import::new(
            "./types".to_string(),
            vec!["A".to_string(), "B".to_string()],
            1,
        );
        imp.type_only = Some(true);

        let pairs = import_name_pairs(&imp);
        assert!(pairs.iter().all(|(_, _, type_only)| *type_only));
    }

    #[test]
    fn import_name_pairs_plain_value_import_flags_no_names() {
        let imp = Import::new(
            "./utils".to_string(),
            vec!["helper".to_string()],
            1,
        );

        let pairs = import_name_pairs(&imp);
        assert!(pairs.iter().all(|(_, _, type_only)| !*type_only));
    }

    /// Minimal in-memory `edges` schema covering only the columns
    /// `insert_edge_chunk` writes.
    fn edges_test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE edges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                target_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                dynamic INTEGER DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    fn sample_edge_row() -> EdgeRow {
        EdgeRow {
            source_id: 1,
            target_id: 2,
            kind: "imports".to_string(),
            confidence: 1.0,
            dynamic: 0,
        }
    }

    #[test]
    fn insert_edges_commits_rows_and_returns_ok_on_success() {
        let conn = edges_test_conn();
        let result = insert_edges(&conn, &[sample_edge_row()]);
        assert!(result.is_ok(), "expected Ok, got {result:?}");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_edges_returns_ok_for_an_empty_batch() {
        let conn = edges_test_conn();
        assert!(insert_edges(&conn, &[]).is_ok());
    }

    /// Regression test for #1827: a transaction-start failure must surface
    /// as `Err`, not be swallowed behind a stderr-only warning while the
    /// caller sees nothing (`run_pipeline` previously ignored this entirely).
    #[test]
    fn insert_edges_returns_err_when_transaction_cannot_start() {
        let conn = edges_test_conn();
        // SQLite refuses to start a second transaction on a connection that
        // already has one active — a reliable way to force
        // `conn.unchecked_transaction()` to fail deterministically.
        conn.execute_batch("BEGIN").unwrap();

        let result = insert_edges(&conn, &[sample_edge_row()]);
        assert!(
            result.is_err(),
            "insert_edges must return Err instead of silently no-op'ing when the transaction can't start"
        );

        conn.execute_batch("ROLLBACK").unwrap();
    }
}
