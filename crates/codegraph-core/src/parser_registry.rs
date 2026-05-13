use std::path::Path;
use tree_sitter::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LanguageKind {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Go,
    Rust,
    Java,
    CSharp,
    Ruby,
    Php,
    Hcl,
    C,
    Cpp,
    Kotlin,
    Swift,
    Scala,
    Bash,
    Elixir,
    Lua,
    Dart,
    Zig,
    Haskell,
    Ocaml,
    OcamlInterface,
    Julia,
    Cuda,
    Clojure,
    Erlang,
    Solidity,
    Verilog,
}

impl LanguageKind {
    /// Return the string ID used by dataflow/cfg rules lookup.
    /// Matches the JS `DATAFLOW_RULES` map keys in `src/dataflow.js`.
    pub fn lang_id_str(&self) -> &'static str {
        match self {
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Python => "python",
            Self::Go => "go",
            Self::Rust => "rust",
            Self::Java => "java",
            Self::CSharp => "csharp",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Hcl => "hcl",
            Self::C => "c",
            Self::Cpp => "cpp",
            Self::Kotlin => "kotlin",
            Self::Swift => "swift",
            Self::Scala => "scala",
            Self::Bash => "bash",
            Self::Elixir => "elixir",
            Self::Lua => "lua",
            Self::Dart => "dart",
            Self::Zig => "zig",
            Self::Haskell => "haskell",
            Self::Ocaml => "ocaml",
            Self::OcamlInterface => "ocaml-interface",
            Self::Julia => "julia",
            Self::Cuda => "cuda",
            Self::Clojure => "clojure",
            Self::Erlang => "erlang",
            Self::Solidity => "solidity",
            Self::Verilog => "verilog",
        }
    }

    /// Determine language from file extension — mirrors `getParser()` in parser.js
    pub fn from_extension(file_path: &str) -> Option<Self> {
        let path = Path::new(file_path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let _name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // .tsx must come before .ts check
        if file_path.ends_with(".tsx") {
            return Some(Self::Tsx);
        }
        if file_path.ends_with(".d.ts") || ext == "ts" {
            return Some(Self::TypeScript);
        }
        match ext {
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "tf" | "hcl" => Some(Self::Hcl),
            "go" => Some(Self::Go),
            "rs" => Some(Self::Rust),
            "java" => Some(Self::Java),
            "cs" => Some(Self::CSharp),
            "rb" | "rake" | "gemspec" => Some(Self::Ruby),
            "php" | "phtml" => Some(Self::Php),
            "c" | "h" => Some(Self::C),
            "cpp" | "cc" | "cxx" | "hpp" => Some(Self::Cpp),
            "cu" | "cuh" => Some(Self::Cuda),
            "kt" | "kts" => Some(Self::Kotlin),
            "swift" => Some(Self::Swift),
            "scala" => Some(Self::Scala),
            "sh" | "bash" => Some(Self::Bash),
            "ex" | "exs" => Some(Self::Elixir),
            "lua" => Some(Self::Lua),
            "dart" => Some(Self::Dart),
            "zig" => Some(Self::Zig),
            "hs" => Some(Self::Haskell),
            "ml" => Some(Self::Ocaml),
            "mli" => Some(Self::OcamlInterface),
            "jl" => Some(Self::Julia),
            "clj" | "cljs" | "cljc" => Some(Self::Clojure),
            "erl" | "hrl" => Some(Self::Erlang),
            "sol" => Some(Self::Solidity),
            "v" | "sv" => Some(Self::Verilog),
            _ => None,
        }
    }

    /// Resolve a language kind from a lang_id string (e.g. "javascript", "python").
    /// Inverse of `lang_id_str()`.
    pub fn from_lang_id(lang_id: &str) -> Option<Self> {
        match lang_id {
            "javascript" => Some(Self::JavaScript),
            "typescript" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "python" => Some(Self::Python),
            "go" => Some(Self::Go),
            "rust" => Some(Self::Rust),
            "java" => Some(Self::Java),
            "csharp" => Some(Self::CSharp),
            "ruby" => Some(Self::Ruby),
            "php" => Some(Self::Php),
            "hcl" => Some(Self::Hcl),
            "c" => Some(Self::C),
            "cpp" => Some(Self::Cpp),
            "kotlin" => Some(Self::Kotlin),
            "swift" => Some(Self::Swift),
            "scala" => Some(Self::Scala),
            "bash" => Some(Self::Bash),
            "elixir" => Some(Self::Elixir),
            "lua" => Some(Self::Lua),
            "dart" => Some(Self::Dart),
            "zig" => Some(Self::Zig),
            "haskell" => Some(Self::Haskell),
            "ocaml" => Some(Self::Ocaml),
            "ocaml-interface" => Some(Self::OcamlInterface),
            "julia" => Some(Self::Julia),
            "cuda" => Some(Self::Cuda),
            "clojure" => Some(Self::Clojure),
            "erlang" => Some(Self::Erlang),
            "solidity" => Some(Self::Solidity),
            "verilog" => Some(Self::Verilog),
            _ => None,
        }
    }

    /// Return the native tree-sitter `Language` for this variant.
    pub fn tree_sitter_language(&self) -> Language {
        match self {
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
            Self::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Self::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            Self::Php => tree_sitter_php::LANGUAGE_PHP.into(),
            Self::Hcl => tree_sitter_hcl::LANGUAGE.into(),
            Self::C => tree_sitter_c::LANGUAGE.into(),
            Self::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Self::Kotlin => tree_sitter_kotlin_sg::LANGUAGE.into(),
            Self::Swift => tree_sitter_swift::LANGUAGE.into(),
            Self::Scala => tree_sitter_scala::LANGUAGE.into(),
            Self::Bash => tree_sitter_bash::LANGUAGE.into(),
            Self::Elixir => tree_sitter_elixir::LANGUAGE.into(),
            Self::Lua => tree_sitter_lua::LANGUAGE.into(),
            Self::Dart => tree_sitter_dart::language().into(),
            Self::Zig => tree_sitter_zig::LANGUAGE.into(),
            Self::Haskell => tree_sitter_haskell::LANGUAGE.into(),
            Self::Ocaml => tree_sitter_ocaml::LANGUAGE_OCAML.into(),
            Self::OcamlInterface => tree_sitter_ocaml::LANGUAGE_OCAML_INTERFACE.into(),
            Self::Julia => tree_sitter_julia::LANGUAGE.into(),
            Self::Cuda => tree_sitter_cuda::LANGUAGE.into(),
            Self::Clojure => tree_sitter_clojure_orchard::LANGUAGE.into(),
            Self::Erlang => tree_sitter_erlang::LANGUAGE.into(),
            Self::Solidity => tree_sitter_solidity::LANGUAGE.into(),
            Self::Verilog => tree_sitter_verilog::LANGUAGE.into(),
        }
    }

    /// Every variant in declaration order. Adding a new `LanguageKind` variant
    /// requires adding it here too — the regression test in this file's
    /// `tests` module iterates this list to confirm each grammar loads at
    /// runtime, so missing entries silently lose ABI coverage for that
    /// language. See #1054 (tree-sitter-hcl 1.1.0 shipped ABI 15 while the
    /// runtime was pinned at ABI 14, and `set_language` rejected the grammar
    /// at runtime instead of at compile time).
    pub fn all() -> &'static [LanguageKind] {
        use LanguageKind::*;
        &[
            JavaScript, TypeScript, Tsx, Python, Go, Rust, Java, CSharp, Ruby, Php, Hcl, C,
            Cpp, Kotlin, Swift, Scala, Bash, Elixir, Lua, Dart, Zig, Haskell, Ocaml,
            OcamlInterface, Julia, Cuda, Clojure, Erlang, Solidity, Verilog,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    /// Catches tree-sitter ABI version mismatches between the runtime crate
    /// and individual grammar crates. When a grammar ships parser code built
    /// against a newer ABI than the runtime supports, `set_language` rejects
    /// it with `LanguageError`, `parse_file` silently returns `None`, and
    /// every file in that language is "dropped" — the user sees a warning
    /// and the JS layer falls back to WASM. See #1054 (tree-sitter-hcl 1.1.0
    /// vs tree-sitter 0.24).
    #[test]
    fn all_grammars_have_compatible_abi() {
        let mut failures: Vec<String> = Vec::new();
        for &kind in LanguageKind::all() {
            let mut parser = Parser::new();
            let language = kind.tree_sitter_language();
            if let Err(e) = parser.set_language(&language) {
                failures.push(format!("  {:?}: {:?}", kind, e));
            }
        }
        assert!(
            failures.is_empty(),
            "Tree-sitter grammar ABI mismatch — bump `tree-sitter` in Cargo.toml \
             or pin the failing grammar crate down (#1054):\n{}",
            failures.join("\n")
        );
    }

    /// Every variant declared in the enum must appear in `all()`. Without
    /// this check, a new variant added to the enum would silently lose
    /// ABI coverage from `all_grammars_have_compatible_abi`.
    #[test]
    fn all_kinds_listed_in_all() {
        // Exhaustive match — fails to compile if a variant is added without
        // updating the body. The match itself is a no-op; the compile-time
        // exhaustiveness check is the test. If this match starts failing,
        // also update `LanguageKind::all()`.
        let kind = LanguageKind::JavaScript;
        let _: () = match kind {
            LanguageKind::JavaScript
            | LanguageKind::TypeScript
            | LanguageKind::Tsx
            | LanguageKind::Python
            | LanguageKind::Go
            | LanguageKind::Rust
            | LanguageKind::Java
            | LanguageKind::CSharp
            | LanguageKind::Ruby
            | LanguageKind::Php
            | LanguageKind::Hcl
            | LanguageKind::C
            | LanguageKind::Cpp
            | LanguageKind::Kotlin
            | LanguageKind::Swift
            | LanguageKind::Scala
            | LanguageKind::Bash
            | LanguageKind::Elixir
            | LanguageKind::Lua
            | LanguageKind::Dart
            | LanguageKind::Zig
            | LanguageKind::Haskell
            | LanguageKind::Ocaml
            | LanguageKind::OcamlInterface
            | LanguageKind::Julia
            | LanguageKind::Cuda
            | LanguageKind::Clojure
            | LanguageKind::Erlang
            | LanguageKind::Solidity
            | LanguageKind::Verilog => (),
        };
        // IMPORTANT: this constant must equal the number of arms in the match
        // above AND the length of the slice returned by `LanguageKind::all()`.
        // Because both checks require the same manual update, they reinforce
        // each other: a developer who updates the match is reminded to also
        // update `all()` and this count.
        const EXPECTED_LEN: usize = 30;
        assert_eq!(
            LanguageKind::all().len(),
            EXPECTED_LEN,
            "A LanguageKind variant is in the exhaustive match but missing from \
             `all()` (or vice-versa). Update `all()` and bump EXPECTED_LEN.",
        );
    }
}
