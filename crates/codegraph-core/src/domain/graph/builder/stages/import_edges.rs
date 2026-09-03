//! Import edge building and barrel file resolution.
//!
//! Ports the import-edge construction from `build-edges.ts:buildImportEdges()`,
//! the barrel detection from `resolve-imports.ts:isBarrelFile()`, and the
//! recursive barrel export resolution from `resolveBarrelExport()`.

use crate::domain::graph::builder::barrel_resolution::{self, BarrelContext, ReexportRef};
use crate::domain::graph::resolve;
use crate::shared::constants::{is_type_erased_import_target, TYPESCRIPT_EXTENSIONS};
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
    /// Set of files that are barrel-only (reexport count > definition count).
    pub barrel_only_files: HashSet<String>,
    /// Parsed symbols per relative path.
    pub file_symbols: BTreeMap<String, FileSymbols>,
    /// Root directory.
    pub root_dir: String,
    /// Path aliases.
    pub aliases: PathAliases,
    /// All known file paths (for resolution).
    pub known_files: HashSet<String>,
    /// Monorepo workspace packages, keyed by package name (issue #1927).
    pub workspaces: HashMap<String, resolve::WorkspaceEntry>,
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
            Some(&self.known_files),
            Some(&self.workspaces),
        )
    }

    /// Check if a file is a barrel file (reexport count strictly exceeds
    /// definition count). Strict `>`, not `>=` (issue #2339): a file with
    /// exactly one reexport and one own definition is a genuine hybrid (real
    /// logic plus a reexport), not a pure barrel — `>=` misclassified it as
    /// barrel-only, silently dropping its own outgoing call/receiver edges
    /// whenever it got pulled into Stage 6b's barrel-candidate reparse. This
    /// is orthogonal to #1848's fix, which scopes *which files* are even
    /// eligible for this check (only transient barrel-candidate reparses,
    /// never a file genuinely part of this build's changed set) — not the
    /// comparison itself.
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
        reexport_count > symbols.definitions.len()
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
            .is_some_and(|s| s.definitions.iter().any(|d| d.name == symbol))
    }
}

/// Adapter over the two distinct "import statement" Rust representations in
/// this crate that [`import_name_pairs`] needs to read from: the native
/// orchestrator's own parsed `crate::types::Import`, and the FFI-facing
/// `ImportInfo` wire struct the hybrid native path (`build_edges.rs`)
/// deserializes from JS. Both mirror TS `Import` — this trait exists only so
/// `import_name_pairs` has one implementation instead of being duplicated
/// per Rust type, since the two structs differ in `Option` wrapping.
pub(crate) trait ImportNameSource {
    fn names(&self) -> &[String];
    fn renamed_imports(&self) -> &[RenamedImport];
    fn is_type_only(&self) -> bool;
    fn type_only_names(&self) -> &[String];
}

