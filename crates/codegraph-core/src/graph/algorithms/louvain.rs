use std::collections::{BTreeMap, HashMap};

use crate::shared::constants::{
    DEFAULT_RANDOM_SEED, LOUVAIN_MAX_LEVELS, LOUVAIN_MAX_PASSES, LOUVAIN_MIN_GAIN,
};
use crate::types::GraphEdge;
use napi_derive::napi;

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

/// Internal state for the Louvain multi-level loop.
///
/// `cur_edges` uses `BTreeMap` (not `HashMap`) so that iteration order is
/// deterministic across process runs. Rust's default `HashMap` hasher is
/// randomly seeded per-process (DoS resistance), so iterating a `HashMap`
/// here would silently reorder the adjacency list built in
/// `local_move_phase` on every run, changing which local optimum the greedy
/// local-move phase converges to even with a fixed `rng_state` seed (#1734).
struct LouvainState {
    cur_n: usize,
    cur_edges: BTreeMap<(usize, usize), f64>,
    cur_degree: Vec<f64>,
    original_community: Vec<usize>,
    rng_state: u32,
}

/// Build the initial index-based edge map and degree vector from raw edges.
fn louvain_init(
    edges: &[GraphEdge],
    node_ids: &[String],
    seed: u32,
) -> (BTreeMap<(usize, usize), f64>, f64, LouvainState) {
    let n = node_ids.len();
    let mut id_to_idx: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, id) in node_ids.iter().enumerate() {
        id_to_idx.insert(id.as_str(), i);
    }

    // Build undirected weighted edge list (deduplicate, merge parallel edges).
    // BTreeMap keeps this deterministically ordered by (src, tgt) — see the
    // `LouvainState.cur_edges` doc comment above for why this matters.
    let mut edge_map: BTreeMap<(usize, usize), f64> = BTreeMap::new();
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

    let mut cur_degree: Vec<f64> = vec![0.0; n];
    for (&(src, tgt), &w) in &edge_map {
        cur_degree[src] += w;
        cur_degree[tgt] += w;
    }

    let rng_state = if seed == 0 { 1 } else { seed };

    let state = LouvainState {
        cur_n: n,
        cur_edges: edge_map.clone(),
        cur_degree,
        original_community: (0..n).collect(),
        rng_state,
    };

    (edge_map, total_weight, state)
}

/// Xorshift32 PRNG step.
fn xorshift32(state: &mut u32) -> u32 {
    *state ^= *state << 13;
    *state ^= *state >> 17;
    *state ^= *state << 5;
    *state
}

