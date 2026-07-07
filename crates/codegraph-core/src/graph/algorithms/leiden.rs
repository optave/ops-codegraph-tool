//! Leiden community detection (undirected modularity), ported from the
//! TypeScript reference implementation in `src/graph/algorithms/leiden/*`
//! (vendored from ngraph.leiden, MIT — see that directory's LICENSE) to fix
//! issue #1804: the native (this file, formerly classic Louvain) and JS
//! fallback (`detectClusters` in the TS `leiden/` directory) engines used to
//! run two genuinely different community-detection algorithms, so
//! `codegraph communities`/`--drift` reported different partitions purely
//! based on whether the native addon loaded. Both engines must now run
//! Leiden.
//!
//! ## Scope
//!
//! This port covers exactly the option surface reachable through
//! `louvainCommunities`/`LouvainOptions`
//! (`src/graph/algorithms/louvain.ts`): undirected graphs, modularity
//! quality (not CPM), the default "neighbors" candidate strategy,
//! `refine: true` (always), uniform node size (1.0) and edge weight (1.0
//! per edge — `GraphEdge` carries no weight field), no
//! `maxCommunitySize`/`fixedNodes`/`preserveLabels` overrides. These are the
//! *only* knobs `louvainCommunities` ever threads through to either engine
//! (see `LouvainOptions` and `louvainJS()`'s call into `detectClusters`).
//!
//! The TS `leiden/` directory's directed-graph mode, CPM quality function,
//! alternate candidate strategies (all/random/random-neighbor),
//! `allowNewCommunity`, `fixedNodes`, and `preserveLabels` knobs are **not**
//! ported — they are unreachable from this binding today. Issue #1936
//! tracks porting that remaining surface if a caller ever needs to drive
//! native Leiden with it.
//!
//! ## Determinism
//!
//! Every place the TS reference relies on `Map`/`Array` *insertion order*
//! (not sorted order) to break ties deterministically, this port uses an
//! explicit insertion-order-preserving structure (a `Vec` of records plus a
//! `HashMap` used purely for O(1) index lookup, never iterated) rather than
//! a `BTreeMap`. A `BTreeMap` would still be deterministic across runs, but
//! it iterates in *sorted* order, which does not match the TS reference's
//! *insertion* order — silently reordering a node's adjacency list relative
//! to the JS engine and changing which candidate community wins a tie in
//! the local-move/refinement phases. That would reintroduce a cross-engine
//! divergence of exactly the kind this file exists to fix, so `HashMap` is
//! used strictly as a lookup index here, never as an iterated collection.
//!
//! Separately (and orthogonally), every `HashMap` used as a plain lookup
//! (e.g. `id_to_idx`) is safe from issue #1734's failure mode (Rust's
//! per-process-randomized hasher reordering iteration) because it is never
//! iterated — only `.get()`/`.insert()` are used.

use std::collections::HashMap;

use napi_derive::napi;

use crate::shared::constants::{
    DEFAULT_RANDOM_SEED, LEIDEN_DEFAULT_CAPACITY_GROWTH_FACTOR, LEIDEN_DEFAULT_MAX_LEVELS,
    LEIDEN_DEFAULT_MAX_LOCAL_PASSES, LEIDEN_DEFAULT_REFINEMENT_THETA, LEIDEN_DEFAULT_RESOLUTION,
    LEIDEN_GAIN_EPSILON,
};
use crate::types::GraphEdge;

// ════════════════════════════════════════════════════════════════════════
// napi-facing types + entry point
// ════════════════════════════════════════════════════════════════════════

#[napi(object)]
#[derive(Debug, Clone)]
pub struct LeidenCommunityAssignment {
    pub node: String,
    pub community: i32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct LeidenCommunitiesResult {
    pub assignments: Vec<LeidenCommunityAssignment>,
    pub modularity: f64,
}

/// Leiden community detection (undirected modularity optimization).
///
/// Mirrors `detectClusters(graph, { resolution, randomSeed, directed: false,
/// maxLevels, maxLocalPasses, refinementTheta, capacityGrowthFactor })` in
/// `src/graph/algorithms/leiden/index.ts` exactly — see the module doc for
/// the precise (and deliberately narrower) option surface covered.
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn leiden_communities(
    edges: Vec<GraphEdge>,
    node_ids: Vec<String>,
    resolution: Option<f64>,
    random_seed: Option<u32>,
    max_levels: Option<u32>,
    max_local_passes: Option<u32>,
    refinement_theta: Option<f64>,
    capacity_growth_factor: Option<f64>,
) -> LeidenCommunitiesResult {
    if edges.is_empty() || node_ids.is_empty() {
        return LeidenCommunitiesResult {
            assignments: vec![],
            modularity: 0.0,
        };
    }

    let cfg = LeidenConfig {
        resolution: resolution.unwrap_or(LEIDEN_DEFAULT_RESOLUTION),
        max_levels: (max_levels.unwrap_or(LEIDEN_DEFAULT_MAX_LEVELS as u32) as usize).max(1),
        max_local_passes: (max_local_passes.unwrap_or(LEIDEN_DEFAULT_MAX_LOCAL_PASSES as u32)
            as usize)
            .max(1),
        // TS throws a RangeError for theta <= 0 (optimiser.ts). This binding
        // is never reached with a caller-controlled theta outside
        // `.codegraphrc.json`'s `community.refinementTheta` (config default
        // 1.0), so rather than panic across the FFI boundary for a
        // misconfiguration, fall back to the default -- strictly safer than
        // the old native path, which silently ignored this option entirely.
        refinement_theta: refinement_theta
            .filter(|&t| t > 0.0)
            .unwrap_or(LEIDEN_DEFAULT_REFINEMENT_THETA),
        capacity_growth_factor: capacity_growth_factor
            .unwrap_or(LEIDEN_DEFAULT_CAPACITY_GROWTH_FACTOR),
    };
    let seed = random_seed.unwrap_or(DEFAULT_RANDOM_SEED);

    let n = node_ids.len();
    let mut id_to_idx: HashMap<&str, usize> = HashMap::with_capacity(n);
    for (i, id) in node_ids.iter().enumerate() {
        id_to_idx.insert(id.as_str(), i);
    }
    // Edge weight is always 1.0: `GraphEdge` carries no weight field, and
    // `graph.toEdgeArray()` (the sole caller, in louvain.ts) never attaches
    // one either -- matching the TS reference's default `linkWeight`
    // fallback, which is the only value ever exercised by this binding.
    let raw_edges: Vec<(usize, usize, f64)> = edges
        .iter()
        .filter_map(|e| {
            let a = *id_to_idx.get(e.source.as_str())?;
            let b = *id_to_idx.get(e.target.as_str())?;
            Some((a, b, 1.0))
        })
        .collect();

    let base_graph = build_adapter(n, &raw_edges, &vec![1.0; n]);

    if base_graph.total_weight == 0.0 {
        return LeidenCommunitiesResult {
            assignments: node_ids
                .iter()
                .enumerate()
                .map(|(i, id)| LeidenCommunityAssignment {
                    node: id.clone(),
                    community: i as i32,
                })
                .collect(),
            modularity: 0.0,
        };
    }

    let original_to_current = run_leiden(&base_graph, &cfg, seed);
    let modularity = compute_final_modularity(&base_graph, &original_to_current);

    let assignments = node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| LeidenCommunityAssignment {
            node: id.clone(),
            community: original_to_current[i] as i32,
        })
        .collect();

