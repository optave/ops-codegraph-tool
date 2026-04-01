//! File collection for the build pipeline.
//!
//! Recursively walks the project directory, respecting `.gitignore` files,
//! extension filters, and ignored directory names. Uses the `ignore` crate
//! (from BurntSushi/ripgrep) for gitignore-aware traversal.

use crate::parser_registry::LanguageKind;
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

/// Collect all source files under `root_dir`, respecting gitignore and ignore dirs.
///
/// `extra_ignore_dirs` are additional directory names to skip (from config `ignoreDirs`).
pub fn collect_files(root_dir: &str, extra_ignore_dirs: &[String]) -> CollectResult {
    let mut ignore_set: HashSet<&str> = DEFAULT_IGNORE_DIRS.iter().copied().collect();
    for d in extra_ignore_dirs {
        // Leak is fine here — these are config-provided strings that live for the build duration.
        // We avoid it by storing owned strings separately.
        ignore_set.insert(leak_str(d));
    }

    let ext_set: HashSet<&str> = SUPPORTED_EXTENSIONS.iter().copied().collect();

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
/// Returns `None` when the fast path isn't applicable.
pub fn try_fast_collect(
    root_dir: &str,
    db_files: &[String],
    journal_changed: &[String],
    journal_removed: &[String],
) -> CollectResult {
    let mut file_set: HashSet<String> = db_files.iter().cloned().collect();

    // Apply journal deltas
    for removed in journal_removed {
        file_set.remove(removed);
    }
    for changed in journal_changed {
        file_set.insert(changed.clone());
    }

    // Convert relative paths to absolute and compute directories
    let root = Path::new(root_dir);
    let mut files = Vec::with_capacity(file_set.len());
    let mut directories = HashSet::new();

    for rel_path in &file_set {
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

/// Helper to get a `&'static str` from a `&String` for use in HashSet closures.
/// This leaks the string, which is acceptable for config values that live for
/// the duration of the build.
fn leak_str(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
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

        let result = collect_files(tmp.to_str().unwrap(), &[]);
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

        let result = collect_files(tmp.to_str().unwrap(), &[]);
        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].contains("app.ts"));

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

        let result = try_fast_collect(root, &db_files, &changed, &removed);
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
}
