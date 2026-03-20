/**
 * Unified in-memory graph model.
 *
 * Stores directed (default) or undirected graphs with node/edge attributes.
 * Node IDs are always strings. DB integer IDs should be stringified before use.
 */

export class CodeGraph {
  /**
   * @param {{ directed?: boolean }} [opts]
   */
  constructor(opts = {}) {
    this._directed = opts.directed !== false;
    /** @type {Map<string, object>} */
    this._nodes = new Map();
    /** @type {Map<string, Map<string, object>>} node → (target → edgeAttrs) */
    this._successors = new Map();
    /** @type {Map<string, Map<string, object>>} node → (source → edgeAttrs) */
    this._predecessors = new Map();
  }

  get directed() {
    return this._directed;
  }

  get nodeCount() {
    return this._nodes.size;
  }

  get edgeCount() {
    let count = 0;
    for (const targets of this._successors.values()) count += targets.size;
    // Undirected graphs store each edge twice (a→b and b→a)
    return this._directed ? count : count / 2;
  }

  // ─── Node operations ────────────────────────────────────────────

  addNode(id, attrs = {}) {
    const key = String(id);
    this._nodes.set(key, attrs);
    if (!this._successors.has(key)) this._successors.set(key, new Map());
    if (!this._predecessors.has(key)) this._predecessors.set(key, new Map());
    return this;
  }

  hasNode(id) {
    return this._nodes.has(String(id));
  }

  getNodeAttrs(id) {
    return this._nodes.get(String(id));
  }

  /** @returns {IterableIterator<[string, object]>} */
  nodes() {
    return this._nodes.entries();
  }

  /** @returns {string[]} */
  nodeIds() {
    return [...this._nodes.keys()];
  }

  // ─── Edge operations ────────────────────────────────────────────

  addEdge(source, target, attrs = {}) {
    const src = String(source);
    const tgt = String(target);
    // Auto-add nodes if missing
    if (!this._nodes.has(src)) this.addNode(src);
    if (!this._nodes.has(tgt)) this.addNode(tgt);

    this._successors.get(src).set(tgt, attrs);
    this._predecessors.get(tgt).set(src, attrs);

    if (!this._directed) {
      this._successors.get(tgt).set(src, attrs);
      this._predecessors.get(src).set(tgt, attrs);
    }
    return this;
  }

  hasEdge(source, target) {
    const src = String(source);
    const tgt = String(target);
    return this._successors.has(src) && this._successors.get(src).has(tgt);
  }

  getEdgeAttrs(source, target) {
    const src = String(source);
    const tgt = String(target);
    return this._successors.get(src)?.get(tgt);
  }

  /** @yields {[string, string, object]} source, target, attrs */
  *edges() {
    const seen = this._directed ? null : new Set();
    for (const [src, targets] of this._successors) {
      for (const [tgt, attrs] of targets) {
        if (!this._directed) {
          // \0 is safe as separator — node IDs are file paths/symbols, never contain null bytes
          const key = src < tgt ? `${src}\0${tgt}` : `${tgt}\0${src}`;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        yield [src, tgt, attrs];
      }
    }
  }

  // ─── Adjacency ──────────────────────────────────────────────────

  /** Direct successors of a node (outgoing edges). */
  successors(id) {
    const key = String(id);
    const map = this._successors.get(key);
    return map ? [...map.keys()] : [];
  }

  /** Direct predecessors of a node (incoming edges). */
  predecessors(id) {
    const key = String(id);
    const map = this._predecessors.get(key);
    return map ? [...map.keys()] : [];
  }

  /** All neighbors (union of successors + predecessors). */
  neighbors(id) {
    const key = String(id);
    const set = new Set();
    const succ = this._successors.get(key);
    if (succ) for (const k of succ.keys()) set.add(k);
    const pred = this._predecessors.get(key);
    if (pred) for (const k of pred.keys()) set.add(k);
    return [...set];
  }

  outDegree(id) {
    const map = this._successors.get(String(id));
    return map ? map.size : 0;
  }

  inDegree(id) {
    const map = this._predecessors.get(String(id));
    return map ? map.size : 0;
  }

  // ─── Filtering ──────────────────────────────────────────────────

  /** Return a new graph containing only nodes matching the predicate. */
  subgraph(predicate) {
    const g = new CodeGraph({ directed: this._directed });
    for (const [id, attrs] of this._nodes) {
      if (predicate(id, attrs)) g.addNode(id, { ...attrs });
    }
    for (const [src, tgt, attrs] of this.edges()) {
      if (g.hasNode(src) && g.hasNode(tgt)) {
        g.addEdge(src, tgt, { ...attrs });
      }
    }
    return g;
  }

  /** Return a new graph containing only edges matching the predicate. */
  filterEdges(predicate) {
    const g = new CodeGraph({ directed: this._directed });
    for (const [id, attrs] of this._nodes) {
      g.addNode(id, { ...attrs });
    }
    for (const [src, tgt, attrs] of this.edges()) {
      if (predicate(src, tgt, attrs)) {
        g.addEdge(src, tgt, { ...attrs });
      }
    }
    return g;
  }

  // ─── Conversion ─────────────────────────────────────────────────

  /** Convert to flat edge array for native Rust interop. */
  toEdgeArray() {
    const result = [];
    for (const [source, target] of this.edges()) {
      result.push({ source, target });
    }
    return result;
  }

  // ─── Utilities ──────────────────────────────────────────────────

  clone() {
    const g = new CodeGraph({ directed: this._directed });
    for (const [id, attrs] of this._nodes) {
      g.addNode(id, { ...attrs });
    }
    for (const [src, tgt, attrs] of this.edges()) {
      g.addEdge(src, tgt, { ...attrs });
    }
    return g;
  }

  /** Merge another graph into this one. Nodes/edges from other override on conflict. */
  merge(other) {
    for (const [id, attrs] of other.nodes()) {
      this.addNode(id, attrs);
    }
    for (const [src, tgt, attrs] of other.edges()) {
      this.addEdge(src, tgt, attrs);
    }
    return this;
  }
}
