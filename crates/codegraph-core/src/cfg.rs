use tree_sitter::Node;
use crate::constants::MAX_WALK_DEPTH;
use crate::types::{CfgBlock, CfgData, CfgEdge};

// ─── CFG Rules ──────────────────────────────────────────────────────────

/// Per-language node type names for CFG construction.
pub struct CfgRules {
    pub if_node: Option<&'static str>,
    pub if_nodes: &'static [&'static str],
    pub elif_node: Option<&'static str>,
    pub else_clause: Option<&'static str>,
    pub else_via_alternative: bool,
    pub if_consequent_field: Option<&'static str>,
    pub for_nodes: &'static [&'static str],
    pub condition_field: Option<&'static str>,
    pub while_node: Option<&'static str>,
    pub while_nodes: &'static [&'static str],
    pub do_node: Option<&'static str>,
    pub infinite_loop_node: Option<&'static str>,
    pub unless_node: Option<&'static str>,
    pub until_node: Option<&'static str>,
    pub switch_node: Option<&'static str>,
    pub switch_nodes: &'static [&'static str],
    pub case_node: Option<&'static str>,
    pub case_nodes: &'static [&'static str],
    pub default_node: Option<&'static str>,
    pub wildcard_pattern_node: Option<&'static str>,
    pub try_node: Option<&'static str>,
    pub try_nodes: &'static [&'static str],
    pub catch_node: Option<&'static str>,
    pub finally_node: Option<&'static str>,
    pub else_node: Option<&'static str>,
    pub return_node: Option<&'static str>,
    pub throw_node: Option<&'static str>,
    pub break_node: Option<&'static str>,
    pub continue_node: Option<&'static str>,
    pub block_node: Option<&'static str>,
    pub block_nodes: &'static [&'static str],
    pub labeled_node: Option<&'static str>,
}

fn matches_opt(kind: &str, opt: Option<&str>) -> bool {
    opt.is_some_and(|s| s == kind)
}

fn matches_slice(kind: &str, slice: &[&str]) -> bool {
    slice.contains(&kind)
}

// ─── Per-Language Rules ─────────────────────────────────────────────────

pub static JS_TS_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: None,
    else_clause: Some("else_clause"),
    else_via_alternative: false,
    if_consequent_field: None,
    for_nodes: &["for_statement", "for_in_statement"],
    condition_field: Some("condition"),
    while_node: Some("while_statement"),
    while_nodes: &[],
    do_node: Some("do_statement"),
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: Some("switch_statement"),
    switch_nodes: &[],
    case_node: Some("switch_case"),
    case_nodes: &[],
    default_node: Some("switch_default"),
    wildcard_pattern_node: None,
    try_node: Some("try_statement"),
    try_nodes: &[],
    catch_node: Some("catch_clause"),
    finally_node: Some("finally_clause"),
    else_node: None,
    return_node: Some("return_statement"),
    throw_node: Some("throw_statement"),
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("statement_block"),
    block_nodes: &[],
    labeled_node: Some("labeled_statement"),
};

pub static PYTHON_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: Some("elif_clause"),
    else_clause: Some("else_clause"),
    else_via_alternative: false,
    if_consequent_field: None,
    for_nodes: &["for_statement"],
    condition_field: Some("condition"),
    while_node: Some("while_statement"),
    while_nodes: &[],
    do_node: None,
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: Some("match_statement"),
    switch_nodes: &[],
    case_node: Some("case_clause"),
    case_nodes: &[],
    default_node: None,
    wildcard_pattern_node: Some("wildcard_pattern"),
    try_node: Some("try_statement"),
    try_nodes: &[],
    catch_node: Some("except_clause"),
    finally_node: Some("finally_clause"),
    else_node: Some("else_clause"),
    return_node: Some("return_statement"),
    throw_node: Some("raise_statement"),
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("block"),
    block_nodes: &[],
    labeled_node: None,
};

pub static GO_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: None,
    else_clause: None,
    else_via_alternative: true,
    if_consequent_field: None,
    for_nodes: &["for_statement"],
    condition_field: Some("condition"),
    while_node: None,
    while_nodes: &[],
    do_node: None,
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: None,
    switch_nodes: &["expression_switch_statement", "type_switch_statement", "select_statement"],
    case_node: Some("expression_case"),
    case_nodes: &["type_case", "communication_case"],
    default_node: Some("default_case"),
    wildcard_pattern_node: None,
    try_node: None,
    try_nodes: &[],
    catch_node: None,
    finally_node: None,
    else_node: None,
    return_node: Some("return_statement"),
    throw_node: None,
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("block"),
    block_nodes: &[],
    labeled_node: Some("labeled_statement"),
};

