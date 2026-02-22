use std::collections::HashMap;

use crate::types::GraphEdge;

/// Detect cycles using Tarjan's strongly connected components algorithm.
/// Returns SCCs with size > 1 (actual cycles).
/// Mirrors the JS implementation in src/cycles.js.
pub fn detect_cycles(edges: &[GraphEdge]) -> Vec<Vec<String>> {
    // Build adjacency list
    let mut graph: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        graph
            .entry(edge.source.as_str())
            .or_default()
            .push(edge.target.as_str());
        graph.entry(edge.target.as_str()).or_default();
    }

    let mut state = TarjanState {
        index: 0,
        stack: Vec::new(),
        on_stack: HashMap::new(),
        indices: HashMap::new(),
        lowlinks: HashMap::new(),
        sccs: Vec::new(),
    };

    let nodes: Vec<&str> = graph.keys().copied().collect();
    for node in nodes {
        if !state.indices.contains_key(node) {
            strongconnect(node, &graph, &mut state);
        }
    }

    state.sccs
}

struct TarjanState<'a> {
    index: usize,
    stack: Vec<&'a str>,
    on_stack: HashMap<&'a str, bool>,
    indices: HashMap<&'a str, usize>,
    lowlinks: HashMap<&'a str, usize>,
    sccs: Vec<Vec<String>>,
}

fn strongconnect<'a>(
    v: &'a str,
    graph: &HashMap<&'a str, Vec<&'a str>>,
    state: &mut TarjanState<'a>,
) {
    state.indices.insert(v, state.index);
    state.lowlinks.insert(v, state.index);
    state.index += 1;
    state.stack.push(v);
    state.on_stack.insert(v, true);

    if let Some(neighbors) = graph.get(v) {
        for &w in neighbors {
            if !state.indices.contains_key(w) {
                strongconnect(w, graph, state);
                let low_w = state.lowlinks[w];
                let low_v = state.lowlinks[v];
                state.lowlinks.insert(v, low_v.min(low_w));
            } else if state.on_stack.get(w).copied().unwrap_or(false) {
                let idx_w = state.indices[w];
                let low_v = state.lowlinks[v];
                state.lowlinks.insert(v, low_v.min(idx_w));
            }
        }
    }

    if state.lowlinks[v] == state.indices[v] {
        let mut scc = Vec::new();
        loop {
            let w = state.stack.pop().unwrap();
            state.on_stack.insert(w, false);
            scc.push(w.to_string());
            if w == v {
                break;
            }
        }
        if scc.len() > 1 {
            state.sccs.push(scc);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_cycles() {
        let edges = vec![
            GraphEdge {
                source: "a".to_string(),
                target: "b".to_string(),
            },
            GraphEdge {
                source: "b".to_string(),
                target: "c".to_string(),
            },
        ];
        let cycles = detect_cycles(&edges);
        assert!(cycles.is_empty());
    }

    #[test]
    fn test_simple_cycle() {
        let edges = vec![
            GraphEdge {
                source: "a".to_string(),
                target: "b".to_string(),
            },
            GraphEdge {
                source: "b".to_string(),
                target: "a".to_string(),
            },
        ];
        let cycles = detect_cycles(&edges);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].len(), 2);
    }

    #[test]
    fn test_triangle_cycle() {
        let edges = vec![
            GraphEdge {
                source: "a".to_string(),
                target: "b".to_string(),
            },
            GraphEdge {
                source: "b".to_string(),
                target: "c".to_string(),
            },
            GraphEdge {
                source: "c".to_string(),
                target: "a".to_string(),
            },
        ];
        let cycles = detect_cycles(&edges);
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].len(), 3);
    }

    #[test]
    fn test_multiple_cycles() {
        let edges = vec![
            GraphEdge {
                source: "a".to_string(),
                target: "b".to_string(),
            },
            GraphEdge {
                source: "b".to_string(),
                target: "a".to_string(),
            },
            GraphEdge {
                source: "c".to_string(),
                target: "d".to_string(),
            },
            GraphEdge {
                source: "d".to_string(),
                target: "c".to_string(),
            },
        ];
        let cycles = detect_cycles(&edges);
        assert_eq!(cycles.len(), 2);
    }
}
