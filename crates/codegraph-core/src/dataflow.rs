use std::collections::HashMap;
use tree_sitter::{Node, Tree};

use crate::types::{
    DataflowArgFlow, DataflowAssignment, DataflowMutation, DataflowParam, DataflowResult,
    DataflowReturn,
};

// ─── Param Strategy ──────────────────────────────────────────────────────

/// Per-language parameter extraction strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParamStrategy {
    Default,
    Python,
    Go,
    Rust,
    Java,
    CSharp,
    Php,
    Ruby,
}

// ─── DataflowRules ──────────────────────────────────────────────────────

/// Per-language AST node type names and field names for dataflow extraction.
/// Mirrors `DATAFLOW_DEFAULTS` + per-language overrides in `src/dataflow.js`.
pub struct DataflowRules {
    // Scope entry
    function_nodes: &'static [&'static str],

    // Function name extraction
    name_field: &'static str,
    var_assigned_fn_parent: Option<&'static str>,
    assignment_fn_parent: Option<&'static str>,
    pair_fn_parent: Option<&'static str>,

    // Parameters
    param_list_field: &'static str,
    param_identifier: &'static str,
    param_wrapper_types: &'static [&'static str],
    default_param_type: Option<&'static str>,
    rest_param_type: Option<&'static str>,
    object_destruct_type: Option<&'static str>,
    array_destruct_type: Option<&'static str>,
    shorthand_prop_pattern: Option<&'static str>,
    pair_pattern_type: Option<&'static str>,
    extract_param_strategy: ParamStrategy,

    // Return
    return_node: Option<&'static str>,

    // Variable declarations
    var_declarator_node: Option<&'static str>,
    var_declarator_nodes: &'static [&'static str],
    var_name_field: &'static str,
    var_value_field: Option<&'static str>,
    assignment_node: Option<&'static str>,
    assign_left_field: &'static str,
    assign_right_field: &'static str,

    // Calls
    call_node: Option<&'static str>,
    call_nodes: &'static [&'static str],
    call_function_field: &'static str,
    call_args_field: &'static str,
    spread_type: Option<&'static str>,

    // Member access
    member_node: Option<&'static str>,
    member_object_field: &'static str,
    member_property_field: &'static str,
    optional_chain_node: Option<&'static str>,

    // Await
    await_node: Option<&'static str>,

    // Mutation
    mutating_methods: &'static [&'static str],
    expression_stmt_node: &'static str,
    call_object_field: Option<&'static str>,

    // Structural wrappers
    expression_list_type: Option<&'static str>,
    equals_clause_type: Option<&'static str>,
    argument_wrapper_type: Option<&'static str>,
    extra_identifier_types: &'static [&'static str],
}

// ─── Per-Language Configs ────────────────────────────────────────────────

static JS_TS_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &[
        "function_declaration",
        "method_definition",
        "arrow_function",
        "function_expression",
        "function",
    ],
    name_field: "name",
    var_assigned_fn_parent: Some("variable_declarator"),
    assignment_fn_parent: Some("assignment_expression"),
    pair_fn_parent: Some("pair"),
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &["required_parameter", "optional_parameter"],
    default_param_type: Some("assignment_pattern"),
    rest_param_type: Some("rest_pattern"),
    object_destruct_type: Some("object_pattern"),
    array_destruct_type: Some("array_pattern"),
    shorthand_prop_pattern: Some("shorthand_property_identifier_pattern"),
    pair_pattern_type: Some("pair_pattern"),
    extract_param_strategy: ParamStrategy::Default,
    return_node: Some("return_statement"),
    var_declarator_node: Some("variable_declarator"),
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: Some("value"),
    assignment_node: Some("assignment_expression"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("call_expression"),
    call_nodes: &[],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: Some("spread_element"),
    member_node: Some("member_expression"),
    member_object_field: "object",
    member_property_field: "property",
    optional_chain_node: Some("optional_chain_expression"),
    await_node: Some("await_expression"),
    mutating_methods: &[
        "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "set", "delete",
        "add", "clear",
    ],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: None,
    extra_identifier_types: &[],
};

static PYTHON_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &["function_definition", "lambda"],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: Some("default_parameter"),
    rest_param_type: Some("list_splat_pattern"),
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Python,
    return_node: Some("return_statement"),
    var_declarator_node: None,
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: Some("value"),
    assignment_node: Some("assignment"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("call"),
    call_nodes: &[],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: Some("list_splat"),
    member_node: Some("attribute"),
    member_object_field: "object",
    member_property_field: "attribute",
    optional_chain_node: None,
    await_node: Some("await"),
    mutating_methods: &[
        "append", "extend", "insert", "pop", "remove", "clear", "sort", "reverse", "add",
        "discard", "update",
    ],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: None,
    extra_identifier_types: &[],
};