pub static RUST_CFG: CfgRules = CfgRules {
    if_node: Some("if_expression"),
    if_nodes: &["if_let_expression"],
    elif_node: None,
    else_clause: Some("else_clause"),
    else_via_alternative: false,
    if_consequent_field: None,
    for_nodes: &["for_expression"],
    condition_field: None,
    while_node: Some("while_expression"),
    while_nodes: &["while_let_expression"],
    do_node: None,
    infinite_loop_node: Some("loop_expression"),
    unless_node: None,
    until_node: None,
    switch_node: Some("match_expression"),
    switch_nodes: &[],
    case_node: Some("match_arm"),
    case_nodes: &[],
    default_node: None,
    wildcard_pattern_node: None,
    try_node: None,
    try_nodes: &[],
    catch_node: None,
    finally_node: None,
    else_node: None,
    return_node: Some("return_expression"),
    throw_node: None,
    break_node: Some("break_expression"),
    continue_node: Some("continue_expression"),
    block_node: Some("block"),
    block_nodes: &[],
    labeled_node: None,
};

pub static JAVA_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: None,
    else_clause: None,
    else_via_alternative: true,
    if_consequent_field: None,
    for_nodes: &["for_statement", "enhanced_for_statement"],
    condition_field: Some("condition"),
    while_node: Some("while_statement"),
    while_nodes: &[],
    do_node: Some("do_statement"),
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: Some("switch_statement"),
    switch_nodes: &["switch_expression"],
    case_node: Some("switch_block_statement_group"),
    case_nodes: &["switch_rule"],
    default_node: None,
    wildcard_pattern_node: None,
    try_node: Some("try_statement"),
    try_nodes: &[],
    catch_node: Some("catch_clause"),
    finally_node: Some("finally_clause"),
    else_node: None,
    return_node: Some("return_statement"),
    throw_node: Some("throw_statement"),
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("block"),
    block_nodes: &[],
    labeled_node: Some("labeled_statement"),
};

pub static CSHARP_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: None,
    else_clause: None,
    else_via_alternative: true,
    if_consequent_field: None,
    for_nodes: &["for_statement", "foreach_statement"],
    condition_field: Some("condition"),
    while_node: Some("while_statement"),
    while_nodes: &[],
    do_node: Some("do_statement"),
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: Some("switch_statement"),
    switch_nodes: &["switch_expression"],
    case_node: Some("switch_section"),
    case_nodes: &["switch_expression_arm"],
    default_node: None,
    wildcard_pattern_node: None,
    try_node: Some("try_statement"),
    try_nodes: &[],
    catch_node: Some("catch_clause"),
    finally_node: Some("finally_clause"),
    else_node: None,
    return_node: Some("return_statement"),
    throw_node: Some("throw_statement"),
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("block"),
    block_nodes: &[],
    labeled_node: Some("labeled_statement"),
};

pub static RUBY_CFG: CfgRules = CfgRules {
    if_node: Some("if"),
    if_nodes: &[],
    elif_node: Some("elsif"),
    else_clause: Some("else"),
    else_via_alternative: false,
    if_consequent_field: None,
    for_nodes: &["for"],
    condition_field: Some("condition"),
    while_node: Some("while"),
    while_nodes: &[],
    do_node: None,
    infinite_loop_node: None,
    unless_node: Some("unless"),
    until_node: Some("until"),
    switch_node: Some("case"),
    switch_nodes: &[],
    case_node: Some("when"),
    case_nodes: &[],
    default_node: Some("else"),
    wildcard_pattern_node: None,
    try_node: Some("begin"),
    try_nodes: &["body_statement"],
    catch_node: Some("rescue"),
    finally_node: Some("ensure"),
    else_node: None,
    return_node: Some("return"),
    throw_node: None,
    break_node: Some("break"),
    continue_node: Some("next"),
    block_node: None,
    block_nodes: &["then", "do", "body_statement"],
    labeled_node: None,
};

pub static PHP_CFG: CfgRules = CfgRules {
    if_node: Some("if_statement"),
    if_nodes: &[],
    elif_node: Some("else_if_clause"),
    else_clause: Some("else_clause"),
    else_via_alternative: false,
    if_consequent_field: Some("body"),
    for_nodes: &["for_statement", "foreach_statement"],
    condition_field: Some("condition"),
    while_node: Some("while_statement"),
    while_nodes: &[],
    do_node: Some("do_statement"),
    infinite_loop_node: None,
    unless_node: None,
    until_node: None,
    switch_node: Some("switch_statement"),
    switch_nodes: &[],
    case_node: Some("case_statement"),
    case_nodes: &[],
    default_node: Some("default_statement"),
    wildcard_pattern_node: None,
    try_node: Some("try_statement"),
    try_nodes: &[],
    catch_node: Some("catch_clause"),
    finally_node: Some("finally_clause"),
    else_node: None,
    return_node: Some("return_statement"),
    throw_node: Some("throw_expression"),
    break_node: Some("break_statement"),
    continue_node: Some("continue_statement"),
    block_node: Some("compound_statement"),
    block_nodes: &[],
    labeled_node: None,
};

/// Get CFG rules for a language ID.
pub fn get_cfg_rules(lang_id: &str) -> Option<&'static CfgRules> {
    match lang_id {
        "javascript" | "typescript" | "tsx" => Some(&JS_TS_CFG),
        "python" => Some(&PYTHON_CFG),
        "go" => Some(&GO_CFG),
        "rust" => Some(&RUST_CFG),
        "java" => Some(&JAVA_CFG),
        "csharp" => Some(&CSHARP_CFG),
        "ruby" => Some(&RUBY_CFG),
        "php" => Some(&PHP_CFG),
        _ => None,
    }
}

