use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::types::{AliasMapping, ImportResolutionInput, PathAliases, ResolvedImport};

/// Check file existence using known_files set when available, falling back to FS.
fn file_exists(path: &str, known: Option<&HashSet<String>>) -> bool {
    known.map_or_else(|| Path::new(path).exists(), |set| set.contains(path))
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
    _root_dir: &str,
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
                if file_exists(&full, known_files) {
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
                if file_exists(&full, known_files) {
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
fn resolve_import_path_inner(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
) -> String {
    // Try alias resolution for non-relative imports
    if !import_source.starts_with('.') {
        if let Some(alias_resolved) =
            resolve_via_alias(import_source, aliases, root_dir, known_files)
        {
            let root = Path::new(root_dir);
            if let Ok(rel) = Path::new(&alias_resolved).strip_prefix(root) {
                return normalize_path(&rel.display().to_string());
            }
            return normalize_path(&alias_resolved);
        }
        // Bare specifier (e.g., "lodash") — return as-is
        return import_source.to_string();
    }

    // Relative import — normalize immediately to remove `.` / `..` segments
    let dir = Path::new(from_file).parent().unwrap_or(Path::new(""));
    let resolved = clean_path(&dir.join(import_source));
    let resolved_str = resolved.display().to_string().replace('\\', "/");

    // .js → .ts remap
    if resolved_str.ends_with(".js") {
        let ts_candidate = resolved_str.replace(".js", ".ts");
        if file_exists(&ts_candidate, known_files) {
            let root = Path::new(root_dir);
            if let Ok(rel) = Path::new(&ts_candidate).strip_prefix(root) {
                return normalize_path(&rel.display().to_string());
            }
        }
        let tsx_candidate = resolved_str.replace(".js", ".tsx");
        if file_exists(&tsx_candidate, known_files) {
            let root = Path::new(root_dir);
            if let Ok(rel) = Path::new(&tsx_candidate).strip_prefix(root) {
                return normalize_path(&rel.display().to_string());
            }
        }
    }

    // Extension probing
    let extensions = [
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
    for ext in &extensions {
        let candidate = format!("{}{}", resolved_str, ext);
        if file_exists(&candidate, known_files) {
            let root = Path::new(root_dir);
            if let Ok(rel) = Path::new(&candidate).strip_prefix(root) {
                return normalize_path(&rel.display().to_string());
            }
        }
    }

    // Exact match
    if file_exists(&resolved_str, known_files) {
        let root = Path::new(root_dir);
        if let Ok(rel) = Path::new(&resolved_str).strip_prefix(root) {
            return normalize_path(&rel.display().to_string());
        }
    }

    // Fallback: return relative path
    let root = Path::new(root_dir);
    if let Ok(rel) = resolved.strip_prefix(root) {
        normalize_path(&rel.display().to_string())
    } else {
        normalize_path(&resolved_str)
    }
}

/// Compute proximity-based confidence for call resolution.
/// Mirrors `computeConfidence()` in builder.js.
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

    if caller_dir == target_dir {
        return 0.7;
    }

    let caller_parent = Path::new(&caller_dir)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let target_parent = Path::new(&target_dir)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    if caller_parent == target_parent {
        return 0.5;
    }

    0.3
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
}
