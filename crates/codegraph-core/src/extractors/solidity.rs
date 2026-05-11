use super::helpers::*;
use super::SymbolExtractor;
use crate::types::*;
use tree_sitter::{Node, Tree};

pub struct SolidityExtractor;

impl SymbolExtractor for SolidityExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_solidity_node);
        walk_ast_nodes_with_config(
            &tree.root_node(),
            source,
            &mut symbols.ast_nodes,
            &SOLIDITY_AST_CONFIG,
        );
        symbols
    }
}

// ── Constants ────────────────────────────────────────────────────────────────

/// Container kinds that "own" nested declarations (functions, structs, enums…).
/// Mirrors `SOL_PARENT_TYPES` in `src/extractors/solidity.ts`.
const SOL_PARENT_TYPES: &[&str] = &[
    "contract_declaration",
    "interface_declaration",
    "library_declaration",
];

// ── Walker ───────────────────────────────────────────────────────────────────

fn match_solidity_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "contract_declaration" => handle_contract_decl(node, source, symbols, "class"),
        "interface_declaration" => handle_contract_decl(node, source, symbols, "interface"),
        "library_declaration" => handle_contract_decl(node, source, symbols, "module"),
        "struct_declaration" => handle_struct_decl(node, source, symbols),
        "enum_declaration" => handle_enum_decl(node, source, symbols),
        "function_definition" => handle_function_def(node, source, symbols),
        "modifier_definition" => handle_modifier_def(node, source, symbols),
        "event_definition" => handle_event_def(node, source, symbols),
        "error_declaration" => handle_error_decl(node, source, symbols),
        "state_variable_declaration" => handle_state_var_decl(node, source, symbols),
        "import_directive" => handle_import_directive(node, source, symbols),
        "call_expression" | "function_call" => handle_call_expression(node, source, symbols),
        _ => {}
    }
}

// ── Contracts / interfaces / libraries ───────────────────────────────────────

fn handle_contract_decl(
    node: &Node,
    source: &[u8],
    symbols: &mut FileSymbols,
    kind: &str,
) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let name = node_text(&name_node, source).to_string();

    let body = node
        .child_by_field_name("body")
        .or_else(|| find_child(node, "contract_body"));
    let members = match body {
        Some(b) => extract_contract_members(&b, source),
        None => Vec::new(),
    };

    symbols.definitions.push(Definition {
        name: name.clone(),
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(members),
    });

    extract_inheritance(node, &name, source, symbols);
}

/// Extract member declarations from a contract body node.
fn extract_contract_members(body: &Node, source: &[u8]) -> Vec<Definition> {
    let mut members = Vec::new();
    for i in 0..body.child_count() {
        if let Some(child) = body.child(i) {
            if let Some(member) = extract_contract_member(&child, source) {
                members.push(member);
            }
        }
    }
    members
}

/// Map a single contract body child to a SubDeclaration, or None.
fn extract_contract_member(child: &Node, source: &[u8]) -> Option<Definition> {
    let line = start_line(child);
    match child.kind() {
        "function_definition" => {
            let name_node = child.child_by_field_name("name")?;
            Some(child_def(
                node_text(&name_node, source).to_string(),
                "method",
                line,
            ))
        }
        "state_variable_declaration" => {
            let name_node = child.child_by_field_name("name")?;
            Some(child_def(
                node_text(&name_node, source).to_string(),
                "property",
                line,
            ))
        }
        "event_definition" => {
            let name_node = child.child_by_field_name("name")?;
            Some(Definition {
                name: node_text(&name_node, source).to_string(),
                kind: "property".to_string(),
                line,
                end_line: None,
                decorators: Some(vec!["event".to_string()]),
                complexity: None,
                cfg: None,
                children: None,
            })
        }
        "error_declaration" => {
            let name_node = child.child_by_field_name("name")?;
            Some(Definition {
                name: node_text(&name_node, source).to_string(),
                kind: "property".to_string(),
                line,
                end_line: None,
                decorators: Some(vec!["error".to_string()]),
                complexity: None,
                cfg: None,
                children: None,
            })
        }
        "modifier_definition" => {
            let name_node = child.child_by_field_name("name")?;
            Some(Definition {
                name: node_text(&name_node, source).to_string(),
                kind: "method".to_string(),
                line,
                end_line: None,
                decorators: Some(vec!["modifier".to_string()]),
                complexity: None,
                cfg: None,
                children: None,
            })
        }
        _ => None,
    }
}

/// Extract inheritance (extends) relationships from a contract node.
fn extract_inheritance(node: &Node, name: &str, source: &[u8], symbols: &mut FileSymbols) {
    let Some(inheritance) = find_child(node, "inheritance_specifier") else {
        return;
    };
    for i in 0..inheritance.child_count() {
        let Some(child) = inheritance.child(i) else {
            continue;
        };
        if child.kind() == "user_defined_type" || child.kind() == "identifier" {
            symbols.classes.push(ClassRelation {
                name: name.to_string(),
                extends: Some(node_text(&child, source).to_string()),
                implements: None,
                line: start_line(node),
            });
        }
    }
}

