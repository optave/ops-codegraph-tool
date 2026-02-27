use tree_sitter::Node;

use crate::types::ComplexityMetrics;

// ─── Language-Configurable Complexity Rules ───────────────────────────────

/// Language-specific AST node type rules for complexity analysis.
/// Mirrors `COMPLEXITY_RULES` from `src/complexity.js`.
pub struct LangRules {
    pub branch_nodes: &'static [&'static str],
    pub case_nodes: &'static [&'static str],
    pub logical_operators: &'static [&'static str],
    pub logical_node_type: &'static str,
    pub optional_chain_type: Option<&'static str>,
    pub nesting_nodes: &'static [&'static str],
    pub function_nodes: &'static [&'static str],
    pub if_node_type: Option<&'static str>,
    pub else_node_type: Option<&'static str>,
    pub elif_node_type: Option<&'static str>,
    pub else_via_alternative: bool,
    pub switch_like_nodes: &'static [&'static str],
}

impl LangRules {
    fn is_branch(&self, kind: &str) -> bool {
        self.branch_nodes.contains(&kind)
    }
    fn is_case(&self, kind: &str) -> bool {
        self.case_nodes.contains(&kind)
    }
    fn is_logical_op(&self, kind: &str) -> bool {
        self.logical_operators.contains(&kind)
    }
    fn is_nesting(&self, kind: &str) -> bool {
        self.nesting_nodes.contains(&kind)
    }
    fn is_function(&self, kind: &str) -> bool {
        self.function_nodes.contains(&kind)
    }
    fn is_switch_like(&self, kind: &str) -> bool {
        self.switch_like_nodes.contains(&kind)
    }
}

// ─── Per-Language Rules ───────────────────────────────────────────────────

pub static JS_TS_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "switch_statement",
        "for_statement",
        "for_in_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    case_nodes: &["switch_case"],
    logical_operators: &["&&", "||", "??"],
    logical_node_type: "binary_expression",
    optional_chain_type: Some("optional_chain_expression"),
    nesting_nodes: &[
        "if_statement",
        "switch_statement",
        "for_statement",
        "for_in_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &[
        "function_declaration",
        "function_expression",
        "arrow_function",
        "method_definition",
        "generator_function",
        "generator_function_declaration",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
};

pub static PYTHON_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "elif_clause",
        "else_clause",
        "for_statement",
        "while_statement",
        "except_clause",
        "conditional_expression",
        "match_statement",
    ],
    case_nodes: &["case_clause"],
    logical_operators: &["and", "or"],
    logical_node_type: "boolean_operator",
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "while_statement",
        "except_clause",
        "conditional_expression",
    ],
    function_nodes: &["function_definition", "lambda"],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("elif_clause"),
    else_via_alternative: false,
    switch_like_nodes: &["match_statement"],
};

pub static GO_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
    ],
    case_nodes: &[
        "expression_case",
        "type_case",
        "default_case",
        "communication_case",
    ],
    logical_operators: &["&&", "||"],
    logical_node_type: "binary_expression",
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "expression_switch_statement",
        "type_switch_statement",
        "select_statement",
    ],
    function_nodes: &[
        "function_declaration",
        "method_declaration",
        "func_literal",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &[
        "expression_switch_statement",
        "type_switch_statement",
    ],
};

pub static RUST_LANG_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_expression",
        "else_clause",
        "for_expression",
        "while_expression",
        "loop_expression",
        "if_let_expression",
        "while_let_expression",
        "match_expression",
    ],
    case_nodes: &["match_arm"],
    logical_operators: &["&&", "||"],
    logical_node_type: "binary_expression",
    optional_chain_type: None,
    nesting_nodes: &[
        "if_expression",
        "for_expression",
        "while_expression",
        "loop_expression",
        "if_let_expression",
        "while_let_expression",
        "match_expression",
    ],
    function_nodes: &["function_item", "closure_expression"],
    if_node_type: Some("if_expression"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["match_expression"],
};

