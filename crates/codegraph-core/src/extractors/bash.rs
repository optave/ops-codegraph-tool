use tree_sitter::{Node, Tree};
use crate::cfg::build_function_cfg;
use crate::complexity::compute_all_metrics;
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct BashExtractor;

impl SymbolExtractor for BashExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_bash_node);
        walk_ast_nodes_with_config(&tree.root_node(), source, &mut symbols.ast_nodes, &BASH_AST_CONFIG);
        symbols
    }
}

const BASH_AST_CONFIG: LangAstConfig = LangAstConfig {
    call_types: &["command", "command_substitution"],
    new_types: &[],
    throw_types: &[],
    await_types: &[],
    string_types: &["string", "expansion"],
    regex_types: &[],
    quote_chars: &['"', '\''],
    string_prefixes: &[],
};

fn match_bash_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    match node.kind() {
        "function_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = node_text(&name_node, source).to_string();
                symbols.definitions.push(Definition {
                    name,
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: compute_all_metrics(node, source, "bash"),
                    cfg: build_function_cfg(node, "bash", source),
                    children: None,
                });
            }
        }

        "command" => {
            if let Some(cmd_name) = find_child(node, "command_name") {
                let name = node_text(&cmd_name, source);
                match name {
                    "source" | "." => {
                        // Treat as import — the argument is the sourced file
                        // Get the first argument after the command name
                        for i in 0..node.child_count() {
                            if let Some(child) = node.child(i) {
                                if child.kind() == "word" || child.kind() == "string" || child.kind() == "raw_string" {
                                    let path = node_text(&child, source)
                                        .trim_matches(|c| c == '"' || c == '\'')
                                        .to_string();
                                    if !path.is_empty() {
                                        let last = path.split('/').last().unwrap_or(&path).to_string();
                                        let mut imp = Import::new(path, vec![last], start_line(node));
                                        imp.bash_source = Some(true);
                                        symbols.imports.push(imp);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                    _ => {
                        symbols.calls.push(Call {
                            name: name.to_string(),
                            line: start_line(node),
                            dynamic: None,
                            receiver: None,
                        });
                    }
                }
            }
        }

        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::Parser;

    fn parse_bash(code: &str) -> FileSymbols {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .unwrap();
        let tree = parser.parse(code.as_bytes(), None).unwrap();
        BashExtractor.extract(&tree, code.as_bytes(), "test.sh")
    }

    #[test]
    fn extracts_function() {
        let s = parse_bash("function greet() { echo hello; }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
    }

    #[test]
    fn extracts_function_alt_syntax() {
        let s = parse_bash("greet() { echo hello; }");
        let greet = s.definitions.iter().find(|d| d.name == "greet").unwrap();
        assert_eq!(greet.kind, "function");
    }

    #[test]
    fn extracts_source_import() {
        let s = parse_bash("source ./utils.sh");
        assert_eq!(s.imports.len(), 1);
        assert_eq!(s.imports[0].path, "./utils.sh");
        assert!(s.imports[0].bash_source.unwrap());
    }

    #[test]
    fn extracts_command_calls() {
        let s = parse_bash("function main() { ls -la; grep foo bar; }");
        assert!(s.calls.iter().any(|c| c.name == "ls"));
        assert!(s.calls.iter().any(|c| c.name == "grep"));
    }
}