static GO_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &["function_declaration", "method_declaration", "func_literal"],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Go,
    return_node: Some("return_statement"),
    var_declarator_node: None,
    var_declarator_nodes: &["short_var_declaration", "var_declaration"],
    var_name_field: "left",
    var_value_field: Some("right"),
    assignment_node: Some("assignment_statement"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("call_expression"),
    call_nodes: &[],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: None,
    member_node: Some("selector_expression"),
    member_object_field: "operand",
    member_property_field: "field",
    optional_chain_node: None,
    await_node: None,
    mutating_methods: &[],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: Some("expression_list"),
    equals_clause_type: None,
    argument_wrapper_type: None,
    extra_identifier_types: &[],
};

static RUST_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &["function_item", "closure_expression"],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Rust,
    return_node: Some("return_expression"),
    var_declarator_node: Some("let_declaration"),
    var_declarator_nodes: &[],
    var_name_field: "pattern",
    var_value_field: Some("value"),
    assignment_node: Some("assignment_expression"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("call_expression"),
    call_nodes: &[],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: None,
    member_node: Some("field_expression"),
    member_object_field: "value",
    member_property_field: "field",
    optional_chain_node: None,
    await_node: Some("await_expression"),
    mutating_methods: &["push", "pop", "insert", "remove", "clear", "sort", "reverse"],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: None,
    extra_identifier_types: &[],
};

static JAVA_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
    ],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Java,
    return_node: Some("return_statement"),
    var_declarator_node: Some("variable_declarator"),
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: Some("value"),
    assignment_node: Some("assignment_expression"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: None,
    call_nodes: &["method_invocation", "object_creation_expression"],
    call_function_field: "name",
    call_args_field: "arguments",
    spread_type: None,
    member_node: Some("field_access"),
    member_object_field: "object",
    member_property_field: "field",
    optional_chain_node: None,
    await_node: None,
    mutating_methods: &["add", "remove", "clear", "put", "set", "push", "pop", "sort"],
    expression_stmt_node: "expression_statement",
    call_object_field: Some("object"),
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: Some("argument"),
    extra_identifier_types: &[],
};

static CSHARP_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &[
        "method_declaration",
        "constructor_declaration",
        "lambda_expression",
        "local_function_statement",
    ],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::CSharp,
    return_node: Some("return_statement"),
    var_declarator_node: Some("variable_declarator"),
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: None,
    assignment_node: Some("assignment_expression"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("invocation_expression"),
    call_nodes: &[],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: None,
    member_node: Some("member_access_expression"),
    member_object_field: "expression",
    member_property_field: "name",
    optional_chain_node: None,
    await_node: Some("await_expression"),
    mutating_methods: &["Add", "Remove", "Clear", "Insert", "Sort", "Reverse", "Push", "Pop"],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: Some("equals_value_clause"),
    argument_wrapper_type: Some("argument"),
    extra_identifier_types: &[],
};

static PHP_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &[
        "function_definition",
        "method_declaration",
        "anonymous_function_creation_expression",
        "arrow_function",
    ],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "variable_name",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Php,
    return_node: Some("return_statement"),
    var_declarator_node: None,
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: Some("value"),
    assignment_node: Some("assignment_expression"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: None,
    call_nodes: &[
        "function_call_expression",
        "member_call_expression",
        "scoped_call_expression",
    ],
    call_function_field: "function",
    call_args_field: "arguments",
    spread_type: Some("spread_expression"),
    member_node: Some("member_access_expression"),
    member_object_field: "object",
    member_property_field: "name",
    optional_chain_node: None,
    await_node: None,
    mutating_methods: &["push", "pop", "shift", "unshift", "splice", "sort", "reverse"],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: Some("argument"),
    extra_identifier_types: &["variable_name", "name"],
};

static RUBY_DATAFLOW: DataflowRules = DataflowRules {
    function_nodes: &["method", "singleton_method", "lambda"],
    name_field: "name",
    var_assigned_fn_parent: None,
    assignment_fn_parent: None,
    pair_fn_parent: None,
    param_list_field: "parameters",
    param_identifier: "identifier",
    param_wrapper_types: &[],
    default_param_type: None,
    rest_param_type: None,
    object_destruct_type: None,
    array_destruct_type: None,
    shorthand_prop_pattern: None,
    pair_pattern_type: None,
    extract_param_strategy: ParamStrategy::Ruby,
    return_node: Some("return"),
    var_declarator_node: None,
    var_declarator_nodes: &[],
    var_name_field: "name",
    var_value_field: Some("value"),
    assignment_node: Some("assignment"),
    assign_left_field: "left",
    assign_right_field: "right",
    call_node: Some("call"),
    call_nodes: &[],
    call_function_field: "method",
    call_args_field: "arguments",
    spread_type: Some("splat_parameter"),
    member_node: Some("call"),
    member_object_field: "receiver",
    member_property_field: "method",
    optional_chain_node: None,
    await_node: None,
    mutating_methods: &[
        "push", "pop", "shift", "unshift", "delete", "clear", "sort!", "reverse!", "map!",
        "select!", "reject!", "compact!", "flatten!", "concat", "replace", "insert",
    ],
    expression_stmt_node: "expression_statement",
    call_object_field: None,
    expression_list_type: None,
    equals_clause_type: None,
    argument_wrapper_type: None,
    extra_identifier_types: &[],
};