pub static JAVA_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
        "switch_expression",
    ],
    case_nodes: &["switch_label"],
    logical_operators: &["&&", "||"],
    logical_node_type: "binary_expression",
    optional_chain_type: None,
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "enhanced_for_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "ternary_expression",
    ],
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: None,
    elif_node_type: None,
    else_via_alternative: true,
    switch_like_nodes: &["switch_expression"],
};

pub static CSHARP_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_clause",
        "for_statement",
        "for_each_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    case_nodes: &["switch_section"],
    logical_operators: &["&&", "||", "??"],
    logical_node_type: "binary_expression",
    optional_chain_type: Some("conditional_access_expression"),
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "for_each_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
        "local_function_statement",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: None,
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
};

pub static RUBY_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if",
        "elsif",
        "else",
        "unless",
        "case",
        "for",
        "while",
        "until",
        "rescue",
        "conditional",
    ],
    case_nodes: &["when"],
    logical_operators: &["and", "or", "&&", "||"],
    logical_node_type: "binary",
    optional_chain_type: None,
    nesting_nodes: &[
        "if",
        "unless",
        "case",
        "for",
        "while",
        "until",
        "rescue",
        "conditional",
    ],
    function_nodes: &["method", "singleton_method", "lambda", "do_block"],
    if_node_type: Some("if"),
    else_node_type: Some("else"),
    elif_node_type: Some("elsif"),
    else_via_alternative: false,
    switch_like_nodes: &["case"],
};

pub static PHP_RULES: LangRules = LangRules {
    branch_nodes: &[
        "if_statement",
        "else_if_clause",
        "else_clause",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    case_nodes: &["case_statement", "default_statement"],
    logical_operators: &["&&", "||", "and", "or", "??"],
    logical_node_type: "binary_expression",
    optional_chain_type: Some("nullsafe_member_access_expression"),
    nesting_nodes: &[
        "if_statement",
        "for_statement",
        "foreach_statement",
        "while_statement",
        "do_statement",
        "catch_clause",
        "conditional_expression",
        "switch_statement",
    ],
    function_nodes: &[
        "function_definition",
        "method_declaration",
        "anonymous_function_creation_expression",
        "arrow_function",
    ],
    if_node_type: Some("if_statement"),
    else_node_type: Some("else_clause"),
    elif_node_type: Some("else_if_clause"),
    else_via_alternative: false,
    switch_like_nodes: &["switch_statement"],
};

/// Look up complexity rules by language ID (matches `COMPLEXITY_RULES` keys in JS).
pub fn lang_rules(lang_id: &str) -> Option<&'static LangRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_RULES),
        "python" => Some(&PYTHON_RULES),
        "go" => Some(&GO_RULES),
        "rust" => Some(&RUST_LANG_RULES),
        "java" => Some(&JAVA_RULES),
        "c_sharp" => Some(&CSHARP_RULES),
        "ruby" => Some(&RUBY_RULES),
        "php" => Some(&PHP_RULES),
        _ => None,
    }
}

// ─── Single-traversal DFS complexity computation ──────────────────────────

/// Compute cognitive complexity, cyclomatic complexity, and max nesting depth
/// for a function's AST subtree in a single DFS walk.
///
/// This is a faithful port of `computeFunctionComplexity()` from `src/complexity.js`.
pub fn compute_function_complexity(
    function_node: &Node,
    rules: &LangRules,
) -> ComplexityMetrics {
    let mut cognitive: u32 = 0;
    let mut cyclomatic: u32 = 1; // McCabe starts at 1
    let mut max_nesting: u32 = 0;

    walk(
        function_node,
        0,
        true,
        rules,
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

fn walk_children(
    node: &Node,
    nesting_level: u32,
    is_top_function: bool,
    rules: &LangRules,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk(
                &child,
                nesting_level,
                is_top_function,
                rules,
                cognitive,
                cyclomatic,
                max_nesting,
            );
        }
    }
}

