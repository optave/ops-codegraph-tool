//! File collection for the build pipeline.
//!
//! Recursively walks the project directory, respecting `.gitignore` files,
//! extension filters, and ignored directory names. Uses the `ignore` crate
//! (from BurntSushi/ripgrep) for gitignore-aware traversal.

use crate::parser_registry::LanguageKind;
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::collections::HashSet;
use std::path::Path;

/// Default directories to ignore (mirrors `IGNORE_DIRS` in `src/shared/constants.ts`).
const DEFAULT_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    ".codegraph",
    "__pycache__",
    ".tox",
    "vendor",
    ".venv",
    "venv",
    "env",
    ".env",
];

/// All supported file extensions (mirrors the JS `EXTENSIONS` set).
/// Must stay in sync with `LanguageKind::from_extension`.
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "d.ts", "py", "pyi", "go", "rs", "java", "cs", "rb",
    "rake", "gemspec", "php", "phtml", "tf", "hcl", "c", "h", "cpp", "cc", "cxx", "hpp", "kt",
    "kts", "swift", "scala", "sh", "bash", "ex", "exs", "lua", "dart", "zig", "hs", "ml", "mli",
];

/// Result of file collection.
pub struct CollectResult {
    /// Absolute paths of all collected source files.
    pub files: Vec<String>,
    /// Absolute paths of directories containing source files.
    pub directories: HashSet<String>,
}

/// Compile a list of glob patterns into a `GlobSet`.
///
/// Invalid patterns are logged via `eprintln!` and skipped so a single bad
/// entry in config can't take down the whole build.
fn build_glob_set(patterns: &[String]) -> Option<GlobSet> {
    if patterns.is_empty() {
        return None;
    }
    let mut builder = GlobSetBuilder::new();
    let mut added = 0usize;
    for p in patterns {
        match Glob::new(p) {
            Ok(g) => {
                builder.add(g);
                added += 1;
            }
            Err(e) => {
                eprintln!("codegraph: ignoring invalid glob pattern {p:?}: {e}");
            }
        }
    }
    if added == 0 {
        return None;
    }
    match builder.build() {
        Ok(set) => Some(set),
        Err(e) => {
            // Failing to build the GlobSet disables *all* include/exclude
            // filters, which silently changes what files the build sees.
            // Surface the error so users can correct their config instead of
            // being confused by ignored filters.
            eprintln!("codegraph: failed to build glob set: {e}");
            None
        }
    }
}

/// `true` when the relative path passes the configured include/exclude filters.
///
/// `rel_path` must be relative to the project root and normalized to forward
/// slashes. Mirrors `passesIncludeExclude` in `src/domain/graph/builder/helpers.ts`
/// so both engines accept or reject the same set of files.
pub fn passes_include_exclude(
    rel_path: &str,
    include: Option<&GlobSet>,
    exclude: Option<&GlobSet>,
) -> bool {
    if let Some(set) = include {
        if !set.is_match(rel_path) {
            return false;
        }
    }
    if let Some(set) = exclude {
        if set.is_match(rel_path) {
            return false;
        }
    }
    true
}

