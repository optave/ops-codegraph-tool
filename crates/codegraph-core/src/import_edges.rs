//! Import edge building and barrel file resolution.
//!
//! Ports the import-edge construction from `build-edges.ts:buildImportEdges()`,
//! the barrel detection from `resolve-imports.ts:isBarrelFile()`, and the
//! recursive barrel export resolution from `resolveBarrelExport()`.

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
        let key = format!("{abs_file}|{import_source}");
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
    pub fn resolve_barrel_export(
        &self,
        barrel_path: &str,
        symbol_name: &str,
        visited: &mut HashSet<String>,
    ) -> Option<String> {
        if visited.contains(barrel_path) {
            return None;
        }
        visited.insert(barrel_path.to_string());

        let reexports = self.reexport_map.get(barrel_path)?;
        for re in reexports {
            // Named reexport (not wildcard)
            if !re.names.is_empty() && !re.wildcard_reexport {
                if re.names.iter().any(|n| n == symbol_name) {
                    if let Some(target_symbols) = self.file_symbols.get(&re.source) {
                        let has_def = target_symbols
                            .definitions
                            .iter()
                            .any(|d| d.name == symbol_name);
                        if has_def {
                            return Some(re.source.clone());
                        }
                        let deeper = self.resolve_barrel_export(&re.source, symbol_name, visited);
                        if deeper.is_some() {
                            return deeper;
                        }
                    }
                    return Some(re.source.clone());
                }
                continue;
            }

            // Wildcard reexport or unnamed
            if re.wildcard_reexport || re.names.is_empty() {
                if let Some(target_symbols) = self.file_symbols.get(&re.source) {
                    let has_def = target_symbols
                        .definitions
                        .iter()
                        .any(|d| d.name == symbol_name);
                    if has_def {
                        return Some(re.source.clone());
                    }
                    let deeper = self.resolve_barrel_export(&re.source, symbol_name, visited);
                    if deeper.is_some() {
                        return deeper;
                    }
                }
            }
        }
        None
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

/// Look up a file node ID from the database.
fn get_file_node_id(conn: &Connection, rel_path: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM nodes WHERE name = ? AND kind = 'file' AND file = ? AND line = 0",
        [rel_path, rel_path],
        |row| row.get(0),
    )
    .ok()
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

    for (rel_path, symbols) in &ctx.file_symbols {
        let is_barrel_only = ctx.barrel_only_files.contains(rel_path);
        let file_node_id = match get_file_node_id(conn, rel_path) {
            Some(id) => id,
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
            let target_id = match get_file_node_id(conn, &resolved_path) {
                Some(id) => id,
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
                            if let Some(actual_id) = get_file_node_id(conn, &actual_source) {
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

/// Batch insert edges into the database.
pub fn insert_edges(conn: &Connection, edges: &[EdgeRow]) {
    if edges.is_empty() {
        return;
    }
    let tx = match conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(_) => return,
    };
    if let Ok(mut stmt) = tx.prepare(
        "INSERT OR IGNORE INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)",
    ) {
        for e in edges {
            let _ = stmt.execute(rusqlite::params![
                e.source_id,
                e.target_id,
                e.kind,
                e.confidence,
                e.dynamic,
            ]);
        }
    }
    let _ = tx.commit();
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