fn walk(
    node: &Node,
    nesting_level: u32,
    is_top_function: bool,
    rules: &LangRules,
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
    if kind == rules.logical_node_type {
        if let Some(op_node) = node.child(1) {
            let op = op_node.kind();
            if rules.is_logical_op(op) {
                // Cyclomatic: +1 for every logical operator
                *cyclomatic += 1;

                // Cognitive: +1 only when operator changes from the previous sibling sequence
                let mut same_sequence = false;
                if let Some(parent) = node.parent() {
                    if parent.kind() == rules.logical_node_type {
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
                walk_children(
                    node,
                    nesting_level,
                    false,
                    rules,
                    cognitive,
                    cyclomatic,
                    max_nesting,
                );
                return;
            }
        }
    }

    // Handle optional chaining (cyclomatic only)
    if let Some(opt_type) = rules.optional_chain_type {
        if kind == opt_type {
            *cyclomatic += 1;
        }
    }

    // Handle branch/control flow nodes (skip keyword leaf tokens — childCount > 0 guard)
    if rules.is_branch(kind) && node.child_count() > 0 {
        // Pattern A: else clause wraps if (JS/C#/Rust)
        if let Some(else_type) = rules.else_node_type {
            if kind == else_type {
                let first_child = node.named_child(0);
                if first_child.map_or(false, |c| {
                    rules.if_node_type.map_or(false, |if_t| c.kind() == if_t)
                }) {
                    // else-if: the if_statement child handles its own increment
                    walk_children(
                        node,
                        nesting_level,
                        false,
                        rules,
                        cognitive,
                        cyclomatic,
                        max_nesting,
                    );
                    return;
                }
                // Plain else
                *cognitive += 1;
                walk_children(
                    node,
                    nesting_level,
                    false,
                    rules,
                    cognitive,
                    cyclomatic,
                    max_nesting,
                );
                return;
            }
        }

        // Pattern B: explicit elif node (Python/Ruby/PHP)
        if let Some(elif_type) = rules.elif_node_type {
            if kind == elif_type {
                *cognitive += 1;
                *cyclomatic += 1;
                walk_children(
                    node,
                    nesting_level,
                    false,
                    rules,
                    cognitive,
                    cyclomatic,
                    max_nesting,
                );
                return;
            }
        }

        // Detect else-if via Pattern A or C
        let mut is_else_if = false;
        if rules.if_node_type.map_or(false, |if_t| kind == if_t) {
            if rules.else_via_alternative {
                // Pattern C (Go/Java): if_statement is the alternative of parent if_statement
                if let Some(parent) = node.parent() {
                    if rules
                        .if_node_type
                        .map_or(false, |if_t| parent.kind() == if_t)
                    {
                        if let Some(alt) = parent.child_by_field_name("alternative") {
                            if alt.id() == node.id() {
                                is_else_if = true;
                            }
                        }
                    }
                }
            } else if rules.else_node_type.is_some() {
                // Pattern A (JS/C#/Rust): if_statement inside else_clause
                if let Some(parent) = node.parent() {
                    if rules
                        .else_node_type
                        .map_or(false, |else_t| parent.kind() == else_t)
                    {
                        is_else_if = true;
                    }
                }
            }
        }

        if is_else_if {
            *cognitive += 1;
            *cyclomatic += 1;
            walk_children(
                node,
                nesting_level,
                false,
                rules,
                cognitive,
                cyclomatic,
                max_nesting,
            );
            return;
        }

        // Regular branch node
        *cognitive += 1 + nesting_level; // structural + nesting
        *cyclomatic += 1;

        // Switch-like nodes don't add cyclomatic themselves (cases do)
        if rules.is_switch_like(kind) {
            *cyclomatic -= 1; // Undo the ++ above; cases handle cyclomatic
        }

        if rules.is_nesting(kind) {
            walk_children(
                node,
                nesting_level + 1,
                false,
                rules,
                cognitive,
                cyclomatic,
                max_nesting,
            );
            return;
        }
    }

    // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
    if rules.else_via_alternative {
        if rules.if_node_type.map_or(false, |if_t| kind != if_t) {
            if let Some(parent) = node.parent() {
                if rules
                    .if_node_type
                    .map_or(false, |if_t| parent.kind() == if_t)
                {
                    if let Some(alt) = parent.child_by_field_name("alternative") {
                        if alt.id() == node.id() {
                            *cognitive += 1;
                            walk_children(
                                node,
                                nesting_level,
                                false,
                                rules,
                                cognitive,
                                cyclomatic,
                                max_nesting,
                            );
                            return;
                        }
                    }
                }
            }
        }
    }

    // Handle case nodes (cyclomatic only, skip keyword leaves)
    if rules.is_case(kind) && node.child_count() > 0 {
        *cyclomatic += 1;
    }

    // Handle nested function definitions (increase nesting)
    if !is_top_function && rules.is_function(kind) {
        walk_children(
            node,
            nesting_level + 1,
            false,
            rules,
            cognitive,
            cyclomatic,
            max_nesting,
        );
        return;
    }

    // Walk children
    walk_children(
        node,
        nesting_level,
        false,
        rules,
        cognitive,
        cyclomatic,
        max_nesting,
    );
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
        let root = tree.root_node();
        let func = find_first_function(&root, &JS_TS_RULES).expect("no function found in test code");
        compute_function_complexity(&func, &JS_TS_RULES)
    }

    fn find_first_function<'a>(node: &Node<'a>, rules: &LangRules) -> Option<Node<'a>> {
        if rules.is_function(node.kind()) {
            return Some(*node);
        }
        // For variable declarations with arrow functions
        if node.kind() == "variable_declarator" {
            if let Some(value) = node.child_by_field_name("value") {
                if rules.is_function(value.kind()) {
                    return Some(value);
                }
            }
        }
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if let Some(found) = find_first_function(&child, rules) {
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
        // if (+1 cog, +1 cyc), else-if (+1 cog, +1 cyc), plain else (+1 cog)
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

    // ─── Python tests ─────────────────────────────────────────────────────

    fn compute_python(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_python::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &PYTHON_RULES).expect("no function found");
        compute_function_complexity(&func, &PYTHON_RULES)
    }

    #[test]
    fn python_empty_function() {
        let m = compute_python("def f():\n    pass");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
    }

    #[test]
    fn python_if_elif_else() {
        let m = compute_python("def f(x):\n    if x > 0:\n        return 1\n    elif x < 0:\n        return -1\n    else:\n        return 0");
        // if: +1 cog, +1 cyc; elif: +1 cog, +1 cyc; else: +1 cog
        assert_eq!(m.cognitive, 3);
        assert_eq!(m.cyclomatic, 3);
    }

    #[test]
    fn python_for_loop() {
        let m = compute_python("def f(xs):\n    for x in xs:\n        print(x)");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }

    // ─── Go tests ─────────────────────────────────────────────────────────

    fn compute_go(code: &str) -> ComplexityMetrics {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_go::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        let root = tree.root_node();
        let func = find_first_function(&root, &GO_RULES).expect("no function found");
        compute_function_complexity(&func, &GO_RULES)
    }

    #[test]
    fn go_empty_function() {
        let m = compute_go("package main\nfunc f() {}");
        assert_eq!(m.cognitive, 0);
        assert_eq!(m.cyclomatic, 1);
    }

    #[test]
    fn go_if_else() {
        let m = compute_go("package main\nfunc f(x int) int {\n    if x > 0 {\n        return 1\n    } else {\n        return 0\n    }\n}");
        // if: +1 cog, +1 cyc; else (via alternative): +1 cog
        assert_eq!(m.cognitive, 2);
        assert_eq!(m.cyclomatic, 2);
    }

    #[test]
    fn go_for_loop() {
        let m = compute_go("package main\nfunc f() {\n    for i := 0; i < 10; i++ {\n        println(i)\n    }\n}");
        assert_eq!(m.cognitive, 1);
        assert_eq!(m.cyclomatic, 2);
    }
}