/// Collect all source files under `root_dir`, respecting gitignore and ignore dirs.
///
/// `extra_ignore_dirs` are additional directory names to skip (from config `ignoreDirs`).
/// `include_patterns` / `exclude_patterns` are file-level glob filters applied after
/// the extension check, matched against paths relative to `root_dir`.
pub fn collect_files(
    root_dir: &str,
    extra_ignore_dirs: &[String],
    include_patterns: &[String],
    exclude_patterns: &[String],
) -> CollectResult {
    // Build an owned set of ignore dirs to avoid leaking memory.
    // The closure captures this owned set, so lifetimes are satisfied without Box::leak.
    let ignore_set: HashSet<String> = DEFAULT_IGNORE_DIRS
        .iter()
        .map(|s| s.to_string())
        .chain(extra_ignore_dirs.iter().cloned())
        .collect();

    let ext_set: HashSet<&str> = SUPPORTED_EXTENSIONS.iter().copied().collect();

    let include_set = build_glob_set(include_patterns);
    let exclude_set = build_glob_set(exclude_patterns);
    let root_path = Path::new(root_dir);

    let mut files = Vec::new();
    let mut directories = HashSet::new();

    // Use the `ignore` crate for gitignore-aware walking.
    let walker = ignore::WalkBuilder::new(root_dir)
        .hidden(true) // skip hidden files/dirs by default
        .git_ignore(true) // respect .gitignore
        .git_global(false) // skip global gitignore
        .git_exclude(true) // respect .git/info/exclude
        .filter_entry(move |entry| {
            let name = entry.file_name().to_str().unwrap_or("");
            // Skip ignored directory names
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                if ignore_set.contains(name) {
                    return false;
                }
                // Skip hidden dirs (starting with '.') unless it's '.'
                if name.starts_with('.') && name != "." {
                    return false;
                }
            }
            true
        })
        .build();

    for entry in walker.flatten() {
        let ft = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        if !ft.is_file() {
            continue;
        }

        let path = entry.path();

        // Check if the file has a supported extension using LanguageKind
        // (authoritative parser registry) as primary check.
        let path_str = path.to_str().unwrap_or("");
        if LanguageKind::from_extension(path_str).is_none() {
            // Fallback: check raw extension for edge cases (.d.ts handled by LanguageKind)
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext_set.contains(ext) {
                continue;
            }
        }

        // Apply file-level include/exclude globs against the relative path.
        if include_set.is_some() || exclude_set.is_some() {
            let rel = path
                .strip_prefix(root_path)
                .ok()
                .and_then(|p| p.to_str())
                .map(|s| s.replace('\\', "/"))
                .unwrap_or_else(|| normalize_path(path));
            if !passes_include_exclude(&rel, include_set.as_ref(), exclude_set.as_ref()) {
                continue;
            }
        }

        let abs = normalize_path(path);
        if let Some(parent) = path.parent() {
            directories.insert(normalize_path(parent));
        }
        files.push(abs);
    }

    CollectResult { files, directories }
}

/// Reconstruct file list from DB file_hashes + journal deltas (fast path).
///
/// Applies `include_patterns` / `exclude_patterns` so incremental builds honor
/// config changes — the paths in the DB were collected under an earlier config
/// that may have had different glob filters.
///
/// Returns `None` when the fast path isn't applicable.
pub fn try_fast_collect(
    root_dir: &str,
    db_files: &[String],
    journal_changed: &[String],
    journal_removed: &[String],
    include_patterns: &[String],
    exclude_patterns: &[String],
) -> CollectResult {
    let mut file_set: HashSet<String> = db_files.iter().cloned().collect();

    // Apply journal deltas
    for removed in journal_removed {
        file_set.remove(removed);
    }
    for changed in journal_changed {
        file_set.insert(changed.clone());
    }

    let include_set = build_glob_set(include_patterns);
    let exclude_set = build_glob_set(exclude_patterns);
    let has_filters = include_set.is_some() || exclude_set.is_some();

    // Convert relative paths to absolute and compute directories
    let root = Path::new(root_dir);
    let mut files = Vec::with_capacity(file_set.len());
    let mut directories = HashSet::new();

    for rel_path in &file_set {
        if has_filters {
            let norm = rel_path.replace('\\', "/");
            if !passes_include_exclude(&norm, include_set.as_ref(), exclude_set.as_ref()) {
                continue;
            }
        }
        let abs = root.join(rel_path);
        let abs_str = normalize_path(&abs);
        if let Some(parent) = abs.parent() {
            directories.insert(normalize_path(parent));
        }
        files.push(abs_str);
    }

    CollectResult { files, directories }
}

