use tree_sitter::Node;
use crate::types::{AstNode, Definition};

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

// ── AST node extraction (shared across all languages) ────────────────────────

/// Max length for the AST `text` field — matches `TEXT_MAX` in `ast.js`.
pub const AST_TEXT_MAX: usize = 200;

/// Language-specific AST node type configuration.
pub struct LangAstConfig {
    /// Node types mapping to `"call"` kind (e.g. `call_expression`, `method_invocation`)
    pub call_types: &'static [&'static str],
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
    call_types: &["call"],
    new_types: &[],
    throw_types: &["raise_statement"],
    await_types: &["await"],
    string_types: &["string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
    string_prefixes: &['r', 'b', 'f', 'u', 'R', 'B', 'F', 'U'],
};

pub const GO_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["call_expression"],
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["interpreted_string_literal", "raw_string_literal"],
    regex_types: &[],
    quote_chars: &['"', '`'],
    string_prefixes: &[],
};

pub const RUST_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["call_expression", "method_call_expression"],
    new_types: &[],
    throw_types: &[],
    await_types: &["await_expression"],
    string_types: &["string_literal", "raw_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const JAVA_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["method_invocation"],
    new_types: &["object_creation_expression"],
    throw_types: &["throw_statement"],
    await_types: &[],
    string_types: &["string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const CSHARP_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["invocation_expression"],
    new_types: &["object_creation_expression"],
    throw_types: &["throw_statement", "throw_expression"],
    await_types: &["await_expression"],
    string_types: &["string_literal", "verbatim_string_literal"],
    regex_types: &[],
    quote_chars: &['"'],
    string_prefixes: &[],
};

pub const RUBY_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["call", "method_call"],
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string"],
    regex_types: &["regex"],
    quote_chars: &['\'', '"'],
    string_prefixes: &[],
};