impl ImportNameSource for crate::types::Import {
    fn names(&self) -> &[String] {
        &self.names
    }
    fn renamed_imports(&self) -> &[RenamedImport] {
        self.renamed_imports.as_deref().unwrap_or(&[])
    }
    fn is_type_only(&self) -> bool {
        self.type_only.unwrap_or(false)
    }
    fn type_only_names(&self) -> &[String] {
        self.type_only_names.as_deref().unwrap_or(&[])
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
pub(crate) fn import_name_pairs<T: ImportNameSource>(imp: &T) -> Vec<(String, String, bool)> {
    let mut original_name_for: HashMap<&str, &str> = HashMap::new();
    for r in imp.renamed_imports() {
        original_name_for.insert(&r.local, &r.imported);
    }
    let statement_type_only = imp.is_type_only();
    let type_only_names: HashSet<&str> = imp.type_only_names().iter().map(|s| s.as_str()).collect();
    imp.names()
        .iter()
        .map(|name| {
            let local = name
                .strip_prefix("* as ")
                .or_else(|| name.strip_prefix("*\tas "))
                .unwrap_or(name);
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

/// Persist barrel re-export rename pairs (`export { X as Y } from …`) from
/// `reexport_map` into the `reexport_renames` table (#1967) — the native
/// orchestrator's counterpart of `persistReexportRenames` in
/// `resolve-imports.ts` (JS pipeline).
///
/// `codegraph watch`'s single-file incremental rebuild (JS-only —
/// `resolveBarrelTarget` in `domain/graph/builder/incremental.ts`) resolves
/// barrel chains purely from already-persisted `reexports` edges, which
/// carry no rename metadata. Persisting the rename table here, once per
/// native-orchestrated build (full or incremental), gives that JS-only watch
/// path something durable to query even for repos built with the native
/// engine.
///
/// Deletes and re-inserts per barrel file so a barrel whose renames changed
/// (or were removed entirely) never leaves stale rows behind for that file.
pub fn persist_reexport_renames(
    conn: &Connection,
    reexport_map: &HashMap<String, Vec<ReexportEntry>>,
) -> Result<(), String> {
    if reexport_map.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("persist_reexport_renames: failed to start transaction: {e}"))?;
    {
        let mut delete_stmt = tx
            .prepare("DELETE FROM reexport_renames WHERE barrel_file = ?1")
            .map_err(|e| e.to_string())?;
        let mut insert_stmt = tx
            .prepare(
                "INSERT INTO reexport_renames (barrel_file, local_name, imported_name, source_file)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| e.to_string())?;
        for (barrel_file, entries) in reexport_map {
            delete_stmt
                .execute([barrel_file])
                .map_err(|e| e.to_string())?;
            for entry in entries {
                for rename in &entry.renames {
                    insert_stmt
                        .execute(rusqlite::params![
                            barrel_file,
                            rename.local,
                            rename.imported,
                            entry.source
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("persist_reexport_renames: commit failed: {e}"))?;
    Ok(())
}

/// Persist per-file invoked-property-name evidence (#2087) into
/// `invoked_property_names` — the native orchestrator's counterpart of
/// `persistInvokedPropertyNames` in `resolve-imports.ts` (JS pipeline). A
/// property/method name counts as "invoked" for a file when some call in
/// that file's own `calls` carries a receiver (`x.name(...)` member-call
/// syntax, regardless of whether the receiver itself resolves).
///
/// Called once per native-orchestrated build (full or incremental) so
/// `codegraph watch`'s JS-only single-file rebuild
/// (`collectInvokedPropertyNames` in `domain/graph/builder/incremental.ts`)
/// has a durable, whole-graph view to query instead of only the file it is
/// currently rebuilding — see #2087 for the false-negative this closes.
///
/// Excludes `dynamic_kind: "value-ref"` calls (issue #2260), mirroring
/// `collect_invoked_property_names`'s own exclusion in `build_edges.rs` — a
/// value-ref call's `receiver` names its own dispatch table, not a genuine
/// member-call-syntax invocation, so counting it here would let a
/// value-ref's own persisted evidence satisfy its own liveness gate on a
/// later build pass. This function has its own inline scan (rather than
/// calling `collect_invoked_property_names`) because it iterates one file's
/// calls at a time for per-file delete+reinsert, so the exclusion is
/// duplicated here rather than shared — keep both in sync.
///
/// Deletes and re-inserts per file so a file whose invoked names changed (or
/// were removed entirely) never leaves stale rows behind for it.
pub fn persist_invoked_property_names(
    conn: &Connection,
    files: &[super::build_edges::FileEdgeInput],
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("persist_invoked_property_names: failed to start transaction: {e}"))?;
    {
        let mut delete_stmt = tx
            .prepare("DELETE FROM invoked_property_names WHERE file = ?1")
            .map_err(|e| e.to_string())?;
        let mut insert_stmt = tx
            .prepare("INSERT OR IGNORE INTO invoked_property_names (file, name) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for file in files {
            delete_stmt
                .execute([&file.file])
                .map_err(|e| e.to_string())?;
            let mut seen: HashSet<&str> = HashSet::new();
            for call in &file.calls {
                if call.receiver.is_some()
                    && call.dynamic_kind.as_deref() != Some("value-ref")
                    && seen.insert(call.name.as_str())
                {
                    insert_stmt
                        .execute(rusqlite::params![file.file, call.name])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("persist_invoked_property_names: commit failed: {e}"))?;
    Ok(())
}

/// Persist object-literal allocation sites (#2088).
pub fn persist_object_literal_sites(
    conn: &Connection,
    files: &[super::build_edges::FileEdgeInput],
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("persist_object_literal_sites: failed to start transaction: {e}"))?;
    {
        let mut delete_stmt = tx
            .prepare("DELETE FROM object_literal_sites WHERE file = ?1")
            .map_err(|e| e.to_string())?;
        let mut insert_stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO object_literal_sites (file, site, escapes) VALUES (?1, ?2, ?3)",
            )
            .map_err(|e| e.to_string())?;
        for file in files {
            delete_stmt
                .execute([&file.file])
                .map_err(|e| e.to_string())?;
            if let Some(sites) = &file.object_literal_sites {
                for site in sites {
                    insert_stmt
                        .execute(rusqlite::params![
                            file.file,
                            site.site,
                            if site.escapes { 1 } else { 0 }
                        ])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("persist_object_literal_sites: commit failed: {e}"))?;
    Ok(())
}

/// Persist per-file correlated invoked-property evidence (#2088) into
/// `invoked_property_sites` — the durable counterpart of
/// `persistInvokedPropertySites` in `build-edges.ts`. Called once per native
/// orchestrator pass after `prepare_invoked_property_site_resolution` has this
/// pass's keys, so a later `codegraph watch` extra-SELECT is not empty.
///
/// Deletes and re-inserts per file so a file whose correlated keys changed
/// (or were removed entirely) never leaves stale rows behind for it.
pub fn persist_invoked_property_sites(
    conn: &Connection,
    files: &[super::build_edges::FileEdgeInput],
    sites_by_file: &HashMap<String, HashSet<String>>,
) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("persist_invoked_property_sites: failed to start transaction: {e}"))?;
    {
        let mut delete_stmt = tx
            .prepare("DELETE FROM invoked_property_sites WHERE file = ?1")
            .map_err(|e| e.to_string())?;
        let mut insert_stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO invoked_property_sites (site_key, name, file) VALUES (?1, ?2, ?3)",
            )
            .map_err(|e| e.to_string())?;
        for file in files {
            delete_stmt
                .execute([&file.file])
                .map_err(|e| e.to_string())?;
            let Some(keys) = sites_by_file.get(&file.file) else {
                continue;
            };
            for key in keys {
                let Some(sep) = key.rfind('|') else {
                    continue;
                };
                insert_stmt
                    .execute(rusqlite::params![&key[..sep], &key[sep + 1..], file.file])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("persist_invoked_property_sites: commit failed: {e}"))?;
    Ok(())
}

/// Persist per-file return-type evidence (#2138) into `return_types` — gives
/// a later incremental build's `propagate_return_types_across_files` a
/// durable, whole-graph view of files it doesn't itself re-parse this pass.
/// Mirrors `persistReturnTypes` in `build-edges.ts`. See that function's doc
/// comment (and `propagate_return_types_across_files`'s) for the
/// dispatch-edge loss this closes.
///
/// Deletes and re-inserts per file so a file whose return types changed (or
/// were removed entirely) never leaves stale rows behind for it.
pub fn persist_return_types(
    conn: &Connection,
    file_symbols: &BTreeMap<String, FileSymbols>,
) -> Result<(), String> {
    if file_symbols.is_empty() {
        return Ok(());
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("persist_return_types: failed to start transaction: {e}"))?;
    {
        let mut delete_stmt = tx
            .prepare("DELETE FROM return_types WHERE file = ?1")
            .map_err(|e| e.to_string())?;
        let mut insert_stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO return_types (file, fn_name, type_name, confidence) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| e.to_string())?;
        for (rel_path, symbols) in file_symbols {
            delete_stmt.execute([rel_path]).map_err(|e| e.to_string())?;
            for entry in &symbols.return_type_map {
                insert_stmt
                    .execute(rusqlite::params![
                        rel_path,
                        entry.name,
                        entry.type_name,
                        entry.confidence
                    ])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("persist_return_types: commit failed: {e}"))?;
    Ok(())
}

/// Detect which of `candidate_paths` are barrel-only (reexport count >=
/// definition count).
///
/// `candidate_paths` must be scoped to files loaded purely to resolve
/// reexport chains (the transient merges `reparse_barrel_candidates` performs
/// during Stage 6b) — never to every key in `ctx.file_symbols`. A file that's
/// genuinely part of this build's changed set (or, on a full build, *every*
/// file) must always get its own non-reexport imports emitted; only a file
/// that was side-loaded solely for barrel resolution — whose real edges
/// either don't exist yet or are being fully reconstructed by this same
/// re-parse — is eligible to have its non-reexport imports skipped. Mirrors
/// `resolve-imports.ts::reparseBarrelFiles`, which marks barrel-only status
/// inside its own re-parse loop rather than recomputing it over the whole
/// `fileSymbols` map (#1848).
pub fn detect_barrel_only_files(
    ctx: &ImportEdgeContext,
    candidate_paths: &[String],
) -> HashSet<String> {
    candidate_paths
        .iter()
        .filter(|rel_path| ctx.is_barrel_file(rel_path))
        .cloned()
        .collect()
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
    if let Ok(mut stmt) =
        conn.prepare("SELECT file, id FROM nodes WHERE kind = 'file' AND line = 0 AND name = file")
    {
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

/// Load symbol node IDs (and kinds) for the supplied `(name, file)` pairs in
/// one chunked query. Mirrors the JS `nodesByNameAndFile` lookup map;
/// preserves the first-row semantics of the legacy `LIMIT 1` query by keeping
/// the first row seen per key. `kind` lets `emit_named_symbol_rows` credit
/// plain imports resolving to a TypeScript interface/type-alias declaration,
/// not just `import type` statements (#1833).
///
/// The pairs are pre-computed by walking the type-only imports, named
/// re-exports, and TypeScript-file-targeting imports in `ctx.file_symbols`,
/// so we never scan the entire `nodes` table — even on monorepos with 100k+
/// symbols, only the slice actually reachable by one of those import shapes
/// is hit (#1013, #1028 review).
fn load_symbol_node_ids(
    conn: &Connection,
    needed_pairs: &HashSet<(String, String)>,
) -> HashMap<(String, String), (i64, String)> {
    let mut map: HashMap<(String, String), (i64, String)> = HashMap::new();
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
            "SELECT name, file, id, kind FROM nodes WHERE kind != 'file' AND (name, file) IN ({})",
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
                    row.get::<_, String>(3)?,
                ))
            }) {
                for r in rows.flatten() {
                    map.entry((r.0, r.1)).or_insert((r.2, r.3));
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

/// True for a genuine wildcard re-export (`export * from 'Y'`). Emitted as a
/// distinct file-level marker edge (`reexports-wildcard`) alongside the
/// generic `reexports` edge so the query layer can tell a target reached
/// only by named specifiers apart from one that's also reached by a
/// wildcard — even when a *different* statement in the same file names
/// specific symbols from that exact target (#1849 review). Mirrors
/// `is_wildcard_reexport` in build_edges.rs (FFI fallback path).
fn is_wildcard_reexport(imp: &crate::types::Import) -> bool {
    imp.reexport.unwrap_or(false) && imp.wildcard_reexport.unwrap_or(false)
}

/// True when `file`'s extension means it *might* hold a TypeScript
/// interface/type-alias declaration (see `is_type_erased_import_target`) —
/// used to widen `collect_symbol_lookup_pairs` beyond syntactically
/// type-only imports without scanning every plain import in every language
/// (#1833).
fn maybe_type_erased_file(file: &str) -> bool {
    TYPESCRIPT_EXTENSIONS.iter().any(|ext| file.ends_with(ext))
}

/// Resolve `symbol_name` through a possible barrel hop at `resolved_path` to
/// the file that actually declares it and the name declared there. Falls
/// back to `resolved_path`/`symbol_name` unchanged when `resolved_path` isn't
/// a barrel, or when barrel resolution finds nothing.
///
/// Single source of truth for this fallback (#2461) — mirrors TS's
/// `traceBarrelTarget` in `stages/resolve-imports.ts` (#2071/#2295). Before
/// this helper existed, `collect_symbol_lookup_pairs`, `emit_named_symbol_rows`,
/// and `emit_barrel_through_rows` each inlined their own copy of this exact
/// "resolve through a barrel, falling back to the original file/name" pattern,
/// with no shared implementation to consolidate onto (unlike the TS side,
/// which already had one from #2071).
fn trace_barrel_target(
    ctx: &ImportEdgeContext,
    resolved_path: &str,
    symbol_name: &str,
) -> barrel_resolution::BarrelResolution {
    if !ctx.is_barrel_file(resolved_path) {
        return barrel_resolution::BarrelResolution {
            file: resolved_path.to_string(),
            name: symbol_name.to_string(),
        };
    }
    let mut visited = HashSet::new();
    ctx.resolve_barrel_export(resolved_path, symbol_name, &mut visited)
        .unwrap_or_else(|| barrel_resolution::BarrelResolution {
            file: resolved_path.to_string(),
            name: symbol_name.to_string(),
        })
}

/// Walk type-only imports, named re-exports, and plain imports that might
/// target a TypeScript interface/type-alias declaration in `ctx.file_symbols`,
/// returning the distinct `(name, file)` pairs that `build_import_edges` will
/// need to look up. Resolves barrel files the same way the edge-building
/// loop does so the pre-computed set matches the actual lookup keys.
/// Shared by symbol-level `imports-type` (#1724, #1833) and `reexports`
/// (#1742) edges — all three name specific symbols requiring a
/// (name, file) → node-id/kind lookup.
fn collect_symbol_lookup_pairs(ctx: &ImportEdgeContext) -> HashSet<(String, String)> {
    let mut pairs = HashSet::new();
    for (rel_path, symbols) in &ctx.file_symbols {
        let abs_file = Path::new(&ctx.root_dir).join(rel_path);
        let abs_str = abs_file.to_str().unwrap_or("");
        for imp in &symbols.imports {
            let is_reexport = is_named_reexport(imp);
            let resolved_path = ctx.get_resolved(abs_str, &imp.source);
            let maybe_type_erased = maybe_type_erased_file(&resolved_path);
            if !has_type_only_names(imp) && !is_reexport && !maybe_type_erased {
                continue;
            }
            for (_local, original, type_only) in import_name_pairs(imp) {
                if !is_reexport && !type_only && !maybe_type_erased {
                    continue;
                }
                let resolved = trace_barrel_target(ctx, &resolved_path, &original);
                pairs.insert((resolved.name, resolved.file));
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

/// For a `type` import, a plain import of a TypeScript interface/type-alias,
/// or a named re-export, emit one symbol-level edge per name so the target
/// symbols receive fan-in credit and aren't classified dead (`imports-type`,
/// #1724, #1833), or so `codegraph exports` can report the precise re-export
/// surface instead of the target's full export list (`reexports`, #1742).
/// `kind` selects which edge kind to emit.
///
/// For `kind == "imports-type"`, a specifier gets an edge when either it's
/// actually marked type-only (whole-statement or inline per-specifier,
/// #1813 — a mixed `import { value, type Foo }` must not credit `value` on
/// this basis alone), or the resolved target is a TypeScript
/// interface/type-alias declaration (`is_type_erased_import_target`) — those
/// kinds are erased before runtime, so a plain `import { Foo } from 'y'` (no
/// `type` keyword) is the only consumption signal `codegraph exports` can
/// observe for them (#1833).
/// Push an import/reexport edge row unless an edge with the same
/// (source, target, kind) has already been pushed for this file. Two import
/// statements in the same file often resolve to the same target — two
/// `import()` calls to the same module, a named + wildcard reexport from the
/// same source, or two reexport statements naming the same original symbol
/// under different aliases (#2297) — so without this, the identical edge row
/// is computed and pushed once per statement instead of once per file.
/// `INSERT OR IGNORE` + `idx_edges_content_unique` already deduplicate the DB
/// rows themselves at insert time; this only avoids the redundant
/// computation and batch-insert row upstream of that. Mirrors
/// `pushImportEdgeOnce` in stages/build-edges.ts.
fn push_edge_once(
    seen: &mut HashSet<(i64, i64, String)>,
    edges: &mut Vec<EdgeRow>,
    source_id: i64,
    target_id: i64,
    kind: &str,
    confidence: f64,
) {
    if !seen.insert((source_id, target_id, kind.to_string())) {
        return;
    }
    edges.push(EdgeRow {
        source_id,
        target_id,
        kind: kind.to_string(),
        confidence,
        dynamic: 0,
    });
}

// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical import-edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_named_symbol_rows(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    imp: &crate::types::Import,
    resolved_path: &str,
    kind: &str,
    ctx: &ImportEdgeContext,
    symbol_node_ids: &HashMap<(String, String), (i64, String)>,
    seen_edges: &mut HashSet<(i64, i64, String)>,
) {
    for (_local, original, type_only) in import_name_pairs(imp) {
        let resolved = trace_barrel_target(ctx, resolved_path, &original);
        let Some((sym_id, sym_kind)) =
            symbol_node_ids.get(&(resolved.name.clone(), resolved.file.clone()))
        else {
            continue;
        };
        if kind == "imports-type"
            && !type_only
            && !is_type_erased_import_target(sym_kind, &resolved.file)
        {
            continue;
        }
        push_edge_once(seen_edges, edges, file_node_id, *sym_id, kind, 1.0);
    }
}

/// For a non-reexport import targeting a barrel file, emit `imports`-like
/// edges to each ultimate definition file reached through the barrel chain.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical import-edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_barrel_through_rows(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    imp: &crate::types::Import,
    resolved_path: &str,
    edge_kind: &str,
    ctx: &ImportEdgeContext,
    file_node_ids: &HashMap<String, i64>,
    seen_edges: &mut HashSet<(i64, i64, String)>,
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
        let actual_source = trace_barrel_target(ctx, resolved_path, &original).file;
        if actual_source == resolved_path || !resolved_sources.insert(actual_source.clone()) {
            continue;
        }
        if let Some(&actual_id) = file_node_ids.get(&actual_source) {
            push_edge_once(
                seen_edges,
                edges,
                file_node_id,
                actual_id,
                through_kind,
                0.9,
            );
        }
    }
}

/// Emit all edges produced by a single import on a single source file.
// A params-struct refactor is deferred to avoid a hasty change to this
// parity-critical import-edge-emission path (dual-engine mandate) — tracked in #2481.
#[allow(clippy::too_many_arguments)]
fn emit_edges_for_import(
    edges: &mut Vec<EdgeRow>,
    file_node_id: i64,
    abs_str: &str,
    imp: &crate::types::Import,
    is_barrel_only: bool,
    ctx: &ImportEdgeContext,
    file_node_ids: &HashMap<String, i64>,
    symbol_node_ids: &HashMap<(String, String), (i64, String)>,
    seen_edges: &mut HashSet<(i64, i64, String)>,
) {
    let is_reexport = imp.reexport.unwrap_or(false);
    if is_barrel_only && !is_reexport {
        return;
    }
    let resolved_path = ctx.get_resolved(abs_str, &imp.source);

    // `from pkg import submod` depends on `pkg/submod.py`, not merely on
    // `pkg/__init__.py` — emitting only the latter would report the package
    // barrel as the dependency and leave the module that actually changed
    // invisible to `deps`/`impact` (#2387). Mirrors emitEdgesForImport in
    // stages/build-edges.ts.
    for (_local, original, _type_only) in import_name_pairs(imp) {
        let Some(submodule) = crate::domain::graph::resolve::resolve_python_submodule(
            abs_str,
            &imp.source,
            &original,
            &ctx.root_dir,
            Some(&ctx.known_files),
        ) else {
            continue;
        };
        if let Some(&submodule_id) = file_node_ids.get(&submodule) {
            push_edge_once(
                seen_edges,
                edges,
                file_node_id,
                submodule_id,
                "imports",
                1.0,
            );
        }
    }

    let target_id = match file_node_ids.get(&resolved_path) {
        Some(&id) => id,
        None => return,
    };
    let edge_kind = classify_import_kind(imp);
    push_edge_once(seen_edges, edges, file_node_id, target_id, edge_kind, 1.0);
    // Always attempted (not just for `import type`/inline-`type` specifiers) —
    // emit_named_symbol_rows also credits plain specifiers that resolve to a
    // TypeScript interface/type-alias declaration (#1833).
    if !is_reexport {
        emit_named_symbol_rows(
            edges,
            file_node_id,
            imp,
            &resolved_path,
            "imports-type",
            ctx,
            symbol_node_ids,
            seen_edges,
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
            seen_edges,
        );
    } else if is_wildcard_reexport(imp) {
        push_edge_once(
            seen_edges,
            edges,
            file_node_id,
            target_id,
            "reexports-wildcard",
            1.0,
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
        seen_edges,
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
        let mut seen_edges: HashSet<(i64, i64, String)> = HashSet::new();

        for imp in &symbols.imports {
            // CJS require bindings feed imported_names for receiver-edge resolution
            // but must not produce DB import edges (#1678).
            if imp.cjs_require.unwrap_or(false) {
                continue;
            }
            emit_edges_for_import(
                &mut edges,
                file_node_id,
                abs_str,
                imp,
                is_barrel_only,
                ctx,
                &file_node_ids,
                &symbol_node_ids,
                &mut seen_edges,
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
fn insert_edge_chunk(tx: &rusqlite::Transaction<'_>, chunk: &[EdgeRow]) -> rusqlite::Result<()> {
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
        make_symbols_with_imports(
            defs,
            reexport_imports
                .into_iter()
                .map(|src| {
                    let mut imp = Import::new(src.to_string(), vec![], 1);
                    imp.reexport = Some(true);
                    imp.wildcard_reexport = Some(true);
                    imp
                })
                .collect(),
        )
    }

    fn make_symbols_with_imports(defs: Vec<&str>, imports: Vec<Import>) -> FileSymbols {
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
                    bodyless: None,
                    content_hash: None,
                    accessor_kind: None,
                })
                .collect(),
            imports,
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
            computed_dispatch_table_evidence: vec![],
            new_expressions: vec![],
            object_literal_sites: vec![],
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
            workspaces: HashMap::new(),
        };

        assert!(ctx.is_barrel_file("src/index.ts"));
        assert!(!ctx.is_barrel_file("src/utils.ts"));
        assert!(!ctx.is_barrel_file("nonexistent.ts"));
    }

    /// Regression coverage for #2461's shared `trace_barrel_target` helper —
    /// the three call sites it replaces (`collect_symbol_lookup_pairs`,
    /// `emit_named_symbol_rows`, `emit_barrel_through_rows`) are exercised
    /// indirectly by their own tests below; these exercise the helper
    /// directly against all three branches its doc comment describes.
    #[test]
    fn trace_barrel_target_falls_back_to_identity_for_a_non_barrel_file() {
        let ctx = empty_ctx(BTreeMap::new());
        let resolved = trace_barrel_target(&ctx, "src/utils.ts", "helper");
        assert_eq!(resolved.file, "src/utils.ts");
        assert_eq!(resolved.name, "helper");
    }

    #[test]
    fn trace_barrel_target_resolves_through_a_barrel_to_the_declaring_file() {
        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec![], vec!["src/real.ts"]),
        );
        file_symbols.insert(
            "src/real.ts".to_string(),
            make_symbols_with_imports(vec!["helper"], vec![]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.reexport_map.insert(
            "src/index.ts".to_string(),
            vec![ReexportEntry {
                source: "src/real.ts".to_string(),
                names: vec!["helper".to_string()],
                wildcard_reexport: false,
                renames: vec![],
            }],
        );

        let resolved = trace_barrel_target(&ctx, "src/index.ts", "helper");
        assert_eq!(resolved.file, "src/real.ts");
        assert_eq!(resolved.name, "helper");
    }

    #[test]
    fn trace_barrel_target_falls_back_to_identity_when_barrel_resolution_finds_nothing() {
        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec![], vec!["src/real.ts"]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.reexport_map.insert(
            "src/index.ts".to_string(),
            vec![ReexportEntry {
                source: "src/real.ts".to_string(),
                names: vec!["other".to_string()], // "helper" is not reexported
                wildcard_reexport: false,
                renames: vec![],
            }],
        );

        let resolved = trace_barrel_target(&ctx, "src/index.ts", "helper");
        assert_eq!(resolved.file, "src/index.ts");
        assert_eq!(resolved.name, "helper");
    }

    /// Regression test for #1848: `detect_barrel_only_files` must only
    /// classify files present in the supplied candidate list, even when a
    /// file outside that list also satisfies the reexports-outnumber-
    /// ownDefs heuristic. `run_pipeline` relies on this scoping to keep a
    /// genuinely-changed (or, on a full build, every) file's own
    /// non-reexport imports from ever being dropped — only files
    /// transiently side-loaded by `reparse_barrel_candidates` for barrel
    /// resolution may be classified as barrel-only.
    #[test]
    fn detect_barrel_only_files_scopes_to_candidate_paths_only() {
        let mut file_symbols = BTreeMap::new();
        // Barrel-like (1 def, 2 reexports) but NOT in the candidate list —
        // e.g. a file that's genuinely part of this build's changed set.
        file_symbols.insert(
            "src/changed-barrel.ts".to_string(),
            make_symbols(vec!["helper"], vec!["./a", "./b"]),
        );
        // Barrel-like AND in the candidate list — a file side-loaded purely
        // for reexport-chain resolution.
        file_symbols.insert(
            "src/transient-barrel.ts".to_string(),
            make_symbols(vec!["helper"], vec!["./c", "./d"]),
        );
        // Not barrel-like at all, also in the candidate list.
        file_symbols.insert(
            "src/transient-hybrid.ts".to_string(),
            make_symbols(vec!["foo", "bar", "baz"], vec!["./e"]),
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
            workspaces: HashMap::new(),
        };

        let candidates = vec![
            "src/transient-barrel.ts".to_string(),
            "src/transient-hybrid.ts".to_string(),
        ];
        let barrel_only = detect_barrel_only_files(&ctx, &candidates);

        assert!(barrel_only.contains("src/transient-barrel.ts"));
        assert!(!barrel_only.contains("src/transient-hybrid.ts"));
        assert!(
            !barrel_only.contains("src/changed-barrel.ts"),
            "a barrel-like file outside the candidate list must never be classified barrel-only"
        );
    }

    /// Regression test for #1848: on a full build the caller passes an empty
    /// candidate list (mirrors `run_pipeline` never invoking
    /// `reparse_barrel_candidates` when `is_full_build` is true), so no file
    /// — however barrel-like — is ever classified barrel-only.
    #[test]
    fn detect_barrel_only_files_returns_empty_for_empty_candidates() {
        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec!["helper"], vec!["./a", "./b"]),
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
            workspaces: HashMap::new(),
        };

        assert!(detect_barrel_only_files(&ctx, &[]).is_empty());
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
        let imp = Import::new("./utils".to_string(), vec!["helper".to_string()], 1);

        let pairs = import_name_pairs(&imp);
        assert!(pairs.iter().all(|(_, _, type_only)| !*type_only));
    }

    fn empty_ctx(file_symbols: BTreeMap<String, FileSymbols>) -> ImportEdgeContext {
        ImportEdgeContext {
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
            workspaces: HashMap::new(),
        }
    }

    #[test]
    fn emit_named_symbol_rows_credits_plain_import_of_ts_interface() {
        // `import { Foo } from './types'` — no `type` keyword — where `Foo`
        // is a TypeScript interface. Interfaces are erased before runtime, so
        // this plain import is the only observable consumption signal
        // `codegraph exports` can rely on; it must be credited exactly like
        // `import type { Foo }` would be (#1833).
        let ctx = empty_ctx(BTreeMap::new());
        let imp = Import::new("./types".to_string(), vec!["Foo".to_string()], 1);
        let mut symbol_node_ids: HashMap<(String, String), (i64, String)> = HashMap::new();
        symbol_node_ids.insert(
            ("Foo".to_string(), "src/types.ts".to_string()),
            (50, "interface".to_string()),
        );

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        emit_named_symbol_rows(
            &mut edges,
            1,
            &imp,
            "src/types.ts",
            "imports-type",
            &ctx,
            &symbol_node_ids,
            &mut seen_edges,
        );

        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].kind, "imports-type");
        assert_eq!(edges[0].target_id, 50);
    }

    #[test]
    fn emit_named_symbol_rows_skips_plain_import_of_value_symbol() {
        // A plain import of a real function must NOT get a fabricated
        // `imports-type` edge — value-symbol consumption credit still comes
        // exclusively from an actual `calls` edge (#1833 must not regress
        // the existing value-import behaviour).
        let ctx = empty_ctx(BTreeMap::new());
        let imp = Import::new("./utils".to_string(), vec!["helper".to_string()], 1);
        let mut symbol_node_ids: HashMap<(String, String), (i64, String)> = HashMap::new();
        symbol_node_ids.insert(
            ("helper".to_string(), "src/utils.ts".to_string()),
            (50, "function".to_string()),
        );

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        emit_named_symbol_rows(
            &mut edges,
            1,
            &imp,
            "src/utils.ts",
            "imports-type",
            &ctx,
            &symbol_node_ids,
            &mut seen_edges,
        );

        assert!(edges.is_empty());
    }

    #[test]
    fn emit_named_symbol_rows_skips_non_typescript_interface() {
        // An 'interface'-kind node outside a .ts/.tsx file (e.g. a Go
        // `type ... interface {}`) is runtime-observable in its own
        // language, so this heuristic — scoped to TypeScript's compile-time
        // erasure — must not credit it on mere import (#1833).
        let ctx = empty_ctx(BTreeMap::new());
        let imp = Import::new("./iface".to_string(), vec!["Reader".to_string()], 1);
        let mut symbol_node_ids: HashMap<(String, String), (i64, String)> = HashMap::new();
        symbol_node_ids.insert(
            ("Reader".to_string(), "src/iface.go".to_string()),
            (50, "interface".to_string()),
        );

        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();
        emit_named_symbol_rows(
            &mut edges,
            1,
            &imp,
            "src/iface.go",
            "imports-type",
            &ctx,
            &symbol_node_ids,
            &mut seen_edges,
        );

        assert!(edges.is_empty());
    }

    /// `emit_barrel_through_rows` previously had no dedicated unit test of
    /// its own (#2461) — it was only exercised indirectly through the
    /// higher-level `emit_edges_for_import` orchestrator. These also verify
    /// the #2461 refactor's behavior-preservation argument directly: the
    /// function used to `continue` immediately when `resolve_barrel_export`
    /// returned `None`, via its own explicit match; after routing through
    /// `trace_barrel_target` (which never returns `None`, only a fallback
    /// identity), that case now flows through the pre-existing
    /// `actual_source == resolved_path` self-reference check below instead —
    /// same observable outcome (no edge emitted), different code path.
    #[test]
    fn emit_barrel_through_rows_emits_an_edge_to_the_actual_definition_file() {
        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec![], vec!["src/real.ts"]),
        );
        file_symbols.insert(
            "src/real.ts".to_string(),
            make_symbols_with_imports(vec!["helper"], vec![]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.reexport_map.insert(
            "src/index.ts".to_string(),
            vec![ReexportEntry {
                source: "src/real.ts".to_string(),
                names: vec!["helper".to_string()],
                wildcard_reexport: false,
                renames: vec![],
            }],
        );
        let imp = Import::new("./index".to_string(), vec!["helper".to_string()], 1);
        let mut file_node_ids = HashMap::new();
        file_node_ids.insert("src/real.ts".to_string(), 42i64);
        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();

        emit_barrel_through_rows(
            &mut edges,
            1,
            &imp,
            "src/index.ts",
            "imports",
            &ctx,
            &file_node_ids,
            &mut seen_edges,
        );

        assert_eq!(edges.len(), 1, "expected exactly one edge; got: {edges:?}");
        assert_eq!(edges[0].source_id, 1);
        assert_eq!(edges[0].target_id, 42);
        assert_eq!(edges[0].kind, "imports");
        assert_eq!(edges[0].confidence, 0.9);
    }

    #[test]
    fn emit_barrel_through_rows_emits_nothing_when_barrel_resolution_finds_no_target() {
        let mut file_symbols = BTreeMap::new();
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec![], vec!["src/real.ts"]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.reexport_map.insert(
            "src/index.ts".to_string(),
            vec![ReexportEntry {
                source: "src/real.ts".to_string(),
                names: vec!["other".to_string()], // "helper" is not reexported
                wildcard_reexport: false,
                renames: vec![],
            }],
        );
        let imp = Import::new("./index".to_string(), vec!["helper".to_string()], 1);
        let file_node_ids = HashMap::new();
        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();

        emit_barrel_through_rows(
            &mut edges,
            1,
            &imp,
            "src/index.ts",
            "imports",
            &ctx,
            &file_node_ids,
            &mut seen_edges,
        );

        assert!(
            edges.is_empty(),
            "must not emit an edge when barrel resolution finds nothing: {edges:?}"
        );
    }

    #[test]
    fn emit_barrel_through_rows_skips_a_barrel_that_resolves_back_to_itself() {
        let mut file_symbols = BTreeMap::new();
        // 1 def + 2 reexports -> barrel (reexport_count strictly exceeds
        // definition count); the file also defines "helper" itself, so a
        // reexport entry pointing back at "src/index.ts" genuinely resolves.
        file_symbols.insert(
            "src/index.ts".to_string(),
            make_symbols(vec!["helper"], vec!["a", "b"]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.reexport_map.insert(
            "src/index.ts".to_string(),
            vec![ReexportEntry {
                source: "src/index.ts".to_string(),
                names: vec!["helper".to_string()],
                wildcard_reexport: false,
                renames: vec![],
            }],
        );
        let imp = Import::new("./index".to_string(), vec!["helper".to_string()], 1);
        let file_node_ids = HashMap::new();
        let mut edges = Vec::new();
        let mut seen_edges = HashSet::new();

        emit_barrel_through_rows(
            &mut edges,
            1,
            &imp,
            "src/index.ts",
            "imports",
            &ctx,
            &file_node_ids,
            &mut seen_edges,
        );

        assert!(
            edges.is_empty(),
            "must not emit a self-referencing through edge: {edges:?}"
        );
    }

    #[test]
    fn push_edge_once_drops_a_repeat_of_the_same_source_target_kind() {
        // #2297: two import statements in the same file resolving to the same
        // (source, target, kind) must only push one edge row — the second
        // push is redundant computation the DB-level unique constraint would
        // silently discard anyway, but should never reach the batch at all.
        let mut seen = HashSet::new();
        let mut edges = Vec::new();
        push_edge_once(&mut seen, &mut edges, 1, 2, "imports", 1.0);
        push_edge_once(&mut seen, &mut edges, 1, 2, "imports", 1.0);

        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn push_edge_once_keeps_rows_that_differ_only_by_kind() {
        // Two edges kinds for the same (source, target) pair are NOT
        // duplicates of each other — e.g. a plain `imports` edge and an
        // `imports-type` symbol-level edge to the same file must both survive.
        let mut seen = HashSet::new();
        let mut edges = Vec::new();
        push_edge_once(&mut seen, &mut edges, 1, 2, "imports", 1.0);
        push_edge_once(&mut seen, &mut edges, 1, 2, "imports-type", 1.0);

        assert_eq!(edges.len(), 2);
    }

    #[test]
    fn collect_symbol_lookup_pairs_includes_plain_imports_targeting_ts_files() {
        // A plain (non-type-only, non-reexport) import must still be
        // collected when its resolved target is a TypeScript file — the
        // target might be an interface/type-alias declaration, which
        // `emit_named_symbol_rows` can only credit if this pre-pass fetched
        // its (id, kind) from the DB (#1833).
        let mut file_symbols = BTreeMap::new();
        let plain_ts_import = Import::new("./types".to_string(), vec!["Foo".to_string()], 1);
        let plain_py_import = Import::new("./helpers".to_string(), vec!["util".to_string()], 2);
        file_symbols.insert(
            "src/app.ts".to_string(),
            make_symbols_with_imports(vec![], vec![plain_ts_import, plain_py_import]),
        );
        let mut ctx = empty_ctx(file_symbols);
        ctx.batch_resolved.insert(
            "/project/src/app.ts|./types".to_string(),
            "src/types.ts".to_string(),
        );
        ctx.batch_resolved.insert(
            "/project/src/app.ts|./helpers".to_string(),
            "src/helpers.py".to_string(),
        );

        let pairs = collect_symbol_lookup_pairs(&ctx);
        assert!(pairs.contains(&("Foo".to_string(), "src/types.ts".to_string())));
        assert!(!pairs.contains(&("util".to_string(), "src/helpers.py".to_string())));
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
