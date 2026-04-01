//! Read/write the `changes.journal` file for incremental build fast paths.
//!
//! Format:
//! ```text
//! # codegraph-journal v1 <timestamp_ms>
//! relative/path/to/changed.ts
//! DELETED relative/path/to/removed.ts
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const HEADER_PREFIX: &str = "# codegraph-journal v1 ";

#[derive(Debug, Default)]
pub struct JournalResult {
    pub valid: bool,
    pub timestamp: f64,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
}

fn journal_path(root_dir: &str) -> PathBuf {
    Path::new(root_dir)
        .join(".codegraph")
        .join("changes.journal")
}

/// Read and parse the changes journal.
pub fn read_journal(root_dir: &str) -> JournalResult {
    let path = journal_path(root_dir);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return JournalResult::default(),
    };

    let mut lines = content.lines();
    let header = match lines.next() {
        Some(h) if h.starts_with(HEADER_PREFIX) => h,
        _ => return JournalResult::default(),
    };

    let timestamp: f64 = match header[HEADER_PREFIX.len()..].trim().parse::<f64>() {
        Ok(t) if t > 0.0 && t.is_finite() => t,
        _ => return JournalResult::default(),
    };

    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut seen_changed = HashSet::new();
    let mut seen_removed = HashSet::new();

    for line in lines {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(file_path) = line.strip_prefix("DELETED ") {
            if !file_path.is_empty() && seen_removed.insert(file_path.to_string()) {
                removed.push(file_path.to_string());
            }
        } else if seen_changed.insert(line.to_string()) {
            changed.push(line.to_string());
        }
    }

    JournalResult {
        valid: true,
        timestamp,
        changed,
        removed,
    }
}

/// Write a fresh journal header, atomically replacing the old journal.
pub fn write_journal_header(root_dir: &str, timestamp: f64) {
    let dir = Path::new(root_dir).join(".codegraph");
    let path = dir.join("changes.journal");
    let tmp = dir.join("changes.journal.tmp");

    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("Warning: failed to create .codegraph dir: {e}");
        return;
    }

    let content = format!("{HEADER_PREFIX}{timestamp}\n");
    if fs::write(&tmp, &content).is_ok() {
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn round_trip_journal() {
        let tmp = std::env::temp_dir().join("codegraph_journal_test");
        let root = tmp.to_str().unwrap();
        let dir = tmp.join(".codegraph");
        fs::create_dir_all(&dir).unwrap();

        // Write header
        write_journal_header(root, 1700000000000.0);

        // Append some entries manually
        let journal_file = dir.join("changes.journal");
        let mut content = fs::read_to_string(&journal_file).unwrap();
        content.push_str("src/foo.ts\n");
        content.push_str("DELETED src/bar.ts\n");
        content.push_str("src/foo.ts\n"); // duplicate
        fs::write(&journal_file, &content).unwrap();

        let result = read_journal(root);
        assert!(result.valid);
        assert_eq!(result.timestamp, 1700000000000.0);
        assert_eq!(result.changed, vec!["src/foo.ts"]);
        assert_eq!(result.removed, vec!["src/bar.ts"]);

        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn invalid_journal() {
        let tmp = std::env::temp_dir().join("codegraph_journal_invalid");
        let root = tmp.to_str().unwrap();
        let dir = tmp.join(".codegraph");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("changes.journal"), "garbage\n").unwrap();

        let result = read_journal(root);
        assert!(!result.valid);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_journal() {
        let result = read_journal("/nonexistent/path");
        assert!(!result.valid);
    }
}
