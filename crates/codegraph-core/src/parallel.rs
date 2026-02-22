use rayon::prelude::*;
use std::fs;
use tree_sitter::Parser;

use crate::extractors::extract_symbols;
use crate::parser_registry::LanguageKind;
use crate::types::FileSymbols;

/// Parse multiple files in parallel using rayon.
/// Each thread creates its own Parser (cheap; Language objects are Send+Sync).
/// Failed files are silently skipped (matches WASM behavior).
pub fn parse_files_parallel(file_paths: &[String], root_dir: &str) -> Vec<FileSymbols> {
    file_paths
        .par_iter()
        .filter_map(|file_path| {
            let lang = LanguageKind::from_extension(file_path)?;
            let source = fs::read(file_path).ok()?;

            let mut parser = Parser::new();
            parser
                .set_language(&lang.tree_sitter_language())
                .ok()?;

            let tree = parser.parse(&source, None)?;
            let symbols = extract_symbols(lang, &tree, &source, file_path);
            Some(symbols)
        })
        .collect()
}

/// Parse a single file and return its symbols.
pub fn parse_file(file_path: &str, source: &str) -> Option<FileSymbols> {
    let lang = LanguageKind::from_extension(file_path)?;
    let source_bytes = source.as_bytes();

    let mut parser = Parser::new();
    parser
        .set_language(&lang.tree_sitter_language())
        .ok()?;

    let tree = parser.parse(source_bytes, None)?;
    Some(extract_symbols(lang, &tree, source_bytes, file_path))
}
