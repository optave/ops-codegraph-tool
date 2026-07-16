use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rayon::prelude::*;

use crate::domain::parser::LanguageKind;
use crate::types::{ImportResolutionInput, PathAliases, ResolvedImport, WorkspacePackage};

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

// ── Monorepo workspace resolution ───────────────────────────────────
//
// Mirrors `resolveViaWorkspace()`/`setWorkspaces()`/`isWorkspaceResolved()`
// in `src/domain/graph/resolve.ts`. The JS side owns workspace *detection*
// (parsing pnpm-workspace.yaml / package.json / lerna.json — no equivalent
// exists in Rust, matching the established split documented in
// `infrastructure/config.rs`); this module only consumes the already-detected
// `{ packageName -> { dir, entry } }` map, passed in from JS on every call.

/// A single workspace package's resolution data. Mirrors the `WorkspaceEntry`
/// interface in `src/infrastructure/config.ts`. Plain (non-napi) struct built
/// from the napi-facing [`WorkspacePackage`] list.
#[derive(Debug, Clone)]
pub struct WorkspaceEntry {
    pub dir: String,
    pub entry: Option<String>,
}

/// Convert the napi-facing workspace package list into a lookup map, keyed
/// by package name.
pub fn workspaces_from_packages(packages: &[WorkspacePackage]) -> HashMap<String, WorkspaceEntry> {
    packages
        .iter()
        .map(|p| {
            (
                p.package_name.clone(),
                WorkspaceEntry {
                    dir: p.dir.clone(),
                    entry: p.entry.clone(),
                },
            )
        })
        .collect()
}

/// Parse a bare specifier into `(packageName, subpath)`. Mirrors
/// `parseBareSpecifier()` in resolve.ts.
/// Scoped:  `"@scope/pkg/sub"` → `("@scope/pkg", "./sub")`
/// Plain:   `"pkg/sub"`        → `("pkg", "./sub")`
/// No sub:  `"pkg"`            → `("pkg", ".")`
fn parse_bare_specifier(specifier: &str) -> Option<(String, String)> {
    let (package_name, rest) = if specifier.starts_with('@') {
        let parts: Vec<&str> = specifier.splitn(3, '/').collect();
        if parts.len() < 2 {
            return None;
        }
        let package_name = format!("{}/{}", parts[0], parts[1]);
        let rest = parts.get(2).copied().unwrap_or("").to_string();
        (package_name, rest)
    } else {
        match specifier.find('/') {
            None => (specifier.to_string(), String::new()),
            Some(idx) => (
                specifier[..idx].to_string(),
                specifier[idx + 1..].to_string(),
            ),
        }
    };
    let subpath = if rest.is_empty() {
        ".".to_string()
    } else {
        format!("./{rest}")
    };
    Some((package_name, subpath))
}

/// Extensions probed when resolving a workspace subpath import against the
/// filesystem. Mirrors the extension list in `resolveViaWorkspace()`.
const WORKSPACE_PROBE_EXTENSIONS: &[&str] = &[
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    "/index.ts",
    "/index.tsx",
    "/index.js",
];

/// Resolve a bare specifier through monorepo workspace packages.
///
/// For `"@myorg/utils"` → finds the workspace package dir → resolves to its
/// entry point. For `"@myorg/utils/sub"` → finds the package dir → filesystem
/// probes `dir/sub` then `dir/src/sub`.
///
/// Unlike `resolveViaWorkspace()` in resolve.ts, this does not attempt a
/// `package.json` `exports`-field lookup first — the native engine has no
/// `exports`-field resolver at all (tracked separately; see
/// `resolveViaExports()`'s absence from this module). This only affects
/// workspace packages that rely on a conditional `exports` map instead of
/// `main`/`source`/index-file resolution.
fn resolve_via_workspace(
    specifier: &str,
    workspaces: &HashMap<String, WorkspaceEntry>,
    root_dir: &str,
    known_files: Option<&HashSet<String>>,
) -> Option<String> {
    if workspaces.is_empty() {
        return None;
    }
    let (package_name, subpath) = parse_bare_specifier(specifier)?;
    let info = workspaces.get(&package_name)?;

    if subpath == "." {
        return info.entry.clone();
    }

    let sub_rel = &subpath[2..]; // strip leading "./"

    let base = format!("{}/{}", info.dir.trim_end_matches('/'), sub_rel);
    for ext in WORKSPACE_PROBE_EXTENSIONS {
        let candidate = format!("{base}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            return Some(candidate);
        }
    }

    let src_base = format!("{}/src/{}", info.dir.trim_end_matches('/'), sub_rel);
    for ext in WORKSPACE_PROBE_EXTENSIONS {
        let candidate = format!("{src_base}{ext}");
        if file_exists(&candidate, known_files, root_dir) {
            return Some(candidate);
        }
    }

    None
}

