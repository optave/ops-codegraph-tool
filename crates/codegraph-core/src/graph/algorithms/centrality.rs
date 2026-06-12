use std::collections::{HashMap, HashSet};

use crate::types::GraphEdge;
use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FanInOutEntry {
    pub node: String,
    #[napi(js_name = "fanIn")]
    pub fan_in: i32,
    #[napi(js_name = "fanOut")]
    pub fan_out: i32,
}

/// Compute fan-in (in-degree) and fan-out (out-degree) for all nodes.
#[napi]
pub fn fan_in_out(edges: Vec<GraphEdge>) -> Vec<FanInOutEntry> {
    let mut in_degree: HashMap<&str, i32> = HashMap::new();
    let mut out_degree: HashMap<&str, i32> = HashMap::new();
    let mut nodes: HashSet<&str> = HashSet::new();

    for edge in &edges {
        let src = edge.source.as_str();
        let tgt = edge.target.as_str();
        nodes.insert(src);
        nodes.insert(tgt);
        *out_degree.entry(src).or_insert(0) += 1;
        *in_degree.entry(tgt).or_insert(0) += 1;
    }

    nodes
        .into_iter()
        .map(|node| FanInOutEntry {
            node: node.to_string(),
            fan_in: *in_degree.get(node).unwrap_or(&0),
            fan_out: *out_degree.get(node).unwrap_or(&0),
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
    fn test_fan_in_out() {
        let edges = vec![edge("a", "b"), edge("a", "c"), edge("b", "c")];
        let result = fan_in_out(edges);
        let map: HashMap<String, (i32, i32)> = result
            .into_iter()
            .map(|e| (e.node, (e.fan_in, e.fan_out)))
            .collect();
        assert_eq!(map["a"], (0, 2));
        assert_eq!(map["b"], (1, 1));
        assert_eq!(map["c"], (2, 0));
    }
}
