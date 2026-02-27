use tree_sitter::Node;

use crate::types::ComplexityMetrics;

/// Language kind for complexity analysis (only JS/TS/TSX supported).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComplexityLang {
    JavaScript,
    TypeScript,
    Tsx,
}

impl ComplexityLang {
    /// Derive from file extension. Returns None for unsupported languages.
    pub fn from_extension(path: &str) -> Option<Self> {
        let ext = path.rsplit('.').next().unwrap_or("");
        match ext {
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            _ => None,
        }
    }
}

// ─── Node type sets (JS/TS/TSX share the same tree-sitter grammar structure) ──

fn is_branch_node(kind: &str) -> bool {
    matches!(
        kind,
        "if_statement"
            | "else_clause"
            | "switch_statement"
            | "for_statement"
            | "for_in_statement"
            | "while_statement"
            | "do_statement"
            | "catch_clause"
            | "ternary_expression"
    )
}

fn is_nesting_node(kind: &str) -> bool {
    matches!(
        kind,
        "if_statement"
            | "switch_statement"
            | "for_statement"
            | "for_in_statement"
            | "while_statement"
            | "do_statement"
            | "catch_clause"
            | "ternary_expression"
    )
}

fn is_function_node(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "function_expression"
            | "arrow_function"
            | "method_definition"
            | "generator_function"
            | "generator_function_declaration"
    )
}

fn is_logical_operator(kind: &str) -> bool {
    matches!(kind, "&&" | "||" | "??")
}

fn is_case_node(kind: &str) -> bool {
    kind == "switch_case"
}

// ─── Single-traversal DFS complexity computation ──────────────────────────

/// Compute cognitive complexity, cyclomatic complexity, and max nesting depth
/// for a function's AST subtree in a single DFS walk.
///
/// This is a faithful port of `computeFunctionComplexity()` from `src/complexity.js`.
pub fn compute_function_complexity(function_node: &Node) -> ComplexityMetrics {
    let mut cognitive: u32 = 0;
    let mut cyclomatic: u32 = 1; // McCabe starts at 1
    let mut max_nesting: u32 = 0;

    walk(
        function_node,
        0,
        true,
        &mut cognitive,
        &mut cyclomatic,
        &mut max_nesting,
    );

    ComplexityMetrics {
        cognitive,
        cyclomatic,
        max_nesting,
    }
}