pub const PHP_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["function_call_expression", "member_call_expression", "scoped_call_expression"],
    new_types: &["object_creation_expression"],
    throw_types: &["throw_expression"],
    await_types: &[],
    string_types: &["string", "encapsed_string"],
    regex_types: &[],
    quote_chars: &['\'', '"'],
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
    let kind = node.kind();

    // Call extraction — checked first since calls are the most common AST node kind.
    // Do NOT recurse children: prevents double-counting nested calls like `a(b())`.
    if config.call_types.contains(&kind) {
        let name = extract_call_name(node, source);
        let receiver = extract_call_receiver(node, source);
        let text = truncate(node_text(node, source), AST_TEXT_MAX);
        ast_nodes.push(AstNode {
            kind: "call".to_string(),
            name,
            line: start_line(node),
            text: Some(text),
            receiver,
        });
        // Recurse into arguments only — nested calls in args should be captured.
        // Use child_by_field_name("arguments") — immune to kind-name variation across grammars.
        // Falls back to kind-based matching for grammars that don't expose a field name.
        let args_node = node.child_by_field_name("arguments").or_else(|| {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    let ck = child.kind();
                    if ck == "arguments" || ck == "argument_list" || ck == "method_arguments" {
                        return Some(child);
                    }
                }
            }
            None
        });
        if let Some(args) = args_node {
            for j in 0..args.child_count() {
                if let Some(arg) = args.child(j) {
                    walk_ast_nodes_with_config_depth(&arg, source, ast_nodes, config, depth + 1);
                }
            }
        }
        return;
    }

    if config.new_types.contains(&kind) {
        let name = extract_constructor_name(node, source);
        let text = truncate(node_text(node, source), AST_TEXT_MAX);
        ast_nodes.push(AstNode {
            kind: "new".to_string(),
            name,
            line: start_line(node),
            text: Some(text),
            receiver: None,
        });
        // Fall through to recurse children (e.g. string args inside `new`)
    } else if config.throw_types.contains(&kind) {
        let name = extract_throw_target(node, source, config);
        let text = extract_child_expression_text(node, source);
        ast_nodes.push(AstNode {
            kind: "throw".to_string(),
            name,
            line: start_line(node),
            text,
            receiver: None,
        });
        // Fall through to recurse children (e.g. `new` inside `throw new ...`)
    } else if config.await_types.contains(&kind) {
        let name = extract_awaited_name(node, source);
        let text = extract_child_expression_text(node, source);
        ast_nodes.push(AstNode {
            kind: "await".to_string(),
            name,
            line: start_line(node),
            text,
            receiver: None,
        });
        // Fall through to recurse children — captures strings, calls, etc. inside await expr.
        // The call_types guard at the top of the function already handles `call_expression`
        // nodes correctly (recurse-into-args-only), so there is no double-counting risk here.
    } else if config.string_types.contains(&kind) {
        let raw = node_text(node, source);
        let is_raw_string = kind.contains("raw_string");
        // Strip language prefix modifiers before quote chars:
        // - C# verbatim `@"..."`
        // - Rust raw strings `r"..."`, `r#"..."#`
        // - Python prefixes: r, b, f, u and combos like rb, fr
        let without_prefix = raw.trim_start_matches('@')
            .trim_start_matches(|c: char| config.string_prefixes.contains(&c));
        // For raw string node types (e.g. Rust `r#"..."#`), strip the `r` prefix
        // and `#` delimiters.  This must be conditional — the unconditional
        // `.trim_start_matches('r')` that was here before double-stripped 'r' for
        // languages like Python where 'r' is already in string_prefixes.
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
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk_ast_nodes_with_config_depth(&child, source, ast_nodes, config, depth + 1);
                }
            }
            return;
        }
        let name = truncate(content, 100);
        let text = truncate(raw, AST_TEXT_MAX);
        ast_nodes.push(AstNode {
            kind: "string".to_string(),
            name,
            line: start_line(node),
            text: Some(text),
            receiver: None,
        });
        // Fall through to recurse children (template strings may have nested expressions)
    } else if config.regex_types.contains(&kind) {
        let raw = node_text(node, source);
        let name = if raw.is_empty() { "?".to_string() } else { raw.to_string() };
        let text = truncate(raw, AST_TEXT_MAX);
        ast_nodes.push(AstNode {
            kind: "regex".to_string(),
            name,
            line: start_line(node),
            text: Some(text),
            receiver: None,
        });
        // Fall through to recurse children
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
        if let Some(child) = node.child_by_field_name(field) {
            return node_text(&child, source).to_string();
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
        if let Some(fn_node) = node.child_by_field_name(field) {
            return node_text(&fn_node, source).to_string();
        }
    }
    let text = node_text(node, source);
    text.split('(').next().unwrap_or("?").to_string()
}

/// Extract receiver from a call node (e.g. `obj` from `obj.method()`).
/// Looks for a member-expression-like function child and extracts the object part.
fn extract_call_receiver(node: &Node, source: &[u8]) -> Option<String> {
    // PHP: scoped_call_expression — receiver is the "scope" field (e.g. MyClass in MyClass::method())
    if let Some(scope) = node.child_by_field_name("scope") {
        return Some(node_text(&scope, source).to_string());
    }
    // Try "function" field first (JS/TS: call_expression -> member_expression)
    // Then "object" (Go, Python), then "receiver" (Ruby)
    for field in &["function", "object", "receiver"] {
        if let Some(fn_node) = node.child_by_field_name(field) {
            // JS/TS/Python: member_expression / attribute with "object" field
            if let Some(obj) = fn_node.child_by_field_name("object") {
                return Some(node_text(&obj, source).to_string());
            }
            // Go: selector_expression uses "operand" not "object"
            if fn_node.kind() == "selector_expression" {
                if let Some(operand) = fn_node.child_by_field_name("operand") {
                    return Some(node_text(&operand, source).to_string());
                }
            }
            // C#: member_access_expression uses "expression" not "object"
            if fn_node.kind() == "member_access_expression" {
                if let Some(expr) = fn_node.child_by_field_name("expression") {
                    return Some(node_text(&expr, source).to_string());
                }
            }
            // For Ruby/Go where the receiver is directly a field
            if *field == "object" || *field == "receiver" {
                return Some(node_text(&fn_node, source).to_string());
            }
        }
    }
    None
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
