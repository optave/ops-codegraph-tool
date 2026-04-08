use crate::types::{AstNode, Definition, FileSymbols};
use tree_sitter::Node;

// Re-export so extractors that `use super::helpers::*` still see it.
pub use crate::constants::MAX_WALK_DEPTH;

/// Get the text of a node from the source bytes.
pub fn node_text<'a>(node: &Node, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Wrap a children vec into Option — None if empty.
pub fn opt_children(children: Vec<Definition>) -> Option<Vec<Definition>> {
    if children.is_empty() { None } else { Some(children) }
}

/// Create a child Definition with the given kind (parameter, property, constant).
pub fn child_def(name: String, kind: &str, line: u32) -> Definition {
    Definition {
        name,
        kind: kind.to_string(),
        line,
        end_line: None,
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    }
}

/// Find the first child of a given type.
pub fn find_child<'a>(node: &Node<'a>, kind: &str) -> Option<Node<'a>> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == kind {
                return Some(child);
            }
        }
    }
    None
}

/// Find a parent of a given type, walking up the tree.
pub fn find_parent_of_type<'a>(node: &Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == kind {
            return Some(parent);
        }
        current = parent.parent();
    }
    None
}

/// Find a parent that is any of the given types.
pub fn find_parent_of_types<'a>(node: &Node<'a>, kinds: &[&str]) -> Option<Node<'a>> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if kinds.contains(&parent.kind()) {
            return Some(parent);
        }
        current = parent.parent();
    }
    None
}

/// Walk up the tree to find an enclosing type declaration (class, struct, etc.)
/// and return its name. `kinds` specifies which node types count as type declarations
/// for the target language (e.g. `&["class_declaration", "class"]` for JS,
/// `&["class_definition"]` for Python, etc.).
///
/// This replaces the duplicated `find_*_parent_class` helpers that existed in
/// every language extractor with identical logic but different kind lists.
pub fn find_enclosing_type_name(node: &Node, kinds: &[&str], source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(parent) = current {
        if kinds.contains(&parent.kind()) {
            return named_child_text(&parent, "name", source)
                .map(|s| s.to_string());
        }
        current = parent.parent();
    }
    None
}

/// Get the name of a named field child, returning its text.
pub fn named_child_text<'a>(node: &Node<'a>, field: &str, source: &'a [u8]) -> Option<&'a str> {
    node.child_by_field_name(field)
        .map(|n| node_text(&n, source))
}

/// Get the 1-based start line of a node.
pub fn start_line(node: &Node) -> u32 {
    node.start_position().row as u32 + 1
}

/// Get the 1-based end line of a node.
pub fn end_line(node: &Node) -> u32 {
    node.end_position().row as u32 + 1
}

/// Char-safe truncation with ellipsis, matching `ast.js:51-54`.
pub fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(1);
    // Ensure we don't split a multi-byte char
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &s[..end])
}

// ── Generic tree walker ─────────────────────────────────────────────────────

/// Generic depth-limited tree walker. Calls `match_node` on each node,
/// then recurses into children. Eliminates the walk_node/walk_node_depth
/// boilerplate duplicated across all language extractors.
pub fn walk_tree<F>(node: &Node, source: &[u8], symbols: &mut FileSymbols, match_node: F)
where
    F: Fn(&Node, &[u8], &mut FileSymbols, usize),
{
    walk_tree_depth(node, source, symbols, 0, &match_node);
}

fn walk_tree_depth<F>(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    depth: usize,
    match_node: &F,
) where
    F: Fn(&Node, &[u8], &mut FileSymbols, usize),
{
    if depth >= MAX_WALK_DEPTH {
        return;
    }
    match_node(node, source, symbols, depth);
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_tree_depth(&child, source, symbols, depth + 1, match_node);
        }
    }
}

// ── AST node extraction (shared across all languages) ────────────────────────

/// Max length for the AST `text` field — matches `TEXT_MAX` in `ast.js`.
pub const AST_TEXT_MAX: usize = 200;

/// Language-specific AST node type configuration.
pub struct LangAstConfig {
    /// Node types mapping to `"new"` kind (e.g. `new_expression`, `object_creation_expression`)
    pub new_types: &'static [&'static str],
    /// Node types mapping to `"throw"` kind (e.g. `throw_statement`, `raise_statement`)
    pub throw_types: &'static [&'static str],
    /// Node types mapping to `"await"` kind (e.g. `await_expression`, `await`)
    pub await_types: &'static [&'static str],
    /// Node types mapping to `"string"` kind (e.g. `string`, `string_literal`)
    pub string_types: &'static [&'static str],
    /// Node types mapping to `"regex"` kind (e.g. `regex`)
    pub regex_types: &'static [&'static str],
    /// Characters to strip from string delimiters when extracting content.
    pub quote_chars: &'static [char],
    /// Single-char prefixes that can appear before string quotes (e.g. `r`, `b`, `f`, `u` for Python).
    /// Multi-char combos like `rb`, `fr` are handled by stripping each char in sequence.
    pub string_prefixes: &'static [char],
}

