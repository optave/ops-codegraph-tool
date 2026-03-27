import path from 'node:path';
import { openRepo } from '../db/index.js';
import { louvainCommunities } from '../graph/algorithms/louvain.js';
import { buildDependencyGraph } from '../graph/builders/dependency.js';
import type { CodeGraph } from '../graph/model.js';
import { loadConfig } from '../infrastructure/config.js';
import { paginateResult } from '../shared/paginate.js';
import type { CodegraphConfig, Repository } from '../types.js';

// ─── Directory Helpers ────────────────────────────────────────────────

function getDirectory(filePath: string): string {
  const dir = path.dirname(filePath);
  return dir === '.' ? '(root)' : dir;
}

// ─── Community Building ──────────────────────────────────────────────

interface CommunityMember {
  name: string;
  file: string;
  kind?: string;
}

interface CommunityObject {
  id: number;
  size: number;
  directories: Record<string, number>;
  members?: CommunityMember[];
}

function buildCommunityObjects(
  graph: CodeGraph,
  assignments: Map<string, number>,
  opts: { drift?: boolean },
): { communities: CommunityObject[]; communityDirs: Map<number, Set<string>> } {
  const communityMap = new Map<number, string[]>();
  for (const [key] of graph.nodes()) {
    const cid = assignments.get(key);
    if (cid == null) continue;
    if (!communityMap.has(cid)) communityMap.set(cid, []);
    communityMap.get(cid)!.push(key);
  }

  const communities: CommunityObject[] = [];
  const communityDirs = new Map<number, Set<string>>();

  for (const [cid, members] of communityMap) {
    const dirCounts: Record<string, number> = {};
    const memberData: CommunityMember[] = [];
    for (const key of members) {
      const attrs = graph.getNodeAttrs(key)!;
      const dir = getDirectory(attrs.file as string);
      dirCounts[dir] = (dirCounts[dir] || 0) + 1;
      memberData.push({
        name: attrs.label as string,
        file: attrs.file as string,
        ...(attrs.kind ? { kind: attrs.kind as string } : {}),
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

interface DriftResult {
  splitCandidates: Array<{ directory: string; communityCount: number }>;
  mergeCandidates: Array<{
    communityId: number;
    size: number;
    directoryCount: number;
    directories: string[];
  }>;
  driftScore: number;
}

function analyzeDrift(
  communities: CommunityObject[],
  communityDirs: Map<number, Set<string>>,
): DriftResult {
  const dirToCommunities = new Map<string, Set<number>>();
  for (const [cid, dirs] of communityDirs) {
    for (const dir of dirs) {
      if (!dirToCommunities.has(dir)) dirToCommunities.set(dir, new Set());
      dirToCommunities.get(dir)!.add(cid);
    }
  }

  const splitCandidates: DriftResult['splitCandidates'] = [];
  for (const [dir, cids] of dirToCommunities) {
    if (cids.size >= 2) {
      splitCandidates.push({ directory: dir, communityCount: cids.size });
    }
  }
  splitCandidates.sort((a, b) => b.communityCount - a.communityCount);

  const mergeCandidates: DriftResult['mergeCandidates'] = [];
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

export function communitiesData(
  customDbPath?: string,
  opts: {
    functions?: boolean;
    resolution?: number;
    noTests?: boolean;
    drift?: boolean;
    json?: boolean;
    config?: CodegraphConfig;
    maxLevels?: number;
    maxLocalPasses?: number;
    refinementTheta?: number;
    limit?: number;
    offset?: number;
    repo?: Repository;
  } = {},
): Record<string, unknown> {
  const { repo, close } = openRepo(customDbPath, opts);
  let graph: CodeGraph;
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
  const refinementTheta = opts.refinementTheta ?? config.community?.refinementTheta;
  const { assignments, modularity } = louvainCommunities(graph, {
    resolution,
    maxLevels,
    maxLocalPasses,
    refinementTheta,
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

export function communitySummaryForStats(
  customDbPath?: string,
  opts: { noTests?: boolean; repo?: Repository } = {},
): { communityCount: number; modularity: number; driftScore: number } {
  const data = communitiesData(customDbPath, { ...opts, drift: true }) as {
    summary: { communityCount: number; modularity: number; driftScore: number };
  };
  return data.summary;
}
