import path from 'node:path';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import {
  getCallableNodes,
  getCallEdges,
  getFileNodesAll,
  getImportEdges,
  openReadonlyOrFail,
} from './db.js';
import { isTestFile } from './infrastructure/test-filter.js';
import { paginateResult } from './paginate.js';

// ─── Graph Construction ───────────────────────────────────────────────

/**
 * Build a graphology graph from the codegraph SQLite database.
 *
 * @param {object} db - open better-sqlite3 database (readonly)
 * @param {object} opts
 * @param {boolean} [opts.functions] - Function-level instead of file-level
 * @param {boolean} [opts.noTests] - Exclude test files
 * @returns {Graph}
 */
function buildGraphologyGraph(db, opts = {}) {
  const graph = new Graph({ type: 'undirected' });

  if (opts.functions) {
    // Function-level: nodes = function/method/class symbols, edges = calls
    let nodes = getCallableNodes(db);
    if (opts.noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

    const nodeIds = new Set();
    for (const n of nodes) {
      const key = String(n.id);
      graph.addNode(key, { label: n.name, file: n.file, kind: n.kind });
      nodeIds.add(n.id);
    }

    const edges = getCallEdges(db);
    for (const e of edges) {
      if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
      const src = String(e.source_id);
      const tgt = String(e.target_id);
      if (src === tgt) continue;
      if (!graph.hasEdge(src, tgt)) {
        graph.addEdge(src, tgt);
      }
    }
  } else {
    // File-level: nodes = files, edges = imports + imports-type (deduplicated, cross-file)
    let nodes = getFileNodesAll(db);
    if (opts.noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

    const nodeIds = new Set();
    for (const n of nodes) {
      const key = String(n.id);
      graph.addNode(key, { label: n.file, file: n.file });
      nodeIds.add(n.id);
    }

    const edges = getImportEdges(db);
    for (const e of edges) {
      if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
      const src = String(e.source_id);
      const tgt = String(e.target_id);
      if (src === tgt) continue;
      if (!graph.hasEdge(src, tgt)) {
        graph.addEdge(src, tgt);
      }
    }
  }

  return graph;
}

// ─── Directory Helpers ────────────────────────────────────────────────

function getDirectory(filePath) {
  const dir = path.dirname(filePath);
  return dir === '.' ? '(root)' : dir;
}

// ─── Core Analysis ────────────────────────────────────────────────────

/**
 * Run Louvain community detection and return structured data.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts]
 * @param {boolean} [opts.functions] - Function-level instead of file-level
 * @param {number}  [opts.resolution] - Louvain resolution (default 1.0)
 * @param {boolean} [opts.noTests] - Exclude test files
 * @param {boolean} [opts.drift] - Drift-only mode (omit community member lists)
 * @param {boolean} [opts.json] - JSON output (used by CLI wrapper only)
 * @returns {{ communities: object[], modularity: number, drift: object, summary: object }}
 */
export function communitiesData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const resolution = opts.resolution ?? 1.0;
  let graph;
  try {
    graph = buildGraphologyGraph(db, {
      functions: opts.functions,
      noTests: opts.noTests,
    });
  } finally {
    db.close();
  }

  // Handle empty or trivial graphs
  if (graph.order === 0 || graph.size === 0) {
    return {
      communities: [],
      modularity: 0,
      drift: { splitCandidates: [], mergeCandidates: [] },
      summary: { communityCount: 0, modularity: 0, nodeCount: graph.order, driftScore: 0 },
    };
  }

  // Run Louvain
  const details = louvain.detailed(graph, { resolution });
  const assignments = details.communities; // node → community id
  const modularity = details.modularity;

  // Group nodes by community
  const communityMap = new Map(); // community id → node keys[]
  graph.forEachNode((key) => {
    const cid = assignments[key];
    if (!communityMap.has(cid)) communityMap.set(cid, []);
    communityMap.get(cid).push(key);
  });

  // Build community objects
  const communities = [];
  const communityDirs = new Map(); // community id → Set<dir>

  for (const [cid, members] of communityMap) {
    const dirCounts = {};
    const memberData = [];
    for (const key of members) {
      const attrs = graph.getNodeAttributes(key);
      const dir = getDirectory(attrs.file);
      dirCounts[dir] = (dirCounts[dir] || 0) + 1;
      memberData.push({
        name: attrs.label,
        file: attrs.file,
        ...(attrs.kind ? { kind: attrs.kind } : {}),
      });
    }

    communityDirs.set(cid, new Set(Object.keys(dirCounts)));

    communities.push({
      id: cid,
      size: members.length,
      directories: dirCounts,
      ...(opts.drift ? {} : { members: memberData }),
    });
  }

  // Sort by size descending
  communities.sort((a, b) => b.size - a.size);

  // ─── Drift Analysis ─────────────────────────────────────────────

  // Split candidates: directories with members in 2+ communities
  const dirToCommunities = new Map(); // dir → Set<community id>
  for (const [cid, dirs] of communityDirs) {
    for (const dir of dirs) {
      if (!dirToCommunities.has(dir)) dirToCommunities.set(dir, new Set());
      dirToCommunities.get(dir).add(cid);
    }
  }
  const splitCandidates = [];
  for (const [dir, cids] of dirToCommunities) {
    if (cids.size >= 2) {
      splitCandidates.push({ directory: dir, communityCount: cids.size });
    }
  }
  splitCandidates.sort((a, b) => b.communityCount - a.communityCount);

  // Merge candidates: communities spanning 2+ directories
  const mergeCandidates = [];
  for (const c of communities) {
    const dirCount = Object.keys(c.directories).length;
    if (dirCount >= 2) {
      mergeCandidates.push({
        communityId: c.id,
        size: c.size,
        directoryCount: dirCount,
        directories: Object.keys(c.directories),
      });
    }
  }
  mergeCandidates.sort((a, b) => b.directoryCount - a.directoryCount);

  // Drift score: 0-100 based on how much directory structure diverges from communities
  // Higher = more drift (directories don't match communities)
  const totalDirs = dirToCommunities.size;
  const splitDirs = splitCandidates.length;
  const splitRatio = totalDirs > 0 ? splitDirs / totalDirs : 0;

  const totalComms = communities.length;
  const mergeComms = mergeCandidates.length;
  const mergeRatio = totalComms > 0 ? mergeComms / totalComms : 0;

  const driftScore = Math.round(((splitRatio + mergeRatio) / 2) * 100);

  const base = {
    communities: opts.drift ? [] : communities,
    modularity: +modularity.toFixed(4),
    drift: { splitCandidates, mergeCandidates },
    summary: {
      communityCount: communities.length,
      modularity: +modularity.toFixed(4),
      nodeCount: graph.order,
      driftScore,
    },
  };
  return paginateResult(base, 'communities', { limit: opts.limit, offset: opts.offset });
}

/**
 * Lightweight summary for stats integration.
 *
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @returns {{ communityCount: number, modularity: number, driftScore: number }}
 */
export function communitySummaryForStats(customDbPath, opts = {}) {
  const data = communitiesData(customDbPath, { ...opts, drift: true });
  return data.summary;
}
