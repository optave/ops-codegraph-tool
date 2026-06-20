use crate::types::{AstNode, Call, Definition, FileSymbols, Import, TypeMapEntry};
use tree_sitter::Node;

// Re-export so extractors that `use super::helpers::*` still see it.
pub use crate::shared::constants::MAX_WALK_DEPTH;

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

/// Find the first child whose type is in `kinds`. Useful when several
/// grammar variants name the same conceptual node differently (e.g.
/// `string` vs `string_literal`). Returns the first match in document
/// order, or `None`.
///
/// Mirrors `findFirstChildOfTypes` in `src/extractors/helpers.ts`.
pub fn find_first_child_of_types<'a>(node: &Node<'a>, kinds: &[&str]) -> Option<Node<'a>> {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if kinds.contains(&child.kind()) {
                return Some(child);
            }
        }
    }
    None
}

/// Common punctuation tokens — handy as a `skip_kinds` set for
/// [`iter_children`]. Mirrors `PUNCTUATION_TOKENS` in
/// `src/extractors/helpers.ts`.
pub const PUNCTUATION_TOKENS: &[&str] = &[
    ",", ";", "(", ")", "[", "]", "{", "}", ":", ".",
];

/// Iterate the direct children of `node` in document order, skipping
/// nulls and tokens whose `kind()` is in `skip_kinds`. Mirrors the
/// common `for i in 0..node.child_count() { let c = node.child(i); ... }`
/// idiom while letting callers filter out grammar punctuation
/// (`,`, `(`, `{`, etc.).
///
/// Mirrors `iterChildren` in `src/extractors/helpers.ts`.
pub fn iter_children<'a>(
    node: &'a Node<'a>,
    skip_kinds: &'a [&'a str],
) -> impl Iterator<Item = Node<'a>> + 'a {
    (0..node.child_count()).filter_map(move |i| {
        let child = node.child(i)?;
        if skip_kinds.contains(&child.kind()) {
            None
        } else {
            Some(child)
        }
    })
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

/// CUDA is a C++ superset; the tree-sitter-cuda grammar extends C++ with
/// `__global__`/`__device__`/`__host__`/`__shared__` qualifiers and kernel
/// launch syntax. The node-type vocabulary for literals, exceptions, and
/// awaits is otherwise identical to C++.
pub const CUDA_AST_CONFIG: LangAstConfig = LangAstConfig {
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

// F# string nodes in tree-sitter-fsharp surface under the `string` kind inside
// `const` literals. The grammar exposes no dedicated raw-string or regex form.
pub const FSHARP_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

/// Objective-C string literals use the `@"..."` prefix. The shared
/// `build_string_node` strips a leading `@` before applying prefixes, so we
/// don't need to list it explicitly here.
pub const OBJC_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &["throw_statement"],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const GLEAM_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const JULIA_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string_literal", "prefixed_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const CLOJURE_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["str_lit"],
    regex_types: &["regex_lit"],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const ERLANG_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const GROOVY_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["object_creation_expression"],
    throw_types: &["throw_statement"],
    await_types: &[],
    // `gstring` listed defensively: tree-sitter-groovy 0.1.x emits `string_literal`
    // for both single- and double-quoted strings, but some grammar variants use
    // `gstring` for double-quoted / interpolated strings. Mirrors TS config.
    string_types: &["string_literal", "gstring"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const R_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    // tree-sitter-r emits `string` for both single- and double-quoted literals.
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const SOLIDITY_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &["new_expression"],
    throw_types: &["revert_statement"],
    await_types: &[],
    string_types: &["string_literal", "hex_string_literal", "unicode_string_literal"],
    regex_types: &[],
    quote_chars: &['"', '\''],
    string_prefixes: &[],
};

/// Verilog/SystemVerilog AST config.
///
/// The WASM-side `AST_TYPE_MAPS` (in `src/ast-analysis/rules/index.ts`) has no
/// `verilog` entry, so the JS engine emits no `ast_nodes` rows for Verilog
/// files. Keeping every list empty produces the same outcome here: the generic
/// walker visits every node but classifies none, so nothing is pushed. If the
/// JS map ever grows a Verilog entry, mirror it here.
pub const VERILOG_AST_CONFIG: LangAstConfig = LangAstConfig {
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &[],
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

// ── Output-push helpers ────────────────────────────────────────────────────
//
// Most extractors finish with `symbols.calls.push(Call { name, line: start_line(node), ... })`
// or `symbols.imports.push(Import::new(source, names, start_line(node)))`. Centralising
// the construction keeps `line` derivation consistent and removes the many
// hand-rolled `start_position().row + 1` literals scattered across language extractors.

/// Append a [`Call`] to `symbols`, using `start_line(node)` for the line and
/// the given optional `receiver`/`dynamic` flags. Skips no-op pushes when
/// `name` is empty.
///
/// Mirrors `pushCall` in `src/extractors/helpers.ts`.
pub fn push_call(
    symbols: &mut FileSymbols,
    node: &Node,
    name: impl Into<String>,
    receiver: Option<String>,
    dynamic: Option<bool>,
) {
    let name = name.into();
    if name.is_empty() {
        return;
    }
    symbols.calls.push(Call {
        name,
        line: start_line(node),
        dynamic,
        receiver,
        ..Default::default()
    });
}

/// Append a simple [`Call`] (no receiver, no dynamic flag) to `symbols`.
/// Convenience wrapper around [`push_call`] for the common case shared by
/// most C-family and procedural-language extractors.
pub fn push_simple_call(symbols: &mut FileSymbols, node: &Node, name: impl Into<String>) {
    push_call(symbols, node, name, None, None);
}

/// Append an [`Import`] to `symbols`, using `start_line(node)` for the
/// line. If `names` is empty, the last `/`-segment of `source` is used as
/// a single-name fallback — matching the convention used by gleam, julia,
/// and similar module-path imports.
///
/// The `customize` closure receives a mutable reference to the freshly
/// constructed `Import` so callers can flip language-specific flags
/// (`c_include`, `python_import`, `bash_source`, etc.) before the entry
/// is pushed. Pass `|_| {}` when no flags are needed.
///
/// Mirrors `pushImport` in `src/extractors/helpers.ts`.
pub fn push_import<F>(
    symbols: &mut FileSymbols,
    node: &Node,
    source: impl Into<String>,
    names: Vec<String>,
    customize: F,
) where
    F: FnOnce(&mut Import),
{
    let source = source.into();
    if source.is_empty() {
        return;
    }
    let resolved_names = if names.is_empty() {
        let fallback = source.rsplit('/').next().unwrap_or(source.as_str());
        vec![fallback.to_string()]
    } else {
        names
    };
    let mut imp = Import::new(source, resolved_names, start_line(node));
    customize(&mut imp);
    symbols.imports.push(imp);
}

// ── Parameter extraction ───────────────────────────────────────────────────

/// Configuration for [`extract_simple_parameters`].
///
/// Collapses the boilerplate in `extract_*_params` helpers across
/// java / julia / gleam / solidity / r / etc. — each one walks a
/// parameter list, matches a parameter-node kind, reads the `name`
/// field, and pushes a [`Definition`] with `kind: "parameter"`.
pub struct ExtractParametersOptions<'a> {
    /// Tree-sitter node kinds that mark a single parameter node
    /// (e.g. `formal_parameter`, `parameter`).
    pub param_kinds: &'a [&'a str],
    /// Field name on each parameter that holds the bound identifier.
    /// Defaults to `Some("name")`. Pass `None` to use the parameter
    /// node itself when its kind is in `param_kinds` and it has no
    /// `name` field (e.g. R's bare `identifier`).
    pub name_field: Option<&'a str>,
    /// If true, when `name_field` lookup fails fall back to the first
    /// `identifier` child of the parameter. Useful for gleam /
    /// solidity-style grammars.
    pub fallback_to_identifier: bool,
}

impl<'a> Default for ExtractParametersOptions<'a> {
    fn default() -> Self {
        Self {
            param_kinds: &[],
            name_field: Some("name"),
            fallback_to_identifier: false,
        }
    }
}

/// Resolve the identifier node that names a parameter. Used by
/// [`extract_simple_parameters`]; exposed so language-specific
/// extractors can reuse the same lookup logic in custom loops.
///
/// Mirrors `resolveParamName` in `src/extractors/helpers.ts`.
pub fn resolve_param_name<'a>(
    param_node: &Node<'a>,
    name_field: Option<&str>,
    fallback_to_identifier: bool,
) -> Option<Node<'a>> {
    let Some(field) = name_field else {
        return Some(*param_node);
    };
    if let Some(named) = param_node.child_by_field_name(field) {
        return Some(named);
    }
    if fallback_to_identifier {
        return find_child(param_node, "identifier");
    }
    None
}

