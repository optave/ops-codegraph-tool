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
            "kt" | "kts" => Some(Self::Kotlin),
            "swift" => Some(Self::Swift),
            "scala" => Some(Self::Scala),
            "sh" | "bash" => Some(Self::Bash),
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
        }
    }
}