/// Get dataflow rules for a language ID string.
fn get_dataflow_rules(lang_id: &str) -> Option<&'static DataflowRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_DATAFLOW),
        "python" => Some(&PYTHON_DATAFLOW),
        "go" => Some(&GO_DATAFLOW),
        "rust" => Some(&RUST_DATAFLOW),
        "java" => Some(&JAVA_DATAFLOW),
        "csharp" => Some(&CSHARP_DATAFLOW),
        "php" => Some(&PHP_DATAFLOW),
        "ruby" => Some(&RUBY_DATAFLOW),
        _ => None,
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

fn is_call_node(rules: &DataflowRules, kind: &str) -> bool {
    if !rules.call_nodes.is_empty() {
        rules.call_nodes.contains(&kind)
    } else {
        rules.call_node.is_some_and(|cn| cn == kind)
    }
}

fn is_function_node(rules: &DataflowRules, kind: &str) -> bool {
    rules.function_nodes.contains(&kind)
}

fn is_ident(rules: &DataflowRules, kind: &str) -> bool {
    kind == "identifier"
        || kind == rules.param_identifier
        || rules.extra_identifier_types.contains(&kind)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut result = String::with_capacity(max + 3);
        // Take at most `max` bytes, but don't split a char
        for ch in s.chars() {
            if result.len() + ch.len_utf8() > max {
                break;
            }
            result.push(ch);
        }
        result.push('…');
        result
    }
}

fn node_text<'a>(node: &Node, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn node_line(node: &Node) -> u32 {
    node.start_position().row as u32 + 1
}

/// Extract function name from a function AST node.
fn function_name<'a>(fn_node: &Node<'a>, rules: &DataflowRules, source: &[u8]) -> Option<String> {
    // Try the standard name field
    if let Some(name_node) = fn_node.child_by_field_name(rules.name_field) {
        return Some(node_text(&name_node, source).to_string());
    }

    // JS-specific: arrow_function/function_expression assigned to variable, pair, or assignment
    if let Some(parent) = fn_node.parent() {
        let pt = parent.kind();
        if rules.var_assigned_fn_parent.is_some_and(|v| v == pt) {
            let n = parent.child_by_field_name("name");
            return n.map(|n| node_text(&n, source).to_string());
        }
        if rules.pair_fn_parent.is_some_and(|v| v == pt) {
            let key = parent.child_by_field_name("key");
            return key.map(|k| node_text(&k, source).to_string());
        }
        if rules.assignment_fn_parent.is_some_and(|v| v == pt) {
            let left = parent.child_by_field_name(rules.assign_left_field);
            return left.map(|l| node_text(&l, source).to_string());
        }
    }
    None
}

