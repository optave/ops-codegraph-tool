//! Shared barrel-file resolution logic.
//!
//! Both `edge_builder.rs` (napi-driven) and `import_edges.rs` (SQLite-driven)
//! need to recursively resolve a symbol through barrel reexport chains.
//! This module extracts the common algorithm so both callers share a single
//! implementation.

use std::collections::HashSet;

use crate::types::RenamedImport;

/// Minimal view of a single reexport entry, borrowed from the caller's data.
pub struct ReexportRef<'a> {
    pub source: &'a str,
    pub names: &'a [String],
    pub wildcard_reexport: bool,
    /// `{ local, imported }` pairs for `export { X as Y } from …` specifiers
    /// within this entry: `local` is the external name (Y) a consumer of the
    /// barrel imports, `imported` is the name (X) actually declared in
    /// `source`. Lets `resolve_barrel_export` translate a consumer's
    /// requested name back to X before matching it against `names` (#1823).
    pub renames: &'a [RenamedImport],
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

/// Result of successfully resolving a symbol through a barrel chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BarrelResolution {
    /// The file that actually defines the symbol.
    pub file: String,
    /// The name the symbol is declared under in `file`. Identical to the
    /// requested symbol name unless one of the barrel hops in the chain
    /// renamed it (`export { X as Y } from …`), in which case this is the
    /// *original* declared name (X) to search for in `file` (#1823).
    pub name: String,
}

/// Translate a consumer-requested name through a single reexport entry's
/// rename table, if it renamed that name (`export { X as Y } from …` records
/// `{ local: Y, imported: X }`). Returns `symbol_name` unchanged when the
/// entry doesn't rename it — covers both "not renamed at all" and "requested
/// name isn't one of this entry's external aliases" (#1823).
fn translate_through_rename(re: &ReexportRef, symbol_name: &str) -> String {
    re.renames
        .iter()
        .find(|r| r.local == symbol_name)
        .map(|r| r.imported.clone())
        .unwrap_or_else(|| symbol_name.to_string())
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
) -> Option<BarrelResolution> {
    if visited.contains(barrel_path) {
        return None;
    }
    visited.insert(barrel_path.to_string());

    let reexports = ctx.reexports_for(barrel_path)?;

    for re in &reexports {
        // Translate the requested external name (Y) back to the name
        // actually declared in `re.source` (X) before matching
        // `re.names`/checking the target's definitions — `re.names` always
        // carries the original declaration name, never the barrel's
        // external alias (#1823).
        let lookup_name = translate_through_rename(re, symbol_name);

        // Named reexports (non-wildcard)
        if !re.names.is_empty() && !re.wildcard_reexport {
            if re.names.iter().any(|n| n == &lookup_name) {
                if ctx.has_definition(re.source, &lookup_name) {
                    return Some(BarrelResolution { file: re.source.to_string(), name: lookup_name });
                }
                let deeper = resolve_barrel_export(ctx, re.source, &lookup_name, visited);
                if deeper.is_some() {
                    return deeper;
                }
                // Fallback: return source even if no definition found
                return Some(BarrelResolution { file: re.source.to_string(), name: lookup_name });
            }
            continue;
        }

        // Wildcard or empty-names reexports
        if ctx.has_definition(re.source, &lookup_name) {
            return Some(BarrelResolution { file: re.source.to_string(), name: lookup_name });
        }
        let deeper = resolve_barrel_export(ctx, re.source, &lookup_name, visited);
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
        reexports: HashMap<String, Vec<(String, Vec<String>, bool, Vec<RenamedImport>)>>,
        definitions: HashMap<String, HashSet<String>>,
    }

    impl BarrelContext for TestContext {
        fn reexports_for(&self, barrel_path: &str) -> Option<Vec<ReexportRef<'_>>> {
            self.reexports.get(barrel_path).map(|entries| {
                entries
                    .iter()
                    .map(|(source, names, wildcard, renames)| ReexportRef {
                        source: source.as_str(),
                        names: names.as_slice(),
                        wildcard_reexport: *wildcard,
                        renames: renames.as_slice(),
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
            vec![("src/utils.ts".to_string(), vec!["foo".to_string()], false, vec![])],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/utils.ts".to_string(),
            HashSet::from(["foo".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "foo", &mut visited);
        assert_eq!(
            result,
            Some(BarrelResolution { file: "src/utils.ts".to_string(), name: "foo".to_string() })
        );
    }

    #[test]
    fn resolves_wildcard_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/index.ts".to_string(),
            vec![("src/utils.ts".to_string(), vec![], true, vec![])],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/utils.ts".to_string(),
            HashSet::from(["bar".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "bar", &mut visited);
        assert_eq!(
            result,
            Some(BarrelResolution { file: "src/utils.ts".to_string(), name: "bar".to_string() })
        );
    }

    #[test]
    fn resolves_transitive_chain() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/index.ts".to_string(),
            vec![("src/mid.ts".to_string(), vec![], true, vec![])],
        );
        reexports.insert(
            "src/mid.ts".to_string(),
            vec![("src/deep.ts".to_string(), vec!["baz".to_string()], false, vec![])],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/deep.ts".to_string(),
            HashSet::from(["baz".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/index.ts", "baz", &mut visited);
        assert_eq!(
            result,
            Some(BarrelResolution { file: "src/deep.ts".to_string(), name: "baz".to_string() })
        );
    }

    #[test]
    fn prevents_circular_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/a.ts".to_string(),
            vec![("src/b.ts".to_string(), vec![], true, vec![])],
        );
        reexports.insert(
            "src/b.ts".to_string(),
            vec![("src/a.ts".to_string(), vec![], true, vec![])],
        );

        let ctx = TestContext {
            reexports,
            definitions: HashMap::new(),
        };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/a.ts", "missing", &mut visited);
        assert_eq!(result, None);
    }

    /// `export { realName as friendlyName } from './underlying'` — a consumer
    /// requesting `friendlyName` must resolve to `underlying.ts`'s `realName`
    /// definition, with the resolution's `name` reporting the *declared* name
    /// (#1823).
    #[test]
    fn resolves_renamed_reexport() {
        let mut reexports = HashMap::new();
        reexports.insert(
            "src/barrel.ts".to_string(),
            vec![(
                "src/underlying.ts".to_string(),
                vec!["realName".to_string()],
                false,
                vec![RenamedImport {
                    local: "friendlyName".to_string(),
                    imported: "realName".to_string(),
                }],
            )],
        );
        let mut definitions = HashMap::new();
        definitions.insert(
            "src/underlying.ts".to_string(),
            HashSet::from(["realName".to_string()]),
        );

        let ctx = TestContext { reexports, definitions };
        let mut visited = HashSet::new();
        let result = resolve_barrel_export(&ctx, "src/barrel.ts", "friendlyName", &mut visited);
        assert_eq!(
            result,
            Some(BarrelResolution {
                file: "src/underlying.ts".to_string(),
                name: "realName".to_string(),
            })
        );
    }
}