// ── Per-language configs ─────────────────────────────────────────────────────

pub const PYTHON_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &["raise_statement"],
    await_types: &["await"],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &['r', 'b', 'f', 'u', 'R', 'B', 'F', 'U'],
};

pub const GO_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["interpreted_string_literal", "raw_string_literal"],
    regex_types: &[],
    quote_chars: &['"', '`'],
    string_prefixes: &[],
};

pub const RUST_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &["await_expression"],
    string_types: &["string_literal", "raw_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const JAVA_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["object_creation_expression"],
    throw_types: &["throw_statement"],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const CSHARP_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["object_creation_expression"],
    throw_types: &["throw_statement", "throw_expression"],
    await_types: &["await_expression"],
    string_types: &["string_literal", "verbatim_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const RUBY_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &["regex"],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const PHP_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["object_creation_expression"],
    throw_types: &["throw_expression"],
    await_types: &[],
    string_types: &["string", "encapsed_string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const C_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const CPP_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["new_expression"],
    throw_types: &["throw_statement"],
    await_types: &["co_await_expression"],
    string_types: &["string_literal", "raw_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &['L', 'u', 'U', 'R'],
};

pub const KOTLIN_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &["throw_expression"],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const SWIFT_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &["throw_statement"],
    await_types: &["await_expression"],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const SCALA_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["object_creation_expression"],
    throw_types: &["throw_expression"],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const BASH_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string", "expansion"],
    regex_types: &[],
    quote_chars: &['"', '\''],
    string_prefixes: &[],
};

pub const ELIXIR_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &["sigil"],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const LUA_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const DART_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["new_expression", "constructor_invocation"],
    throw_types: &["throw_expression"],
    await_types: &["await_expression"],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const ZIG_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const HASKELL_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string", "char"],
    regex_types: &[],
    quote_chars: &['"', '\''],
    string_prefixes: &[],
};

pub const OCAML_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

// ── Generic AST node walker ──────────────────────────────────────────────────

/// Node types that represent identifiers across languages.
const IDENT_TYPES: &[&str] = &[
    "identifier", "type_identifier", "name", "qualified_name",
    "scoped_identifier", "qualified_identifier",
    "member_expression", "member_access_expression",
    "field_expression", "attribute", "scoped_type_identifier",
];

/// Node types that represent function/method calls across languages.
const CALL_TYPES: &[&str] = &[
    "call_expression", "call", "invocation_expression",
    "method_invocation", "function_call_expression",
    "member_call_expression", "scoped_call_expression",
];

/// Walk the tree collecting AST nodes using language-specific config.
/// Generic version of `walk_ast_nodes()` in `javascript.rs`.
pub fn walk_ast_nodes_with_config(
    node: &Node,
    source: &[u8],
    ast_nodes: &mut Vec<AstNode>,
    config: &LangAstConfig,
) {
    walk_ast_nodes_with_config_depth(node, source, ast_nodes, config, 0);
}

/// Classify a tree-sitter node against the language AST config.
/// Returns the AST kind string if matched, or `None` to skip.
fn classify_ast_node<'a>(kind: &str, config: &'a LangAstConfig) -> Option<&'a str> {
    if config.new_types.contains(&kind) {
        Some("new")
    } else if config.throw_types.contains(&kind) {
        Some("throw")
    } else if config.await_types.contains(&kind) {
        Some("await")
    } else if config.string_types.contains(&kind) {
        Some("string")
    } else if config.regex_types.contains(&kind) {
        Some("regex")
    } else {
        None
    }
}

/// Build an AstNode for a "new" expression.
fn build_new_node(node: &Node, source: &[u8]) -> AstNode {
    AstNode {
        kind: "new".to_string(),
        name: extract_constructor_name(node, source),
        line: start_line(node),
        text: Some(truncate(node_text(node, source), AST_TEXT_MAX)),
        receiver: None,
    }
}

/// Build an AstNode for a "throw" statement.
fn build_throw_node(node: &Node, source: &[u8], config: &LangAstConfig) -> AstNode {
    AstNode {
        kind: "throw".to_string(),
        name: extract_throw_target(node, source, config),
        line: start_line(node),
        text: extract_child_expression_text(node, source),
        receiver: None,
    }
}

/// Build an AstNode for an "await" expression.
fn build_await_node(node: &Node, source: &[u8]) -> AstNode {
    AstNode {
        kind: "await".to_string(),
        name: extract_awaited_name(node, source),
        line: start_line(node),
        text: extract_child_expression_text(node, source),
        receiver: None,
    }
}

