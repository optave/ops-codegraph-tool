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
        "csharp" => Some(&CSHARP_RULES),
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

    ComplexityMetrics::basic(cognitive, cyclomatic, max_nesting)
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

// ─── Halstead Operator/Operand Classification ─────────────────────────────

/// Language-specific Halstead classification rules.
pub struct HalsteadRules {
    pub operator_leaf_types: &'static [&'static str],
    pub operand_leaf_types: &'static [&'static str],
    pub compound_operators: &'static [&'static str],
    pub skip_types: &'static [&'static str],
}

pub static JS_TS_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**",
        "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=",
        "==", "===", "!=", "!==", "<", ">", "<=", ">=",
        "&&", "||", "!", "??",
        "&", "|", "^", "~", "<<", ">>", ">>>",
        "++", "--",
        "typeof", "instanceof", "new", "return", "throw", "yield", "await",
        "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
        "try", "catch", "finally",
        "=>", "...", "?", ":", ".", "?.",
        ",", ";",
    ],
    operand_leaf_types: &[
        "identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern",
        "number", "string_fragment", "regex_pattern",
        "true", "false", "null", "undefined", "this", "super",
        "private_property_identifier",
    ],
    compound_operators: &[
        "call_expression", "subscript_expression", "new_expression", "template_substitution",
    ],
    skip_types: &["type_annotation", "type_parameters", "return_type", "implements_clause"],
};

pub static PYTHON_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**", "//",
        "=", "+=", "-=", "*=", "/=", "%=", "**=", "//=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=",
        "and", "or", "not",
        "&", "|", "^", "~", "<<", ">>",
        "if", "else", "elif", "for", "while", "with", "try", "except", "finally",
        "raise", "return", "yield", "await", "pass", "break", "continue",
        "import", "from", "as", "in", "is", "lambda", "del",
        ".", ",", ":", "@", "->",
    ],
    operand_leaf_types: &[
        "identifier", "integer", "float", "string_content",
        "true", "false", "none",
    ],
    compound_operators: &["call", "subscript", "attribute"],
    skip_types: &[],
};

pub static GO_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%",
        "=", ":=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=",
        "&&", "||", "!",
        "&", "|", "^", "~", "<<", ">>", "&^",
        "++", "--",
        "if", "else", "for", "switch", "select", "case", "default",
        "return", "break", "continue", "goto", "fallthrough",
        "go", "defer", "range", "chan", "func", "var", "const", "type", "struct", "interface",
        ".", ",", ";", ":", "<-",
    ],
    operand_leaf_types: &[
        "identifier", "field_identifier", "package_identifier", "type_identifier",
        "int_literal", "float_literal", "imaginary_literal", "rune_literal",
        "interpreted_string_literal", "raw_string_literal",
        "true", "false", "nil", "iota",
    ],
    compound_operators: &["call_expression", "index_expression", "selector_expression"],
    skip_types: &[],
};

pub static RUST_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%",
        "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=",
        "&&", "||", "!",
        "&", "|", "^", "<<", ">>",
        "if", "else", "for", "while", "loop", "match",
        "return", "break", "continue",
        "let", "mut", "ref", "as", "in", "move",
        "fn", "struct", "enum", "trait", "impl", "pub", "mod", "use",
        ".", ",", ";", ":", "::", "=>", "->", "?",
    ],
    operand_leaf_types: &[
        "identifier", "field_identifier", "type_identifier",
        "integer_literal", "float_literal", "string_content", "char_literal",
        "true", "false", "self", "Self",
    ],
    compound_operators: &["call_expression", "index_expression", "field_expression"],
    skip_types: &[],
};

