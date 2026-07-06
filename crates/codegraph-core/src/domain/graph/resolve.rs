use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::types::{ImportResolutionInput, PathAliases, ResolvedImport};

/// Check file existence using known_files set when available, falling back to FS.
///
/// When `known_files` is provided, candidates may be absolute paths while
/// the set contains relative paths (normalized with forward slashes).
/// We try both the raw path and the root-relative version so extension
/// probing works regardless of the path format (#804).
fn file_exists(path: &str, known: Option<&HashSet<String>>, root_dir: &str) -> bool {
    match known {
        Some(set) => {
            if set.contains(path) {
                return true;
            }
            // Candidates are often absolute; known_files are relative — try stripping root
            let normalized = path.replace('\\', "/");
            let root_normalized = root_dir.replace('\\', "/");
            let root_prefix = if root_normalized.ends_with('/') {
                root_normalized
            } else {
                format!("{}/", root_normalized)
            };
            if let Some(rel) = normalized.strip_prefix(&root_prefix) {
                return set.contains(rel);
            }
            false
        }
        None => Path::new(path).exists(),
    }
}

/// Resolve `.` and `..` components in a path without touching the filesystem.
/// Unlike `PathBuf::components().collect()`, this properly collapses `..` by
/// popping the previous component from the result.
///
/// NOTE: if the path begins with more `..` components than there are preceding
/// components to pop (e.g. a purely relative `../../foo`), the excess `..`
/// components are silently dropped.  This function is therefore only correct
/// when called on paths that have already been joined to a base directory with
/// sufficient depth.
fn clean_path(p: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                result.pop();
            }
            std::path::Component::CurDir => {}
            _ => result.push(c),
        }
    }
    result
}

/// Normalize a path to use forward slashes and clean `.` / `..` segments
/// (cross-platform consistency).
fn normalize_path(p: &str) -> String {
    let cleaned = clean_path(Path::new(p));
    cleaned.display().to_string().replace('\\', "/")
}

/// Try resolving via path aliases (tsconfig/jsconfig paths).
fn resolve_via_alias(
    import_source: &str,
    aliases: &PathAliases,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    // baseUrl resolution
    if let Some(base_url) = &aliases.base_url {
        if !import_source.starts_with('.') && !import_source.starts_with('/') {
            let candidate = PathBuf::from(base_url).join(import_source);
            for ext in &[
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                "/index.ts",
                "/index.tsx",
                "/index.js",
            ] {
                let full = format!("{}{}", candidate.display(), ext);
                if file_exists(&full, known_files, root_dir) {
                    return Some(full);
                }
            }
        }
    }

    // Path pattern resolution
    for mapping in &aliases.paths {
        let prefix = mapping.pattern.trim_end_matches('*');
        if !import_source.starts_with(prefix) {
            continue;
        }
        let rest = &import_source[prefix.len()..];
        for target in &mapping.targets {
            let resolved = target.replace('*', rest);
            for ext in &[
                "",
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                "/index.ts",
                "/index.tsx",
                "/index.js",
            ] {
                let full = format!("{}{}", resolved, ext);
                if file_exists(&full, known_files, root_dir) {
                    return Some(full);
                }
            }
        }
    }

    None
}

/// Resolve a single import path, mirroring `resolveImportPath()` in builder.js.
pub fn resolve_import_path(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
) -> String {
    resolve_import_path_inner(from_file, import_source, root_dir, aliases, None)
}

/// Inner implementation with optional known_files cache.
/// Convert an absolute path candidate into a root-relative, normalized
/// path string. Used as the success exit of every probe in
/// `resolve_import_path_inner`.
fn relativize_to_root(candidate: &str, root_dir: &str) -> String {
    let root = Path::new(root_dir);
    if let Ok(rel) = Path::new(candidate).strip_prefix(root) {
        normalize_path(&rel.display().to_string())
    } else {
        normalize_path(candidate)
    }
}

