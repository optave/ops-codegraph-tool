use tree_sitter::Node;

/// Get the text of a node from the source bytes.
pub fn node_text<'a>(node: &Node, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
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