/// Process-lifetime cache of root-relative paths resolved via a workspace
/// import. Mirrors `_workspaceResolvedPaths` in resolve.ts — read by
/// `compute_confidence()` to grant workspace-resolved imports a 0.95
/// confidence floor regardless of directory distance.
///
/// Populated as a side effect of `resolve_import_path`/`resolve_imports_batch`
/// and reset once per build by the callers that own "start of build" timing:
/// `resolve_imports` (the per-call FFI entry point, called exactly once per
/// JS-driven build by `resolveImportsBatch()`) and `pipeline_setup` (the Rust
/// orchestrator's once-per-build setup stage). Later same-build calls (e.g.
/// the barrel re-parse loop, which calls `resolve_imports_batch` repeatedly)
/// only add to the set, matching `setWorkspaces()`'s clear-once-then-accumulate
/// contract on the JS side.
fn workspace_resolved_cache() -> &'static Mutex<HashSet<String>> {
    static CACHE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Clear the workspace-resolved-paths cache. Call once per build, before any
/// resolution runs, mirroring `_workspaceResolvedPaths.clear()` inside
/// `setWorkspaces()`.
///
/// Recovers the inner data via `unwrap_or_else` instead of silently no-op'ing
/// on a poisoned lock (`if let Ok(...)`): if a thread ever panics while
/// holding this mutex, a silent skip here would leave workspace-resolved
/// paths from the panicking build in the cache forever — every subsequent
/// build's `.lock()` call keeps returning `Err`, so `compute_confidence`
/// would keep awarding the 0.95 floor to paths that are no longer
/// workspace-resolved (Greptile review).
pub fn reset_workspace_resolved_paths() {
    let mut set = workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set.clear();
}

fn mark_workspace_resolved(path: &str) {
    let mut set = workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set.insert(path.to_string());
}

fn is_workspace_resolved(path: &str) -> bool {
    workspace_resolved_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(path)
}

