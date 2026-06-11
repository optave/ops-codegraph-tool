use std::collections::HashMap;
use send_wrapper::SendWrapper;
use tree_sitter::{Parser, Tree};

use napi_derive::napi;

use crate::extractors::extract_symbols;
use crate::domain::parser::LanguageKind;
use crate::types::FileSymbols;

struct CacheEntry {
    tree: Tree,
    lang: LanguageKind,
}

/// Cache of parse trees for incremental parsing.
///
/// Keeps the previous tree for each file so tree-sitter can reuse
/// unchanged CST subtrees when re-parsing (old-tree hint).
///
/// `tree_sitter::Tree` is `!Send`, but the cache is only ever accessed
/// from the JS main thread.  `SendWrapper` satisfies napi's `Send` bound
/// while panicking if misused from another thread.
#[napi]
pub struct ParseTreeCache {
    entries: SendWrapper<HashMap<String, CacheEntry>>,
}

#[napi]
impl ParseTreeCache {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            entries: SendWrapper::new(HashMap::new()),
        }
    }

    /// Parse a file, reusing the cached tree if available (old-tree hint).
    /// Returns the extracted symbols, or null for unsupported extensions.
    #[napi]
    pub fn parse_file(&mut self, file_path: String, source: String) -> Option<FileSymbols> {
        let lang = LanguageKind::from_extension(&file_path)?;

        let mut parser = Parser::new();
        parser.set_language(&lang.tree_sitter_language()).ok()?;

        let source_bytes = source.as_bytes();

        let old_tree = self.entries.get(&file_path).map(|e| &e.tree);
        let tree = parser.parse(source_bytes, old_tree)?;

        let symbols = extract_symbols(lang, &tree, source_bytes, &file_path);

        self.entries.insert(file_path, CacheEntry { tree, lang });

        Some(symbols)
    }

    /// Remove a file from the cache.
    #[napi]
    pub fn remove(&mut self, file_path: String) {
        self.entries.remove(&file_path);
    }

    /// Check if a file is in the cache.
    #[napi]
    pub fn contains(&self, file_path: String) -> bool {
        self.entries.contains_key(&file_path)
    }

    /// Clear the entire cache.
    #[napi]
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Number of files currently cached.
    #[napi]
    pub fn size(&self) -> u32 {
        self.entries.len() as u32
    }
}