fn walk(
    node: &Node,
    nesting_level: u32,
    is_top_function: bool,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
) {
    let kind = node.kind();

    // Track nesting depth
    if nesting_level > *max_nesting {
        *max_nesting = nesting_level;
    }

    // Handle logical operators in binary expressions
    if kind == "binary_expression" {
        if let Some(op_node) = node.child(1) {
            let op = op_node.kind();
            if is_logical_operator(op) {
                // Cyclomatic: +1 for every logical operator
                *cyclomatic += 1;

                // Cognitive: +1 only when operator changes from the previous sibling sequence
                let mut same_sequence = false;
                if let Some(parent) = node.parent() {
                    if parent.kind() == "binary_expression" {
                        if let Some(parent_op) = parent.child(1) {
                            if parent_op.kind() == op {
                                same_sequence = true;
                            }
                        }
                    }
                }
                if !same_sequence {
                    *cognitive += 1;
                }

                // Walk children manually to avoid double-counting
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(&child, nesting_level, false, cognitive, cyclomatic, max_nesting);
                    }
                }
                return;
            }
        }
    }

    // Handle optional chaining (cyclomatic only)
    if kind == "optional_chain_expression" {
        *cyclomatic += 1;
    }

    // Handle branch/control flow nodes
    if is_branch_node(kind) {
        let is_else_if = kind == "if_statement"
            && node
                .parent()
                .map_or(false, |p| p.kind() == "else_clause");

        if kind == "else_clause" {
            // else: +1 cognitive structural, no nesting increment, no cyclomatic
            // But only if it's a plain else (not else-if)
            let first_child = node.named_child(0);
            if first_child.map_or(false, |c| c.kind() == "if_statement") {
                // This is else-if: the if_statement child handles its own increment
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        walk(&child, nesting_level, false, cognitive, cyclomatic, max_nesting);
                    }
                }
                return;
            }
            // Plain else
            *cognitive += 1;
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk(&child, nesting_level, false, cognitive, cyclomatic, max_nesting);
                }
            }
            return;
        }

        if is_else_if {
            // else-if: +1 structural cognitive, +1 cyclomatic, NO nesting increment
            *cognitive += 1;
            *cyclomatic += 1;
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk(&child, nesting_level, false, cognitive, cyclomatic, max_nesting);
                }
            }
            return;
        }

        // Regular branch node
        *cognitive += 1 + nesting_level; // structural + nesting
        *cyclomatic += 1;

        // switch_statement doesn't add cyclomatic itself (cases do), but adds cognitive
        if kind == "switch_statement" {
            *cyclomatic -= 1; // Undo the ++ above; cases handle cyclomatic
        }

        if is_nesting_node(kind) {
            for i in 0..node.child_count() {
                if let Some(child) = node.child(i) {
                    walk(
                        &child,
                        nesting_level + 1,
                        false,
                        cognitive,
                        cyclomatic,
                        max_nesting,
                    );
                }
            }
            return;
        }
    }

    // Handle case nodes (cyclomatic only)
    if is_case_node(kind) {
        *cyclomatic += 1;
    }

    // Handle nested function definitions (increase nesting)
    if !is_top_function && is_function_node(kind) {
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                walk(
                    &child,
                    nesting_level + 1,
                    false,
                    cognitive,
                    cyclomatic,
                    max_nesting,
                );
            }
        }
        return;
    }

    // Walk children
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk(&child, nesting_level, false, cognitive, cyclomatic, max_nesting);
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn compute_js(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_javascript::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        // Find the first function node
        let root = tree.root_node();
        let func = find_first_function(&root).expect("no function found in test code");
        compute_function_complexity(&func)
    }

    fn find_first_function<'a>(node: &Node<'a>) -> Option<Node<'a>> {
        if is_function_node(node.kind()) {
            return Some(*node);
        }
        // For variable declarations with arrow functions
        if node.kind() == "variable_declarator" {
            if let Some(value) = node.child_by_field_name("value") {
                if is_function_node(value.kind()) {
                    return Some(value);
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if let Some(found) = find_first_function(&child) {
                    return Some(found);
                }
            }
        }
        None
    }

    #[test]
    fn empty_function() {
        let m = compute_js("function f() {}");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
        assert_eq!(m.max_nesting, 0);
    }

    #[test]
    fn single_if() {
        let m = compute_js("function f(x) { if (x) { return 1; } }");
        assert_eq!(m.cognitive, 1); // +1 structural
        assert_eq!(m.cyclomatic, 2); // 1 base + 1 if
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn if_else() {
        let m = compute_js("function f(x) { if (x) { return 1; } else { return 0; } }");
        assert_eq!(m.cognitive, 2); // +1 if, +1 else
        assert_eq!(m.cyclomatic, 2); // 1 base + 1 if
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn if_else_if_else() {
        let m = compute_js(
            "function f(x) { if (x > 0) { return 1; } else if (x < 0) { return -1; } else { return 0; } }",
        );
        assert_eq!(m.cognitive, 4); // +1 if, +1 else-if, +1 else (from else-if's else_clause), +1 else-if cognitive
        // Wait, let me recalculate:
        // if: cognitive +1 (nesting 0), cyclomatic +1
        // else-if: cognitive +1, cyclomatic +1 (no nesting)
        // else: cognitive +1
        // Total cognitive = 3, cyclomatic = 1 + 1 + 1 = 3
        // Hmm, the else clause wrapping the else-if doesn't add anything (it's detected as else-if wrapper)
        // So: if (+1 cog, +1 cyc), else-if (+1 cog, +1 cyc), plain else (+1 cog)
        // cognitive = 3, cyclomatic = 3
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn nested_if() {
        let m = compute_js(
            "function f(x, y) { if (x) { if (y) { return 1; } } }",
        );
        // Outer if: cognitive +1 (nesting 0), cyclomatic +1
        // Inner if: cognitive +1+1 (nesting 1), cyclomatic +1
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn for_loop() {
        let m = compute_js("function f(arr) { for (let i = 0; i < arr.length; i++) { process(arr[i]); } }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn logical_operators_same() {
        let m = compute_js("function f(a, b, c) { if (a && b && c) { return 1; } }");
        // if: cognitive +1, cyclomatic +1
        // &&: cyclomatic +1 each (2 operators), cognitive +1 for first && (sequence start)
        // second && is same sequence, no cognitive
        assert_eq!(m.cognitive, 2); // 1 (if) + 1 (&&)
        assert_eq!(m.cyclomatic, 4); // 1 base + 1 if + 2 &&
    }

    #[test]
    fn logical_operators_mixed() {
        let m = compute_js("function f(a, b, c) { if (a && b || c) { return 1; } }");
        // if: cognitive +1, cyclomatic +1
        // The AST is: (a && b) || c
        // || at top: cyclomatic +1, cognitive +1 (new sequence)
        // && nested: cyclomatic +1, cognitive +1 (different from parent ||)
        assert_eq!(m.cognitive, 3); // 1 (if) + 1 (&&) + 1 (||)
        assert_eq!(m.cyclomatic, 4); // 1 base + 1 if + 1 && + 1 ||
    }

    #[test]
    fn switch_case() {
        let m = compute_js(
            "function f(x) { switch(x) { case 1: return 'a'; case 2: return 'b'; default: return 'c'; } }",
        );
        // switch: cognitive +1, cyclomatic undone
        // case 1: cyclomatic +1
        // case 2: cyclomatic +1
        // default is not switch_case, so no cyclomatic
        assert_eq!(m.cognitive, 1); // switch structural
        assert_eq!(m.cyclomatic, 3); // 1 base + 2 cases
    }

    #[test]
    fn ternary() {
        let m = compute_js("function f(x) { return x ? 1 : 0; }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn nested_function() {
        let m = compute_js(
            "function f(x) { const inner = () => { if (x) { return 1; } }; }",
        );
        // Nested arrow function increases nesting
        // if inside nested: cognitive +1+1 (nesting=1 from nested fn), cyclomatic +1
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 2);
    }

    #[test]
    fn catch_clause() {
        let m = compute_js(
            "function f() { try { doSomething(); } catch(e) { handleError(e); } }",
        );
        // catch: cognitive +1 (nesting 0), cyclomatic +1
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn while_loop() {
        let m = compute_js("function f() { while (true) { doSomething(); } }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn do_while_loop() {
        let m = compute_js("function f() { do { doSomething(); } while (true); }");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
        assert_eq!(m.max_nesting, 1);
    }

    #[test]
    fn complexity_lang_from_extension() {
        assert_eq!(
            ComplexityLang::from_extension("foo.js"),
            Some(ComplexityLang::JavaScript)
        );
        assert_eq!(
            ComplexityLang::from_extension("foo.ts"),
            Some(ComplexityLang::TypeScript)
        );
        assert_eq!(
            ComplexityLang::from_extension("foo.tsx"),
            Some(ComplexityLang::Tsx)
        );
        assert_eq!(ComplexityLang::from_extension("foo.py"), None);
        assert_eq!(ComplexityLang::from_extension("foo.go"), None);
    }
}