// ─── Core Algorithm ─────────────────────────────────────────────────────

/// Loop context for break/continue resolution.
struct LoopCtx {
    header_idx: u32,
    exit_idx: u32,
    is_loop: bool,
}

/// Label context for labeled break/continue.
struct LabelCtx {
    header_idx: Option<u32>,
    exit_idx: Option<u32>,
}

/// CFG builder state.
struct CfgBuilder<'a> {
    rules: &'a CfgRules,
    source: &'a [u8],
    blocks: Vec<CfgBlock>,
    edges: Vec<CfgEdge>,
    next_index: u32,
    exit_idx: u32,
    loop_stack: Vec<LoopCtx>,
    label_map: Vec<(String, LabelCtx)>,
}

impl<'a> CfgBuilder<'a> {
    fn new(rules: &'a CfgRules, source: &'a [u8]) -> Self {
        Self {
            rules,
            source,
            blocks: Vec::new(),
            edges: Vec::new(),
            next_index: 0,
            exit_idx: 0,
            loop_stack: Vec::new(),
            label_map: Vec::new(),
        }
    }

    fn make_block(&mut self, block_type: &str, start_line: Option<u32>, end_line: Option<u32>, label: Option<&str>) -> u32 {
        let idx = self.next_index;
        self.next_index += 1;
        self.blocks.push(CfgBlock {
            index: idx,
            block_type: block_type.to_string(),
            start_line,
            end_line,
            label: label.map(|s| s.to_string()),
        });
        idx
    }

    fn add_edge(&mut self, source: u32, target: u32, kind: &str) {
        self.edges.push(CfgEdge {
            source_index: source,
            target_index: target,
            kind: kind.to_string(),
        });
    }

    fn set_end_line(&mut self, block_idx: u32, line: u32) {
        if let Some(b) = self.blocks.iter_mut().find(|b| b.index == block_idx) {
            b.end_line = Some(line);
        }
    }

    fn set_start_line_if_empty(&mut self, block_idx: u32, line: u32) {
        if let Some(b) = self.blocks.iter_mut().find(|b| b.index == block_idx) {
            if b.start_line.is_none() {
                b.start_line = Some(line);
            }
        }
    }

    fn start_line_of(&self, block_idx: u32) -> Option<u32> {
        self.blocks.iter().find(|b| b.index == block_idx).and_then(|b| b.start_line)
    }