/// Resolve a non-relative (alias or bare) import source. Returns the
/// resolved path or the raw source if no alias matches (bare specifier).
fn resolve_non_relative_import(
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
) -> String {
    if let Some(alias_resolved) = resolve_via_alias(import_source, aliases, root_dir, known_files) {
        return relativize_to_root(&alias_resolved, root_dir);
    }
    import_source.to_string()
}

/// Probe the `.js → .ts/.tsx` remap candidates and return the first
/// existing file's root-relative path, if any.
/// Skips candidates that exist but lie outside `root_dir` (strip_prefix
/// would fail), preserving the original fall-through behaviour.
fn probe_js_to_ts_remap(
    resolved_str: &str,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    if !resolved_str.ends_with(".js") {
        return None;
    }
    let root = Path::new(root_dir);
    for replacement in [".ts", ".tsx"] {
        let candidate = resolved_str.replace(".js", replacement);
        if file_exists(&candidate, known_files, root_dir) {
            if let Ok(rel) = Path::new(&candidate).strip_prefix(root) {
                return Some(normalize_path(&rel.display().to_string()));
            }
            // candidate exists but is outside root_dir — keep probing
        }
    }
    None
}

/// Probe known extensions (TS/JS/Python plus index files) for an existing
/// match against the normalized relative path stem.
/// Skips candidates that exist but lie outside `root_dir` (strip_prefix
/// would fail), preserving the original fall-through behaviour.
fn probe_known_extensions(
    resolved_str: &str,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    const EXTENSIONS: &[&str] = &[
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".py",
        ".pyi",
        "/index.ts",
        "/index.tsx",
        "/index.js",
        "/__init__.py",
    ];
    let root = Path::new(root_dir);
    for ext in EXTENSIONS {
        let candidate = format!("{resolved_str}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            if let Ok(rel) = Path::new(&candidate).strip_prefix(root) {
                return Some(normalize_path(&rel.display().to_string()));
            }
            // candidate exists but is outside root_dir — keep probing
        }
    }
    None
}

fn resolve_import_path_inner(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
) -> String {
    if !import_source.starts_with('.') {
        return resolve_non_relative_import(import_source, root_dir, aliases, known_files);
    }

    let dir = Path::new(from_file).parent().unwrap_or(Path::new(""));
    let resolved = clean_path(&dir.join(import_source));
    let resolved_str = resolved.display().to_string().replace('\\', "/");

    if let Some(p) = probe_js_to_ts_remap(&resolved_str, root_dir, known_files) {
        return p;
    }
    if let Some(p) = probe_known_extensions(&resolved_str, root_dir, known_files) {
        return p;
    }
    if file_exists(&resolved_str, known_files, root_dir) {
        return relativize_to_root(&resolved_str, root_dir);
    }
    relativize_to_root(&resolved.display().to_string().replace('\\', "/"), root_dir)
}

/// All ancestor directories of `dir`, starting with `dir` itself, walking up to the root.
fn ancestor_chain(dir: &str) -> Vec<String> {
    let mut chain = vec![dir.to_string()];
    let mut cur = dir.to_string();
    while let Some(parent) = Path::new(&cur).parent() {
        let parent_str = parent.display().to_string();
        chain.push(parent_str.clone());
        cur = parent_str;
    }
    chain
}

/// Directory-tree distance between two directories: hops up from `a` to the
/// nearest ancestor shared with `b`, plus hops down from there to `b`.
///
/// Symmetric and depth-independent — unlike a fixed-depth equality check
/// (e.g. comparing the parent-of-parent of `a` to the parent-of-parent of
/// `b`, as `compute_confidence` used to), this correctly scores both sibling
/// directories (common parent) and direct ancestor/descendant directories
/// (one nested inside the other) regardless of how deep either path is. The
/// fixed-depth check only matched when both files sat at the *same* depth,
/// so e.g. a file in `graph/algorithms/*.rs` calling a method declared in
/// the shallower `graph/model.rs` was scored as maximally distant (issue #1769).
fn directory_distance(a: &str, b: &str) -> usize {
    let chain_a = ancestor_chain(a);
    let chain_b = ancestor_chain(b);
    for (i, dir_a) in chain_a.iter().enumerate() {
        if let Some(j) = chain_b.iter().position(|dir_b| dir_b == dir_a) {
            return i + j;
        }
    }
    usize::MAX
}