/// Extract parameter names using per-language strategy.
fn extract_param_names_strategy(node: &Node, strategy: ParamStrategy, source: &[u8]) -> Option<Vec<String>> {
    match strategy {
        ParamStrategy::Default => None,
        ParamStrategy::Python => {
            let t = node.kind();
            if t == "typed_parameter" || t == "typed_default_parameter" {
                let cursor = &mut node.walk();
                for c in node.named_children(cursor) {
                    if c.kind() == "identifier" {
                        return Some(vec![node_text(&c, source).to_string()]);
                    }
                }
                return Some(vec![]);
            }
            if t == "default_parameter" {
                if let Some(name_node) = node.child_by_field_name("name") {
                    return Some(vec![node_text(&name_node, source).to_string()]);
                }
                return Some(vec![]);
            }
            if t == "list_splat_pattern" || t == "dictionary_splat_pattern" {
                let cursor = &mut node.walk();
                for c in node.named_children(cursor) {
                    if c.kind() == "identifier" {
                        return Some(vec![node_text(&c, source).to_string()]);
                    }
                }
                return Some(vec![]);
            }
            None
        }
        ParamStrategy::Go => {
            let t = node.kind();
            if t == "parameter_declaration" {
                let mut names = Vec::new();
                let cursor = &mut node.walk();
                for c in node.named_children(cursor) {
                    if c.kind() == "identifier" {
                        names.push(node_text(&c, source).to_string());
                    }
                }
                if !names.is_empty() { Some(names) } else { None }
            } else if t == "variadic_parameter_declaration" {
                node.child_by_field_name("name")
                    .map(|n| vec![node_text(&n, source).to_string()])
            } else {
                None
            }
        }
        ParamStrategy::Rust => {
            let t = node.kind();
            if t == "parameter" {
                if let Some(pat) = node.child_by_field_name("pattern") {
                    if pat.kind() == "identifier" {
                        return Some(vec![node_text(&pat, source).to_string()]);
                    }
                }
                return Some(vec![]);
            }
            if t == "identifier" {
                return Some(vec![node_text(node, source).to_string()]);
            }
            None
        }
        ParamStrategy::Java => {
            let t = node.kind();
            if t == "formal_parameter" || t == "spread_parameter" {
                if let Some(name_node) = node.child_by_field_name("name") {
                    return Some(vec![node_text(&name_node, source).to_string()]);
                }
                return Some(vec![]);
            }
            if t == "identifier" {
                return Some(vec![node_text(node, source).to_string()]);
            }
            None
        }
        ParamStrategy::CSharp => {
            let t = node.kind();
            if t == "parameter" {
                if let Some(name_node) = node.child_by_field_name("name") {
                    return Some(vec![node_text(&name_node, source).to_string()]);
                }
                return Some(vec![]);
            }
            if t == "identifier" {
                return Some(vec![node_text(node, source).to_string()]);
            }
            None
        }
        ParamStrategy::Php => {
            let t = node.kind();
            if t == "simple_parameter" || t == "variadic_parameter" {
                if let Some(name_node) = node.child_by_field_name("name") {
                    return Some(vec![node_text(&name_node, source).to_string()]);
                }
                return Some(vec![]);
            }
            if t == "variable_name" {
                return Some(vec![node_text(node, source).to_string()]);
            }
            None
        }
        ParamStrategy::Ruby => {
            let t = node.kind();
            if t == "identifier" {
                return Some(vec![node_text(node, source).to_string()]);
            }
            if t == "optional_parameter"
                || t == "keyword_parameter"
                || t == "splat_parameter"
                || t == "hash_splat_parameter"
            {
                if let Some(name_node) = node.child_by_field_name("name") {
                    return Some(vec![node_text(&name_node, source).to_string()]);
                }
                return Some(vec![]);
            }
            None
        }
    }
}

/// Extract parameter names from a node, using rules and strategy.
fn extract_param_names(node: &Node, rules: &DataflowRules, source: &[u8]) -> Vec<String> {
    let t = node.kind();

    // Language-specific override
    if let Some(names) = extract_param_names_strategy(node, rules.extract_param_strategy, source) {
        return names;
    }

    // Leaf identifier
    if t == rules.param_identifier {
        return vec![node_text(node, source).to_string()];
    }

    // Wrapper types (TS required_parameter, etc.)
    if rules.param_wrapper_types.contains(&t) {
        let pattern = node
            .child_by_field_name("pattern")
            .or_else(|| node.child_by_field_name("name"));
        return pattern
            .map(|p| extract_param_names(&p, rules, source))
            .unwrap_or_default();
    }

    // Default parameter
    if rules.default_param_type.is_some_and(|d| d == t) {
        let left = node
            .child_by_field_name("left")
            .or_else(|| node.child_by_field_name("name"));
        return left
            .map(|l| extract_param_names(&l, rules, source))
            .unwrap_or_default();
    }

    // Rest / splat parameter
    if rules.rest_param_type.is_some_and(|r| r == t) {
        if let Some(name_node) = node.child_by_field_name("name") {
            return vec![node_text(&name_node, source).to_string()];
        }
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            if child.kind() == rules.param_identifier {
                return vec![node_text(&child, source).to_string()];
            }
        }
        return vec![];
    }

    // Object destructuring (JS only)
    if rules.object_destruct_type.is_some_and(|o| o == t) {
        let mut names = Vec::new();
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            let ck = child.kind();
            if rules.shorthand_prop_pattern.is_some_and(|s| s == ck) {
                names.push(node_text(&child, source).to_string());
            } else if rules.pair_pattern_type.is_some_and(|p| p == ck) {
                if let Some(value) = child.child_by_field_name("value") {
                    names.extend(extract_param_names(&value, rules, source));
                }
            } else if rules.rest_param_type.is_some_and(|r| r == ck) {
                names.extend(extract_param_names(&child, rules, source));
            }
        }
        return names;
    }

    // Array destructuring (JS only)
    if rules.array_destruct_type.is_some_and(|a| a == t) {
        let mut names = Vec::new();
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            names.extend(extract_param_names(&child, rules, source));
        }
        return names;
    }

    vec![]
}