/// Local move phase: greedily reassign nodes to communities to maximize modularity.
/// Returns true if any node moved.
fn local_move_phase(
    state: &mut LouvainState,
    resolution: f64,
    total_m2: f64,
) -> (Vec<usize>, bool) {
    let cur_n = state.cur_n;

    // Build adjacency list
    let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; cur_n];
    for (&(src, tgt), &w) in &state.cur_edges {
        adj[src].push((tgt, w));
        adj[tgt].push((src, w));
    }

    let mut level_comm: Vec<usize> = (0..cur_n).collect();
    let mut comm_total: Vec<f64> = state.cur_degree.clone();

    // Shuffle visit order with seeded RNG
    let mut order: Vec<usize> = (0..cur_n).collect();
    for i in (1..order.len()).rev() {
        let j = xorshift32(&mut state.rng_state) as usize % (i + 1);
        order.swap(i, j);
    }

    let mut any_moved = false;
    // BTreeMap (not HashMap) so the best-move scan below visits candidate
    // communities in a fixed, deterministic order — otherwise a genuine tie
    // in `gain` would be broken by Rust's per-process-randomized HashMap
    // iteration order instead of a reproducible rule (#1734). Hoisted out of
    // the node loop and cleared per-iteration instead of reallocated, since
    // `cur_n * LOUVAIN_MAX_PASSES` fresh allocations would otherwise show up
    // on very high-degree hub nodes.
    let mut comm_w: BTreeMap<usize, f64> = BTreeMap::new();
    for _pass in 0..LOUVAIN_MAX_PASSES {
        let mut pass_moved = false;
        for &node in &order {
            let node_comm = level_comm[node];
            let node_deg = state.cur_degree[node];

            comm_w.clear();
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

    (level_comm, any_moved)
}

/// Aggregation phase: renumber communities, compose original mapping, build coarse graph.
/// Returns false if no further coarsening is possible (convergence).
fn aggregation_phase(
    state: &mut LouvainState,
    level_comm: &mut Vec<usize>,
) -> bool {
    // Renumber communities contiguously
    let mut comm_remap: HashMap<usize, usize> = HashMap::new();
    let mut next_id: usize = 0;
    for &c in level_comm.iter() {
        if !comm_remap.contains_key(&c) {
            comm_remap.insert(c, next_id);
            next_id += 1;
        }
    }
    for c in level_comm.iter_mut() {
        *c = comm_remap[c];
    }
    let coarse_n = next_id;

    if coarse_n == state.cur_n {
        return false;
    }

    // Compose: update original_community through this level's assignments
    for oc in state.original_community.iter_mut() {
        *oc = level_comm[*oc];
    }

    // Build coarse graph for next level
    let mut coarse_edge_map: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for (&(src, tgt), &w) in &state.cur_edges {
        let cu = level_comm[src];
        let cv = level_comm[tgt];
        if cu == cv {
            continue;
        }
        let key = if cu < cv { (cu, cv) } else { (cv, cu) };
        *coarse_edge_map.entry(key).or_insert(0.0) += w;
    }

    let mut coarse_degree: Vec<f64> = vec![0.0; coarse_n];
    for (i, &deg) in state.cur_degree.iter().enumerate() {
        coarse_degree[level_comm[i]] += deg;
    }

    state.cur_n = coarse_n;
    state.cur_edges = coarse_edge_map;
    state.cur_degree = coarse_degree;

    true
}

/// Compute final modularity score: Q = sum_c [ L_c / m - gamma * (k_c / 2m)^2 ]
fn compute_modularity(
    edge_map: &BTreeMap<(usize, usize), f64>,
    original_community: &[usize],
    total_weight: f64,
    resolution: f64,
    n: usize,
) -> f64 {
    let m = total_weight;
    let m2 = 2.0 * m;

    let mut orig_degree: Vec<f64> = vec![0.0; n];
    for (&(src, tgt), &w) in edge_map {
        orig_degree[src] += w;
        orig_degree[tgt] += w;
    }

    let max_comm = original_community.iter().copied().max().unwrap_or(0) + 1;
    let mut kc: Vec<f64> = vec![0.0; max_comm];
    let mut lc: Vec<f64> = vec![0.0; max_comm];

    for (i, &deg) in orig_degree.iter().enumerate() {
        kc[original_community[i]] += deg;
    }
    for (&(src, tgt), &w) in edge_map {
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
    modularity
}

fn louvain_impl(
    edges: &[GraphEdge],
    node_ids: &[String],
    resolution: f64,
    seed: u32,
) -> LouvainResult {
    let n = node_ids.len();
    let (edge_map, total_weight, mut state) = louvain_init(edges, node_ids, seed);

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

    // m2 = 2 x total edge weight of the ORIGINAL graph -- a constant across all levels.
    // Recalculating from cur_edges would undercount because coarsening strips intra-community
    // edges, inflating the penalty term and causing under-merging at coarser levels.
    let total_m2: f64 = 2.0 * total_weight;

    for _level in 0..LOUVAIN_MAX_LEVELS {
        if state.cur_edges.is_empty() {
            break;
        }

        let (mut level_comm, any_moved) = local_move_phase(&mut state, resolution, total_m2);
        if !any_moved {
            break;
        }

        if !aggregation_phase(&mut state, &mut level_comm) {
            break;
        }
    }

    let modularity = compute_modularity(&edge_map, &state.original_community, total_weight, resolution, n);

    let assignments = node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| CommunityAssignment {
            node: id.clone(),
            community: state.original_community[i] as i32,
        })
        .collect();

    LouvainResult {
        assignments,
        modularity,
    }
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

    /// Regression test for #1734: `codegraph communities --drift` produced
    /// different modularity/community assignments across separate full
    /// rebuilds of byte-identical source. Root cause: `local_move_phase`
    /// accumulated per-candidate-community weights in a `HashMap`, whose
    /// iteration order is randomized per-process — so a genuine tie in
    /// modularity gain between candidate communities was broken by hashmap
    /// bucket order instead of a reproducible rule, even with a fixed
    /// `random_seed`. Fixed by switching `cur_edges`/`comm_w` to `BTreeMap`.
    ///
    /// This graph is symmetric by construction — three disjoint triangles
    /// plus a bridge node connected with equal weight to one member of each
    /// triangle — so moving the bridge node into any of the three triangles
    /// yields the exact same modularity gain, forcing a genuine tie on every
    /// run of the local-move phase.
    #[test]
    fn test_louvain_deterministic_across_repeated_calls_with_tie() {
        let edges = vec![
            edge("a1", "a2"),
            edge("a2", "a3"),
            edge("a3", "a1"),
            edge("b1", "b2"),
            edge("b2", "b3"),
            edge("b3", "b1"),
            edge("c1", "c2"),
            edge("c2", "c3"),
            edge("c3", "c1"),
            edge("x", "a1"),
            edge("x", "b1"),
            edge("x", "c1"),
        ];
        let nodes: Vec<String> = vec!["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3", "x"]
            .into_iter()
            .map(String::from)
            .collect();

        let mut snapshots: Vec<(String, f64)> = Vec::new();
        for _ in 0..30 {
            let result = louvain_communities(edges.clone(), nodes.clone(), Some(1.0), Some(42));
            let mut pairs: Vec<String> = result
                .assignments
                .iter()
                .map(|a| format!("{}:{}", a.node, a.community))
                .collect();
            pairs.sort();
            snapshots.push((pairs.join(","), result.modularity));
        }

        let first = &snapshots[0];
        for (i, snapshot) in snapshots.iter().enumerate().skip(1) {
            assert_eq!(
                snapshot.0, first.0,
                "run {i} produced a different assignment than run 0 — \
                 tie-breaking is not deterministic"
            );
            assert_eq!(
                snapshot.1, first.1,
                "run {i} produced a different modularity than run 0"
            );
        }
    }
}
