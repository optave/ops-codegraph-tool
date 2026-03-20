import path from 'node:path';
import { openRepo } from '../db/index.js';
import { louvainCommunities } from '../graph/algorithms/louvain.js';
import { buildDependencyGraph } from '../graph/builders/dependency.js';
import { loadConfig } from '../infrastructure/config.js';
import { paginateResult } from '../shared/paginate.js';

// ─── Directory Helpers ────────────────────────────────────────────────

function getDirectory(filePath) {
  const dir = path.dirname(filePath);
  return dir === '.' ? '(root)' : dir;
}

// ─── Community Building ──────────────────────────────────────────────

/**
 * Group graph nodes by Louvain community assignment and build structured objects.
 * @param {object} graph - The dependency graph
 * @param {Map<string, number>} assignments - Node key → community ID
 * @param {object} opts
 * @param {boolean} [opts.drift] - If true, omit member lists
 * @returns {{ communities: object[], communityDirs: Map<number, Set<string>> }}
 */
function buildCommunityObjects(graph, assignments, opts) {
  const communityMap = new Map();
  for (const [key] of graph.nodes()) {
    const cid = assignments.get(key);
    if (cid == null) continue;
    if (!communityMap.has(cid)) communityMap.set(cid, []);
    communityMap.get(cid).push(key);
  }

  const communities = [];
  const communityDirs = new Map();

  for (const [cid, members] of communityMap) {
    const dirCounts = {};
    const memberData = [];
    for (const key of members) {
      const attrs = graph.getNodeAttrs(key);
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

  communities.sort((a, b) => b.size - a.size);
  return { communities, communityDirs };
}

// ─── Drift Analysis ──────────────────────────────────────────────────

/**
 * Compute split/merge candidates and drift score from community directory data.
 * @param {object[]} communities - Community objects with `directories`
 * @param {Map<number, Set<string>>} communityDirs - Community ID → directory set
 * @returns {{ splitCandidates: object[], mergeCandidates: object[], driftScore: number }}
 */
function analyzeDrift(communities, communityDirs) {
  const dirToCommunities = new Map();
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

  const totalDirs = dirToCommunities.size;
  const splitRatio = totalDirs > 0 ? splitCandidates.length / totalDirs : 0;
  const totalComms = communities.length;
  const mergeRatio = totalComms > 0 ? mergeCandidates.length / totalComms : 0;
  const driftScore = Math.round(((splitRatio + mergeRatio) / 2) * 100);

  return { splitCandidates, mergeCandidates, driftScore };
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
  const { repo, close } = openRepo(customDbPath, opts);
  let graph;
  try {
    graph = buildDependencyGraph(repo, {
      fileLevel: !opts.functions,
      noTests: opts.noTests,
    });
  } finally {
    close();
  }

  if (graph.nodeCount === 0 || graph.edgeCount === 0) {
    return {
      communities: [],
      modularity: 0,
      drift: { splitCandidates: [], mergeCandidates: [] },
      summary: { communityCount: 0, modularity: 0, nodeCount: graph.nodeCount, driftScore: 0 },
    };
  }

  const config = opts.config || loadConfig();
  const resolution = opts.resolution ?? config.community?.resolution ?? 1.0;
  const maxLevels = opts.maxLevels ?? config.community?.maxLevels;
  const maxLocalPasses = opts.maxLocalPasses ?? config.community?.maxLocalPasses;
  const { assignments, modularity } = louvainCommunities(graph, {
    resolution,
    maxLevels,
    maxLocalPasses,
  });

  const { communities, communityDirs } = buildCommunityObjects(graph, assignments, opts);
  const { splitCandidates, mergeCandidates, driftScore } = analyzeDrift(communities, communityDirs);

  const base = {
    communities: opts.drift ? [] : communities,
    modularity: +modularity.toFixed(4),
    drift: { splitCandidates, mergeCandidates },
    summary: {
      communityCount: communities.length,
      modularity: +modularity.toFixed(4),
      nodeCount: graph.nodeCount,
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