/// Normalize a path to use forward slashes (cross-platform consistency).
fn normalize_path(p: &Path) -> String {
    p.to_str().unwrap_or("").replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn collect_finds_supported_files() {
        let tmp = std::env::temp_dir().join("codegraph_collect_test");
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("main.ts"), "export const x = 1;").unwrap();
        fs::write(src.join("readme.md"), "# Hello").unwrap();
        fs::write(src.join("util.js"), "module.exports = {};").unwrap();

        let result = collect_files(tmp.to_str().unwrap(), &[], &[], &[]);
        let names: HashSet<String> = result
            .files
            .iter()
            .filter_map(|f| {
                Path::new(f)
                    .file_name()
                    .map(|n| n.to_str().unwrap().to_string())
            })
            .collect();

        assert!(names.contains("main.ts"));
        assert!(names.contains("util.js"));
        assert!(!names.contains("readme.md"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_skips_ignored_dirs() {
        let tmp = std::env::temp_dir().join("codegraph_collect_ignore_test");
        let _ = fs::remove_dir_all(&tmp);
        let nm = tmp.join("node_modules").join("pkg");
        fs::create_dir_all(&nm).unwrap();
        fs::write(nm.join("index.js"), "").unwrap();
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("app.ts"), "").unwrap();

        let result = collect_files(tmp.to_str().unwrap(), &[], &[], &[]);
        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].contains("app.ts"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_honors_exclude_globs() {
        let tmp = std::env::temp_dir().join("codegraph_collect_exclude_test");
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("app.ts"), "").unwrap();
        fs::write(src.join("app.test.ts"), "").unwrap();
        fs::write(src.join("util.ts"), "").unwrap();

        let exclude = vec!["**/*.test.ts".to_string()];
        let result = collect_files(tmp.to_str().unwrap(), &[], &[], &exclude);
        let names: HashSet<String> = result
            .files
            .iter()
            .filter_map(|f| Path::new(f).file_name().map(|n| n.to_str().unwrap().to_string()))
            .collect();
        assert!(names.contains("app.ts"));
        assert!(names.contains("util.ts"));
        assert!(!names.contains("app.test.ts"), "exclude glob should reject matching files");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_honors_include_globs() {
        let tmp = std::env::temp_dir().join("codegraph_collect_include_test");
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let tests = tmp.join("tests");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&tests).unwrap();
        fs::write(src.join("app.ts"), "").unwrap();
        fs::write(tests.join("spec.ts"), "").unwrap();

        let include = vec!["src/**".to_string()];
        let result = collect_files(tmp.to_str().unwrap(), &[], &include, &[]);
        let names: HashSet<String> = result
            .files
            .iter()
            .filter_map(|f| Path::new(f).file_name().map(|n| n.to_str().unwrap().to_string()))
            .collect();
        assert!(names.contains("app.ts"));
        assert!(!names.contains("spec.ts"), "include glob should reject non-matching files");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn fast_collect_applies_deltas() {
        let root = "/project";
        let db_files = vec![
            "src/a.ts".to_string(),
            "src/b.ts".to_string(),
            "src/c.ts".to_string(),
        ];
        let changed = vec!["src/d.ts".to_string()];
        let removed = vec!["src/b.ts".to_string()];

        let result = try_fast_collect(root, &db_files, &changed, &removed, &[], &[]);
        assert_eq!(result.files.len(), 3); // a, c, d
        let names: HashSet<&str> = result
            .files
            .iter()
            .map(|f| f.rsplit('/').next().unwrap_or(f))
            .collect();
        assert!(names.contains("a.ts"));
        assert!(!names.contains("b.ts"));
        assert!(names.contains("c.ts"));
        assert!(names.contains("d.ts"));
    }

    #[test]
    fn fast_collect_honors_exclude_globs() {
        let root = "/project";
        let db_files = vec![
            "src/a.ts".to_string(),
            "src/a.test.ts".to_string(),
            "src/b.ts".to_string(),
        ];
        let exclude = vec!["**/*.test.ts".to_string()];

        let result = try_fast_collect(root, &db_files, &[], &[], &[], &exclude);
        let names: HashSet<&str> = result
            .files
            .iter()
            .map(|f| f.rsplit('/').next().unwrap_or(f))
            .collect();
        assert!(names.contains("a.ts"));
        assert!(names.contains("b.ts"));
        assert!(
            !names.contains("a.test.ts"),
            "fast path must filter out excluded files so incremental builds honor config changes"
        );
    }
}
