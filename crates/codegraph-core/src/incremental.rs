use std::collections::HashMap;
use tree_sitter::{InputEdit, Parser, Tree};

use crate::extractors::extract_symbols;
use crate::parser_registry::LanguageKind;
use crate::types::FileSymbols;

/// Cache of parse trees for incremental parsing.
/// Keeps the old tree and source for each file so tree-sitter can apply edits
/// and re-parse only the changed portion.
pub struct ParseTreeCache {
    entries: HashMap<String, CacheEntry>,
}

struct CacheEntry {
    tree: Tree,
    source: Vec<u8>,
    lang: LanguageKind,
}

impl ParseTreeCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Parse a file, using the cached tree if available for incremental re-parse.
    /// If `edits` is provided, they are applied to the old tree before re-parsing.
    /// Returns the extracted symbols if parsing succeeds.
    pub fn parse_file(
        &mut self,
        file_path: &str,
        new_source: &[u8],
        edits: Option<&[InputEdit]>,
    ) -> Option<FileSymbols> {
        let lang = LanguageKind::from_extension(file_path)?;

        let mut parser = Parser::new();
        parser.set_language(&lang.tree_sitter_language()).ok()?;

        let old_tree = if let Some(entry) = self.entries.get_mut(file_path) {
            if let Some(edits) = edits {
                for edit in edits {
                    entry.tree.edit(edit);
                }
            }
            Some(&entry.tree)
        } else {
            None
        };

        let tree = parser.parse(new_source, old_tree)?;
        let symbols = extract_symbols(lang, &tree, new_source, file_path);

        self.entries.insert(
            file_path.to_string(),
            CacheEntry {
                tree,
                source: new_source.to_vec(),
                lang,
            },
        );

        Some(symbols)
    }

    /// Remove a file from the cache.
    pub fn remove(&mut self, file_path: &str) {
        self.entries.remove(file_path);
    }

    /// Check if a file is in the cache.
    pub fn contains(&self, file_path: &str) -> bool {
        self.entries.contains_key(file_path)
    }

    /// Clear the entire cache.
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}