/// Extract parameters: name + index pairs from formal_parameters node.
fn extract_params(params_node: &Node, rules: &DataflowRules, source: &[u8]) -> Vec<(String, u32)> {
    let mut result = Vec::new();
    let mut index: u32 = 0;
    let cursor = &mut params_node.walk();
    for child in params_node.named_children(cursor) {
        let names = extract_param_names(&child, rules, source);
        for name in names {
            result.push((name, index));
        }
        index += 1;
    }
    result
}

/// Resolve the callee name from a call expression node.
fn resolve_callee_name(call_node: &Node, rules: &DataflowRules, source: &[u8]) -> Option<String> {
    let fn_node = call_node.child_by_field_name(rules.call_function_field);
    match fn_node {
        Some(f) => {
            if is_ident(rules, f.kind()) {
                return Some(node_text(&f, source).to_string());
            }
            if rules.member_node.is_some_and(|m| m == f.kind()) {
                let prop = f.child_by_field_name(rules.member_property_field);
                return prop.map(|p| node_text(&p, source).to_string());
            }
            if rules.optional_chain_node.is_some_and(|o| o == f.kind()) {
                if let Some(target) = f.named_child(0) {
                    if rules.member_node.is_some_and(|m| m == target.kind()) {
                        let prop = target.child_by_field_name(rules.member_property_field);
                        return prop.map(|p| node_text(&p, source).to_string());
                    }
                    if target.kind() == "identifier" {
                        return Some(node_text(&target, source).to_string());
                    }
                }
                let prop = f.child_by_field_name(rules.member_property_field);
                return prop.map(|p| node_text(&p, source).to_string());
            }
            None
        }
        None => {
            // Some languages (Java method_invocation, Ruby call) use 'name'/'method' directly
            let name_node = call_node
                .child_by_field_name("name")
                .or_else(|| call_node.child_by_field_name("method"));
            name_node.map(|n| node_text(&n, source).to_string())
        }
    }
}

/// Get the receiver (object) of a member expression.
fn member_receiver(member_expr: &Node, rules: &DataflowRules, source: &[u8]) -> Option<String> {
    let obj = member_expr.child_by_field_name(rules.member_object_field)?;
    if is_ident(rules, obj.kind()) {
        return Some(node_text(&obj, source).to_string());
    }
    if rules.member_node.is_some_and(|m| m == obj.kind()) {
        return member_receiver(&obj, rules, source);
    }
    None
}

/// Collect all identifier names referenced within a node.
fn collect_identifiers(node: &Node, out: &mut Vec<String>, rules: &DataflowRules, source: &[u8]) {
    if is_ident(rules, node.kind()) {
        out.push(node_text(node, source).to_string());
        return;
    }
    let cursor = &mut node.walk();
    for child in node.named_children(cursor) {
        collect_identifiers(&child, out, rules, source);
    }
}

// ─── Scope Tracking ──────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum LocalSource {
    CallReturn { callee: String },
    Destructured { callee: String },
}

struct ScopeFrame {
    func_name: Option<String>,
    params: HashMap<String, u32>,
    locals: HashMap<String, LocalSource>,
}

/// Binding info returned by find_binding.
struct BindingInfo {
    binding_type: String,
    confidence: f64,
}

fn find_binding(scope_stack: &[ScopeFrame], name: &str) -> Option<BindingInfo> {
    for scope in scope_stack.iter().rev() {
        if scope.params.contains_key(name) {
            return Some(BindingInfo {
                binding_type: "param".to_string(),
                confidence: 1.0,
            });
        }
        if let Some(local) = scope.locals.get(name) {
            let confidence = match local {
                LocalSource::CallReturn { .. } => 0.9,
                LocalSource::Destructured { .. } => 0.8,
            };
            return Some(BindingInfo {
                binding_type: "local".to_string(),
                confidence,
            });
        }
    }
    None
}

fn binding_confidence(binding: &Option<BindingInfo>) -> f64 {
    match binding {
        Some(b) => b.confidence,
        None => 0.5,
    }
}

// ─── Core: extract_dataflow ──────────────────────────────────────────────