/// Resolve a single import path, mirroring `resolveImportPath()` in builder.js.
pub fn resolve_import_path(
    from_file: &str,
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    resolve_import_path_inner(
        from_file,
        import_source,
        root_dir,
        aliases,
        None,
        workspaces,
    )
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

/// Resolve a non-relative (alias, workspace, or bare) import source. Returns
/// the resolved path or the raw source if nothing matches (bare specifier).
///
/// Order mirrors `resolveImportPathJS()`: aliases take priority (tsconfig/
/// jsconfig path mappings), then workspace packages ("workspace packages
/// take priority over node_modules" — resolve.ts), then the raw specifier is
/// returned unresolved.
fn resolve_non_relative_import(
    import_source: &str,
    root_dir: &str,
    aliases: &PathAliases,
    known_files: Option<&HashSet<String>>,
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    if let Some(alias_resolved) = resolve_via_alias(import_source, aliases, root_dir, known_files) {
        return relativize_to_root(&alias_resolved, root_dir);
    }
    if let Some(workspaces) = workspaces {
        if let Some(ws_resolved) =
            resolve_via_workspace(import_source, workspaces, root_dir, known_files)
        {
            let rel = relativize_to_root(&ws_resolved, root_dir);
            mark_workspace_resolved(&rel);
            return rel;
        }
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
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
) -> String {
    if !import_source.starts_with('.') {
        return resolve_non_relative_import(
            import_source,
            root_dir,
            aliases,
            known_files,
            workspaces,
        );
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

// directory_distance is on the hot path for every call-edge confidence
// score, invoked from inside compute_confidence's rayon `.par_iter()` caller
// (line ~330 below). The same directory pairs recur constantly across a
// build, so memoizing avoids rebuilding both ancestor chains and the lookup
// map every call. Thread-local (not a shared Mutex/DashMap) because rayon's
// worker pool is reused across the whole build — each worker accumulates its
// own useful cache with zero lock contention, at the cost of some redundant
// computation the first time a given pair is seen on each thread.
// distance(a, b) === distance(b, a) (symmetric tree distance), so the key is
// order-independent to halve the effective cache size per thread (#1769
// perf regression).
thread_local! {
    static DIRECTORY_DISTANCE_CACHE: std::cell::RefCell<std::collections::HashMap<(String, String), usize>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
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
    let key = if a <= b { (a.to_string(), b.to_string()) } else { (b.to_string(), a.to_string()) };
    if let Some(cached) = DIRECTORY_DISTANCE_CACHE.with(|c| c.borrow().get(&key).copied()) {
        return cached;
    }

    let chain_a = ancestor_chain(a);
    let chain_b = ancestor_chain(b);
    let index_in_b: std::collections::HashMap<&str, usize> =
        chain_b.iter().enumerate().map(|(j, d)| (d.as_str(), j)).collect();
    let mut dist = usize::MAX;
    for (i, dir_a) in chain_a.iter().enumerate() {
        if let Some(&j) = index_in_b.get(dir_a.as_str()) {
            dist = i + j;
            break;
        }
    }
    DIRECTORY_DISTANCE_CACHE.with(|c| c.borrow_mut().insert(key, dist));
    dist
}

/// Coarse "language family" for a file, derived from its extension via
/// `LanguageKind::from_extension`. Collapses TypeScript/Tsx into the same
/// family as JavaScript: despite being distinct `LanguageKind` variants (one
/// per tree-sitter grammar), `.ts`/`.tsx` files routinely import from and
/// call into `.js` files and vice versa within the same project (this
/// codebase's own `src/` tree does this throughout) — treating them as
/// separate families would reject huge amounts of legitimate same-project
/// resolution. Every other `LanguageKind` variant keeps its own family,
/// preserving `from_extension`'s existing per-language extension groupings
/// (e.g. C's `.c`+`.h`, C++'s `.cpp`/`.cc`/`.cxx`/`.hpp`) — EXCEPT `.h`,
/// treated as ambiguous (returns `None`) rather than inheriting
/// `from_extension`'s C-only mapping: `from_extension` needs one canonical
/// grammar per extension, but a `.h` header is real-world ambiguous between
/// C and C++, and the extremely common case of a `.cpp` file calling into
/// its own project's `.h` header would otherwise be misclassified as
/// cross-language and rejected outright — a real regression from the
/// pre-#1783 same-directory score of 0.7 (Greptile review). This keeps the
/// C/C++-header case working without merging C and C++ source-file families
/// wholesale (`.c` vs `.cpp` intentionally do NOT merge — see
/// is_same_language_family_does_not_merge_c_and_cpp).
fn language_family(file: &str) -> Option<LanguageKind> {
    if file.to_ascii_lowercase().ends_with(".h") {
        return None;
    }
    match LanguageKind::from_extension(file) {
        Some(LanguageKind::TypeScript) | Some(LanguageKind::Tsx) => Some(LanguageKind::JavaScript),
        other => other,
    }
}

/// True when `file_a` and `file_b` belong to the same language family, or
/// when either extension is unrecognised (ambiguous cases are not rejected —
/// they fall through to normal scoring). False only when both extensions are
/// recognised AND resolve to different families.
///
/// Guards the global-by-name call-resolution fallback against matching a
/// same-named symbol across unrelated languages — e.g. a Ruby file's bare
/// `load` call has no static relationship to a same-named `load` export in a
/// JS file, even when both happen to live in the same directory (issue
/// #1783). Mirrors `isSameLanguageFamily()` in resolve.ts.
pub fn is_same_language_family(file_a: &str, file_b: &str) -> bool {
    match (language_family(file_a), language_family(file_b)) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
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
        // Workspace-resolved imports get high confidence even across package
        // boundaries — mirrors the `_workspaceResolvedPaths` check in
        // `computeConfidenceJS()` (resolve.ts), backed here by the
        // process-lifetime cache populated by `resolve_import_path`/
        // `resolve_imports_batch` (issue #1927).
        if is_workspace_resolved(imp) {
            return 0.95;
        }
    }
    // Cross-language candidates are never legitimate call targets (#1783) —
    // reject before scoring proximity so a same-directory, same-named symbol
    // in an unrelated language can never pass the resolver's 0.5 threshold.
    if !is_same_language_family(caller_file, target_file) {
        return 0.0;
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
    workspaces: Option<&HashMap<String, WorkspaceEntry>>,
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
                workspaces,
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
            None,
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
            None,
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

    // Regression tests for #1783: the global-by-name call-resolution fallback
    // had no language-consistency check at all, so a bare-name call with no
    // import/receiver match could resolve against a same-named symbol in a
    // completely unrelated language — e.g. a Ruby file's builtin `Kernel#load`
    // call matched a JS ESM loader hook's unrelated `load` export purely
    // because both files sat in the same directory (confidence 0.7 from
    // proximity alone, well above the resolver's 0.5 threshold).

    #[test]
    fn is_same_language_family_rejects_ruby_and_js() {
        assert!(!is_same_language_family("tracer/ruby-tracer.rb", "tracer/loader-hooks.mjs"));
    }

    #[test]
    fn is_same_language_family_rejects_python_and_go() {
        assert!(!is_same_language_family("src/main.py", "src/main.go"));
    }

    #[test]
    fn is_same_language_family_accepts_same_extension() {
        assert!(is_same_language_family("src/a.rb", "lib/b.rb"));
    }

    #[test]
    fn is_same_language_family_merges_javascript_and_typescript() {
        assert!(is_same_language_family("src/a.ts", "src/b.js"));
        assert!(is_same_language_family("src/a.tsx", "src/b.mjs"));
        assert!(is_same_language_family("src/a.cjs", "src/b.jsx"));
    }

    #[test]
    fn is_same_language_family_merges_c_source_and_header() {
        assert!(is_same_language_family("src/a.c", "src/a.h"));
    }

    #[test]
    fn is_same_language_family_treats_h_as_ambiguous_with_cpp() {
        // Greptile follow-up to #1783: `.h` is real-world ambiguous between C
        // and C++ (LANGUAGE_REGISTRY/from_extension assigns it to C alone for
        // grammar-selection purposes), so a `.cpp` file calling into its own
        // project's `.h` header must not be rejected as cross-language.
        assert!(is_same_language_family("src/widget.cpp", "src/widget.h"));
    }

    #[test]
    fn is_same_language_family_merges_cpp_source_and_header_variants() {
        assert!(is_same_language_family("src/a.cpp", "src/a.hpp"));
        assert!(is_same_language_family("src/a.cc", "src/a.cxx"));
    }

    #[test]
    fn is_same_language_family_does_not_merge_c_and_cpp() {
        assert!(!is_same_language_family("src/a.c", "src/a.cpp"));
    }

    #[test]
    fn is_same_language_family_does_not_reject_unrecognised_extensions() {
        // Ambiguous (unrecognised) extensions fall through rather than being rejected.
        assert!(is_same_language_family("README", "src/b.rb"));
        assert!(is_same_language_family("src/a.rb", "Makefile"));
    }

    #[test]
    fn compute_confidence_rejects_cross_language_same_directory_match() {
        // The exact #1783 repro shape: same directory, different languages.
        let conf = compute_confidence(
            "tests/benchmarks/resolution/tracer/ruby-tracer.rb",
            "tests/benchmarks/resolution/tracer/loader-hooks.mjs",
            None,
        );
        assert_eq!(conf, 0.0);
    }

    #[test]
    fn compute_confidence_still_scores_same_language_same_directory_pair() {
        let conf = compute_confidence(
            "tests/benchmarks/resolution/tracer/ruby-tracer.rb",
            "tests/benchmarks/resolution/tracer/other-tracer.rb",
            None,
        );
        assert_eq!(conf, 0.7);
    }

    #[test]
    fn compute_confidence_does_not_regress_same_project_js_ts_resolution() {
        // A .ts caller resolving a same-directory .js target must be unaffected —
        // TS/JS are one family despite being different LanguageKind variants.
        let conf = compute_confidence("src/graph/a.ts", "src/graph/b.js", None);
        assert_eq!(conf, 0.7);
    }

    // Regression tests for #1927: `resolve_import_path_inner` had no
    // workspace-awareness at all, so a bare monorepo-package specifier (e.g.
    // `import "@myorg/lib"`) fell straight through to `resolve_non_relative_import`'s
    // raw-specifier fallback under the native engine, unlike the WASM/JS engine's
    // `resolveViaWorkspace()`.

    fn make_workspaces(entries: &[(&str, &str, Option<&str>)]) -> HashMap<String, WorkspaceEntry> {
        entries
            .iter()
            .map(|(name, dir, entry)| {
                (
                    name.to_string(),
                    WorkspaceEntry {
                        dir: dir.to_string(),
                        entry: entry.map(|e| e.to_string()),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn parse_bare_specifier_scoped_package_root() {
        assert_eq!(
            parse_bare_specifier("@myorg/core"),
            Some(("@myorg/core".to_string(), ".".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_scoped_package_subpath() {
        assert_eq!(
            parse_bare_specifier("@myorg/core/src/helpers"),
            Some(("@myorg/core".to_string(), "./src/helpers".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_plain_package() {
        assert_eq!(
            parse_bare_specifier("lodash"),
            Some(("lodash".to_string(), ".".to_string()))
        );
        assert_eq!(
            parse_bare_specifier("lodash/fp"),
            Some(("lodash".to_string(), "./fp".to_string()))
        );
    }

    #[test]
    fn parse_bare_specifier_rejects_malformed_scoped_specifier() {
        assert_eq!(parse_bare_specifier("@myorg"), None);
    }

    #[test]
    fn resolve_via_workspace_resolves_root_import_to_entry() {
        let workspaces = make_workspaces(&[(
            "@myorg/core",
            "packages/core",
            Some("packages/core/src/index.js"),
        )]);
        let result = resolve_via_workspace("@myorg/core", &workspaces, "/project", None);
        assert_eq!(result, Some("packages/core/src/index.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_returns_none_when_entry_missing() {
        let workspaces = make_workspaces(&[("@myorg/broken", "packages/broken", None)]);
        let result = resolve_via_workspace("@myorg/broken", &workspaces, "/project", None);
        assert_eq!(result, None);
    }

    #[test]
    fn resolve_via_workspace_resolves_subpath_via_known_files_probe() {
        let mut known = HashSet::new();
        known.insert("packages/core/src/helpers.js".to_string());
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        let result = resolve_via_workspace(
            "@myorg/core/src/helpers",
            &workspaces,
            "/project",
            Some(&known),
        );
        assert_eq!(result, Some("packages/core/src/helpers.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_resolves_subpath_via_src_convention() {
        let mut known = HashSet::new();
        known.insert("packages/core/src/helpers.js".to_string());
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        let result =
            resolve_via_workspace("@myorg/core/helpers", &workspaces, "/project", Some(&known));
        assert_eq!(result, Some("packages/core/src/helpers.js".to_string()));
    }

    #[test]
    fn resolve_via_workspace_returns_none_for_unknown_package() {
        let workspaces = make_workspaces(&[("@myorg/core", "packages/core", None)]);
        assert_eq!(
            resolve_via_workspace("@myorg/unknown", &workspaces, "/project", None),
            None
        );
    }

    #[test]
    fn resolve_via_workspace_returns_none_when_no_workspaces_registered() {
        let workspaces: HashMap<String, WorkspaceEntry> = HashMap::new();
        assert_eq!(
            resolve_via_workspace("@myorg/core", &workspaces, "/project", None),
            None
        );
    }

    #[test]
    fn resolve_non_relative_import_prefers_workspace_over_raw_specifier() {
        let workspaces = make_workspaces(&[(
            "@myorg/lib",
            "packages/lib",
            Some("/project/packages/lib/src/index.js"),
        )]);
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved = resolve_non_relative_import(
            "@myorg/lib",
            "/project",
            &aliases,
            None,
            Some(&workspaces),
        );
        assert_eq!(resolved, "packages/lib/src/index.js");
    }

    #[test]
    fn resolve_non_relative_import_falls_back_to_raw_specifier_without_workspace_match() {
        let workspaces = make_workspaces(&[("@myorg/lib", "packages/lib", None)]);
        let aliases = PathAliases {
            base_url: None,
            paths: vec![],
        };
        let resolved =
            resolve_non_relative_import("lodash", "/project", &aliases, None, Some(&workspaces));
        assert_eq!(resolved, "lodash");
    }

    // Serializes access to the process-lifetime workspace-resolved-paths
    // cache: `cargo test` runs tests in parallel threads within one process,
    // and `reset_workspace_resolved_paths()` would otherwise race with
    // concurrent assertions in other tests below.
    static WORKSPACE_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_workspace_cache_lock<F: FnOnce()>(f: F) {
        let guard = WORKSPACE_CACHE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_workspace_resolved_paths();
        f();
        reset_workspace_resolved_paths();
        drop(guard);
    }

    #[test]
    fn resolve_import_path_marks_workspace_resolved_paths() {
        with_workspace_cache_lock(|| {
            let workspaces = make_workspaces(&[(
                "@myorg/lib",
                "packages/lib",
                Some("/project/packages/lib/src/index.js"),
            )]);
            let aliases = PathAliases {
                base_url: None,
                paths: vec![],
            };
            let resolved = resolve_import_path(
                "/project/apps/web/src/app.js",
                "@myorg/lib",
                "/project",
                &aliases,
                Some(&workspaces),
            );
            assert_eq!(resolved, "packages/lib/src/index.js");
            assert!(is_workspace_resolved("packages/lib/src/index.js"));
        });
    }

    #[test]
    fn compute_confidence_returns_0_95_for_workspace_resolved_import() {
        with_workspace_cache_lock(|| {
            mark_workspace_resolved("packages/lib/src/index.js");
            let conf = compute_confidence(
                "apps/web/src/app.js",
                "packages/lib/src/utils.js",
                Some("packages/lib/src/index.js"),
            );
            assert_eq!(conf, 0.95);
        });
    }

    #[test]
    fn compute_confidence_does_not_boost_non_workspace_imports() {
        with_workspace_cache_lock(|| {
            let conf = compute_confidence(
                "apps/web/src/app.js",
                "some/distant/file.js",
                Some("some/other/import.js"),
            );
            assert!(conf < 0.95);
        });
    }

    #[test]
    fn reset_workspace_resolved_paths_clears_previously_marked_entries() {
        with_workspace_cache_lock(|| {
            mark_workspace_resolved("packages/lib/src/index.js");
            assert!(is_workspace_resolved("packages/lib/src/index.js"));
            reset_workspace_resolved_paths();
            assert!(!is_workspace_resolved("packages/lib/src/index.js"));
        });
    }
}
