//! Shared barrel-file resolution logic.
//!
//! Both `edge_builder.rs` (napi-driven) and `import_edges.rs` (SQLite-driven)
//! need to recursively resolve a symbol through barrel reexport chains.
//! This module extracts the common algorithm so both callers share a single
//! implementation.

use std::collections::HashSet;

/// Minimal view of a single reexport entry, borrowed from the caller's data.
pub struct ReexportRef<'a> {
    pub source: &'a str,
    pub names: &'a [String],
    pub wildcard_reexport: bool,
}

/// Trait that abstracts over the different context types in `edge_builder` and
/// `import_edges`.  Each implementor provides access to its own reexport map
/// and definition index so the resolution algorithm stays generic.
pub trait BarrelContext {
    /// Return the reexport entries for `barrel_path`, or `None` if the path
    /// has no reexports.
    fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>>;

    /// Return `true` if `file_path` contains a definition named `symbol`.
    fn has_definition(&self, file_path: &str, symbol: &str) -> bool;
}

/// Recursively resolve a symbol through barrel reexport chains.
///
/// Mirrors `resolveBarrelExport()` in `resolve-imports.ts`.
/// The caller provides a `visited` set to prevent infinite loops on circular
/// reexport chains.
pub fn resolve_barrel_export<C: BarrelContext>(
    ctx: &C,
    barrel_path: &str,
    symbol_name: &str,
    visited: &mut HashSet<String>,
) -> Option<String> {
    if visited.contains(barrel_path) {
        return None;
    }
    visited.insert(barrel_path.to_string());

    let reexports = ctx.reexports_for(barrel_path)?;

    for re in &reexports {
        // Named reexports (non-wildcard)
        if !re.names.is_empty() && !re.wildcard_reexport {
            if re.names.iter().any(|n| n == symbol_name) {
                if ctx.has_definition(re.source, symbol_name) {
                    return Some(re.source.to_string());
                }
                let deeper = resolve_barrel_export(ctx, re.source, symbol_name, visited);
                if deeper.is_some() {
                    return deeper;
                }
                // Fallback: return source even if no definition found
                return Some(re.source.to_string());
            }
            continue;
        }

        // Wildcard or empty-names reexports
        if ctx.has_definition(re.source, symbol_name) {
            return Some(re.source.to_string());
        }
        let deeper = resolve_barrel_export(ctx, re.source, symbol_name, visited);
        if deeper.is_some() {
            return deeper;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct TestContext {
        reexports: HashMap<String, Vec<(String, Vec<String>, bool)>>,
        definitions: HashMap<String, HashSet<String>>,
    }

    impl BarrelContext for TestContext {
        fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>> {
            self.reexports.get(barrel_path).map(|entries| {
                entries
                    .iter()
                    .map(|(source, names, wildcard)| ReexportRef {
                        source: source.as_str(),
                        names: names.as_slice(),
                        wildcard_reexport: *wildcard,
                    })
                    .collect()
            })
        }

        fn has_definition(&self, file_path: &str, symbol: &str) -> bool {
            self.definitions
                .get(file_path)
                .map_or(false, |defs| defs.contains(symbol))
        }
    }

    #[test]
    fn resolves_named_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/index.ts".to_string(),
            vec![("src/utils.ts".to_string(), vec!["foo".to_string()], false)],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/utils.ts".to_string(),
            HashSet::from(["foo".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "foo", &mut visited);
        assert_eq!(result.as_deref(), Some("src/utils.ts"));
    }

    #[test]
    fn resolves_wildcard_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/index.ts".to_string(),
            vec![("src/utils.ts".to_string(), vec![], true)],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/utils.ts".to_string(),
            HashSet::from(["bar".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "bar", &mut visited);
        assert_eq!(result.as_deref(), Some("src/utils.ts"));
    }

    #[test]
    fn resolves_transitive_chain() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/index.ts".to_string(),
            vec![("src/mid.ts".to_string(), vec![], true)],
        );
        reexports.insert(
            "src/mid.ts".to_string(),
            vec![("src/deep.ts".to_string(), vec!["baz".to_string()], false)],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/deep.ts".to_string(),
            HashSet::from(["baz".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "baz", &mut visited);
        assert_eq!(result.as_deref(), Some("src/deep.ts"));
    }

    #[test]
    fn prevents_circular_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/a.ts".to_string(),
            vec![("src/b.ts".to_string(), vec![], true)],
        );
        reexports.insert(
            "src/b.ts".to_string(),
            vec![("src/a.ts".to_string(), vec![], true)],
        );

        let ctx = TestContext {
            reexports,
            definitions: HashMap::new(),
        };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/a.ts", "missing", &mut visited);
        assert_eq!(result, None);
    }
}
