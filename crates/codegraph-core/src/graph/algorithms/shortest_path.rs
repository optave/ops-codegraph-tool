use std::collections::{HashMap, VecDeque};

use super::DirectedGraph;
use crate::types::GraphEdge;
use napi_derive::napi;

/// Walk the parent pointers produced by a BFS back from `terminal` to the
/// start node and return the path as a `Vec<String>` (start → terminal).
fn reconstruct_bfs_path<'a>(
    parent: &HashMap<&'a str, Option<&'a str>>,
    terminal: &'a str,
) -> Vec<String> {
    let mut path: Vec<String> = Vec::new();
    let mut node: Option<&str> = Some(terminal);
    while let Some(n) = node {
        path.push(n.to_string());
        node = parent.get(n).copied().flatten();
    }
    path.reverse();
    path
}

/// BFS-based shortest path on a directed graph.
/// Returns the path from `from_id` to `to_id` (inclusive), or empty if unreachable.
#[napi]
pub fn shortest_path(edges: Vec<GraphEdge>, from_id: String, to_id: String) -> Vec<String> {
    let graph = DirectedGraph::from_edges(&edges);

    if !graph.nodes.contains(from_id.as_str()) || !graph.nodes.contains(to_id.as_str()) {
        return vec![];
    }
    if from_id == to_id {
        return vec![from_id];
    }

    let mut parent: HashMap<&str, Option<&str>> = HashMap::new();
    parent.insert(from_id.as_str(), None);
    let mut queue: VecDeque<&str> = VecDeque::new();
    queue.push_back(from_id.as_str());

    while let Some(current) = queue.pop_front() {
        let neighbors = match graph.successors.get(current) {
            Some(n) => n,
            None => continue,
        };
        for &neighbor in neighbors {
            if parent.contains_key(neighbor) {
                continue;
            }
            parent.insert(neighbor, Some(current));
            if neighbor == to_id.as_str() {
                return reconstruct_bfs_path(&parent, neighbor);
            }
            queue.push_back(neighbor);
        }
    }

    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(src: &str, tgt: &str) -> GraphEdge {
        GraphEdge {
            source: src.to_string(),
            target: tgt.to_string(),
        }
    }

    #[test]
    fn test_shortest_path_found() {
        let edges = vec![edge("a", "b"), edge("b", "c"), edge("a", "c")];
        let path = shortest_path(edges, "a".into(), "c".into());
        assert_eq!(path, vec!["a", "c"]);
    }

    #[test]
    fn test_shortest_path_not_found() {
        let edges = vec![edge("a", "b")];
        let path = shortest_path(edges, "b".into(), "a".into());
        assert!(path.is_empty());
    }

    #[test]
    fn test_shortest_path_same_node() {
        let edges = vec![edge("a", "b")];
        let path = shortest_path(edges, "a".into(), "a".into());
        assert_eq!(path, vec!["a"]);
    }
}