    LeidenCommunitiesResult {
        assignments,
        modularity,
    }
}

// ════════════════════════════════════════════════════════════════════════
// Configuration
// ════════════════════════════════════════════════════════════════════════

#[derive(Clone, Copy)]
struct LeidenConfig {
    resolution: f64,
    max_levels: usize,
    max_local_passes: usize,
    refinement_theta: f64,
    capacity_growth_factor: f64,
}

// ════════════════════════════════════════════════════════════════════════
// RNG — mulberry32, bit-for-bit port of src/graph/algorithms/leiden/rng.ts
// ════════════════════════════════════════════════════════════════════════

/// Mulberry32 PRNG. All arithmetic is done on `u32` with wrapping ops, which
/// is bit-for-bit equivalent to the TS reference's `|0`/`>>>`/`Math.imul`
/// int32 bit-pattern arithmetic: JS's 32-bit bitwise/imul operations only
/// ever depend on the operands' 32-bit bit patterns, not their signed vs.
/// unsigned interpretation, so representing the state as `u32` throughout
/// (rather than mirroring JS's "signed int32" framing) preserves the exact
/// same bit patterns at every step.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let s = self.state;
        let t0 = (s ^ (s >> 15)).wrapping_mul(1 | s);
        let t = t0.wrapping_add((t0 ^ (t0 >> 7)).wrapping_mul(61 | t0)) ^ t0;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// Fisher-Yates shuffle, in the exact same iteration/draw order as
/// `shuffleArrayInPlace` in optimiser.ts.
fn shuffle_in_place(arr: &mut [usize], rng: &mut Mulberry32) {
    for i in (1..arr.len()).rev() {
        let j = (rng.next_f64() * (i + 1) as f64).floor() as usize;
        arr.swap(i, j);
    }
}

// ════════════════════════════════════════════════════════════════════════
// Graph adapter — undirected-only port of leiden/adapter.ts
// ════════════════════════════════════════════════════════════════════════

struct GraphAdapter {
    n: usize,
    /// Self-loop weight per node (single-w convention, matching adapter.ts).
    self_loop: Vec<f64>,
    /// Node strength (== degree for unweighted graphs). TS keeps separate
    /// `strengthOut`/`strengthIn` arrays even in undirected mode (both
    /// populated identically by symmetrization), but only `strengthOut` is
    /// ever read by the undirected-only code paths this file ports, so a
    /// single array replaces both here.
    strength: Vec<f64>,
    /// Node size (always 1.0 for every node reachable through this binding
    /// at level 0; propagated from the previous level's community sizes at
    /// coarser levels — see `build_coarse_graph`).
    size: Vec<f64>,
    /// Adjacency list. Undirected edges are symmetrized: an edge between i
    /// and j appears once in `out_edges[i]` and once in `out_edges[j]`, in
    /// first-seen order (see `build_adapter`). TS also keeps `inEdges`, but
    /// it is never read by the undirected-only code paths ported here.
    out_edges: Vec<Vec<(usize, f64)>>,
    total_weight: f64,
}

/// One aggregated undirected-pair record while building a `GraphAdapter`:
/// accumulates edge weight for an unordered node pair while tracking which
/// direction(s) contributed a raw edge — mirrors adapter.ts's
/// `aggregateUndirectedPairs`/`recordUndirectedPairWeight`. `sum` is
/// averaged by the number of directions seen when emitted, exactly
/// replicating how the TS reference symmetrizes a graph that may store
/// independent per-direction weights (e.g. two files that import each other
/// both contribute to the same undirected community-detection edge).
struct PairAgg {
    sum: f64,
    seen_ab: bool,
    seen_ba: bool,
}

