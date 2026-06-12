//! Graph algorithms — mirrors `src/graph/algorithms/`.

pub mod bfs;
pub mod centrality;
pub mod louvain;
pub mod shortest_path;
pub mod tarjan;

pub use bfs::{bfs_traversal, BfsEntry};
pub use centrality::{fan_in_out, FanInOutEntry};
pub use louvain::{louvain_communities, CommunityAssignment, LouvainResult};
pub use shortest_path::shortest_path;
pub use tarjan::detect_cycles;

use std::collections::{HashMap, HashSet};

use crate::types::GraphEdge;

/// Directed adjacency representation shared by the traversal algorithms.
pub(crate) struct DirectedGraph<'a> {
    pub(crate) successors: HashMap<&'a str, Vec<&'a str>>,
    pub(crate) predecessors: HashMap<&'a str, Vec<&'a str>>,
    pub(crate) nodes: HashSet<&'a str>,
}

impl<'a> DirectedGraph<'a> {
    pub(crate) fn from_edges(edges: &'a [GraphEdge]) -> Self {
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
