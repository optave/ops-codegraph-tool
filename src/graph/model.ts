/**
 * Unified in-memory graph model.
 *
 * Stores directed (default) or undirected graphs with node/edge attributes.
 * Node IDs are always strings. DB integer IDs should be stringified before use.
 */

export interface NodeAttrs {
  [key: string]: unknown;
}

export interface EdgeAttrs {
  [key: string]: unknown;
}

export interface CodeGraphOpts {
  directed?: boolean;
}

/** Canonical key for an undirected edge — smallest ID first, null-byte separated. */
function undirectedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export class CodeGraph {
  private _directed: boolean;
  private _nodes: Map<string, NodeAttrs>;
  private _successors: Map<string, Map<string, EdgeAttrs>>;
  private _predecessors: Map<string, Map<string, EdgeAttrs>>;

  constructor(opts: CodeGraphOpts = {}) {
    this._directed = opts.directed !== false;
    this._nodes = new Map();
    this._successors = new Map();
    this._predecessors = new Map();
  }

  get directed(): boolean {
    return this._directed;
  }

  get nodeCount(): number {
    return this._nodes.size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const targets of this._successors.values()) count += targets.size;
    // Undirected graphs store each edge twice (a→b and b→a)
    return this._directed ? count : count / 2;
  }

  // ─── Node operations ────────────────────────────────────────────

  addNode(id: string | number, attrs: NodeAttrs = {}): this {
    const key = String(id);
    this._nodes.set(key, attrs);
    if (!this._successors.has(key)) this._successors.set(key, new Map());
    if (!this._predecessors.has(key)) this._predecessors.set(key, new Map());
    return this;
  }

  hasNode(id: string | number): boolean {
    return this._nodes.has(String(id));
  }

  getNodeAttrs(id: string | number): NodeAttrs | undefined {
    return this._nodes.get(String(id));
  }

  nodes(): IterableIterator<[string, NodeAttrs]> {
    return this._nodes.entries();
  }

  nodeIds(): string[] {
    return [...this._nodes.keys()];
  }

  // ─── Edge operations ────────────────────────────────────────────

  addEdge(source: string | number, target: string | number, attrs: EdgeAttrs = {}): this {
    const src = String(source);
    const tgt = String(target);
    // Auto-add nodes if missing
    if (!this._nodes.has(src)) this.addNode(src);
    if (!this._nodes.has(tgt)) this.addNode(tgt);

    this._successors.get(src)!.set(tgt, attrs);
    this._predecessors.get(tgt)!.set(src, attrs);

    if (!this._directed) {
      this._successors.get(tgt)!.set(src, attrs);
      this._predecessors.get(src)!.set(tgt, attrs);
    }
    return this;
  }

  hasEdge(source: string | number, target: string | number): boolean {
    const src = String(source);
    const tgt = String(target);
    return this._successors.has(src) && this._successors.get(src)!.has(tgt);
  }

  getEdgeAttrs(source: string | number, target: string | number): EdgeAttrs | undefined {
    const src = String(source);
    const tgt = String(target);
    return this._successors.get(src)?.get(tgt);
  }

  *edges(): Generator<[string, string, EdgeAttrs]> {
    if (this._directed) {
      yield* this._directedEdges();
    } else {
      yield* this._undirectedEdges();
    }
  }

  private *_directedEdges(): Generator<[string, string, EdgeAttrs]> {
    for (const [src, targets] of this._successors) {
      for (const [tgt, attrs] of targets) yield [src, tgt, attrs];
    }
  }

  private *_undirectedEdges(): Generator<[string, string, EdgeAttrs]> {
    // \0 is safe as separator — node IDs are file paths/symbols, never contain null bytes
    const seen = new Set<string>();
    for (const [src, targets] of this._successors) {
      for (const [tgt, attrs] of targets) {
        const key = undirectedEdgeKey(src, tgt);
        if (seen.has(key)) continue;
        seen.add(key);
        yield [src, tgt, attrs];
      }
    }
  }

  // ─── Adjacency ──────────────────────────────────────────────────

  /** Direct successors of a node (outgoing edges). */
  successors(id: string | number): string[] {
    const key = String(id);
    const map = this._successors.get(key);
    return map ? [...map.keys()] : [];
  }

  /** Direct predecessors of a node (incoming edges). */
  predecessors(id: string | number): string[] {
    const key = String(id);
    const map = this._predecessors.get(key);
    return map ? [...map.keys()] : [];
  }

  /** All neighbors (union of successors + predecessors). */
  neighbors(id: string | number): string[] {
    const key = String(id);
    const set = new Set<string>();
    const succ = this._successors.get(key);
    if (succ) for (const k of succ.keys()) set.add(k);
    const pred = this._predecessors.get(key);
    if (pred) for (const k of pred.keys()) set.add(k);
    return [...set];
  }

  outDegree(id: string | number): number {
    const map = this._successors.get(String(id));
    return map ? map.size : 0;
  }

  inDegree(id: string | number): number {
    const map = this._predecessors.get(String(id));
    return map ? map.size : 0;
  }

  // ─── Filtering ──────────────────────────────────────────────────

  /** Return a new graph containing only nodes matching the predicate. */
  subgraph(predicate: (id: string, attrs: NodeAttrs) => boolean): CodeGraph {
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
  filterEdges(predicate: (source: string, target: string, attrs: EdgeAttrs) => boolean): CodeGraph {
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
  toEdgeArray(): { source: string; target: string }[] {
    const result: { source: string; target: string }[] = [];
    for (const [source, target] of this.edges()) {
      result.push({ source, target });
    }
    return result;
  }

  // ─── Utilities ──────────────────────────────────────────────────

  clone(): CodeGraph {
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
  merge(other: CodeGraph): this {
    for (const [id, attrs] of other.nodes()) {
      this.addNode(id, attrs);
    }
    for (const [src, tgt, attrs] of other.edges()) {
      this.addEdge(src, tgt, attrs);
    }
    return this;
  }
}
