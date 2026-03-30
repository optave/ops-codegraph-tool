use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct HclExtractor;

impl SymbolExtractor for HclExtractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_tree(&tree.root_node(), source, &mut symbols, match_hcl_node);
        symbols
    }
}

fn match_hcl_node(node: &Node, source: &[u8], symbols: &mut FileSymbols, _depth: usize) {
    if node.kind() == "block" {
        let mut identifiers = Vec::new();
        let mut strings = Vec::new();

        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                if child.kind() == "identifier" {
                    identifiers.push(node_text(&child, source).to_string());
                }
                if child.kind() == "string_lit" {
                    strings.push(
                        node_text(&child, source)
                            .replace('"', "")
                            .to_string(),
                    );
                }
            }
        }

        if !identifiers.is_empty() {
            let block_type = &identifiers[0];
            let mut name = String::new();

            match block_type.as_str() {
                "resource" if strings.len() >= 2 => {
                    name = format!("{}.{}", strings[0], strings[1]);
                }
                "data" if strings.len() >= 2 => {
                    name = format!("data.{}.{}", strings[0], strings[1]);
                }
                "variable" | "output" | "module" if !strings.is_empty() => {
                    name = format!("{}.{}", block_type, strings[0]);
                }
                "locals" => {
                    name = "locals".to_string();
                }
                "terraform" | "provider" => {
                    name = block_type.clone();
                    if !strings.is_empty() {
                        name = format!("{}.{}", block_type, strings[0]);
                    }
                }
                _ => {}
            }

            if !name.is_empty() {
                symbols.definitions.push(Definition {
                    name,
                    kind: block_type.clone(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                    complexity: None,
                    cfg: None,
                    children: None,
                });

                // Module source imports
                if block_type == "module" {
                    let body = node
                        .children(&mut node.walk())
                        .find(|c| c.kind() == "body");
                    if let Some(body) = body {
                        for i in 0..body.child_count() {
                            if let Some(attr) = body.child(i) {
                                if attr.kind() == "attribute" {
                                    let key = attr
                                        .child_by_field_name("key")
                                        .or_else(|| attr.child(0));
                                    let val = attr
                                        .child_by_field_name("val")
                                        .or_else(|| attr.child(2));
                                    if let (Some(key), Some(val)) = (key, val) {
                                        if node_text(&key, source) == "source" {
                                            let src =
                                                node_text(&val, source).replace('"', "");
                                            if src.starts_with("./") || src.starts_with("../")
                                            {
                                                symbols.imports.push(Import::new(
                                                    src,
                                                    vec![],
                                                    start_line(&attr),
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