    /// Get statement children from a block or statement list.
    fn get_statements<'b>(&self, node: &Node<'b>) -> Vec<Node<'b>> {
        let kind = node.kind();
        if matches_opt(kind, self.rules.block_node) || matches_slice(kind, self.rules.block_nodes) {
            let mut stmts = Vec::new();
            let cursor = &mut node.walk();
            for child in node.named_children(cursor) {
                stmts.push(child);
            }
            return stmts;
        }
        // Single statement
        vec![*node]
    }

    /// Process a list of statements, returns the last current block or None if all paths terminated.
    fn process_statements(&mut self, stmts: &[Node], current: u32) -> Option<u32> {
        let mut cur = Some(current);
        for stmt in stmts {
            match cur {
                None => break, // Dead code after return/break/continue/throw
                Some(c) => cur = self.process_statement(stmt, c),
            }
        }
        cur
    }

    /// Process a single statement.
    fn process_statement(&mut self, stmt: &Node, current: u32) -> Option<u32> {
        let kind = stmt.kind();

        // Unwrap expression_statement (Rust uses expressions for control flow)
        if kind == "expression_statement" && stmt.named_child_count() == 1 {
            if let Some(inner) = stmt.named_child(0) {
                let t = inner.kind();
                if matches_opt(t, self.rules.if_node)
                    || matches_slice(t, self.rules.if_nodes)
                    || matches_slice(t, self.rules.for_nodes)
                    || matches_opt(t, self.rules.while_node)
                    || matches_slice(t, self.rules.while_nodes)
                    || matches_opt(t, self.rules.do_node)
                    || matches_opt(t, self.rules.infinite_loop_node)
                    || matches_opt(t, self.rules.switch_node)
                    || matches_slice(t, self.rules.switch_nodes)
                    || matches_opt(t, self.rules.return_node)
                    || matches_opt(t, self.rules.throw_node)
                    || matches_opt(t, self.rules.break_node)
                    || matches_opt(t, self.rules.continue_node)
                    || matches_opt(t, self.rules.unless_node)
                    || matches_opt(t, self.rules.until_node)
                {
                    return self.process_statement(&inner, current);
                }
            }
        }

        // Labeled statement
        if matches_opt(kind, self.rules.labeled_node) {
            let label_node = stmt.child_by_field_name("label");
            let body = stmt.child_by_field_name("body");
            if let (Some(label_node), Some(body)) = (label_node, body) {
                let label_name = label_node.utf8_text(self.source).unwrap_or("").to_string();
                // We can't know the loop blocks yet — push a placeholder
                self.label_map.push((label_name.clone(), LabelCtx { header_idx: None, exit_idx: None }));
                let result = self.process_statement(&body, current);
                self.label_map.retain(|(n, _)| n != &label_name);
                return result;
            }
            return Some(current);
        }

        // If statement
        if matches_opt(kind, self.rules.if_node) || matches_slice(kind, self.rules.if_nodes) {
            return self.process_if(stmt, current);
        }

        // Unless (Ruby)
        if matches_opt(kind, self.rules.unless_node) {
            return self.process_if(stmt, current);
        }

        // For loops
        if matches_slice(kind, self.rules.for_nodes) {
            return self.process_for_loop(stmt, current);
        }

        // While loop
        if matches_opt(kind, self.rules.while_node) || matches_slice(kind, self.rules.while_nodes) {
            return self.process_while_loop(stmt, current);
        }

        // Until (Ruby)
        if matches_opt(kind, self.rules.until_node) {
            return self.process_while_loop(stmt, current);
        }

        // Do-while
        if matches_opt(kind, self.rules.do_node) {
            return self.process_do_while_loop(stmt, current);
        }

        // Infinite loop (Rust loop {})
        if matches_opt(kind, self.rules.infinite_loop_node) {
            return self.process_infinite_loop(stmt, current);
        }

        // Switch/match
        if matches_opt(kind, self.rules.switch_node) || matches_slice(kind, self.rules.switch_nodes) {
            return self.process_switch(stmt, current);
        }

        // Try/catch/finally
        if matches_opt(kind, self.rules.try_node) {
            return self.process_try_catch(stmt, current);
        }
        // Additional try nodes (e.g. Ruby body_statement with rescue)
        if matches_slice(kind, self.rules.try_nodes) {
            // Only treat as try if it actually contains a catch/rescue child
            let cursor = &mut stmt.walk();
            let has_rescue = stmt.named_children(cursor)
                .any(|c| matches_opt(c.kind(), self.rules.catch_node));
            if has_rescue {
                return self.process_try_catch(stmt, current);
            }
        }

        // Return
        if matches_opt(kind, self.rules.return_node) {
            self.set_end_line(current, node_line(stmt));
            self.add_edge(current, self.exit_idx, "return");
            return None;
        }

        // Throw
        if matches_opt(kind, self.rules.throw_node) {
            self.set_end_line(current, node_line(stmt));
            self.add_edge(current, self.exit_idx, "exception");
            return None;
        }

        // Break
        if matches_opt(kind, self.rules.break_node) {
            let label_name = stmt.child_by_field_name("label")
                .map(|n| n.utf8_text(self.source).unwrap_or("").to_string());

            let target = if let Some(ref name) = label_name {
                self.label_map.iter().rev()
                    .find(|(n, _)| n == name)
                    .and_then(|(_, ctx)| ctx.exit_idx)
            } else {
                self.loop_stack.last().map(|ctx| ctx.exit_idx)
            };

            if let Some(target) = target {
                self.set_end_line(current, node_line(stmt));
                self.add_edge(current, target, "break");
                return None;
            }
            return Some(current);
        }

        // Continue
        if matches_opt(kind, self.rules.continue_node) {
            let label_name = stmt.child_by_field_name("label")
                .map(|n| n.utf8_text(self.source).unwrap_or("").to_string());

            let target = if let Some(ref name) = label_name {
                self.label_map.iter().rev()
                    .find(|(n, _)| n == name)
                    .and_then(|(_, ctx)| ctx.header_idx)
            } else {
                // Walk back to find the nearest actual loop (skip switch entries)
                self.loop_stack.iter().rev()
                    .find(|ctx| ctx.is_loop)
                    .map(|ctx| ctx.header_idx)
            };

            if let Some(target) = target {
                self.set_end_line(current, node_line(stmt));
                self.add_edge(current, target, "continue");
                return None;
            }
            return Some(current);
        }

        // Regular statement — extend current block
        self.set_start_line_if_empty(current, node_line(stmt));
        self.set_end_line(current, node_end_line(stmt));
        Some(current)
    }

    /// Process if/else-if/else chain (handles patterns A, B, C).
    fn process_if(&mut self, if_stmt: &Node, current: u32) -> Option<u32> {
        self.process_if_depth(if_stmt, current, 0)
    }

    fn process_if_depth(&mut self, if_stmt: &Node, current: u32, depth: usize) -> Option<u32> {
        if depth >= MAX_WALK_DEPTH {
            return Some(current);
        }
        self.set_end_line(current, node_line(if_stmt));

        let cond_block = self.make_block("condition", Some(node_line(if_stmt)), Some(node_line(if_stmt)), Some("if"));
        self.add_edge(current, cond_block, "fallthrough");

        let join_block = self.make_block("body", None, None, None);

        // True branch
        let consequent_field = self.rules.if_consequent_field.unwrap_or("consequence");
        let consequent = if_stmt.child_by_field_name(consequent_field);
        let true_block = self.make_block("branch_true", None, None, Some("then"));
        self.add_edge(cond_block, true_block, "branch_true");

        if let Some(consequent) = consequent {
            let true_stmts = self.get_statements(&consequent);
            let true_end = self.process_statements(&true_stmts, true_block);
            if let Some(te) = true_end {
                self.add_edge(te, join_block, "fallthrough");
            }
        } else {
            self.add_edge(true_block, join_block, "fallthrough");
        }

        // False branch
        if self.rules.elif_node.is_some() {
            // Pattern B: elif/else as siblings
            self.process_elif_siblings(if_stmt, cond_block, join_block);
        } else {
            let alternative = if_stmt.child_by_field_name("alternative");
            if let Some(alternative) = alternative {
                let alt_kind = alternative.kind();
                if self.rules.else_via_alternative && !matches_opt(alt_kind, self.rules.else_clause) {
                    // Pattern C: alternative points directly to if or block
                    if matches_opt(alt_kind, self.rules.if_node) || matches_slice(alt_kind, self.rules.if_nodes) {
                        let false_block = self.make_block("branch_false", None, None, Some("else-if"));
                        self.add_edge(cond_block, false_block, "branch_false");
                        let else_if_end = self.process_if_depth(&alternative, false_block, depth + 1);
                        if let Some(eie) = else_if_end {
                            self.add_edge(eie, join_block, "fallthrough");
                        }
                    } else {
                        let false_block = self.make_block("branch_false", None, None, Some("else"));
                        self.add_edge(cond_block, false_block, "branch_false");
                        let false_stmts = self.get_statements(&alternative);
                        let false_end = self.process_statements(&false_stmts, false_block);
                        if let Some(fe) = false_end {
                            self.add_edge(fe, join_block, "fallthrough");
                        }
                    }
                } else if matches_opt(alt_kind, self.rules.else_clause) {
                    // Pattern A: else_clause wrapper
                    let else_children: Vec<Node> = {
                        let cursor = &mut alternative.walk();
                        alternative.named_children(cursor).collect()
                    };
                    if else_children.len() == 1
                        && (matches_opt(else_children[0].kind(), self.rules.if_node)
                            || matches_slice(else_children[0].kind(), self.rules.if_nodes))
                    {
                        // else-if: recurse
                        let false_block = self.make_block("branch_false", None, None, Some("else-if"));
                        self.add_edge(cond_block, false_block, "branch_false");
                        let else_if_end = self.process_if_depth(&else_children[0], false_block, depth + 1);
                        if let Some(eie) = else_if_end {
                            self.add_edge(eie, join_block, "fallthrough");
                        }
                    } else {
                        // else block
                        let false_block = self.make_block("branch_false", None, None, Some("else"));
                        self.add_edge(cond_block, false_block, "branch_false");
                        let false_end = self.process_statements(&else_children, false_block);
                        if let Some(fe) = false_end {
                            self.add_edge(fe, join_block, "fallthrough");
                        }
                    }
                } else {
                    // Unknown alternative type — treat as no else
                    self.add_edge(cond_block, join_block, "branch_false");
                }
            } else {
                // No else: condition-false goes to join
                self.add_edge(cond_block, join_block, "branch_false");
            }
        }

        Some(join_block)
    }

    /// Pattern B: elif/elsif/else_if as sibling children of the if node.
    fn process_elif_siblings(&mut self, if_stmt: &Node, first_cond: u32, join_block: u32) {
        let mut last_cond = first_cond;
        let mut found_else = false;

        let cursor = &mut if_stmt.walk();
        let children: Vec<Node> = if_stmt.named_children(cursor).collect();

        for child in &children {
            let child_kind = child.kind();

            if matches_opt(child_kind, self.rules.elif_node) {
                let elif_cond = self.make_block("condition", Some(node_line(child)), Some(node_line(child)), Some("else-if"));
                self.add_edge(last_cond, elif_cond, "branch_false");

                let elif_consequent_field = self.rules.if_consequent_field.unwrap_or("consequence");
                let elif_consequent = child.child_by_field_name(elif_consequent_field);
                let elif_true = self.make_block("branch_true", None, None, Some("then"));
                self.add_edge(elif_cond, elif_true, "branch_true");

                if let Some(cons) = elif_consequent {
                    let stmts = self.get_statements(&cons);
                    let end = self.process_statements(&stmts, elif_true);
                    if let Some(e) = end {
                        self.add_edge(e, join_block, "fallthrough");
                    }
                } else {
                    self.add_edge(elif_true, join_block, "fallthrough");
                }

                last_cond = elif_cond;
            } else if matches_opt(child_kind, self.rules.else_clause) {
                let else_block = self.make_block("branch_false", None, None, Some("else"));
                self.add_edge(last_cond, else_block, "branch_false");

                // Try field access first, then collect children
                let else_body = child.child_by_field_name("body");
                let else_stmts: Vec<Node> = if let Some(body) = else_body {
                    self.get_statements(&body)
                } else {
                    let cursor2 = &mut child.walk();
                    child.named_children(cursor2).collect()
                };
                let else_end = self.process_statements(&else_stmts, else_block);
                if let Some(ee) = else_end {
                    self.add_edge(ee, join_block, "fallthrough");
                }

                found_else = true;
            }
        }

        if !found_else {
            self.add_edge(last_cond, join_block, "branch_false");
        }
    }

    /// Update label map with loop context (for newly created loops inside labeled stmts).
    fn update_label_map(&mut self, header_idx: u32, exit_idx: u32) {
        if let Some((_, ctx)) = self.label_map.iter_mut().rev()
            .find(|(_, ctx)| ctx.header_idx.is_none())
        {
            ctx.header_idx = Some(header_idx);
            ctx.exit_idx = Some(exit_idx);
        }
    }

    fn process_for_loop(&mut self, for_stmt: &Node, current: u32) -> Option<u32> {
        let header = self.make_block("loop_header", Some(node_line(for_stmt)), Some(node_line(for_stmt)), Some("for"));
        self.add_edge(current, header, "fallthrough");

        let exit = self.make_block("body", None, None, None);

        self.loop_stack.push(LoopCtx { header_idx: header, exit_idx: exit, is_loop: true });
        self.update_label_map(header, exit);

        // Determine if this for-loop is bounded.  C-style for loops have a `condition`
        // field; iterator-style loops (for-in, foreach, enhanced-for, Rust for) have an
        // iterable field (`right` or `value`) or a known iterator node kind.  Only Go's
        // bare `for {}` has none of these and is truly infinite.
        let has_condition = match self.rules.condition_field {
            None => true, // Language has no C-style for (e.g. Rust) — all for-nodes are bounded
            Some(field) => {
                for_stmt.child_by_field_name(field).is_some()
                    || for_stmt.child_by_field_name("right").is_some()
                    || for_stmt.child_by_field_name("value").is_some()
                    // Explicit iterator-style node kinds across supported languages:
                    // JS: for_in_statement, Java: enhanced_for_statement,
                    // C#/PHP: foreach_statement, Ruby: for
                    || matches!(for_stmt.kind(),
                        "for_in_statement" | "enhanced_for_statement" |
                        "foreach_statement" | "for")
            }
        };

        let body = for_stmt.child_by_field_name("body");
        let body_block = self.make_block("loop_body", None, None, None);
        let body_edge = if has_condition { "branch_true" } else { "fallthrough" };
        self.add_edge(header, body_block, body_edge);

        if let Some(body) = body {
            let stmts = self.get_statements(&body);
            let body_end = self.process_statements(&stmts, body_block);
            if let Some(be) = body_end {
                self.add_edge(be, header, "loop_back");
            }
        }

        self.loop_stack.pop();

        if has_condition {
            // Normal for loop with condition — always emit loop_exit edge
            self.add_edge(header, exit, "loop_exit");
            Some(exit)
        } else {
            // Infinite loop (no condition) — only exit via break
            let has_break_to_exit = self.edges.iter().any(|e| e.target_index == exit);
            if has_break_to_exit {
                Some(exit)
            } else {
                None
            }
        }
    }

    fn process_while_loop(&mut self, while_stmt: &Node, current: u32) -> Option<u32> {
        let header = self.make_block("loop_header", Some(node_line(while_stmt)), Some(node_line(while_stmt)), Some("while"));
        self.add_edge(current, header, "fallthrough");

        let exit = self.make_block("body", None, None, None);

        self.loop_stack.push(LoopCtx { header_idx: header, exit_idx: exit, is_loop: true });
        self.update_label_map(header, exit);

        let body = while_stmt.child_by_field_name("body");
        let body_block = self.make_block("loop_body", None, None, None);
        self.add_edge(header, body_block, "branch_true");

        if let Some(body) = body {
            let stmts = self.get_statements(&body);
            let body_end = self.process_statements(&stmts, body_block);
            if let Some(be) = body_end {
                self.add_edge(be, header, "loop_back");
            }
        }

        self.add_edge(header, exit, "loop_exit");
        self.loop_stack.pop();
        Some(exit)
    }

    fn process_do_while_loop(&mut self, do_stmt: &Node, current: u32) -> Option<u32> {
        let body_block = self.make_block("loop_body", Some(node_line(do_stmt)), None, Some("do"));
        self.add_edge(current, body_block, "fallthrough");

        let cond_block = self.make_block("loop_header", None, None, Some("do-while"));
        let exit = self.make_block("body", None, None, None);

        self.loop_stack.push(LoopCtx { header_idx: cond_block, exit_idx: exit, is_loop: true });
        self.update_label_map(cond_block, exit);

        let body = do_stmt.child_by_field_name("body");
        if let Some(body) = body {
            let stmts = self.get_statements(&body);
            let body_end = self.process_statements(&stmts, body_block);
            if let Some(be) = body_end {
                self.add_edge(be, cond_block, "fallthrough");
            }
        }

        self.add_edge(cond_block, body_block, "loop_back");
        self.add_edge(cond_block, exit, "loop_exit");

        self.loop_stack.pop();
        Some(exit)
    }

    fn process_infinite_loop(&mut self, loop_stmt: &Node, current: u32) -> Option<u32> {
        let header = self.make_block("loop_header", Some(node_line(loop_stmt)), Some(node_line(loop_stmt)), Some("loop"));
        self.add_edge(current, header, "fallthrough");

        let exit = self.make_block("body", None, None, None);

        self.loop_stack.push(LoopCtx { header_idx: header, exit_idx: exit, is_loop: true });
        self.update_label_map(header, exit);

        let body = loop_stmt.child_by_field_name("body");
        let body_block = self.make_block("loop_body", None, None, None);
        self.add_edge(header, body_block, "fallthrough");

        if let Some(body) = body {
            let stmts = self.get_statements(&body);
            let body_end = self.process_statements(&stmts, body_block);
            if let Some(be) = body_end {
                self.add_edge(be, header, "loop_back");
            }
        }

        // No loop_exit from header — only exit via break
        self.loop_stack.pop();

        // If no break targeted the exit block, subsequent code is unreachable
        let has_break_to_exit = self.edges.iter().any(|e| e.target_index == exit);
        if has_break_to_exit {
            Some(exit)
        } else {
            None
        }
    }

    fn process_switch(&mut self, switch_stmt: &Node, current: u32) -> Option<u32> {
        self.set_end_line(current, node_line(switch_stmt));

        let switch_header = self.make_block("condition", Some(node_line(switch_stmt)), Some(node_line(switch_stmt)), Some("switch"));
        self.add_edge(current, switch_header, "fallthrough");

        let join_block = self.make_block("body", None, None, None);

        // Switch acts like a break target but not a continue target
        self.loop_stack.push(LoopCtx { header_idx: switch_header, exit_idx: join_block, is_loop: false });

        // Get case children from body field or direct children
        let container = switch_stmt.child_by_field_name("body").unwrap_or(*switch_stmt);

        let mut has_default = false;
        let cursor = &mut container.walk();
        let case_children: Vec<Node> = container.named_children(cursor).collect();

        for case_clause in &case_children {
            let cc_kind = case_clause.kind();
            let is_default = matches_opt(cc_kind, self.rules.default_node)
                || (self.rules.wildcard_pattern_node.is_some()
                    && (matches_opt(cc_kind, self.rules.case_node) || matches_slice(cc_kind, self.rules.case_nodes))
                    && case_clause.named_child(0)
                        .is_some_and(|c| matches_opt(c.kind(), self.rules.wildcard_pattern_node)));
            let is_case = is_default
                || matches_opt(cc_kind, self.rules.case_node)
                || matches_slice(cc_kind, self.rules.case_nodes);

            if !is_case {
                continue;
            }

            let case_label = if is_default { "default" } else { "case" };
            let case_block = self.make_block("case", Some(node_line(case_clause)), None, Some(case_label));
            let edge_kind = if is_default { "branch_false" } else { "branch_true" };
            self.add_edge(switch_header, case_block, edge_kind);
            if is_default {
                has_default = true;
            }

            // Extract case body
            let case_body_node = case_clause.child_by_field_name("body")
                .or_else(|| case_clause.child_by_field_name("consequence"));

            let case_stmts: Vec<Node> = if let Some(body_node) = case_body_node {
                self.get_statements(&body_node)
            } else if let Some(value_node) = case_clause.child_by_field_name("value") {
                // Rust match_arm: the `value` field is the arm expression body
                vec![value_node]
            } else {
                let pattern_node = case_clause.child_by_field_name("pattern");
                let cursor2 = &mut case_clause.walk();
                case_clause.named_children(cursor2)
                    .filter(|child| {
                        if let Some(ref p) = pattern_node { if child.id() == p.id() { return false; } }
                        child.kind() != "switch_label"
                    })
                    .collect()
            };

            let case_end = self.process_statements(&case_stmts, case_block);
            if let Some(ce) = case_end {
                self.add_edge(ce, join_block, "fallthrough");
            }
        }

        if !has_default {
            self.add_edge(switch_header, join_block, "branch_false");
        }

        self.loop_stack.pop();
        Some(join_block)
    }

    fn process_try_catch(&mut self, try_stmt: &Node, current: u32) -> Option<u32> {
        self.set_end_line(current, node_line(try_stmt));

        let join_block = self.make_block("body", None, None, None);

        // Try body
        let try_body = try_stmt.child_by_field_name("body");
        let (try_body_start, try_stmts): (u32, Vec<Node>) = if let Some(body) = try_body {
            (node_line(&body), self.get_statements(&body))
        } else {
            let cursor = &mut try_stmt.walk();
            let stmts: Vec<Node> = try_stmt.named_children(cursor)
                .filter(|child| {
                    let ck = child.kind();
                    !matches_opt(ck, self.rules.catch_node)
                        && !matches_opt(ck, self.rules.finally_node)
                        && !matches_opt(ck, self.rules.else_node)
                })
                .collect();
            (node_line(try_stmt), stmts)
        };

        let try_block = self.make_block("body", Some(try_body_start), None, Some("try"));
        self.add_edge(current, try_block, "fallthrough");
        let try_end = self.process_statements(&try_stmts, try_block);

        // Find catch, finally, and else handlers
        let mut catch_handlers: Vec<Node> = Vec::new();
        let mut finally_handler: Option<Node> = None;
        let mut else_handler: Option<Node> = None;
        let cursor = &mut try_stmt.walk();
        for child in try_stmt.named_children(cursor) {
            if matches_opt(child.kind(), self.rules.catch_node) {
                catch_handlers.push(child);
            }
            if matches_opt(child.kind(), self.rules.finally_node) {
                finally_handler = Some(child);
            }
            if matches_opt(child.kind(), self.rules.else_node) {
                // Only treat as try-else if it's a direct child of the try statement
                // (not the else_clause of an if inside the try body)
                else_handler = Some(child);
            }
        }

        // Process else clause (Python try...except...else): runs when try succeeds
        let success_end = if let Some(else_node) = else_handler {
            let else_block = self.make_block("body", Some(node_line(&else_node)), None, Some("else"));
            if let Some(te) = try_end {
                self.add_edge(te, else_block, "fallthrough");
            }
            let else_stmts = self.get_statements(&else_node);
            self.process_statements(&else_stmts, else_block)
        } else {
            try_end
        };

        if !catch_handlers.is_empty() {
            let mut catch_ends: Vec<Option<u32>> = Vec::new();

            for catch_node in &catch_handlers {
                let catch_block = self.make_block("catch", Some(node_line(catch_node)), None, Some("catch"));
                self.add_edge(try_block, catch_block, "exception");

                let catch_body_node = catch_node.child_by_field_name("body");
                let catch_stmts: Vec<Node> = if let Some(body) = catch_body_node {
                    self.get_statements(&body)
                } else {
                    let cursor2 = &mut catch_node.walk();
                    catch_node.named_children(cursor2).collect()
                };
                let catch_end = self.process_statements(&catch_stmts, catch_block);
                catch_ends.push(catch_end);
            }

            if let Some(finally_node) = finally_handler {
                let finally_block = self.make_block("finally", Some(node_line(&finally_node)), None, Some("finally"));
                if let Some(se) = success_end {
                    self.add_edge(se, finally_block, "fallthrough");
                }
                for catch_end in &catch_ends {
                    if let Some(ce) = *catch_end {
                        self.add_edge(ce, finally_block, "fallthrough");
                    }
                }
                let finally_body = finally_node.child_by_field_name("body");
                let finally_stmts: Vec<Node> = if let Some(body) = finally_body {
                    self.get_statements(&body)
                } else {
                    self.get_statements(&finally_node)
                };
                let finally_end = self.process_statements(&finally_stmts, finally_block);
                if let Some(fe) = finally_end {
                    self.add_edge(fe, join_block, "fallthrough");
                }
            } else {
                if let Some(se) = success_end {
                    self.add_edge(se, join_block, "fallthrough");
                }
                for catch_end in &catch_ends {
                    if let Some(ce) = *catch_end {
                        self.add_edge(ce, join_block, "fallthrough");
                    }
                }
            }
        } else if let Some(finally_node) = finally_handler {
            let finally_block = self.make_block("finally", Some(node_line(&finally_node)), None, Some("finally"));
            if let Some(se) = success_end {
                self.add_edge(se, finally_block, "fallthrough");
            }
            let finally_body = finally_node.child_by_field_name("body");
            let finally_stmts: Vec<Node> = if let Some(body) = finally_body {
                self.get_statements(&body)
            } else {
                self.get_statements(&finally_node)
            };
            let finally_end = self.process_statements(&finally_stmts, finally_block);
            if let Some(fe) = finally_end {
                self.add_edge(fe, join_block, "fallthrough");
            }
        } else {
            if let Some(se) = success_end {
                self.add_edge(se, join_block, "fallthrough");
            }
        }

        Some(join_block)
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

fn node_line(node: &Node) -> u32 {
    node.start_position().row as u32 + 1
}

fn node_end_line(node: &Node) -> u32 {
    node.end_position().row as u32 + 1
}

// ─── Public API ─────────────────────────────────────────────────────────

/// Build a control flow graph for a single function AST node.
pub fn build_function_cfg(function_node: &Node, lang_id: &str, source: &[u8]) -> Option<CfgData> {
    let rules = get_cfg_rules(lang_id)?;

    let mut builder = CfgBuilder::new(rules, source);

    let entry = builder.make_block("entry", None, None, None);
    let exit = builder.make_block("exit", None, None, None);
    builder.exit_idx = exit;

    let body = function_node.child_by_field_name("body");
    let body = match body {
        Some(b) => b,
        None => {
            builder.add_edge(entry, exit, "fallthrough");
            return Some(CfgData { blocks: builder.blocks, edges: builder.edges });
        }
    };

    let stmts = builder.get_statements(&body);
    if stmts.is_empty() {
        builder.add_edge(entry, exit, "fallthrough");
        return Some(CfgData { blocks: builder.blocks, edges: builder.edges });
    }

    let first_block = builder.make_block("body", None, None, None);
    builder.add_edge(entry, first_block, "fallthrough");

    let last_block = builder.process_statements(&stmts, first_block);
    if let Some(lb) = last_block {
        builder.add_edge(lb, exit, "fallthrough");
    }

    Some(CfgData { blocks: builder.blocks, edges: builder.edges })
}
