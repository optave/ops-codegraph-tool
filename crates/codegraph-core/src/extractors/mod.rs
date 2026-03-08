pub mod csharp;
pub mod go;
pub mod hcl;
pub mod helpers;
pub mod java;
pub mod javascript;
pub mod php;
pub mod python;
pub mod ruby;
pub mod rust_lang;

use crate::parser_registry::LanguageKind;
use crate::types::FileSymbols;
use tree_sitter::Tree;

/// Trait every language extractor implements.
pub trait SymbolExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols;
    /// Extract with optional AST node collection. Default delegates to `extract`.
    fn extract_with_opts(
        &self,
        tree: &Tree,
        source: &[u8],
        file_path: &str,
        include_ast_nodes: bool,
    ) -> FileSymbols {
        let mut symbols = self.extract(tree, source, file_path);
        if !include_ast_nodes {
            symbols.ast_nodes.clear();
        }
        symbols
    }
}

/// Dispatch to the correct extractor based on language kind.
pub fn extract_symbols(
    lang: LanguageKind,
    tree: &Tree,
    source: &[u8],
    file_path: &str,
) -> FileSymbols {
    extract_symbols_with_opts(lang, tree, source, file_path, true)
}

/// Dispatch with optional AST node extraction.
pub fn extract_symbols_with_opts(
    lang: LanguageKind,
    tree: &Tree,
    source: &[u8],
    file_path: &str,
    include_ast_nodes: bool,
) -> FileSymbols {
    match lang {
        LanguageKind::JavaScript | LanguageKind::TypeScript | LanguageKind::Tsx => {
            javascript::JsExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Python => {
            python::PythonExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Go => {
            go::GoExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Rust => {
            rust_lang::RustExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Java => {
            java::JavaExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::CSharp => {
            csharp::CSharpExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Ruby => {
            ruby::RubyExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Php => {
            php::PhpExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
        LanguageKind::Hcl => {
            hcl::HclExtractor.extract_with_opts(tree, source, file_path, include_ast_nodes)
        }
    }
}