pub static JAVA_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%",
        "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>=",
        "==", "!=", "<", ">", "<=", ">=",
        "&&", "||", "!",
        "&", "|", "^", "~", "<<", ">>", ">>>",
        "++", "--",
        "instanceof", "new",
        "if", "else", "for", "while", "do", "switch", "case",
        "return", "throw", "break", "continue",
        "try", "catch", "finally",
        ".", ",", ";", ":", "?", "->",
    ],
    operand_leaf_types: &[
        "identifier", "type_identifier",
        "decimal_integer_literal", "hex_integer_literal", "octal_integer_literal", "binary_integer_literal",
        "decimal_floating_point_literal", "hex_floating_point_literal",
        "string_literal", "character_literal",
        "true", "false", "null", "this", "super",
    ],
    compound_operators: &["method_invocation", "array_access", "object_creation_expression"],
    skip_types: &["type_arguments", "type_parameters"],
};

pub static CSHARP_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%",
        "=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=",
        "&&", "||", "!", "??", "??=",
        "&", "|", "^", "~", "<<", ">>",
        "++", "--",
        "is", "as", "new", "typeof", "sizeof", "nameof",
        "if", "else", "for", "foreach", "while", "do", "switch", "case",
        "return", "throw", "break", "continue",
        "try", "catch", "finally", "await", "yield",
        ".", "?.", ",", ";", ":", "=>", "->",
    ],
    operand_leaf_types: &[
        "identifier",
        "integer_literal", "real_literal",
        "string_literal", "character_literal", "verbatim_string_literal", "interpolated_string_text",
        "true", "false", "null", "this", "base",
    ],
    compound_operators: &["invocation_expression", "element_access_expression", "object_creation_expression"],
    skip_types: &["type_argument_list", "type_parameter_list"],
};

pub static RUBY_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**",
        "=", "+=", "-=", "*=", "/=", "%=", "**=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "!=", "<", ">", "<=", ">=", "<=>", "===", "=~", "!~",
        "&&", "||", "!", "and", "or", "not",
        "&", "|", "^", "~", "<<", ">>",
        "if", "else", "elsif", "unless", "case", "when",
        "for", "while", "until", "do", "begin", "end",
        "return", "raise", "break", "next", "redo", "retry",
        "rescue", "ensure", "yield", "def", "class", "module",
        ".", ",", ":", "::", "=>", "->",
    ],
    operand_leaf_types: &[
        "identifier", "constant", "instance_variable", "class_variable", "global_variable",
        "integer", "float", "string_content", "symbol",
        "true", "false", "nil", "self",
    ],
    compound_operators: &["call", "element_reference"],
    skip_types: &[],
};

pub static PHP_HALSTEAD: HalsteadRules = HalsteadRules {
    operator_leaf_types: &[
        "+", "-", "*", "/", "%", "**",
        "=", "+=", "-=", "*=", "/=", "%=", "**=", ".=", "&=", "|=", "^=", "<<=", ">>=",
        "==", "===", "!=", "!==", "<", ">", "<=", ">=", "<=>",
        "&&", "||", "!", "and", "or", "xor", "??",
        "&", "|", "^", "~", "<<", ">>",
        "++", "--",
        "instanceof", "new", "clone",
        "if", "else", "elseif", "for", "foreach", "while", "do", "switch", "case",
        "return", "throw", "break", "continue",
        "try", "catch", "finally", "echo", "print", "yield",
        ".", "->", "?->", "::", ",", ";", ":", "?", "=>",
    ],
    operand_leaf_types: &[
        "name", "variable_name",
        "integer", "float", "string_content",
        "true", "false", "null",
    ],
    compound_operators: &[
        "function_call_expression", "member_call_expression", "scoped_call_expression",
        "subscript_expression", "object_creation_expression",
    ],
    skip_types: &[],
};

/// Look up Halstead rules by language ID.
pub fn halstead_rules(lang_id: &str) -> Option<&'static HalsteadRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_HALSTEAD),
        "python" => Some(&PYTHON_HALSTEAD),
        "go" => Some(&GO_HALSTEAD),
        "rust" => Some(&RUST_HALSTEAD),
        "java" => Some(&JAVA_HALSTEAD),
        "csharp" => Some(&CSHARP_HALSTEAD),
        "ruby" => Some(&RUBY_HALSTEAD),
        "php" => Some(&PHP_HALSTEAD),
        _ => None,
    }
}