/// Extract dataflow information from a parsed AST tree.
/// Returns None if the language has no dataflow rules (e.g., HCL).
pub fn extract_dataflow(tree: &Tree, source: &[u8], lang_id: &str) -> Option<DataflowResult> {
    let rules = get_dataflow_rules(lang_id)?;

    let mut parameters = Vec::new();
    let mut returns = Vec::new();
    let mut assignments = Vec::new();
    let mut arg_flows = Vec::new();
    let mut mutations = Vec::new();

    let mut scope_stack: Vec<ScopeFrame> = Vec::new();

    visit(
        &tree.root_node(),
        rules,
        source,
        &mut scope_stack,
        &mut parameters,
        &mut returns,
        &mut assignments,
        &mut arg_flows,
        &mut mutations,
    );

    Some(DataflowResult {
        parameters,
        returns,
        assignments,
        arg_flows,
        mutations,
    })
}

#[allow(clippy::too_many_arguments)]
fn visit(
    node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &mut Vec<ScopeFrame>,
    parameters: &mut Vec<DataflowParam>,
    returns: &mut Vec<DataflowReturn>,
    assignments: &mut Vec<DataflowAssignment>,
    arg_flows: &mut Vec<DataflowArgFlow>,
    mutations: &mut Vec<DataflowMutation>,
) {
    let t = node.kind();

    // Enter function scope
    if is_function_node(rules, t) {
        enter_scope(node, rules, source, scope_stack, parameters);
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        scope_stack.pop();
        return;
    }

    // Return statements
    if rules.return_node.is_some_and(|r| r == t) {
        if let Some(scope) = scope_stack.last() {
            if let Some(ref func_name) = scope.func_name {
                let expr = node.named_child(0);
                let mut referenced_names = Vec::new();
                if let Some(ref e) = expr {
                    collect_identifiers(e, &mut referenced_names, rules, source);
                }
                returns.push(DataflowReturn {
                    func_name: func_name.clone(),
                    expression: truncate(
                        expr.map(|e| node_text(&e, source)).unwrap_or(""),
                        120,
                    ),
                    referenced_names,
                    line: node_line(node),
                });
            }
        }
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        return;
    }

    // Variable declarations (single type)
    if rules.var_declarator_node.is_some_and(|v| v == t) {
        handle_var_declarator(node, rules, source, scope_stack, assignments);
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        return;
    }

    // Variable declarations (multi-type, e.g., Go)
    if !rules.var_declarator_nodes.is_empty() && rules.var_declarator_nodes.contains(&t) {
        handle_var_declarator(node, rules, source, scope_stack, assignments);
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        return;
    }

    // Call expressions
    if is_call_node(rules, t) {
        handle_call_expr(node, rules, source, scope_stack, arg_flows);
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        return;
    }

    // Assignment expressions
    if rules.assignment_node.is_some_and(|a| a == t) {
        handle_assignment(node, rules, source, scope_stack, assignments, mutations);
        let cursor = &mut node.walk();
        for child in node.named_children(cursor) {
            visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
        }
        return;
    }

    // Mutation detection via expression_statement
    if t == rules.expression_stmt_node {
        handle_expr_stmt_mutation(node, rules, source, scope_stack, mutations);
    }

    // Default: visit children
    let cursor = &mut node.walk();
    for child in node.named_children(cursor) {
        visit(&child, rules, source, scope_stack, parameters, returns, assignments, arg_flows, mutations);
    }
}

fn enter_scope(
    fn_node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &mut Vec<ScopeFrame>,
    parameters: &mut Vec<DataflowParam>,
) {
    let name = function_name(fn_node, rules, source);
    let params_node = fn_node.child_by_field_name(rules.param_list_field);
    let param_list = params_node
        .as_ref()
        .map(|pn| extract_params(pn, rules, source))
        .unwrap_or_default();

    let mut param_map = HashMap::new();
    for (pname, pidx) in &param_list {
        param_map.insert(pname.clone(), *pidx);
        if let Some(ref fn_name) = name {
            let line = params_node
                .as_ref()
                .map(|pn| node_line(pn))
                .unwrap_or_else(|| node_line(fn_node));
            parameters.push(DataflowParam {
                func_name: fn_name.clone(),
                param_name: pname.clone(),
                param_index: *pidx,
                line,
            });
        }
    }

    scope_stack.push(ScopeFrame {
        func_name: name,
        params: param_map,
        locals: HashMap::new(),
    });
}

/// Unwrap await if present, returning the inner expression.
fn unwrap_await<'a>(node: &Node<'a>, rules: &DataflowRules) -> Node<'a> {
    if rules.await_node.is_some_and(|a| a == node.kind()) {
        if let Some(inner) = node.named_child(0) {
            return inner;
        }
    }
    *node
}

