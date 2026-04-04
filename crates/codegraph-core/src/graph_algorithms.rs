use std::collections::{HashMap, HashSet, VecDeque};

use crate::constants::{DEFAULT_RANDOM_SEED, LOUVAIN_MAX_LEVELS, LOUVAIN_MAX_PASSES, LOUVAIN_MIN_GAIN};
use crate::types::GraphEdge;
use napi_derive::napi;

// ─── Result types ────────────────────────────────────────────────────

#[napi(object)]
#[derive(Debug, Clone)]
pub struct BfsEntry {
    pub node: String,
    pub depth: i32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct FanInOutEntry {
    pub node: String,
    #[napi(js_name = "fanIn")]
    pub fan_in: i32,
    #[napi(js_name = "fanOut")]
    pub fan_out: i32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct CommunityAssignment {
    pub node: String,
    pub community: i32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct LouvainResult {
    pub assignments: Vec<CommunityAssignment>,
    pub modularity: f64,
}

// ─── Adjacency builder ──────────────────────────────────────────────

struct DirectedGraph<'a> {
    successors: HashMap<&'a str, Vec<&'a str>>,
    predecessors: HashMap<&'a str, Vec<&'a str>>,
    nodes: HashSet<&'a str>,
}

impl<'a> DirectedGraph<'a> {
    fn from_edges(edges: &'a [GraphEdge]) -> Self {
        let mut successors: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut predecessors: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut nodes: HashSet<&str> = HashSet::new();

        for edge in edges {
            let src = edge.source.as_str();
            let tgt = edge.target.as_str();
            nodes.insert(src);
            nodes.insert(tgt);
            successors.entry(src).or_default().push(tgt);
            predecessors.entry(tgt).or_default().push(src);
            successors.entry(tgt).or_default();
            predecessors.entry(src).or_default();
        }

        Self {
            successors,
            predecessors,
            nodes,
        }
    }
}

// ─── BFS ─────────────────────────────────────────────────────────────

/// BFS traversal on a directed graph built from edges.
/// `direction`: "forward" (default), "backward", or "both".
/// Returns node→depth pairs for all reachable nodes.
#[napi]
pub fn bfs_traversal(
    edges: Vec<GraphEdge>,
    start_ids: Vec<String>,
    max_depth: Option<i32>,
    direction: Option<String>,
) -> Vec<BfsEntry> {
    let graph = DirectedGraph::from_edges(&edges);
    let max_depth = max_depth.unwrap_or(i32::MAX);
    let dir = direction.as_deref().unwrap_or("forward");

    let mut depths: HashMap<&str, i32> = HashMap::new();
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

        let neighbors: Vec<&str> = match dir {
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
        };

        for n in neighbors {
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
            depth,
        })
        .collect()
}

// ─── Shortest path ───────────────────────────────────────────────────

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
        if let Some(neighbors) = graph.successors.get(current) {
            for &neighbor in neighbors {
                if parent.contains_key(neighbor) {
                    continue;
                }
                parent.insert(neighbor, Some(current));
                if neighbor == to_id.as_str() {
                    let mut path: Vec<String> = Vec::new();
                    let mut node: Option<&str> = Some(neighbor);
                    while let Some(n) = node {
                        path.push(n.to_string());
                        node = parent.get(n).copied().flatten();
                    }
                    path.reverse();
                    return path;
                }
                queue.push_back(neighbor);
            }
        }
    }

    vec![]
}

// ─── Fan-in / Fan-out centrality ─────────────────────────────────────

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

// ─── Louvain community detection ─────────────────────────────────────

/// Classic Louvain algorithm for undirected community detection.
///
/// Takes an edge list and treats it as undirected. Optimizes modularity
/// via the standard two-phase Louvain approach:
/// 1. Local phase: greedily move nodes to maximize modularity gain
/// 2. Aggregation phase: collapse communities into super-nodes and repeat
#[napi]
pub fn louvain_communities(
    edges: Vec<GraphEdge>,
    node_ids: Vec<String>,
    resolution: Option<f64>,
    random_seed: Option<u32>,
) -> LouvainResult {
    if edges.is_empty() || node_ids.is_empty() {
        return LouvainResult {
            assignments: vec![],
            modularity: 0.0,
        };
    }
    louvain_impl(
        &edges,
        &node_ids,
        resolution.unwrap_or(1.0),
        random_seed.unwrap_or(DEFAULT_RANDOM_SEED),
    )
}

