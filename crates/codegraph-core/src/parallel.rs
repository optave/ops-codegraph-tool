use rayon::prelude::*;
use std::fs;
use tree_sitter::Parser;

use crate::dataflow::extract_dataflow;
use crate::extractors::extract_symbols_with_opts;
use crate::parser_registry::LanguageKind;
use crate::types::FileSymbols;

/// Parse multiple files in parallel using rayon.
/// Each thread creates its own Parser (cheap; Language objects are Send+Sync).
/// Failed files are silently skipped (matches WASM behavior).
/// All analysis data (symbols, AST nodes, complexity, CFG, dataflow) is always
/// extracted in a single parse pass — no separate re-parse needed downstream.
/// When `include_dataflow` is false, dataflow extraction is skipped for performance.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
pub fn parse_files_parallel(
    file_paths: &[String],
    _root_dir: &str,
    include_dataflow: bool,
    include_ast_nodes: bool,
) -> Vec<FileSymbols> {
    file_paths
        .par_iter()
        .filter_map(|file_path| {
            let lang = LanguageKind::from_extension(file_path)?;
            let source = fs::read(file_path).ok()?;
            let line_count = source.iter().filter(|&&b| b == b'\n').count() as u32 + 1;

            let mut parser = Parser::new();
            parser.set_language(&lang.tree_sitter_language()).ok()?;

            let tree = parser.parse(&source, None)?;
            let mut symbols =
                extract_symbols_with_opts(lang, &tree, &source, file_path, include_ast_nodes);
            if include_dataflow {
                symbols.dataflow = extract_dataflow(&tree, &source, lang.lang_id_str());
            }
            symbols.line_count = Some(line_count);
            Some(symbols)
        })
        .collect()
}

/// Parse multiple files in parallel, always extracting ALL analysis data:
/// symbols, AST nodes, complexity, CFG, and dataflow in a single parse pass.
/// This eliminates the need for any downstream re-parse (WASM or native standalone).
pub fn parse_files_parallel_full(
    file_paths: &[String],
    _root_dir: &str,
) -> Vec<FileSymbols> {
    file_paths
        .par_iter()
        .filter_map(|file_path| {
            let lang = LanguageKind::from_extension(file_path)?;
            let source = fs::read(file_path).ok()?;
            let line_count = source.iter().filter(|&&b| b == b'\n').count() as u32 + 1;

            let mut parser = Parser::new();
            parser.set_language(&lang.tree_sitter_language()).ok()?;

            let tree = parser.parse(&source, None)?;
            // Always include AST nodes
            let mut symbols =
                extract_symbols_with_opts(lang, &tree, &source, file_path, true);
            // Always extract dataflow
            symbols.dataflow = extract_dataflow(&tree, &source, lang.lang_id_str());
            symbols.line_count = Some(line_count);
            Some(symbols)
        })
        .collect()
}

/// Parse a single file and return its symbols.
/// When `include_dataflow` is false, dataflow extraction is skipped for performance.
/// When `include_ast_nodes` is false, AST node walking is skipped for performance.
pub fn parse_file(
    file_path: &str,
    source: &str,
    include_dataflow: bool,
    include_ast_nodes: bool,
) -> Option<FileSymbols> {
    let lang = LanguageKind::from_extension(file_path)?;
    let source_bytes = source.as_bytes();

    let mut parser = Parser::new();
    parser.set_language(&lang.tree_sitter_language()).ok()?;

    let tree = parser.parse(source_bytes, None)?;
    let line_count = source_bytes.iter().filter(|&&b| b == b'\n').count() as u32 + 1;
    let mut symbols =
        extract_symbols_with_opts(lang, &tree, source_bytes, file_path, include_ast_nodes);
    if include_dataflow {
        symbols.dataflow = extract_dataflow(&tree, source_bytes, lang.lang_id_str());
    }
    symbols.line_count = Some(line_count);
    Some(symbols)
}