/// Comment line prefixes per language, used for LOC metrics.
pub fn comment_prefixes(lang_id: &str) -> &'static [&'static str] {
    match lang_id {
        "javascript" | "typescript" | "tsx" | "go" | "rust" | "java" | "csharp" => {
            &["//", "/*", "*", "*/"]
        }
        "python" | "ruby" => &["#"],
        "php" => &["//", "#", "/*", "*", "*/"],
        _ => &["//", "/*", "*", "*/"],
    }
}

// ─── Merged Single-Pass: Complexity + Halstead + LOC + MI ─────────────────

use crate::types::{HalsteadMetrics, LocMetrics};
use std::collections::HashMap;

/// Compute all metrics (complexity + Halstead + LOC + MI) in a single DFS walk.
///
/// This is the primary entry point for extractors. It merges complexity and
/// Halstead classification into one tree traversal, then computes LOC (text-based)
/// and Maintainability Index from the collected data.
///
/// Returns `None` if no complexity rules exist for the given language.
pub fn compute_all_metrics(
    function_node: &Node,
    source: &[u8],
    lang_id: &str,
) -> Option<ComplexityMetrics> {
    let c_rules = lang_rules(lang_id)?;
    let h_rules = halstead_rules(lang_id);

    // ── Complexity state ──
    let mut cognitive: u32 = 0;
    let mut cyclomatic: u32 = 1; // McCabe starts at 1
    let mut max_nesting: u32 = 0;

    // ── Halstead state ──
    let mut operators: HashMap<String, u32> = HashMap::new();
    let mut operands: HashMap<String, u32> = HashMap::new();

    walk_all(
        function_node,
        source,
        0,
        true,
        false,
        c_rules,
        h_rules,
        &mut cognitive,
        &mut cyclomatic,
        &mut max_nesting,
        &mut operators,
        &mut operands,
    );

    // ── Build Halstead metrics ──
    let halstead = if h_rules.is_some() {
        let n1 = operators.len() as u32;
        let n2 = operands.len() as u32;
        let big_n1: u32 = operators.values().sum();
        let big_n2: u32 = operands.values().sum();

        let vocabulary = n1 + n2;
        let length = big_n1 + big_n2;
        let volume = if vocabulary > 0 {
            (length as f64) * (vocabulary as f64).log2()
        } else {
            0.0
        };
        let difficulty = if n2 > 0 {
            (n1 as f64 / 2.0) * (big_n2 as f64 / n2 as f64)
        } else {
            0.0
        };
        let effort = difficulty * volume;
        let bugs = volume / 3000.0;

        Some(HalsteadMetrics {
            n1,
            n2,
            big_n1,
            big_n2,
            vocabulary,
            length,
            volume: round_f64(volume, 2),
            difficulty: round_f64(difficulty, 2),
            effort: round_f64(effort, 2),
            bugs: round_f64(bugs, 4),
        })
    } else {
        None
    };

    // ── LOC metrics (text-based) ──
    let start = function_node.start_byte();
    let end = function_node.end_byte().min(source.len());
    let func_source = &source[start..end];
    let func_text = String::from_utf8_lossy(func_source);
    let lines: Vec<&str> = func_text.split('\n').collect();
    let loc_total = lines.len() as u32;
    let prefixes = comment_prefixes(lang_id);

    let mut comment_lines: u32 = 0;
    let mut blank_lines: u32 = 0;
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            blank_lines += 1;
        } else if prefixes.iter().any(|p| trimmed.starts_with(p)) {
            comment_lines += 1;
        }
    }
    let sloc = (loc_total.saturating_sub(blank_lines).saturating_sub(comment_lines)).max(1);

    let loc_metrics = LocMetrics {
        loc: loc_total,
        sloc,
        comment_lines,
    };

    // ── Maintainability Index ──
    let volume = halstead.as_ref().map_or(0.0, |h| h.volume);
    let safe_volume = if volume > 1.0 { volume } else { 1.0 };
    let safe_sloc = if sloc > 1 { sloc as f64 } else { 1.0 };
    let comment_ratio = if loc_total > 0 {
        comment_lines as f64 / loc_total as f64
    } else {
        0.0
    };

    let mut mi = 171.0 - 5.2 * safe_volume.ln() - 0.23 * (cyclomatic as f64) - 16.2 * safe_sloc.ln();
    if comment_ratio > 0.0 {
        mi += 50.0 * (2.4 * comment_ratio).sqrt().sin();
    }
    let normalized = (mi * 100.0 / 171.0).clamp(0.0, 100.0);
    let maintainability_index = round_f64(normalized, 1);

    Some(ComplexityMetrics {
        cognitive,
        cyclomatic,
        max_nesting,
        halstead: halstead.or(Some(HalsteadMetrics {
            n1: 0, n2: 0, big_n1: 0, big_n2: 0,
            vocabulary: 0, length: 0,
            volume: 0.0, difficulty: 0.0, effort: 0.0, bugs: 0.0,
        })),
        loc: Some(loc_metrics),
        maintainability_index: Some(maintainability_index),
    })
}