fn louvain_impl(
    edges: &[GraphEdge],
    node_ids: &[String],
    resolution: f64,
    seed: u32,
) -> LouvainResult {
    let n = node_ids.len();
    let mut id_to_idx: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, id) in node_ids.iter().enumerate() {
        id_to_idx.insert(id.as_str(), i);
    }

    // Build undirected weighted edge list (deduplicate, merge parallel edges)
    let mut edge_map: HashMap<(usize, usize), f64> = HashMap::new();
    for edge in edges {
        if let (Some(&src), Some(&tgt)) = (
            id_to_idx.get(edge.source.as_str()),
            id_to_idx.get(edge.target.as_str()),
        ) {
            if src == tgt {
                continue;
            }
            let key = if src < tgt { (src, tgt) } else { (tgt, src) };
            *edge_map.entry(key).or_insert(0.0) += 1.0;
        }
    }

    let total_weight: f64 = edge_map.values().sum();
    if total_weight == 0.0 {
        return LouvainResult {
            assignments: node_ids
                .iter()
                .enumerate()
                .map(|(i, id)| CommunityAssignment {
                    node: id.clone(),
                    community: i as i32,
                })
                .collect(),
            modularity: 0.0,
        };
    }

    // original_community[i] tracks each original node's final community
    let mut original_community: Vec<usize> = (0..n).collect();

    // Current level's graph
    let mut cur_n = n;
    let mut cur_edges = edge_map.clone();
    let mut cur_degree: Vec<f64> = vec![0.0; cur_n];
    for (&(src, tgt), &w) in &cur_edges {
        cur_degree[src] += w;
        cur_degree[tgt] += w;
    }

    // Seeded xorshift32 RNG
    let mut rng_state: u32 = if seed == 0 { 1 } else { seed };
    let mut next_rand = || -> u32 {
        rng_state ^= rng_state << 13;
        rng_state ^= rng_state >> 17;
        rng_state ^= rng_state << 5;
        rng_state
    };

    // m2 = 2 × total edge weight of the ORIGINAL graph — a constant across all levels.
    // Recalculating from cur_edges would undercount because coarsening strips intra-community
    // edges, inflating the penalty term and causing under-merging at coarser levels.
    let total_m2: f64 = 2.0 * total_weight;

    for _level in 0..LOUVAIN_MAX_LEVELS {
        if cur_edges.is_empty() {
            break;
        }

        // Build adjacency list
        let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; cur_n];
        for (&(src, tgt), &w) in &cur_edges {
            adj[src].push((tgt, w));
            adj[tgt].push((src, w));
        }

        // Local phase: greedy modularity optimization
        let mut level_comm: Vec<usize> = (0..cur_n).collect();
        let mut comm_total: Vec<f64> = cur_degree.clone();

        let mut order: Vec<usize> = (0..cur_n).collect();
        for i in (1..order.len()).rev() {
            let j = next_rand() as usize % (i + 1);
            order.swap(i, j);
        }

        let mut any_moved = false;
        for _pass in 0..LOUVAIN_MAX_PASSES {
            let mut pass_moved = false;
            for &node in &order {
                let node_comm = level_comm[node];
                let node_deg = cur_degree[node];

                let mut comm_w: HashMap<usize, f64> = HashMap::new();
                for &(neighbor, w) in &adj[node] {
                    *comm_w.entry(level_comm[neighbor]).or_insert(0.0) += w;
                }

                let w_own = *comm_w.get(&node_comm).unwrap_or(&0.0);
                let remove_cost =
                    w_own - resolution * node_deg * (comm_total[node_comm] - node_deg) / total_m2;

                let mut best_comm = node_comm;
                let mut best_gain: f64 = 0.0;

                for (&target_comm, &w_target) in &comm_w {
                    if target_comm == node_comm {
                        continue;
                    }
                    let gain = w_target
                        - resolution * node_deg * comm_total[target_comm] / total_m2
                        - remove_cost;
                    if gain > best_gain {
                        best_gain = gain;
                        best_comm = target_comm;
                    }
                }

                if best_comm != node_comm && best_gain > LOUVAIN_MIN_GAIN {
                    comm_total[node_comm] -= node_deg;
                    comm_total[best_comm] += node_deg;
                    level_comm[node] = best_comm;
                    pass_moved = true;
                    any_moved = true;
                }
            }
            if !pass_moved {
                break;
            }
        }

        if !any_moved {
            break;
        }

        // Renumber communities contiguously
        let mut comm_remap: HashMap<usize, usize> = HashMap::new();
        let mut next_id: usize = 0;
        for &c in &level_comm {
            if !comm_remap.contains_key(&c) {
                comm_remap.insert(c, next_id);
                next_id += 1;
            }
        }
        for c in level_comm.iter_mut() {
            *c = comm_remap[c];
        }
        let coarse_n = next_id;

        if coarse_n == cur_n {
            break;
        }

        // Compose: update original_community through this level's assignments
        for oc in original_community.iter_mut() {
            *oc = level_comm[*oc];
        }

        // Build coarse graph for next level
        let mut coarse_edge_map: HashMap<(usize, usize), f64> = HashMap::new();
        for (&(src, tgt), &w) in &cur_edges {
            let cu = level_comm[src];
            let cv = level_comm[tgt];
            if cu == cv {
                continue;
            }
            let key = if cu < cv { (cu, cv) } else { (cv, cu) };
            *coarse_edge_map.entry(key).or_insert(0.0) += w;
        }

        let mut coarse_degree: Vec<f64> = vec![0.0; coarse_n];
        for (i, &deg) in cur_degree.iter().enumerate() {
            coarse_degree[level_comm[i]] += deg;
        }

        cur_n = coarse_n;
        cur_edges = coarse_edge_map;
        cur_degree = coarse_degree;
    }

    // Compute modularity: Q = sum_c [ L_c / m - gamma * (k_c / 2m)^2 ]
    let m = total_weight;
    let m2 = 2.0 * m;

    let mut orig_degree: Vec<f64> = vec![0.0; n];
    for (&(src, tgt), &w) in &edge_map {
        orig_degree[src] += w;
        orig_degree[tgt] += w;
    }

    let max_comm = original_community.iter().copied().max().unwrap_or(0) + 1;
    let mut kc: Vec<f64> = vec![0.0; max_comm];
    let mut lc: Vec<f64> = vec![0.0; max_comm];

    for (i, &deg) in orig_degree.iter().enumerate() {
        kc[original_community[i]] += deg;
    }
    for (&(src, tgt), &w) in &edge_map {
        if original_community[src] == original_community[tgt] {
            lc[original_community[src]] += w;
        }
    }

    let mut modularity: f64 = 0.0;
    for c in 0..max_comm {
        if kc[c] > 0.0 {
            modularity += lc[c] / m - resolution * (kc[c] / m2).powi(2);
        }
    }

    let assignments = node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| CommunityAssignment {
            node: id.clone(),
            community: original_community[i] as i32,
        })
        .collect();

    LouvainResult {
        assignments,
        modularity,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

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

    #[test]
    fn test_louvain_empty() {
        let result = louvain_communities(vec![], vec![], None, None);
        assert!(result.assignments.is_empty());
        assert_eq!(result.modularity, 0.0);
    }

    #[test]
    fn test_louvain_two_cliques() {
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "a"),
            edge("d", "e"),
            edge("e", "f"),
            edge("f", "d"),
        ];
        let nodes: Vec<String> = vec!["a", "b", "c", "d", "e", "f"]
            .into_iter()
            .map(String::from)
            .collect();
        let result = louvain_communities(edges, nodes, None, None);

        let map: HashMap<String, i32> = result
            .assignments
            .into_iter()
            .map(|a| (a.node, a.community))
            .collect();
        assert_eq!(map["a"], map["b"]);
        assert_eq!(map["b"], map["c"]);
        assert_eq!(map["d"], map["e"]);
        assert_eq!(map["e"], map["f"]);
        assert_ne!(map["a"], map["d"]);
        assert!(result.modularity > 0.0);
    }

    #[test]
    fn test_louvain_single_component() {
        let edges = vec![edge("a", "b"), edge("a", "c"), edge("b", "c")];
        let nodes: Vec<String> = vec!["a", "b", "c"].into_iter().map(String::from).collect();
        let result = louvain_communities(edges, nodes, None, None);
        let map: HashMap<String, i32> = result
            .assignments
            .into_iter()
            .map(|a| (a.node, a.community))
            .collect();
        assert_eq!(map["a"], map["b"]);
        assert_eq!(map["b"], map["c"]);
    }
}