/// Extract parameters from a parameter-list node using a uniform
/// pattern. Returns an empty vec when `param_list` is `None`.
///
/// Mirrors `extractSimpleParameters` in `src/extractors/helpers.ts`.
pub fn extract_simple_parameters(
    param_list: Option<Node>,
    source: &[u8],
    options: &ExtractParametersOptions,
) -> Vec<Definition> {
    let mut params = Vec::new();
    let Some(param_list) = param_list else {
        return params;
    };
    for i in 0..param_list.child_count() {
        let Some(child) = param_list.child(i) else { continue };
        if !options.param_kinds.contains(&child.kind()) {
            continue;
        }
        let Some(name_node) = resolve_param_name(
            &child,
            options.name_field,
            options.fallback_to_identifier,
        ) else {
            continue;
        };
        params.push(child_def(
            node_text(&name_node, source).to_string(),
            "parameter",
            start_line(&child),
        ));
    }
    params
}

// ── Type-map helpers ───────────────────────────────────────────────────────

/// Append a raw type-map entry (name → type_name at the given confidence)
/// without deduplication. Call [`dedup_type_map`] once after all entries
/// have been pushed to collapse duplicates with highest-confidence-wins
/// semantics.
///
/// This is the write half of a two-phase approach: accumulate all entries
/// cheaply (O(1) per write), then deduplicate once in O(n) at the end of
/// extraction — avoiding the previous O(n²) scan-per-write pattern.
///
/// Mirrors `setTypeMapEntry` in `src/extractors/helpers.ts`.
pub fn set_type_map_entry(
    symbols: &mut FileSymbols,
    name: impl Into<String>,
    type_name: impl Into<String>,
    confidence: f64,
) {
    let name = name.into();
    if name.is_empty() {
        return;
    }
    symbols.type_map.push(TypeMapEntry {
        name,
        type_name: type_name.into(),
        confidence,
    });
}