/// Build an AstNode for a string literal.
/// Returns `None` if the string content is too short (< 2 chars).
fn build_string_node(node: &Node, source: &[u8], config: &LangAstConfig) -> Option<AstNode> {
    let raw = node_text(node, source);
    let kind = node.kind();
    let is_raw_string = kind.contains("raw_string");
    // Strip language prefix modifiers before quote chars:
    // - C# verbatim `@"..."`, Rust raw strings `r"..."`, Python prefixes: r, b, f, u
    let without_prefix = raw.trim_start_matches('@')
        .trim_start_matches(|c: char| config.string_prefixes.contains(&c));
    let without_prefix = if is_raw_string {
        without_prefix.trim_start_matches('r').trim_start_matches('#')
    } else {
        without_prefix
    };
    let content = without_prefix
        .trim_start_matches(|c: char| config.quote_chars.contains(&c));
    let content = if is_raw_string {
        content.trim_end_matches('#')
    } else {
        content
    };
    let content = content
        .trim_end_matches(|c: char| config.quote_chars.contains(&c));
    if content.chars().count() < 2 {
        return None;
    }
    Some(AstNode {
        kind: "string".to_string(),
        name: truncate(content, 100),
        line: start_line(node),
        text: Some(truncate(raw, AST_TEXT_MAX)),
        receiver: None,
    })
}

/// Build an AstNode for a regex literal.
fn build_regex_node(node: &Node, source: &[u8]) -> AstNode {
    let raw = node_text(node, source);
    AstNode {
        kind: "regex".to_string(),
        name: if raw.is_empty() { "?".to_string() } else { raw.to_string() },
        line: start_line(node),
        text: Some(truncate(raw, AST_TEXT_MAX)),
        receiver: None,
    }
}

fn walk_ast_nodes_with_config_depth(
    node: &Node,
    source: &[u8],
    ast_nodes: &mut Vec<AstNode>,
    config: &LangAstConfig,
    depth: usize,
) {
    if depth >= MAX_WALK_DEPTH {
        return;
    }

    if let Some(ast_kind) = classify_ast_node(node.kind(), config) {
        match ast_kind {
            "new" => {
                ast_nodes.push(build_new_node(node, source));
            }
            "throw" => {
                ast_nodes.push(build_throw_node(node, source, config));
            }
            "await" => {
                ast_nodes.push(build_await_node(node, source));
            }
            "string" => {
                if build_string_node(node, source, config).map(|n| ast_nodes.push(n)).is_none() {
                    // Short string: recurse children then skip outer loop
                    for i in 0..node.child_count() {
                        if let Some(child) = node.child(i) {
                            walk_ast_nodes_with_config_depth(&child, source, ast_nodes, config, depth + 1);
                        }
                    }
                    return;
                }
            }
            "regex" => {
                ast_nodes.push(build_regex_node(node, source));
            }
            _ => {}
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_ast_nodes_with_config_depth(&child, source, ast_nodes, config, depth + 1);
        }
    }
}

// ── Name extraction helpers ──────────────────────────────────────────────────

/// Extract constructor name from a `new`/`object_creation_expression` node.
fn extract_constructor_name(node: &Node, source: &[u8]) -> String {
    // Try common field names for the constructed type
    for field in &["type", "class", "constructor"] {
        if let Some(text) = named_child_text(node, field, source) {
            return text.to_string();
        }
    }
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if IDENT_TYPES.contains(&child.kind()) {
                return node_text(&child, source).to_string();
            }
        }
    }
    let raw = node_text(node, source);
    raw.split('(')
        .next()
        .unwrap_or(raw)
        .replace("new ", "")
        .trim()
        .to_string()
}

/// Extract name from a throw/raise statement.
fn extract_throw_target(node: &Node, source: &[u8], config: &LangAstConfig) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let ck = child.kind();
            if config.new_types.contains(&ck) {
                return extract_constructor_name(&child, source);
            }
            if CALL_TYPES.contains(&ck) {
                return extract_call_name(&child, source);
            }
            if IDENT_TYPES.contains(&ck) {
                return node_text(&child, source).to_string();
            }
        }
    }
    truncate(node_text(node, source), AST_TEXT_MAX)
}

/// Extract name from an await expression.
fn extract_awaited_name(node: &Node, source: &[u8]) -> String {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            let ck = child.kind();
            if CALL_TYPES.contains(&ck) {
                return extract_call_name(&child, source);
            }
            if IDENT_TYPES.contains(&ck) {
                return node_text(&child, source).to_string();
            }
        }
    }
    truncate(node_text(node, source), AST_TEXT_MAX)
}

/// Extract function name from a call node.
fn extract_call_name(node: &Node, source: &[u8]) -> String {
    for field in &["function", "method", "name"] {
        if let Some(text) = named_child_text(node, field, source) {
            return text.to_string();
        }
    }
    let text = node_text(node, source);
    text.split('(').next().unwrap_or("?").to_string()
}

/// Extract expression text from throw/await — skip the keyword child.
fn extract_child_expression_text(node: &Node, source: &[u8]) -> Option<String> {
    const KEYWORDS: &[&str] = &["throw", "raise", "await", "new"];
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if !KEYWORDS.contains(&child.kind()) {
                return Some(truncate(node_text(&child, source), AST_TEXT_MAX));
            }
        }
    }
    Some(truncate(node_text(node, source), AST_TEXT_MAX))
}