/// Compute proximity-based confidence for call resolution.
/// Mirrors `computeConfidence()` in resolve.ts.
pub fn compute_confidence(
    caller_file: &str,
    target_file: &str,
    imported_from: Option<&str>,
) -> f64 {
    if target_file.is_empty() || caller_file.is_empty() {
        return 0.3;
    }
    if caller_file == target_file {
        return 1.0;
    }
    if let Some(imp) = imported_from {
        if imp == target_file {
            return 1.0;
        }
    }

    let caller_dir = Path::new(caller_file)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let target_dir = Path::new(target_file)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    match directory_distance(&caller_dir, &target_dir) {
        0 => 0.7, // same directory
        1 => 0.6, // direct parent/child directory
        2 => 0.5, // sibling directories, or a grandparent/grandchild pair
        _ => 0.3,
    }
}

/// Batch resolve multiple imports (parallelized with rayon).
pub fn resolve_imports_batch(
    inputs: &[ImportResolutionInput],
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
) -> Vec<ResolvedImport> {
    inputs
        .par_iter()
        .map(|input| {
            let resolved = resolve_import_path_inner(
                &input.from_file,
                &input.import_source,
                root_dir,
                aliases,
                known_files,
            );
            ResolvedImport {
                from_file: input.from_file.clone(),
                import_source: input.import_source.clone(),
                resolved_path: resolved,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_path_collapses_parent_dirs() {
        assert_eq!(
            clean_path(Path::new("src/cli/commands/../../domain/graph/builder.js")),
            PathBuf::from("src/domain/graph/builder.js")
        );
    }

    #[test]
    fn clean_path_skips_cur_dir() {
        assert_eq!(
            clean_path(Path::new("src/./foo.ts")),
            PathBuf::from("src/foo.ts")
        );
    }

    #[test]
    fn clean_path_handles_absolute_root() {
        assert_eq!(
            clean_path(Path::new("/src/../foo.ts")),
            PathBuf::from("/foo.ts")
        );
    }

    #[test]
    fn clean_path_mixed_segments() {
        assert_eq!(
            clean_path(Path::new("a/b/../c/./d/../e.js")),
            PathBuf::from("a/c/e.js")
        );
    }

    #[test]
    fn clean_path_excess_parent_dirs_silently_dropped() {
        // Documents the known limitation: excess leading `..` are dropped
        assert_eq!(
            clean_path(Path::new("../../foo")),
            PathBuf::from("foo")
        );
    }

    #[test]
    fn file_exists_matches_absolute_against_relative_known_files() {
        // Regression test for #804: known_files contains relative paths but
        // extension-probing candidates are absolute. file_exists must strip
        // root_dir to find the match.
        let mut known = HashSet::new();
        known.insert("src/domain/parser.ts".to_string());
        known.insert("src/index.ts".to_string());

        let root = "/project";

        // Absolute candidate should match relative known_files entry
        assert!(file_exists("/project/src/domain/parser.ts", Some(&known), root));
        assert!(file_exists("/project/src/index.ts", Some(&known), root));

        // Non-matching paths should still return false
        assert!(!file_exists("/project/src/nonexistent.ts", Some(&known), root));

        // Relative candidate should still match directly
        assert!(file_exists("src/domain/parser.ts", Some(&known), root));
    }

    #[test]
    fn resolve_with_known_files_probes_extensions() {
        // Regression test for #804: when from_file is absolute and known_files
        // are relative, extension probing should still resolve ./bar to src/bar.ts
        let mut known = HashSet::new();
        known.insert("src/bar.ts".to_string());

        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };

        let result = resolve_import_path_inner(
            "/project/src/foo.ts",
            "./bar",
            "/project",
            &aliases,
            Some(&known),
        );
        assert_eq!(result, "src/bar.ts");
    }

    #[test]
    fn resolve_js_to_ts_remap_with_known_files() {
        // .js → .ts remap should also work with absolute/relative mismatch
        let mut known = HashSet::new();
        known.insert("src/utils.ts".to_string());

        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };

        let result = resolve_import_path_inner(
            "/project/src/index.ts",
            "./utils.js",
            "/project",
            &aliases,
            Some(&known),
        );
        assert_eq!(result, "src/utils.ts");
    }

    // Regression tests for #1769: a fixed-depth "grandparent equality" check
    // used to compare the parent of `caller_dir` to the parent of `target_dir`,
    // which only matched when both files sat at the *same* depth. A file in a
    // subdirectory calling a method declared in its direct parent directory
    // (e.g. `graph/algorithms/bfs.rs` calling `graph/model.rs`) was scored as
    // maximally distant (0.3) purely because the two files were nested at
    // different depths — well below the 0.5 threshold used by the call-edge
    // resolver's typed-method lookup, silently dropping the call edge.

    #[test]
    fn compute_confidence_scores_parent_child_dirs_above_resolver_threshold() {
        let conf = compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        assert!(conf >= 0.5, "expected >= 0.5, got {conf}");
    }

    #[test]
    fn compute_confidence_is_symmetric_for_parent_child_dirs() {
        let caller_deeper =
            compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        let target_deeper =
            compute_confidence("src/graph/model.rs", "src/graph/algorithms/bfs.rs", None);
        assert_eq!(caller_deeper, target_deeper);
    }

    #[test]
    fn compute_confidence_ranks_parent_child_between_same_dir_and_sibling() {
        let same_dir = compute_confidence("src/graph/a.rs", "src/graph/b.rs", None);
        let parent_child =
            compute_confidence("src/graph/algorithms/bfs.rs", "src/graph/model.rs", None);
        // True siblings: both one level below `src`, at equal depth.
        let sibling = compute_confidence("src/graph/a.rs", "src/features/b.rs", None);
        assert!(same_dir > parent_child);
        assert!(parent_child > sibling);
    }

    #[test]
    fn compute_confidence_scores_two_level_nesting_at_or_above_sibling_tier() {
        // the graph/algorithms/leiden/*.rs -> graph/model.rs shape from #1769.
        let conf = compute_confidence(
            "src/graph/algorithms/leiden/cpm.rs",
            "src/graph/model.rs",
            None,
        );
        assert!(conf >= 0.5, "expected >= 0.5, got {conf}");
    }

    #[test]
    fn compute_confidence_still_scores_unrelated_deep_files_as_distant() {
        let conf = compute_confidence(
            "src/graph/algorithms/leiden/cpm.rs",
            "src/mcp/server.rs",
            None,
        );
        assert!(conf < 0.5, "expected < 0.5, got {conf}");
    }

    #[test]
    fn directory_distance_same_dir_is_zero() {
        assert_eq!(directory_distance("src/graph", "src/graph"), 0);
    }

    #[test]
    fn directory_distance_direct_parent_child_is_one() {
        assert_eq!(directory_distance("src/graph/algorithms", "src/graph"), 1);
        assert_eq!(directory_distance("src/graph", "src/graph/algorithms"), 1);
    }

    #[test]
    fn directory_distance_siblings_is_two() {
        // Both dirs are one level below `src` — true siblings at equal depth.
        assert_eq!(directory_distance("src/graph", "src/features"), 2);
    }

    #[test]
    fn directory_distance_unequal_depth_non_siblings_is_three() {
        // `algorithms` is nested inside `graph`, which is a sibling of `features` —
        // not a direct sibling pair despite sharing the `src` ancestor.
        assert_eq!(directory_distance("src/graph/algorithms", "src/features"), 3);
    }
}