fn handle_var_declarator(
    node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &mut Vec<ScopeFrame>,
    assignments: &mut Vec<DataflowAssignment>,
) {
    let mut name_node = node.child_by_field_name(rules.var_name_field);
    let mut value_node = rules.var_value_field.and_then(|f| node.child_by_field_name(f));

    // C#: initializer is inside equals_value_clause child
    if value_node.is_none() {
        if let Some(eq_type) = rules.equals_clause_type {
            let cursor = &mut node.walk();
            for child in node.named_children(cursor) {
                if child.kind() == eq_type {
                    value_node = child
                        .child_by_field_name("value")
                        .or_else(|| child.named_child(0));
                    break;
                }
            }
        }
    }

    // Fallback: initializer is a direct unnamed child (C# variable_declarator)
    if value_node.is_none() {
        if let Some(ref nn) = name_node {
            let cursor = &mut node.walk();
            for child in node.named_children(cursor) {
                if child.id() != nn.id() {
                    let uw = unwrap_await(&child, rules);
                    if is_call_node(rules, uw.kind()) {
                        value_node = Some(child);
                        break;
                    }
                }
            }
        }
    }

    // Go: expression_list wraps LHS/RHS — unwrap to first named child
    if let Some(el_type) = rules.expression_list_type {
        if name_node.as_ref().is_some_and(|n| n.kind() == el_type) {
            name_node = name_node.and_then(|n| n.named_child(0));
        }
        if value_node.as_ref().is_some_and(|v| v.kind() == el_type) {
            value_node = value_node.and_then(|v| v.named_child(0));
        }
    }

    let scope = match scope_stack.last_mut() {
        Some(s) => s,
        None => return,
    };
    let name_n = match name_node {
        Some(n) => n,
        None => return,
    };
    let value_n = match value_node {
        Some(v) => v,
        None => return,
    };

    let unwrapped = unwrap_await(&value_n, rules);
    if !is_call_node(rules, unwrapped.kind()) {
        return;
    }

    let callee = match resolve_callee_name(&unwrapped, rules, source) {
        Some(c) => c,
        None => return,
    };
    let func_name = match &scope.func_name {
        Some(f) => f.clone(),
        None => return,
    };

    // Destructuring: const { a, b } = foo()
    let is_obj_destruct = rules.object_destruct_type.is_some_and(|o| o == name_n.kind());
    let is_arr_destruct = rules.array_destruct_type.is_some_and(|a| a == name_n.kind());

    if is_obj_destruct || is_arr_destruct {
        let names = extract_param_names(&name_n, rules, source);
        for n in &names {
            assignments.push(DataflowAssignment {
                var_name: n.clone(),
                caller_func: Some(func_name.clone()),
                source_call_name: callee.clone(),
                expression: truncate(node_text(node, source), 120),
                line: node_line(node),
            });
            scope
                .locals
                .insert(n.clone(), LocalSource::Destructured { callee: callee.clone() });
        }
    } else {
        let var_name = node_text(&name_n, source).to_string();
        assignments.push(DataflowAssignment {
            var_name: var_name.clone(),
            caller_func: Some(func_name),
            source_call_name: callee.clone(),
            expression: truncate(node_text(node, source), 120),
            line: node_line(node),
        });
        scope.locals.insert(var_name, LocalSource::CallReturn { callee });
    }
}

fn handle_assignment(
    node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &mut Vec<ScopeFrame>,
    assignments: &mut Vec<DataflowAssignment>,
    mutations: &mut Vec<DataflowMutation>,
) {
    let left = node.child_by_field_name(rules.assign_left_field);
    let right = node.child_by_field_name(rules.assign_right_field);

    let func_name = match scope_stack.last() {
        Some(s) => match &s.func_name {
            Some(f) => f.clone(),
            None => return,
        },
        None => return,
    };

    // Mutation: obj.prop = value
    if let Some(ref left_n) = left {
        if rules.member_node.is_some_and(|m| m == left_n.kind()) {
            if let Some(receiver) = member_receiver(left_n, rules, source) {
                let binding = find_binding(scope_stack, &receiver);
                if binding.is_some() {
                    mutations.push(DataflowMutation {
                        func_name: Some(func_name.clone()),
                        receiver_name: receiver,
                        binding_type: binding.as_ref().map(|b| b.binding_type.clone()),
                        mutating_expr: truncate(node_text(node, source), 120),
                        line: node_line(node),
                    });
                }
            }
        }
    }

    // Non-declaration assignment: x = foo()
    if let (Some(left_n), Some(right_n)) = (left, right) {
        if is_ident(rules, left_n.kind()) {
            let unwrapped = unwrap_await(&right_n, rules);
            if is_call_node(rules, unwrapped.kind()) {
                if let Some(callee) = resolve_callee_name(&unwrapped, rules, source) {
                    let var_name = node_text(&left_n, source).to_string();
                    assignments.push(DataflowAssignment {
                        var_name: var_name.clone(),
                        caller_func: Some(func_name),
                        source_call_name: callee.clone(),
                        expression: truncate(node_text(node, source), 120),
                        line: node_line(node),
                    });
                    if let Some(scope) = scope_stack.last_mut() {
                        scope.locals.insert(var_name, LocalSource::CallReturn { callee });
                    }
                }
            }
        }
    }
}