/// Round f64 to `decimals` decimal places.
fn round_f64(value: f64, decimals: u32) -> f64 {
    let factor = 10_f64.powi(decimals as i32);
    (value * factor).round() / factor
}

#[allow(clippy::too_many_arguments)]
fn walk_all_children(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    halstead_skip: bool,
    c_rules: &LangRules,
    h_rules: Option<&HalsteadRules>,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    operators: &mut HashMap<String, u32>,
    operands: &mut HashMap<String, u32>,
) {
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_all(
                &child,
                source,
                nesting_level,
                is_top_function,
                halstead_skip,
                c_rules,
                h_rules,
                cognitive,
                cyclomatic,
                max_nesting,
                operators,
                operands,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn walk_all(
    node: &Node,
    source: &[u8],
    nesting_level: u32,
    is_top_function: bool,
    halstead_skip: bool,
    c_rules: &LangRules,
    h_rules: Option<&HalsteadRules>,
    cognitive: &mut u32,
    cyclomatic: &mut u32,
    max_nesting: &mut u32,
    operators: &mut HashMap<String, u32>,
    operands: &mut HashMap<String, u32>,
) {
    let kind = node.kind();

    // ── Halstead classification ──
    let skip_h = halstead_skip
        || h_rules.map_or(false, |hr| hr.skip_types.contains(&kind));

    if let Some(hr) = h_rules {
        if !skip_h {
            // Compound operators (non-leaf): count node type as operator
            if hr.compound_operators.contains(&kind) {
                *operators.entry(kind.to_string()).or_insert(0) += 1;
            }
            // Leaf nodes: classify as operator or operand
            if node.child_count() == 0 {
                if hr.operator_leaf_types.contains(&kind) {
                    *operators.entry(kind.to_string()).or_insert(0) += 1;
                } else if hr.operand_leaf_types.contains(&kind) {
                    let start = node.start_byte();
                    let end = node.end_byte().min(source.len());
                    let text = String::from_utf8_lossy(&source[start..end]).to_string();
                    *operands.entry(text).or_insert(0) += 1;
                }
            }
        }
    }

    // ── Complexity: track nesting depth ──
    if nesting_level > *max_nesting {
        *max_nesting = nesting_level;
    }

    // Handle logical operators in binary expressions
    if kind == c_rules.logical_node_type {
        if let Some(op_node) = node.child(1) {
            let op = op_node.kind();
            if c_rules.is_logical_op(op) {
                *cyclomatic += 1;

                let mut same_sequence = false;
                if let Some(parent) = node.parent() {
                    if parent.kind() == c_rules.logical_node_type {
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

                walk_all_children(
                    node, source, nesting_level, false, skip_h,
                    c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
                );
                return;
            }
        }
    }

    // Handle optional chaining (cyclomatic only)
    if let Some(opt_type) = c_rules.optional_chain_type {
        if kind == opt_type {
            *cyclomatic += 1;
        }
    }

    // Handle branch/control flow nodes (skip keyword leaf tokens — childCount > 0 guard)
    if c_rules.is_branch(kind) && node.child_count() > 0 {
        // Pattern A: else clause wraps if (JS/C#/Rust)
        if let Some(else_type) = c_rules.else_node_type {
            if kind == else_type {
                let first_child = node.named_child(0);
                if first_child.map_or(false, |c| {
                    c_rules.if_node_type.map_or(false, |if_t| c.kind() == if_t)
                }) {
                    walk_all_children(
                        node, source, nesting_level, false, skip_h,
                        c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
                    );
                    return;
                }
                *cognitive += 1;
                walk_all_children(
                    node, source, nesting_level, false, skip_h,
                    c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
                );
                return;
            }
        }

        // Pattern B: explicit elif node (Python/Ruby/PHP)
        if let Some(elif_type) = c_rules.elif_node_type {
            if kind == elif_type {
                *cognitive += 1;
                *cyclomatic += 1;
                walk_all_children(
                    node, source, nesting_level, false, skip_h,
                    c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
                );
                return;
            }
        }

        // Detect else-if via Pattern A or C
        let mut is_else_if = false;
        if c_rules.if_node_type.map_or(false, |if_t| kind == if_t) {
            if c_rules.else_via_alternative {
                if let Some(parent) = node.parent() {
                    if c_rules.if_node_type.map_or(false, |if_t| parent.kind() == if_t) {
                        if let Some(alt) = parent.child_by_field_name("alternative") {
                            if alt.id() == node.id() {
                                is_else_if = true;
                            }
                        }
                    }
                }
            } else if c_rules.else_node_type.is_some() {
                if let Some(parent) = node.parent() {
                    if c_rules.else_node_type.map_or(false, |else_t| parent.kind() == else_t) {
                        is_else_if = true;
                    }
                }
            }
        }

        if is_else_if {
            *cognitive += 1;
            *cyclomatic += 1;
            walk_all_children(
                node, source, nesting_level, false, skip_h,
                c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
            );
            return;
        }

        // Regular branch node
        *cognitive += 1 + nesting_level;
        *cyclomatic += 1;

        if c_rules.is_switch_like(kind) {
            *cyclomatic -= 1;
        }

        if c_rules.is_nesting(kind) {
            walk_all_children(
                node, source, nesting_level + 1, false, skip_h,
                c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
            );
            return;
        }
    }

    // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
    if c_rules.else_via_alternative {
        if c_rules.if_node_type.map_or(false, |if_t| kind != if_t) {
            if let Some(parent) = node.parent() {
                if c_rules.if_node_type.map_or(false, |if_t| parent.kind() == if_t) {
                    if let Some(alt) = parent.child_by_field_name("alternative") {
                        if alt.id() == node.id() {
                            *cognitive += 1;
                            walk_all_children(
                                node, source, nesting_level, false, skip_h,
                                c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
                            );
                            return;
                        }
                    }
                }
            }
        }
    }

    // Handle case nodes (cyclomatic only, skip keyword leaves)
    if c_rules.is_case(kind) && node.child_count() > 0 {
        *cyclomatic += 1;
    }

    // Handle nested function definitions (increase nesting)
    if !is_top_function && c_rules.is_function(kind) {
        walk_all_children(
            node, source, nesting_level + 1, false, skip_h,
            c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
        );
        return;
    }

    // Walk children
    walk_all_children(
        node, source, nesting_level, false, skip_h,
        c_rules, h_rules, cognitive, cyclomatic, max_nesting, operators, operands,
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
