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
class TestRepoBuilder {
  #pending = { nodes: [], edges: [], complexity: [] };

  /**
   * Add a function node.
   * @param {string} name
   * @param {string} file
   * @param {number} line
   * @param {object} [extra] - Additional node attrs (role, end_line, scope, etc.)
   */
  fn(name, file, line, extra = {}) {
    return this.#addNode(name, 'function', file, line, extra);
  }

  /**
   * Add a method node.
   */
  method(name, file, line, extra = {}) {
    return this.#addNode(name, 'method', file, line, extra);
  }

  /**
   * Add a class node.
   */
  cls(name, file, line, extra = {}) {
    return this.#addNode(name, 'class', file, line, extra);
  }

  /**
   * Add a file node.
   */
  file(filePath) {
    return this.#addNode(filePath, 'file', filePath, 0);
  }

  /**
   * Add an arbitrary node.
   */
  node(name, kind, file, line, extra = {}) {
    return this.#addNode(name, kind, file, line, extra);
  }

  /**
   * Add a 'calls' edge between two named nodes.
   */
  calls(sourceName, targetName) {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'calls' });
    return this;
  }

  /**
   * Add an 'imports' edge.
   */
  imports(sourceName, targetName) {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'imports' });
    return this;
  }

  /**
   * Add an 'extends' edge.
   */
  extends(sourceName, targetName) {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind: 'extends' });
    return this;
  }

  /**
   * Add an edge of any kind.
   */
  edge(sourceName, targetName, kind) {
    this.#pending.edges.push({ source: sourceName, target: targetName, kind });
    return this;
  }

  /**
   * Add complexity metrics for a named node.
   */
  complexity(name, metrics) {
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
      const id = repo.addNode(n);
      if (ids.has(n.name)) {
        throw new Error(`Duplicate node name: "${n.name}" — use unique names or qualify with file path`);
      }
      ids.set(n.name, id);
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

  #addNode(name, kind, file, line, extra = {}) {
    this.#pending.nodes.push({ name, kind, file, line, ...extra });
    return this;
  }
}

/**
 * Create a new TestRepoBuilder.
 * @returns {TestRepoBuilder}
 */
export function createTestRepo() {
  return new TestRepoBuilder();
}
