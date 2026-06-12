use std::collections::{HashMap, VecDeque};

use super::DirectedGraph;
use crate::types::GraphEdge;
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BfsEntry {
    pub node: String,
    pub depth: i32,
}

/// Pick the neighbor set used by `bfs_traversal` for the requested direction.
/// "backward" → predecessors, "both" → predecessors + successors,
/// anything else → successors. Mirrors the JS direction enum.
fn bfs_neighbors_for_direction<'a>(
    graph: &'a DirectedGraph<'a>,
    current: &str,
    direction: &str,
) -> Vec<&'a str> {
    match direction {
        "backward" => graph
            .predecessors
            .get(current)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
            .to_vec(),
        "both" => {
            let mut all: Vec<&str> = Vec::new();
            if let Some(succ) = graph.successors.get(current) {
                all.extend(succ.iter());
            }
            if let Some(pred) = graph.predecessors.get(current) {
                all.extend(pred.iter());
            }
            all
        }
        _ => graph
            .successors
            .get(current)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
            .to_vec(),
    }
}

/// BFS traversal on a directed graph built from edges.
/// `direction`: "forward" (default), "backward", or "both".
/// Returns node→depth pairs for all reachable nodes.
#[napi]
pub fn bfs_traversal(
    edges: Vec<GraphEdge>,
    start_ids: Vec<String>,
    max_depth: Option<u32>,
    direction: Option<String>,
) -> Vec<BfsEntry> {
    let graph = DirectedGraph::from_edges(&edges);
    let max_depth = max_depth.unwrap_or(u32::MAX);
    let dir = direction.as_deref().unwrap_or("forward");

    let mut depths: HashMap<&str, u32> = HashMap::new();
    let mut queue: VecDeque<&str> = VecDeque::new();

    for id in &start_ids {
        let key = id.as_str();
        if graph.nodes.contains(key) && !depths.contains_key(key) {
            depths.insert(key, 0);
            queue.push_back(key);
        }
    }

    while let Some(current) = queue.pop_front() {
        let depth = depths[current];
        if depth >= max_depth {
            continue;
        }
        for n in bfs_neighbors_for_direction(&graph, current, dir) {
            if !depths.contains_key(n) {
                depths.insert(n, depth + 1);
                queue.push_back(n);
            }
        }
    }

    depths
        .into_iter()
        .map(|(node, depth)| BfsEntry {
            node: node.to_string(),
            depth: depth as i32,
        })
        .collect()
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
    fn test_bfs_forward() {
        let edges = vec![edge("a", "b"), edge("b", "c"), edge("c", "d")];
        let result = bfs_traversal(edges, vec!["a".into()], None, None);
        let map: HashMap<String, i32> = result.into_iter().map(|e| (e.node, e.depth)).collect();
        assert_eq!(map["a"], 0);
        assert_eq!(map["b"], 1);
        assert_eq!(map["c"], 2);
        assert_eq!(map["d"], 3);
    }

    #[test]
    fn test_bfs_max_depth() {
        let edges = vec![edge("a", "b"), edge("b", "c"), edge("c", "d")];
        let result = bfs_traversal(edges, vec!["a".into()], Some(2), None);
        let map: HashMap<String, i32> = result.into_iter().map(|e| (e.node, e.depth)).collect();
        assert_eq!(map.get("a"), Some(&0));
        assert_eq!(map.get("b"), Some(&1));
        assert_eq!(map.get("c"), Some(&2));
        assert_eq!(map.get("d"), None);
    }

    #[test]
    fn test_bfs_backward() {
        let edges = vec![edge("a", "b"), edge("b", "c")];
        let result = bfs_traversal(edges, vec!["c".into()], None, Some("backward".into()));
        let map: HashMap<String, i32> = result.into_iter().map(|e| (e.node, e.depth)).collect();
        assert_eq!(map["c"], 0);
        assert_eq!(map["b"], 1);
        assert_eq!(map["a"], 2);
    }
}