/// Record a parameter name → type binding in the type-map sink, using
/// the default confidence of `0.9` shared by every Rust extractor.
///
/// Delegates to [`set_type_map_entry`]. Call [`dedup_type_map`] once after
/// all entries have been pushed to collapse duplicates.
pub fn push_type_map_entry(
    symbols: &mut FileSymbols,
    name: impl Into<String>,
    type_name: impl Into<String>,
) {
    set_type_map_entry(symbols, name, type_name, 0.9);
}

/// Deduplicate a type-map `Vec` in-place, keeping the highest-confidence
/// entry per key (first-write-wins on ties, matching `setTypeMapEntry` in
/// `src/extractors/helpers.ts`).
///
/// This is the read half of the two-phase write-then-dedup approach used by
/// all extractors. Call it once at the end of each `extract()` implementation
/// after all tree-walk passes have completed, for both `symbols.type_map` and
/// `symbols.return_type_map` when applicable.
///
/// Complexity: O(n) where n = number of entries (including duplicates).
pub fn dedup_type_map(entries: &mut Vec<TypeMapEntry>) {
    if entries.len() <= 1 {
        return;
    }
    use std::collections::hash_map::Entry;
    use std::collections::HashMap;
    // Drain all entries into a HashMap, keeping the highest-confidence value
    // per key. On ties the first entry seen wins (the `Occupied` arm only
    // replaces on strict `>`), matching the previous first-write-wins
    // behaviour of the old per-entry linear scan. The values are then
    // sorted by name before being written back so the output is stable.
    let mut map: HashMap<String, TypeMapEntry> = HashMap::with_capacity(entries.len());
    for e in entries.drain(..) {
        match map.entry(e.name.clone()) {
            Entry::Vacant(slot) => { slot.insert(e); }
            Entry::Occupied(mut slot) => {
                if e.confidence > slot.get().confidence {
                    *slot.get_mut() = e;
                }
            }
        }
    }
    let mut out: Vec<TypeMapEntry> = map.into_values().collect();
    out.sort_unstable_by(|a, b| a.name.cmp(&b.name));
    entries.extend(out);
}