fn handle_call_expr(
    node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &[ScopeFrame],
    arg_flows: &mut Vec<DataflowArgFlow>,
) {
    let callee = match resolve_callee_name(node, rules, source) {
        Some(c) => c,
        None => return,
    };
    let args_node = match node.child_by_field_name(rules.call_args_field) {
        Some(a) => a,
        None => return,
    };
    let func_name = match scope_stack.last() {
        Some(s) => match &s.func_name {
            Some(f) => f.clone(),
            None => return,
        },
        None => return,
    };

    let mut arg_index: u32 = 0;
    let cursor = &mut args_node.walk();
    for arg_raw in args_node.named_children(cursor) {
        // PHP/Java: unwrap argument wrapper
        let arg = if rules.argument_wrapper_type.is_some_and(|w| w == arg_raw.kind()) {
            arg_raw.named_child(0).unwrap_or(arg_raw)
        } else {
            arg_raw
        };

        let unwrapped = if rules.spread_type.is_some_and(|s| s == arg.kind()) {
            arg.named_child(0).unwrap_or(arg)
        } else {
            arg
        };

        let arg_name = if is_ident(rules, unwrapped.kind()) {
            Some(node_text(&unwrapped, source).to_string())
        } else {
            None
        };
        let arg_member = if arg_name.is_none()
            && rules.member_node.is_some_and(|m| m == unwrapped.kind())
        {
            member_receiver(&unwrapped, rules, source)
        } else {
            None
        };
        let tracked_name = arg_name.clone().or(arg_member);

        if let Some(ref tracked) = tracked_name {
            let binding = find_binding(scope_stack, tracked);
            if binding.is_some() {
                let conf = binding_confidence(&binding);
                arg_flows.push(DataflowArgFlow {
                    caller_func: Some(func_name.clone()),
                    callee_name: callee.clone(),
                    arg_index,
                    arg_name: Some(tracked.clone()),
                    binding_type: binding.as_ref().map(|b| b.binding_type.clone()),
                    confidence: conf,
                    expression: truncate(node_text(&arg_raw, source), 120),
                    line: node_line(node),
                });
            }
        }
        arg_index += 1;
    }
}

fn handle_expr_stmt_mutation(
    node: &Node,
    rules: &DataflowRules,
    source: &[u8],
    scope_stack: &[ScopeFrame],
    mutations: &mut Vec<DataflowMutation>,
) {
    if rules.mutating_methods.is_empty() {
        return;
    }
    let expr = match node.named_child(0) {
        Some(e) => e,
        None => return,
    };
    if !is_call_node(rules, expr.kind()) {
        return;
    }

    let mut method_name: Option<String> = None;
    let mut receiver: Option<String> = None;

    // Standard pattern: call(fn: member(obj, prop))
    if let Some(fn_node) = expr.child_by_field_name(rules.call_function_field) {
        if rules.member_node.is_some_and(|m| m == fn_node.kind()) {
            if let Some(prop) = fn_node.child_by_field_name(rules.member_property_field) {
                method_name = Some(node_text(&prop, source).to_string());
            }
            receiver = member_receiver(&fn_node, rules, source);
        }
    }

    // Java/combined pattern: call node itself has object + name fields
    if receiver.is_none() {
        if let Some(obj_field) = rules.call_object_field {
            let obj = expr.child_by_field_name(obj_field);
            let name = expr.child_by_field_name(rules.call_function_field);
            if let (Some(obj_n), Some(name_n)) = (obj, name) {
                method_name = Some(node_text(&name_n, source).to_string());
                if is_ident(rules, obj_n.kind()) {
                    receiver = Some(node_text(&obj_n, source).to_string());
                }
            }
        }
    }

    let method = match method_name {
        Some(m) => m,
        None => return,
    };
    if !rules.mutating_methods.contains(&method.as_str()) {
        return;
    }

    let recv = match receiver {
        Some(r) => r,
        None => return,
    };
    let func_name = match scope_stack.last() {
        Some(s) => s.func_name.clone(),
        None => None,
    };
    if func_name.is_none() {
        return;
    }

    let binding = find_binding(scope_stack, &recv);
    if binding.is_some() {
        mutations.push(DataflowMutation {
            func_name,
            receiver_name: recv,
            binding_type: binding.as_ref().map(|b| b.binding_type.clone()),
            mutating_expr: truncate(node_text(&expr, source), 120),
            line: node_line(node),
        });
    }
}
