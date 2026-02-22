pub mod helpers;
pub mod javascript;
pub mod python;
pub mod go;
pub mod rust_lang;
pub mod java;
pub mod csharp;
pub mod ruby;
pub mod php;
pub mod hcl;

use tree_sitter::Tree;
use crate::types::FileSymbols;
use crate::parser_registry::LanguageKind;

/// Trait every language extractor implements.
pub trait SymbolExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols;
}

/// Dispatch to the correct extractor based on language kind.
pub fn extract_symbols(lang: LanguageKind, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
    match lang {
        LanguageKind::JavaScript | LanguageKind::TypeScript | LanguageKind::Tsx => {
            javascript::JsExtractor.extract(tree, source, file_path)
        }
        LanguageKind::Python => python::PythonExtractor.extract(tree, source, file_path),
        LanguageKind::Go => go::GoExtractor.extract(tree, source, file_path),
        LanguageKind::Rust => rust_lang::RustExtractor.extract(tree, source, file_path),
        LanguageKind::Java => java::JavaExtractor.extract(tree, source, file_path),
        LanguageKind::CSharp => csharp::CSharpExtractor.extract(tree, source, file_path),
        LanguageKind::Ruby => ruby::RubyExtractor.extract(tree, source, file_path),
        LanguageKind::Php => php::PhpExtractor.extract(tree, source, file_path),
        LanguageKind::Hcl => hcl::HclExtractor.extract(tree, source, file_path),
    }
}