/// C-family `declaration` / `parameter_declaration` type-map matcher.
///
/// The cpp / cuda / c extractors all emit verbatim copies of the same
/// `match_*_type_map` walker — they share node kinds (`declaration`,
/// `init_declarator`, `parameter_declaration`) and only differ in the
/// per-language declarator-unwrap helper. This helper centralises the
/// shared walker; callers supply the language's `unwrap_declarator`
/// closure (e.g. `unwrap_cpp_declarator`).
///
pub fn match_c_family_type_map<F>(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    mut unwrap_declarator: F,
)
where
    F: FnMut(&Node, &[u8]) -> String,
{
    match node.kind() {
        "declaration" => {
            let Some(type_node) = node.child_by_field_name("type") else {
                return;
            };
            let type_name = node_text(&type_node, source).to_string();
            for i in 0..node.child_count() {
                let Some(child) = node.child(i) else { continue };
                let kind = child.kind();
                if kind != "init_declarator" && kind != "identifier" {
                    continue;
                }
                let name_node = if kind == "init_declarator" {
                    child.child_by_field_name("declarator")
                } else {
                    Some(child)
                };
                let Some(name_node) = name_node else { continue };
                let final_name = unwrap_declarator(&name_node, source);
                push_type_map_entry(symbols, final_name, type_name.clone());
            }
        }
        "parameter_declaration" => {
            let Some(type_node) = node.child_by_field_name("type") else {
                return;
            };
            let Some(decl) = node.child_by_field_name("declarator") else {
                return;
            };
            let name = unwrap_declarator(&decl, source);
            let type_name = node_text(&type_node, source).to_string();
            push_type_map_entry(symbols, name, type_name);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TypeMapEntry;

    fn entry(name: &str, type_name: &str, confidence: f64) -> TypeMapEntry {
        TypeMapEntry { name: name.to_string(), type_name: type_name.to_string(), confidence }
    }

    #[test]
    fn dedup_empty() {
        let mut v: Vec<TypeMapEntry> = vec![];
        dedup_type_map(&mut v);
        assert!(v.is_empty());
    }

    #[test]
    fn dedup_single() {
        let mut v = vec![entry("x", "Foo", 0.9)];
        dedup_type_map(&mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "x");
    }

    #[test]
    fn dedup_no_duplicates() {
        let mut v = vec![entry("x", "Foo", 0.9), entry("y", "Bar", 0.9)];
        dedup_type_map(&mut v);
        assert_eq!(v.len(), 2);
    }

    #[test]
    fn dedup_keeps_highest_confidence() {
        // Lower confidence written first, higher written second — higher wins.
        let mut v = vec![
            entry("x", "Low", 0.6),
            entry("x", "High", 0.9),
        ];
        dedup_type_map(&mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].type_name, "High");
        assert_eq!(v[0].confidence, 0.9);
    }

    #[test]
    fn dedup_first_write_wins_on_equal_confidence() {
        // Two entries with equal confidence — first one wins.
        let mut v = vec![
            entry("x", "First", 0.9),
            entry("x", "Second", 0.9),
        ];
        dedup_type_map(&mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].type_name, "First");
    }

    #[test]
    fn dedup_mixed_keys() {
        let mut v = vec![
            entry("a", "A1", 0.6),
            entry("b", "B1", 0.9),
            entry("a", "A2", 0.9),  // higher — wins for "a"
            entry("b", "B2", 0.7),  // lower  — loses for "b"
        ];
        dedup_type_map(&mut v);
        assert_eq!(v.len(), 2);
        let a = v.iter().find(|e| e.name == "a").expect("a present");
        let b = v.iter().find(|e| e.name == "b").expect("b present");
        assert_eq!(a.type_name, "A2");
        assert_eq!(b.type_name, "B1");
    }
}