/// Build a `GraphAdapter` from a flat, possibly-directed/possibly-duplicate
/// edge list, mirroring `makeGraphAdapter(graph, { directed: false })` in
/// adapter.ts. Used uniformly for the level-0 graph (raw input) and every
/// coarsened level's graph (from `build_coarse_graph`), exactly like the TS
/// reference calls `makeGraphAdapter` uniformly at every level.
fn build_adapter(n: usize, raw_edges: &[(usize, usize, f64)], sizes: &[f64]) -> GraphAdapter {
    let mut self_loop = vec![0.0_f64; n];

    // First-seen insertion order is load-bearing here (see module doc): a
    // `HashMap<(usize, usize), usize>` is used purely to look up the slot
    // index for an already-seen pair in O(1); `pair_order`/`pair_recs` (plain
    // `Vec`s, iterated below in push order) are what actually determine
    // adjacency-list order.
    let mut pair_index: HashMap<(usize, usize), usize> = HashMap::new();
    let mut pair_order: Vec<(usize, usize)> = Vec::new();
    let mut pair_recs: Vec<PairAgg> = Vec::new();

    for &(a, b, w) in raw_edges {
        if a == b {
            self_loop[a] += w;
            continue;
        }
        let (i, j) = if a < b { (a, b) } else { (b, a) };
        let key = (i, j);
        let idx = match pair_index.get(&key) {
            Some(&existing) => existing,
            None => {
                let new_idx = pair_recs.len();
                pair_index.insert(key, new_idx);
                pair_order.push(key);
                pair_recs.push(PairAgg {
                    sum: 0.0,
                    seen_ab: false,
                    seen_ba: false,
                });
                new_idx
            }
        };
        let rec = &mut pair_recs[idx];
        rec.sum += w;
        if a == i {
            rec.seen_ab = true;
        } else {
            rec.seen_ba = true;
        }
    }

    let mut out_edges: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    let mut strength = vec![0.0_f64; n];

    for (k, &(i, j)) in pair_order.iter().enumerate() {
        let rec = &pair_recs[k];
        let dir_count = rec.seen_ab as u8 + rec.seen_ba as u8;
        if dir_count == 0 {
            continue;
        }
        let w = rec.sum / dir_count as f64;
        if w == 0.0 {
            continue;
        }
        out_edges[i].push((j, w));
        out_edges[j].push((i, w));
        strength[i] += w;
        strength[j] += w;
    }

    for v in 0..n {
        let w = self_loop[v];
        if w != 0.0 {
            out_edges[v].push((v, w));
            strength[v] += w;
        }
    }

    // Sequential left fold in index order, matching
    // `strengthOut.reduce((a, b) => a + b, 0)` exactly (Rust's `Sum for f64`
    // is also a sequential left fold from 0.0).
    let total_weight: f64 = strength.iter().sum();

    GraphAdapter {
        n,
        self_loop,
        strength,
        size: sizes.to_vec(),
        out_edges,
        total_weight,
    }
}

// ════════════════════════════════════════════════════════════════════════
// Partition — undirected-only port of leiden/partition.ts +
// leiden/aggregate-helpers.ts
// ════════════════════════════════════════════════════════════════════════

struct Partition {
    n: usize,
    node_community: Vec<usize>,
    community_count: usize,
    community_total_size: Vec<f64>,
    community_node_count: Vec<usize>,
    community_internal_edge_weight: Vec<f64>,
    community_total_strength: Vec<f64>,
    /* scratch arrays for neighbor accumulation — fixed at size `n` for the
    lifetime of a Partition; see module doc / `move_node_to_community` doc
    for why these never need to grow (unlike the four aggregate arrays
    above, which can grow via `resize_communities` after
    `split_disconnected_communities` mints ids beyond the initial `n`). */
    candidate_communities: Vec<usize>,
    candidate_count: usize,
    neighbor_edge_weight_to_community: Vec<f64>,
    is_candidate_community: Vec<bool>,
    capacity_growth_factor: f64,
}

impl Partition {
    fn new(n: usize, capacity_growth_factor: f64) -> Self {
        Partition {
            n,
            node_community: (0..n).collect(),
            community_count: n,
            community_total_size: vec![0.0; n],
            community_node_count: vec![0; n],
            community_internal_edge_weight: vec![0.0; n],
            community_total_strength: vec![0.0; n],
            candidate_communities: vec![0; n],
            candidate_count: 0,
            neighbor_edge_weight_to_community: vec![0.0; n],
            is_candidate_community: vec![false; n],
            capacity_growth_factor,
        }
    }

    /// Full aggregate recompute from `node_community`. Mirrors
    /// `initializeAggregates`/`accumulateNodeAggregates`/
    /// `accumulateInternalEdgeWeights` (undirected branches only).
    fn initialize_aggregates(&mut self, g: &GraphAdapter) {
        for v in self.community_total_size.iter_mut() {
            *v = 0.0;
        }
        for v in self.community_node_count.iter_mut() {
            *v = 0;
        }
        for v in self.community_internal_edge_weight.iter_mut() {
            *v = 0.0;
        }
        for v in self.community_total_strength.iter_mut() {
            *v = 0.0;
        }

        for i in 0..self.n {
            let c = self.node_community[i];
            self.community_total_size[c] += g.size[i];
            self.community_node_count[c] += 1;
            self.community_total_strength[c] += g.strength[i];
            if g.self_loop[i] != 0.0 {
                self.community_internal_edge_weight[c] += g.self_loop[i];
            }
        }
        // Intra-community non-self-loop edges, each counted once (j > i) --
        // matches accumulateInternalEdgeWeights's undirected branch.
        for i in 0..self.n {
            let ci = self.node_community[i];
            for &(j, w) in &g.out_edges[i] {
                if j <= i {
                    continue;
                }
                if ci == self.node_community[j] {
                    self.community_internal_edge_weight[ci] += w;
                }
            }
        }
    }

    fn reset_scratch(&mut self) {
        for i in 0..self.candidate_count {
            let c = self.candidate_communities[i];
            self.is_candidate_community[c] = false;
            self.neighbor_edge_weight_to_community[c] = 0.0;
        }
        self.candidate_count = 0;
    }

    fn touch_candidate(&mut self, c: usize) {
        if self.is_candidate_community[c] {
            return;
        }
        self.is_candidate_community[c] = true;
        self.candidate_communities[self.candidate_count] = c;
        self.candidate_count += 1;
    }

    /// Mirrors `accumulateNeighborCommunityEdgeWeights`'s undirected branch:
    /// always touches the node's own community first, then its neighbors'
    /// communities in `out_edges[v]` order (which includes a self-loop entry
    /// if present, at the end — see `build_adapter`). Returns the number of
    /// distinct candidate communities touched.
    fn accumulate_neighbor_community_edge_weights(&mut self, g: &GraphAdapter, v: usize) -> usize {
        self.reset_scratch();
        let ci = self.node_community[v];
        self.touch_candidate(ci);
        for &(j, w) in &g.out_edges[v] {
            let cj = self.node_community[j];
            self.touch_candidate(cj);
            self.neighbor_edge_weight_to_community[cj] += w;
        }
        self.candidate_count
    }

    fn get_candidate_community_at(&self, i: usize) -> usize {
        self.candidate_communities[i]
    }

