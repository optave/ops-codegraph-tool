/**
 * Graph adapter that converts a CodeGraph into the dense array format
 * expected by the Leiden optimiser.
 *
 * Vendored from ngraph.leiden (MIT) — adapted for CodeGraph.
 */

/**
 * @param {import('../../model.js').CodeGraph} graph
 * @param {object} [opts]
 * @param {boolean} [opts.directed]
 * @param {(attrs: object) => number} [opts.linkWeight]  - extract weight from edge attrs
 * @param {(attrs: object) => number} [opts.nodeSize]    - extract size from node attrs
 * @param {string[]} [opts.baseNodeIds]
 */
export function makeGraphAdapter(graph, opts = {}) {
  const linkWeight =
    opts.linkWeight || ((attrs) => (attrs && typeof attrs.weight === 'number' ? attrs.weight : 1));
  const nodeSize =
    opts.nodeSize || ((attrs) => (attrs && typeof attrs.size === 'number' ? attrs.size : 1));
  const directed = !!opts.directed;
  const baseNodeIds = opts.baseNodeIds;

  // Build dense node index mapping
  const nodeIds = [];
  const idToIndex = new Map();
  if (Array.isArray(baseNodeIds) && baseNodeIds.length > 0) {
    for (let i = 0; i < baseNodeIds.length; i++) {
      const id = baseNodeIds[i];
      if (!graph.hasNode(id)) throw new Error(`Missing node: ${id}`);
      idToIndex.set(id, i);
      nodeIds.push(id);
    }
  } else {
    for (const [id] of graph.nodes()) {
      idToIndex.set(id, nodeIds.length);
      nodeIds.push(id);
    }
  }
  const n = nodeIds.length;

  // Storage
  const size = new Float64Array(n);
  const selfLoop = new Float64Array(n);
  const strengthOut = new Float64Array(n);
  const strengthIn = new Float64Array(n);

  // Edge list by source for fast iteration
  const outEdges = new Array(n);
  const inEdges = new Array(n);
  for (let i = 0; i < n; i++) {
    outEdges[i] = [];
    inEdges[i] = [];
  }

  // Populate from graph
  if (directed) {
    for (const [src, tgt, attrs] of graph.edges()) {
      const from = idToIndex.get(src);
      const to = idToIndex.get(tgt);
      if (from == null || to == null) continue;
      const w = +linkWeight(attrs) || 0;
      if (from === to) {
        selfLoop[from] += w;
        // Self-loop is intentionally kept in outEdges/inEdges as well.
        // partition.js's moveNodeToCommunity (directed path) accounts for this
        // by subtracting selfLoopWeight once from outToOld+inFromOld to avoid
        // triple-counting (see partition.js moveNodeToCommunity directed block).
      }
      outEdges[from].push({ to, w });
      inEdges[to].push({ from, w });
      strengthOut[from] += w;
      strengthIn[to] += w;
    }
  } else {
    // Undirected: symmetrize and average reciprocal pairs
    const pairAgg = new Map();

    for (const [src, tgt, attrs] of graph.edges()) {
      const a = idToIndex.get(src);
      const b = idToIndex.get(tgt);
      if (a == null || b == null) continue;
      const w = +linkWeight(attrs) || 0;
      if (a === b) {
        selfLoop[a] += w;
        continue;
      }
      const i = a < b ? a : b;
      const j = a < b ? b : a;
      const key = `${i}:${j}`;
      let rec = pairAgg.get(key);
      if (!rec) {
        rec = { sum: 0, seenAB: 0, seenBA: 0 };
        pairAgg.set(key, rec);
      }
      rec.sum += w;
      if (a === i) rec.seenAB = 1;
      else rec.seenBA = 1;
    }

    for (const [key, rec] of pairAgg.entries()) {
      const [iStr, jStr] = key.split(':');
      const i = +iStr;
      const j = +jStr;
      const dirCount = (rec.seenAB ? 1 : 0) + (rec.seenBA ? 1 : 0);
      const w = dirCount > 0 ? rec.sum / dirCount : 0;
      if (w === 0) continue;
      outEdges[i].push({ to: j, w });
      outEdges[j].push({ to: i, w });
      inEdges[i].push({ from: j, w });
      inEdges[j].push({ from: i, w });
      strengthOut[i] += w;
      strengthOut[j] += w;
      strengthIn[i] += w;
      strengthIn[j] += w;
    }

    // Add self-loops into adjacency and strengths.
    // Note: uses single-w convention (not standard 2w) — the modularity formulas in
    // modularity.js are written to match this convention, keeping the system self-consistent.
    for (let v = 0; v < n; v++) {
      const w = selfLoop[v];
      if (w !== 0) {
        outEdges[v].push({ to: v, w });
        inEdges[v].push({ from: v, w });
        strengthOut[v] += w;
        strengthIn[v] += w;
      }
    }
  }

  // Node sizes
  for (const [id, attrs] of graph.nodes()) {
    const i = idToIndex.get(id);
    if (i != null) size[i] = +nodeSize(attrs) || 0;
  }

  // Totals
  const totalWeight = strengthOut.reduce((a, b) => a + b, 0);

  function forEachNeighbor(i, cb) {
    const list = outEdges[i];
    for (let k = 0; k < list.length; k++) cb(list[k].to, list[k].w);
  }

  return {
    n,
    nodeIds,
    idToIndex,
    size,
    selfLoop,
    strengthOut,
    strengthIn,
    outEdges,
    inEdges,
    directed,
    totalWeight,
    forEachNeighbor,
  };
}