// ── Structs / enums ──────────────────────────────────────────────────────────

fn handle_struct_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };

    // The JS extractor iterates direct children of the struct_declaration looking
    // for `struct_member`, but the tree-sitter grammar wraps members inside a
    // `struct_body` node. Mirror JS behaviour by scanning direct children — this
    // produces no members in practice, matching WASM output.
    let mut members: Vec<Definition> = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "struct_member" {
                if let Some(member_name) = child.child_by_field_name("name") {
                    members.push(child_def(
                        node_text(&member_name, source).to_string(),
                        "property",
                        start_line(&child),
                    ));
                }
            }
        }
    }

    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "struct".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(members),
    });
}

fn handle_enum_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };

    // Mirror JS: iterate direct children for `enum_value`. The grammar wraps
    // enum values inside `enum_body`, so this produces no members in practice
    // (matching WASM output).
    let mut members: Vec<Definition> = Vec::new();
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            if child.kind() == "enum_value" {
                members.push(child_def(
                    node_text(&child, source).to_string(),
                    "constant",
                    start_line(&child),
                ));
            }
        }
    }

    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "enum".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(members),
    });
}

// ── Functions / modifiers / events / errors / state vars ─────────────────────

fn handle_function_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let parent = find_parent_name(node, source);
    let full_name = match &parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };
    let kind = if parent.is_some() { "method" } else { "function" };

    let params = extract_sol_params(node, source);
    symbols.definitions.push(Definition {
        name: full_name,
        kind: kind.to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: opt_children(params),
    });
}

fn handle_modifier_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "function".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: Some(vec!["modifier".to_string()]),
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_event_def(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "type".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: Some(vec!["event".to_string()]),
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_error_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "type".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: Some(vec!["error".to_string()]),
        complexity: None,
        cfg: None,
        children: None,
    });
}

fn handle_state_var_decl(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let parent = find_parent_name(node, source);
    let full_name = match parent {
        Some(p) => format!("{}.{}", p, node_text(&name_node, source)),
        None => node_text(&name_node, source).to_string(),
    };

    symbols.definitions.push(Definition {
        name: full_name,
        kind: "variable".to_string(),
        line: start_line(node),
        end_line: Some(end_line(node)),
        decorators: None,
        complexity: None,
        cfg: None,
        children: None,
    });
}

// ── Imports ──────────────────────────────────────────────────────────────────

fn handle_import_directive(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    // Three Solidity shapes:
    //   import "path";
    //   import { X, Y } from "path";
    //   import * as Alias from "path";
    for i in 0..node.child_count() {
        let Some(child) = node.child(i) else { continue };
        if child.kind() == "string" || child.kind() == "string_literal" {
            let source_path = strip_quotes(node_text(&child, source));
            let mut names: Vec<String> = Vec::new();
            for j in 0..node.child_count() {
                if let Some(sibling) = node.child(j) {
                    if sibling.kind() == "identifier" {
                        names.push(node_text(&sibling, source).to_string());
                    }
                    if sibling.kind() == "import_declaration" {
                        if let Some(id) = find_child(&sibling, "identifier") {
                            names.push(node_text(&id, source).to_string());
                        }
                    }
                }
            }
            if names.is_empty() {
                names.push("*".to_string());
            }
            symbols
                .imports
                .push(Import::new(source_path, names, start_line(node)));
            return;
        }
        // source_import / import_clause: `import * as Alias from "path"`
        if child.kind() == "source_import" || child.kind() == "import_clause" {
            let str_node = find_child(&child, "string").or_else(|| find_child(&child, "string_literal"));
            if let Some(str_node) = str_node {
                let source_path = strip_quotes(node_text(&str_node, source));
                symbols
                    .imports
                    .push(Import::new(source_path, vec!["*".to_string()], start_line(node)));
                return;
            }
        }
    }
}

// ── Calls ────────────────────────────────────────────────────────────────────