    fn get_neighbor_edge_weight_to_community(&self, c: usize) -> f64 {
        if c < self.neighbor_edge_weight_to_community.len() {
            self.neighbor_edge_weight_to_community[c]
        } else {
            0.0
        }
    }

    fn get_community_total_strength(&self, c: usize) -> f64 {
        if c < self.community_total_strength.len() {
            self.community_total_strength[c]
        } else {
            0.0
        }
    }

    fn get_community_node_count(&self, c: usize) -> usize {
        if c < self.community_node_count.len() {
            self.community_node_count[c]
        } else {
            0
        }
    }

    fn get_community_members(&self) -> Vec<Vec<usize>> {
        let mut comms: Vec<Vec<usize>> = vec![Vec::new(); self.community_count];
        for i in 0..self.n {
            comms[self.node_community[i]].push(i);
        }
        comms
    }

    /// Mirrors `moveNodeToCommunity`'s undirected branch. `new_c` must
    /// already be `< community_count` — unlike TS, this never grows on a
    /// brand-new id, because `allowNewCommunity` (the only way TS reaches
    /// that branch) is never enabled by this binding's option surface (see
    /// module doc).
    fn move_node_to_community(&mut self, g: &GraphAdapter, v: usize, new_c: usize) -> bool {
        let old_c = self.node_community[v];
        if old_c == new_c {
            return false;
        }
        let strength_v = g.strength[v];
        let self_loop_w = g.self_loop[v];
        let node_sz = g.size[v];

        self.community_node_count[old_c] -= 1;
        self.community_node_count[new_c] += 1;
        self.community_total_size[old_c] -= node_sz;
        self.community_total_size[new_c] += node_sz;

        self.community_total_strength[old_c] -= strength_v;
        self.community_total_strength[new_c] += strength_v;

        // outToOld/outToNew already include the self-loop weight (self-loops
        // live in out_edges), doubled here to match the "2*weight" internal
        // edge convention, with the self-loop weight added back once more --
        // see applyMoveInternalEdgeWeightDeltaUndirected in partition.ts.
        let weight_to_old = self.get_neighbor_edge_weight_to_community(old_c);
        let weight_to_new = self.get_neighbor_edge_weight_to_community(new_c);
        self.community_internal_edge_weight[old_c] -= 2.0 * weight_to_old + self_loop_w;
        self.community_internal_edge_weight[new_c] += 2.0 * weight_to_new + self_loop_w;

        self.node_community[v] = new_c;
        true
    }

    /// Grow the four aggregate arrays (not the fixed-size scratch arrays --
    /// see their field doc) to fit at least `new_count` communities.
    /// Reachable only via `split_disconnected_communities`, which can mint
    /// ids beyond the initial `n` allocation when a post-refinement
    /// community turns out to be disconnected.
    fn ensure_capacity(&mut self, new_count: usize) {
        if new_count <= self.community_total_size.len() {
            return;
        }
        let grow_to = new_count.max(
            ((self.community_total_size.len() as f64) * self.capacity_growth_factor).ceil()
                as usize,
        );
        self.community_total_size.resize(grow_to, 0.0);
        self.community_node_count.resize(grow_to, 0);
        self.community_internal_edge_weight.resize(grow_to, 0.0);
        self.community_total_strength.resize(grow_to, 0.0);
    }

    fn resize_communities(&mut self, new_count: usize) {
        self.ensure_capacity(new_count);
        self.community_count = new_count;
    }

    /// Renumber communities: default (only reachable) compaction mode --
    /// descending total size, tie-broken by descending node count then
    /// ascending original id. Mirrors `compactCommunityIds()` with no
    /// options (`preserveLabels`/`keepOldOrder` are unreachable here).
    fn compact_community_ids(&mut self, g: &GraphAdapter) {
        let ids = sorted_nonempty_community_ids(
            self.community_count,
            &self.community_node_count,
            &self.community_total_size,
        );

        let mut new_id = vec![0usize; self.community_count];
        for (i, &c) in ids.iter().enumerate() {
            new_id[c] = i;
        }
        for slot in self.node_community.iter_mut() {
            *slot = new_id[*slot];
        }

        self.community_count = ids.len();
        self.community_total_size = vec![0.0; self.community_count];
        self.community_node_count = vec![0; self.community_count];
        self.community_internal_edge_weight = vec![0.0; self.community_count];
        self.community_total_strength = vec![0.0; self.community_count];
        self.initialize_aggregates(g);
    }
}

