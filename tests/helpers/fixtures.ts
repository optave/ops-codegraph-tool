import { InMemoryRepository } from '../../src/db/repository/in-memory-repository.js';

/**
 * Fluent builder for constructing test graphs quickly.
 *
 * Usage:
 *   const { repo, ids } = createTestRepo()
 *     .fn('authenticate', 'auth.js', 10)
 *     .fn('authMiddleware', 'middleware.js', 5)
 *     .calls('authMiddleware', 'authenticate')
 *     .build();
 */
interface PendingNode {
  name: string;
  kind: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

interface PendingEdge {
  source: string;
  target: string;
  kind: string;
}

interface PendingComplexity {
  name: string;
  metrics: Record<string, unknown>;
}

class TestRepoBuilder {
  #pending: { nodes: PendingNode[]; edges: PendingEdge[]; complexity: PendingComplexity[] } = {
    nodes: [],
    edges: [],
    complexity: [],
  };

  /** Add a function node. */
  fn(name: string, file: string, line: number, extra: Record<string, unknown> = {}): this {
    return this.#addNode(name, 'function', file, line, extra);
  }

  /** Add a method node. */
  method(name: string, file: string, line: number, extra: Record<string, unknown> = {}): this {
    return this.#addNode(name, 'method', file, line, extra);
  }

  /** Add a class node. */
  cls(name: string, file: string, line: number, extra: Record<string, unknown> = {}): this {
    return this.#addNode(name, 'class', file, line, extra);
  }

  /** Add a file node. */
  file(filePath: string): this {
    return this.#addNode(filePath, 'file', filePath, 0);
  }

  /** Add an arbitrary node. */
  node(
    name: string,
    kind: string,
    file: string,
    line: number,
    extra: Record<string, unknown> = {},
  ): this {
    return this.#addNode(name, kind, file, line, extra);
  }

  /** Add a 'calls' edge between two named nodes. */
  calls(sourceName: string, targetName: string): this {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'calls' });
    return this;
  }

  /** Add an 'imports' edge. */
  imports(sourceName: string, targetName: string): this {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'imports' });
    return this;
  }

  /** Add an 'extends' edge. */
  extends(sourceName: string, targetName: string): this {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'extends' });
    return this;
  }

  /** Add an edge of any kind. */
  edge(sourceName: string, targetName: string, kind: string): this {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind });
    return this;
  }

  /** Add complexity metrics for a named node. */
  complexity(name: string, metrics: Record<string, unknown>): this {
    this.#pending.complexity.push({ name, metrics });
    return this;
  }

  /**
   * Build the InMemoryRepository and return { repo, ids }.
   * `ids` maps node names to their auto-assigned IDs.
   */
  build() {
    const repo = new InMemoryRepository();
    const ids = new Map();

    // Add nodes
    for (const n of this.#pending.nodes) {
      if (ids.has(n.name)) {
        throw new Error(
          `Duplicate node name: "${n.name}" — use unique names or qualify with file path`,
        );
      }
      ids.set(n.name, repo.addNode(n));
    }

    // Add edges
    for (const e of this.#pending.edges) {
      const sourceId = ids.get(e.source);
      const targetId = ids.get(e.target);
      if (sourceId == null) throw new Error(`Unknown source node: "${e.source}"`);
      if (targetId == null) throw new Error(`Unknown target node: "${e.target}"`);
      repo.addEdge({ source_id: sourceId, target_id: targetId, kind: e.kind });
    }

    // Add complexity
    for (const c of this.#pending.complexity) {
      const nodeId = ids.get(c.name);
      if (nodeId == null) throw new Error(`Unknown node for complexity: "${c.name}"`);
      repo.addComplexity(nodeId, c.metrics);
    }

    return { repo, ids };
  }

  #addNode(
    name: string,
    kind: string,
    file: string,
    line: number,
    extra: Record<string, unknown> = {},
  ): this {
    this.#pending.nodes.push({ name, kind, file, line, ...extra });
    return this;
  }
}

/** Create a new TestRepoBuilder. */
export function createTestRepo(): TestRepoBuilder {
  return new TestRepoBuilder();
}