fn handle_call_expression(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    let func_node = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("callee"));
    let Some(func_node) = func_node else {
        return;
    };

    let (name, receiver) = match func_node.kind() {
        "member_expression" | "member_access" => {
            let prop = func_node
                .child_by_field_name("property")
                .or_else(|| func_node.child_by_field_name("member"));
            let obj = func_node
                .child_by_field_name("object")
                .or_else(|| func_node.child_by_field_name("expression"));
            (
                prop.map(|n| node_text(&n, source).to_string()).unwrap_or_default(),
                obj.map(|n| node_text(&n, source).to_string()),
            )
        }
        _ => (node_text(&func_node, source).to_string(), None),
    };

    if !name.is_empty() {
        symbols.calls.push(Call {
            name,
            line: start_line(node),
            dynamic: None,
            receiver,
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn extract_sol_params(func_node: &Node, source: &[u8]) -> Vec<Definition> {
    let mut params = Vec::new();
    let param_list = func_node
        .child_by_field_name("parameters")
        .or_else(|| find_child(func_node, "parameter_list"));
    let Some(param_list) = param_list else {
        return params;
    };
    for i in 0..param_list.child_count() {
        let Some(param) = param_list.child(i) else { continue };
        if param.kind() != "parameter" {
            continue;
        }
        if let Some(name_node) = param.child_by_field_name("name") {
            params.push(child_def(
                node_text(&name_node, source).to_string(),
                "parameter",
                start_line(&param),
            ));
        }
    }
    params
}

/// Find the name of an enclosing contract/interface/library, if any.
fn find_parent_name(node: &Node, source: &[u8]) -> Option<String> {
    find_enclosing_type_name(node, SOL_PARENT_TYPES, source)
}

/// Strip leading/trailing single, double, or backtick quotes.
fn strip_quotes(text: &str) -> String {
    let trimmed = text
        .trim_start_matches(|c: char| c == '\'' || c == '"' || c == '`')
        .trim_end_matches(|c: char| c == '\'' || c == '"' || c == '`');
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_sol(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&crate::parser_registry::LanguageKind::Solidity.tree_sitter_language())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        SolidityExtractor.extract(&tree, code.as_bytes(), "Test.sol")
    }

    #[test]
    fn extracts_contract_as_class() {
        let s = parse_sol("contract MyToken { uint256 public total; }");
        let d = s.definitions.iter().find(|d| d.name == "MyToken").unwrap();
        assert_eq!(d.kind, "class");
    }

    #[test]
    fn extracts_interface() {
        let s = parse_sol(
            "interface IERC20 { function transfer(address to, uint256 amount) external returns (bool); }",
        );
        let d = s.definitions.iter().find(|d| d.name == "IERC20").unwrap();
        assert_eq!(d.kind, "interface");
    }

    #[test]
    fn extracts_library_as_module() {
        let s = parse_sol(
            "library Validators { function v(string memory n) internal pure returns (bool) { return true; } }",
        );
        let d = s.definitions.iter().find(|d| d.name == "Validators").unwrap();
        assert_eq!(d.kind, "module");
    }

    #[test]
    fn extracts_function_with_contract_prefix() {
        let s = parse_sol(
            "contract Token { function transfer(address to, uint256 amount) public returns (bool) { return true; } }",
        );
        let d = s.definitions.iter().find(|d| d.name == "Token.transfer").unwrap();
        assert_eq!(d.kind, "method");
        // NOTE: matches WASM/JS behaviour — neither a `parameters` field nor a
        // `parameter_list` node exists in the Solidity tree-sitter grammar
        // (parameters are direct children of `function_definition`), so the
        // current extractor emits no parameter children. Tracked alongside JS
        // parity; do not "fix" here without also updating the WASM extractor.
    }

    #[test]
    fn extracts_import() {
        let s = parse_sol("import \"./IERC20.sol\";");
        let imp = s.imports.iter().find(|i| i.source == "./IERC20.sol").unwrap();
        assert_eq!(imp.names, vec!["*".to_string()]);
    }

    #[test]
    fn extracts_named_import() {
        let s = parse_sol("import { Foo, Bar } from \"./Stuff.sol\";");
        let imp = s.imports.iter().find(|i| i.source == "./Stuff.sol").unwrap();
        assert!(imp.names.contains(&"Foo".to_string()));
        assert!(imp.names.contains(&"Bar".to_string()));
    }

    #[test]
    fn extracts_inheritance() {
        let s = parse_sol("contract MyToken is ERC20 {}");
        let c = s.classes.iter().find(|c| c.name == "MyToken").unwrap();
        assert_eq!(c.extends.as_deref(), Some("ERC20"));
    }

    #[test]
    fn extracts_event_as_member() {
        let s = parse_sol("contract Token { event Transfer(address from, address to); }");
        let token = s.definitions.iter().find(|d| d.name == "Token").unwrap();
        let children = token.children.as_ref().unwrap();
        let ev = children.iter().find(|c| c.name == "Transfer").unwrap();
        assert_eq!(ev.kind, "property");
        assert_eq!(ev.decorators.as_deref(), Some(&["event".to_string()][..]));
    }

    #[test]
    fn extracts_modifier_definition() {
        let s = parse_sol(
            "contract Token { modifier onlyOwner() { _; } function foo() public onlyOwner {} }",
        );
        let m = s
            .definitions
            .iter()
            .find(|d| d.name == "Token.onlyOwner")
            .unwrap();
        assert_eq!(m.kind, "function");
        assert_eq!(m.decorators.as_deref(), Some(&["modifier".to_string()][..]));
    }
}