/// Non-empty community ids in ascending original order, then sorted
/// descending by size / node count / ascending id. Extracted as a free
/// function (taking plain slices) to keep the sort's borrows trivially
/// disjoint from the `&mut self` mutations that follow it in
/// `compact_community_ids`.
fn sorted_nonempty_community_ids(
    community_count: usize,
    node_count: &[usize],
    total_size: &[f64],
) -> Vec<usize> {
    let mut ids: Vec<usize> = (0..community_count)
        .filter(|&c| node_count[c] > 0)
        .collect();
    ids.sort_by(|&a, &b| {
        total_size[b]
            .partial_cmp(&total_size[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| node_count[b].cmp(&node_count[a]))
            .then_with(|| a.cmp(&b))
    });
    ids
}

// ════════════════════════════════════════════════════════════════════════
// Modularity — undirected-only port of leiden/modularity.ts
// ════════════════════════════════════════════════════════════════════════

/// Mirrors `diffModularity`'s undirected branch exactly.
fn diff_modularity(partition: &Partition, g: &GraphAdapter, v: usize, c: usize, gamma: f64) -> f64 {
    let old_c = partition.node_community[v];
    if c == old_c {
        return 0.0;
    }
    let k_v = g.strength[v];
    let m2 = g.total_weight;
    let k_v_in_new = partition.get_neighbor_edge_weight_to_community(c);
    let k_v_in_old = partition.get_neighbor_edge_weight_to_community(old_c);
    let w_tot_new = partition.get_community_total_strength(c);
    let w_tot_old = partition.community_total_strength[old_c];
    let gain_remove = -(k_v_in_old / m2 - (gamma * (k_v * w_tot_old)) / (m2 * m2));
    let gain_add = k_v_in_new / m2 - (gamma * (k_v * w_tot_new)) / (m2 * m2);
    gain_remove + gain_add
}

/// Standard Newman-Girvan modularity, mirrors `qualityModularity`'s
/// undirected branch. Used only for the final quality() computation on the
/// original (level-0) graph, always at gamma=1.0 regardless of the
/// optimization resolution (see `compute_final_modularity`).
fn quality_modularity(
    community_count: usize,
    community_internal_edge_weight: &[f64],
    community_total_strength: &[f64],
    m2: f64,
    gamma: f64,
) -> f64 {
    let mut sum = 0.0_f64;
    for c in 0..community_count {
        let lc = community_internal_edge_weight[c];
        let dc = community_total_strength[c];
        sum += (2.0 * lc) / m2 - (gamma * (dc * dc)) / (m2 * m2);
    }
    sum
}

// ════════════════════════════════════════════════════════════════════════
// Optimiser — undirected-only, "neighbors"-strategy-only, refine-always-on
// port of leiden/optimiser.ts
// ════════════════════════════════════════════════════════════════════════

/// Evaluate every touched candidate community for `node_index` and return
/// the best (community, gain) pair — mirrors `findBestCommunityMove`'s
/// "neighbors" branch (the only candidate strategy this binding reaches;
/// `allowNewCommunity`'s new-community probe is also unreachable here).
fn find_best_community_move(
    partition: &Partition,
    g: &GraphAdapter,
    node_index: usize,
    candidate_count: usize,
    resolution: f64,
) -> (usize, f64) {
    let own = partition.node_community[node_index];
    let mut best_c = own;
    let mut best_gain = 0.0_f64;
    for t in 0..candidate_count {
        let c = partition.get_candidate_community_at(t);
        if c == own {
            continue;
        }
        let gain = diff_modularity(partition, g, node_index, c, resolution);
        if gain > best_gain {
            best_gain = gain;
            best_c = c;
        }
    }
    (best_c, best_gain)
}

/// Greedy local-move phase: iterate nodes in a shuffled order, moving each
/// to the best candidate community, until no improvement or
/// `max_local_passes` is reached. Mirrors `runLocalMovePhase` exactly.
fn run_local_move_phase(
    g: &GraphAdapter,
    partition: &mut Partition,
    cfg: &LeidenConfig,
    rng: &mut Mulberry32,
) {
    let mut order: Vec<usize> = (0..g.n).collect();
    let mut improved = true;
    let mut local_passes = 0usize;
    while improved {
        improved = false;
        local_passes += 1;
        shuffle_in_place(&mut order, rng);
        for &node_index in &order {
            let candidate_count =
                partition.accumulate_neighbor_community_edge_weights(g, node_index);
            let (best_c, best_gain) =
                find_best_community_move(partition, g, node_index, candidate_count, cfg.resolution);
            if best_c != partition.node_community[node_index] && best_gain > LEIDEN_GAIN_EPSILON {
                partition.move_node_to_community(g, node_index, best_c);
                improved = true;
            }
        }
        if local_passes >= cfg.max_local_passes {
            break;
        }
    }
}

/// Boltzmann probabilistic candidate selection (Algorithm 3, Traag et al.
/// 2019). Returns `None` when the node should stay a singleton (TS's `-1`
/// sentinel), or `Some(community)` otherwise. Mirrors
/// `boltzmannSelectCandidate` exactly.
fn boltzmann_select_candidate(
    cand_len: usize,
    theta: f64,
    rng: &mut Mulberry32,
    cand_c: &[usize],
    cand_gain: &[f64],
    cand_weight: &mut [f64],
) -> Option<usize> {
    let mut max_gain = 0.0_f64;
    for &gain in cand_gain.iter().take(cand_len) {
        if gain > max_gain {
            max_gain = gain;
        }
    }
    let stay_weight = ((0.0 - max_gain) / theta).exp();
    let mut total_weight = stay_weight;
    for i in 0..cand_len {
        cand_weight[i] = ((cand_gain[i] - max_gain) / theta).exp();
        total_weight += cand_weight[i];
    }

    let r = rng.next_f64() * total_weight;
    if r < stay_weight {
        return None;
    }
    let mut cumulative = stay_weight;
    for i in 0..cand_len {
        cumulative += cand_weight[i];
        if r < cumulative {
            return Some(cand_c[i]);
        }
    }
    Some(cand_c[cand_len - 1])
}

/// True Leiden refinement phase: singleton start, singleton guard (only
/// still-alone nodes may merge), single randomized pass, Boltzmann
/// probabilistic selection scoped to candidates sharing the same
/// macro-community. Mirrors `refineWithinCoarseCommunities` exactly.
fn refine_within_coarse_communities(
    g: &GraphAdapter,
    base_part: &Partition,
    cfg: &LeidenConfig,
    rng: &mut Mulberry32,
) -> Partition {
    let mut p = Partition::new(g.n, cfg.capacity_growth_factor);
    p.initialize_aggregates(g);

    // Macro-community membership per node, from the already-compacted
    // local-move partition. TS's `commMacro` is built by copying
    // `basePart.nodeCommunity` element-for-element into an array sized
    // `p.communityCount` (== g.n for a fresh singleton partition), i.e. it
    // is just a clone of `macro` at this point — reproduced directly here.
    let comm_macro: Vec<usize> = base_part.node_community.clone();

    let theta = cfg.refinement_theta;

    let mut order: Vec<usize> = (0..g.n).collect();
    shuffle_in_place(&mut order, rng);

    let mut cand_c = vec![0usize; g.n];
    let mut cand_gain = vec![0.0_f64; g.n];
    let mut cand_weight = vec![0.0_f64; g.n];

    for &v in &order {
        // Singleton guard: only nodes still alone in their community may merge.
        let cur_c = p.node_community[v];
        if p.get_community_node_count(cur_c) > 1 {
            continue;
        }

        let macro_v = comm_macro[v];
        let touched = p.accumulate_neighbor_community_edge_weights(g, v);

        let mut cand_len = 0usize;
        for t in 0..touched {
            let c = p.get_candidate_community_at(t);
            if c == p.node_community[v] {
                continue;
            }
            if comm_macro[c] != macro_v {
                continue;
            }
            let gain = diff_modularity(&p, g, v, c, cfg.resolution);
            if gain > LEIDEN_GAIN_EPSILON {
                cand_c[cand_len] = c;
                cand_gain[cand_len] = gain;
                cand_len += 1;
            }
        }
        if cand_len == 0 {
            continue;
        }

        let chosen =
            boltzmann_select_candidate(cand_len, theta, rng, &cand_c, &cand_gain, &mut cand_weight);
        if let Some(c) = chosen {
            p.move_node_to_community(g, v, c);
        }
    }

    p
}

/// BFS over the subgraph induced by `in_community`, starting from `start`.
/// Mirrors `bfsComponent` (the undirected-only branch — `out_edges` alone
/// carries the full symmetrized adjacency).
fn bfs_component(
    g: &GraphAdapter,
    start: usize,
    in_community: &[bool],
    visited: &mut [bool],
) -> Vec<usize> {
    let mut queue = vec![start];
    visited[start] = true;
    let mut head = 0usize;
    while head < queue.len() {
        let v = queue[head];
        head += 1;
        for &(to, _w) in &g.out_edges[v] {
            if in_community[to] && !visited[to] {
                visited[to] = true;
                queue.push(to);
            }
        }
    }
    queue
}

/// Post-refinement connectivity check: split any community with more than
/// one connected component into its components, reassigning secondary
/// components to fresh community ids. Mirrors `splitDisconnectedCommunities`
/// exactly (O(V+E), since communities partition V).
fn split_disconnected_communities(g: &GraphAdapter, partition: &mut Partition) {
    let n = g.n;
    let members = partition.get_community_members();
    let mut next_c = partition.community_count;
    let mut did_split = false;

    let mut visited = vec![false; n];
    let mut in_community = vec![false; n];

    for nodes in &members {
        if nodes.len() <= 1 {
            continue;
        }
        for &nd in nodes {
            in_community[nd] = true;
        }

        let mut component_count = 0usize;
        for &start in nodes {
            if visited[start] {
                continue;
            }
            component_count += 1;
            let component = bfs_component(g, start, &in_community, &mut visited);
            if component_count > 1 {
                let new_c = next_c;
                next_c += 1;
                for &q in &component {
                    partition.node_community[q] = new_c;
                }
                did_split = true;
            }
        }

        for &nd in nodes {
            in_community[nd] = false;
            visited[nd] = false;
        }
    }

    if did_split {
        partition.resize_communities(next_c);
        partition.initialize_aggregates(g);
    }
}

/// One level's outcome: the effective (post-refinement) partition's
/// node→community assignment and per-community sizes (needed by
/// `build_coarse_graph`), plus whether this level made no progress at all
/// (both the macro local-move phase and the refined/split partition ended
/// up fully singleton) — mirrors `runLevel`'s `{ effectivePartition,
/// terminate }`.
struct LevelOutcome {
    node_community: Vec<usize>,
    community_total_size: Vec<f64>,
    community_count: usize,
    terminate: bool,
}

fn run_level(g: &GraphAdapter, cfg: &LeidenConfig, rng: &mut Mulberry32) -> LevelOutcome {
    let mut partition = Partition::new(g.n, cfg.capacity_growth_factor);
    partition.initialize_aggregates(g);

    run_local_move_phase(g, &mut partition, cfg, rng);
    partition.compact_community_ids(g);
    let macro_community_count = partition.community_count;

    // Leiden refinement always runs here: `louvainCommunities`'s option
    // surface never threads a `refine` flag through to `detectClusters`, so
    // the TS reference always takes `options.refine !== false` => true. This
    // is the step that makes the algorithm Leiden rather than plain Louvain.
    let mut refined = refine_within_coarse_communities(g, &partition, cfg, rng);
    split_disconnected_communities(g, &mut refined);
    refined.compact_community_ids(g);

    let effective_community_count = refined.community_count;
    let terminate = macro_community_count == g.n && effective_community_count == g.n;

    LevelOutcome {
        node_community: refined.node_community,
        community_total_size: refined.community_total_size,
        community_count: refined.community_count,
        terminate,
    }
}

/// Build the next level's coarse graph: each community becomes a single
/// node, sized by its aggregate size from the previous level. Mirrors
/// `buildCoarseGraph` *plus* the next level's `makeGraphAdapter(coarse, {
/// directed: false })` re-read of that coarse `CodeGraph` — both stages
/// matter for byte-identical output, not just the edge-weight arithmetic:
///
/// Stage 1 (mirrors `buildCoarseGraph`'s `acc: Map<string, number>`):
/// accumulate a first-seen-order, *directional*-key (`cu:cv` and `cv:cu` as
/// distinct entries) sum over `g.out_edges`.
///
/// Stage 2 (mirrors constructing the coarse `CodeGraph` via
/// `coarse.addNode(String(c), ...)` for `c` in ascending `0..communityCount`
/// *before* any edges are added, then `coarse.addEdge(cu, cv, ...)` per
/// stage-1 entry): because `addNode` pre-populates `_successors` with keys
/// "0","1",...,"commCount-1" in that ascending order, and `CodeGraph`'s
/// `Map`-backed adjacency never reorders an *existing* key on a later write,
/// each community's neighbor list is ordered by when a partner was *first*
/// touched (from either direction) — not by stage-1's raw discovery order.
/// Getting this wrong (e.g. reusing stage-1's order directly) is exactly
/// the bug this fix addresses: it does not change *which* nodes end up
/// grouped together for graphs with an unambiguous optimum (small hand-built
/// fixtures all still passed), but it does change candidate/tie-breaking
/// order from the second coarsening level onward, which the resolution
/// benchmark and this repo's own ~700-8800 node dependency graphs surfaced
/// as a real, reproducible native/JS divergence.
///
/// Stage 3 (mirrors `_undirectedEdges()`'s dedup traversal of the coarse
/// `CodeGraph`, which is what the *next* level's `makeGraphAdapter` actually
/// iterates): walk communities in ascending order, each one's neighbor list
/// in its stage-2 discovery order, yielding each canonical pair once. The
/// result is fed through the same `build_adapter` used for level 0 — each
/// pair now appears exactly once (dirCount will always be 1), which is
/// mathematically the same value stage-1's directional sums would average
/// to for this binding's integer-only edge weights (see the reciprocal-edge
/// test), but replicating the real order removes any doubt.
fn build_coarse_graph(
    g: &GraphAdapter,
    node_community: &[usize],
    community_total_size: &[f64],
    community_count: usize,
) -> GraphAdapter {
    let sizes: Vec<f64> = community_total_size[0..community_count].to_vec();

    // Stage 1: `acc`-equivalent — directional-key, first-seen-order sum.
    let mut acc_index: HashMap<(usize, usize), usize> = HashMap::new();
    let mut acc_order: Vec<(usize, usize)> = Vec::new();
    let mut acc_values: Vec<f64> = Vec::new();

    for i in 0..g.n {
        let cu = node_community[i];
        for &(j, w) in &g.out_edges[i] {
            let cv = node_community[j];
            // Undirected: each non-self edge (i,j) appears in both
            // out_edges[i] and out_edges[j]. For intra-community edges
            // (cu==cv), skip the reverse occurrence to avoid inflating the
            // coarse self-loop weight by 2x (matches the `j < i` guard in
            // optimiser.ts's buildCoarseGraph).
            if cu == cv && j < i {
                continue;
            }
            let key = (cu, cv);
            match acc_index.get(&key) {
                Some(&idx) => acc_values[idx] += w,
                None => {
                    let idx = acc_values.len();
                    acc_index.insert(key, idx);
                    acc_order.push(key);
                    acc_values.push(w);
                }
            }
        }
    }

    // Stage 2: per-community neighbor discovery order (mirrors the coarse
    // CodeGraph's per-node adjacency Map insertion order) + last-write-wins
    // weight per canonical (undirected) pair (mirrors addEdge overwriting an
    // existing Map entry's value without moving its position).
    let mut neighbor_order: Vec<Vec<usize>> = vec![Vec::new(); community_count];
    let mut neighbor_seen: Vec<std::collections::HashSet<usize>> =
        vec![std::collections::HashSet::new(); community_count];
    let mut final_weight: HashMap<(usize, usize), f64> = HashMap::new();

    for (idx, &(cu, cv)) in acc_order.iter().enumerate() {
        let w = acc_values[idx];
        if cu == cv {
            if neighbor_seen[cu].insert(cu) {
                neighbor_order[cu].push(cu);
            }
            final_weight.insert((cu, cu), w);
            continue;
        }
        let (lo, hi) = if cu < cv { (cu, cv) } else { (cv, cu) };
        final_weight.insert((lo, hi), w);
        if neighbor_seen[cu].insert(cv) {
            neighbor_order[cu].push(cv);
        }
        if neighbor_seen[cv].insert(cu) {
            neighbor_order[cv].push(cu);
        }
    }

    // Stage 3: ascending community order, each community's neighbors in
    // discovery order, canonical-pair dedup — mirrors `_undirectedEdges()`.
    let mut raw_edges: Vec<(usize, usize, f64)> = Vec::new();
    let mut yielded: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for (cu, neighbors) in neighbor_order.iter().enumerate() {
        for &cv in neighbors {
            let (lo, hi) = if cu < cv { (cu, cv) } else { (cv, cu) };
            if !yielded.insert((lo, hi)) {
                continue;
            }
            let w = *final_weight
                .get(&(lo, hi))
                .expect("weight recorded in stage 2");
            raw_edges.push((cu, cv, w));
        }
    }

    build_adapter(community_count, &raw_edges, &sizes)
}

/// Run the full multi-level Leiden pipeline and return the final
/// original-node → final-community mapping. Mirrors
/// `runLouvainUndirectedModularity`'s level loop exactly.
fn run_leiden(base_graph: &GraphAdapter, cfg: &LeidenConfig, seed: u32) -> Vec<usize> {
    let mut rng = Mulberry32::new(seed);
    let orig_n = base_graph.n;
    let mut original_to_current: Vec<usize> = (0..orig_n).collect();

    let mut coarse_graph: Option<GraphAdapter> = None;

    for _level in 0..cfg.max_levels {
        let graph_ref: &GraphAdapter = coarse_graph.as_ref().unwrap_or(base_graph);

        let outcome = run_level(graph_ref, cfg, &mut rng);

        for slot in original_to_current.iter_mut() {
            *slot = outcome.node_community[*slot];
        }

        if outcome.terminate {
            break;
        }

        let next_coarse = build_coarse_graph(
            graph_ref,
            &outcome.node_community,
            &outcome.community_total_size,
            outcome.community_count,
        );
        coarse_graph = Some(next_coarse);
    }

    original_to_current
}

/// Final quality(): recompute aggregates on the ORIGINAL (level-0) graph
/// using the final fine→coarse mapping, then evaluate standard modularity
/// at gamma=1.0 regardless of the optimization resolution — mirrors
/// `detectClusters().quality()`'s modularity branch (`buildOriginalPartition`
/// combined with `qualityModularity(part, baseGraph, 1.0)`) exactly.
/// Computing on the original graph (rather than the last coarse level)
/// matters, since the modularity null model depends on the degree
/// distribution, which changes after coarsening.
fn compute_final_modularity(base: &GraphAdapter, original_to_current: &[usize]) -> f64 {
    let community_count = original_to_current
        .iter()
        .copied()
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    if community_count == 0 || base.total_weight == 0.0 {
        return 0.0;
    }

    let mut total_strength = vec![0.0_f64; community_count];
    let mut internal_edge_weight = vec![0.0_f64; community_count];

    for (i, &c) in original_to_current.iter().enumerate().take(base.n) {
        total_strength[c] += base.strength[i];
        if base.self_loop[i] != 0.0 {
            internal_edge_weight[c] += base.self_loop[i];
        }
    }
    for i in 0..base.n {
        let ci = original_to_current[i];
        for &(j, w) in &base.out_edges[i] {
            if j <= i {
                continue;
            }
            if ci == original_to_current[j] {
                internal_edge_weight[ci] += w;
            }
        }
    }

    quality_modularity(
        community_count,
        &internal_edge_weight,
        &total_strength,
        base.total_weight,
        1.0,
    )
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    fn edge(src: &str, tgt: &str) -> GraphEdge {
        GraphEdge {
            source: src.to_string(),
            target: tgt.to_string(),
        }
    }

    fn assignments_map(result: &LeidenCommunitiesResult) -> StdHashMap<String, i32> {
        result
            .assignments
            .iter()
            .map(|a| (a.node.clone(), a.community))
            .collect()
    }

    #[test]
    fn test_leiden_empty() {
        let result = leiden_communities(vec![], vec![], None, None, None, None, None, None);
        assert!(result.assignments.is_empty());
        assert_eq!(result.modularity, 0.0);
    }

    #[test]
    fn test_leiden_two_cliques() {
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
        let result = leiden_communities(edges, nodes, None, None, None, None, None, None);

        let map = assignments_map(&result);
        assert_eq!(map["a"], map["b"]);
        assert_eq!(map["b"], map["c"]);
        assert_eq!(map["d"], map["e"]);
        assert_eq!(map["e"], map["f"]);
        assert_ne!(map["a"], map["d"]);
        assert!(result.modularity > 0.0);
    }

    #[test]
    fn test_leiden_single_component() {
        let edges = vec![edge("a", "b"), edge("a", "c"), edge("b", "c")];
        let nodes: Vec<String> = vec!["a", "b", "c"].into_iter().map(String::from).collect();
        let result = leiden_communities(edges, nodes, None, None, None, None, None, None);
        let map = assignments_map(&result);
        assert_eq!(map["a"], map["b"]);
        assert_eq!(map["b"], map["c"]);
    }

    /// Regression test mirroring #1734 (originally filed against the classic
    /// Louvain implementation this file replaces): repeated calls with a
    /// fixed seed on a graph engineered to force a genuine modularity-gain
    /// tie must produce byte-identical assignments and modularity every
    /// time. This graph is symmetric by construction — three disjoint
    /// triangles plus a bridge node connected with equal weight to one
    /// member of each triangle — so moving the bridge node into any of the
    /// three triangles yields the exact same modularity gain.
    #[test]
    fn test_leiden_deterministic_across_repeated_calls_with_tie() {
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
            let result = leiden_communities(
                edges.clone(),
                nodes.clone(),
                Some(1.0),
                Some(42),
                None,
                None,
                None,
                None,
            );
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
                "run {i} produced a different assignment than run 0 — tie-breaking is not deterministic"
            );
            assert_eq!(
                snapshot.1, first.1,
                "run {i} produced a different modularity than run 0"
            );
        }
    }

    /// A "mutual import" style graph: both (a,b) and (b,a) are present as
    /// independent directed edges (as `graph.toEdgeArray()` would emit for a
    /// directed CodeGraph with edges in both directions between two nodes).
    /// These must be treated as ONE undirected edge of weight 1 (averaged),
    /// not weight 2 (summed) — the classic Louvain implementation this file
    /// replaces summed reciprocal edges instead of averaging them, an
    /// additional (independent) source of native/JS divergence beyond the
    /// algorithm mismatch that issue #1804 is about. Verified by comparing
    /// against a graph with the exact same structure but only ONE direction
    /// per edge: both must produce identical modularity, since averaging
    /// duplicate reciprocal edges must be equivalent to de-duplicating them.
    #[test]
    fn test_leiden_reciprocal_edges_are_averaged_not_summed() {
        let nodes: Vec<String> = vec!["a", "b", "c", "d"]
            .into_iter()
            .map(String::from)
            .collect();

        let reciprocal_edges = vec![
            edge("a", "b"),
            edge("b", "a"),
            edge("b", "c"),
            edge("c", "b"),
            edge("c", "d"),
            edge("d", "c"),
        ];
        let single_direction_edges = vec![edge("a", "b"), edge("b", "c"), edge("c", "d")];

        let reciprocal_result = leiden_communities(
            reciprocal_edges,
            nodes.clone(),
            Some(1.0),
            Some(42),
            None,
            None,
            None,
            None,
        );
        let single_result = leiden_communities(
            single_direction_edges,
            nodes,
            Some(1.0),
            Some(42),
            None,
            None,
            None,
            None,
        );

        assert_eq!(reciprocal_result.modularity, single_result.modularity);
        assert_eq!(
            assignments_map(&reciprocal_result),
            assignments_map(&single_result)
        );
    }

    /// A node with a self-loop must have that weight counted toward its own
    /// degree/strength (and hence total_weight / modularity), matching
    /// adapter.ts's single-w self-loop convention — not silently dropped
    /// (the classic Louvain implementation this file replaces dropped
    /// self-loops entirely).
    #[test]
    fn test_leiden_self_loop_contributes_to_modularity() {
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "a"),
            edge("a", "a"),
        ];
        let nodes: Vec<String> = vec!["a", "b", "c"].into_iter().map(String::from).collect();
        let with_self_loop = leiden_communities(
            edges,
            nodes.clone(),
            Some(1.0),
            Some(42),
            None,
            None,
            None,
            None,
        );

        let edges_no_loop = vec![edge("a", "b"), edge("b", "c"), edge("c", "a")];
        let without_self_loop = leiden_communities(
            edges_no_loop,
            nodes,
            Some(1.0),
            Some(42),
            None,
            None,
            None,
            None,
        );

        assert_ne!(with_self_loop.modularity, without_self_loop.modularity);
    }

    /// `refinementTheta`/`maxLevels`/`maxLocalPasses`/`capacityGrowthFactor`
    /// must actually be threaded through (the classic Louvain implementation
    /// this file replaces silently ignored all four).
    #[test]
    fn test_leiden_accepts_all_leiden_options() {
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("c", "a"),
            edge("x", "y"),
            edge("y", "z"),
            edge("z", "x"),
            edge("c", "x"),
        ];
        let nodes: Vec<String> = vec!["a", "b", "c", "x", "y", "z"]
            .into_iter()
            .map(String::from)
            .collect();

        let result = leiden_communities(
            edges,
            nodes,
            Some(1.0),
            Some(42),
            Some(50),
            Some(20),
            Some(1.0),
            Some(1.5),
        );
        assert_eq!(result.assignments.len(), 6);
    }
}
