import { communitiesData } from '../features/communities.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface CommunitiesCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  functions?: boolean;
  resolution?: number;
  drift?: boolean;
}

interface CommunityMember {
  name: string;
  kind?: string;
  file: string;
}

interface Community {
  id: number;
  size: number;
  directories: Record<string, number>;
  members?: CommunityMember[];
}

interface DriftAnalysis {
  splitCandidates: Array<{ directory: string; communityCount: number }>;
  mergeCandidates: Array<{
    communityId: number;
    size: number;
    directoryCount: number;
    directories: string[];
  }>;
}

interface CommunitiesResult {
  summary: {
    communityCount: number;
    nodeCount: number;
    modularity: number;
    driftScore: number;
  };
  communities: Community[];
  drift: DriftAnalysis;
}

function renderCommunityList(communityList: Community[]): void {
  for (const c of communityList) {
    const dirs = Object.entries(c.directories)
      .sort((a, b) => b[1] - a[1])
      .map(([d, n]) => `${d} (${n})`)
      .join(', ');
    console.log(`  Community ${c.id} (${c.size} members): ${dirs}`);
    if (c.members) {
      const shown = c.members.slice(0, 8);
      for (const m of shown) {
        const kind = m.kind ? ` [${m.kind}]` : '';
        console.log(`    - ${m.name}${kind}  ${m.file}`);
      }
      if (c.members.length > 8) {
        console.log(`    ... and ${c.members.length - 8} more`);
      }
    }
  }
}

function renderDriftAnalysis(d: DriftAnalysis, driftScore: number): void {
  if (d.splitCandidates.length === 0 && d.mergeCandidates.length === 0) return;

  console.log(`\n# Drift Analysis (score: ${driftScore}%)\n`);

  if (d.splitCandidates.length > 0) {
    console.log('  Split candidates (directories spanning multiple communities):');
    for (const s of d.splitCandidates.slice(0, 10)) {
      console.log(`    - ${s.directory} → ${s.communityCount} communities`);
    }
  }

  if (d.mergeCandidates.length > 0) {
    console.log('  Merge candidates (communities spanning multiple directories):');
    for (const m of d.mergeCandidates.slice(0, 10)) {
      console.log(
        `    - Community ${m.communityId} (${m.size} members) → ${m.directoryCount} dirs: ${m.directories.join(', ')}`,
      );
    }
  }
}

export function communities(customDbPath: string | undefined, opts: CommunitiesCliOpts = {}): void {
  const data = communitiesData(customDbPath, opts) as unknown as CommunitiesResult;

  if (outputResult(data, 'communities', opts)) return;

  if (data.summary.communityCount === 0) {
    console.log(
      '\nNo communities detected. The graph may be too small or disconnected.\n' +
        'Run "codegraph build" first to populate the graph.\n',
    );
    return;
  }

  const mode = opts.functions ? 'Function' : 'File';
  console.log(`\n# ${mode}-Level Communities\n`);
  console.log(
    `  ${data.summary.communityCount} communities | ${data.summary.nodeCount} nodes | modularity: ${data.summary.modularity} | drift: ${data.summary.driftScore}%\n`,
  );

  if (!opts.drift) {
    renderCommunityList(data.communities);
  }

  renderDriftAnalysis(data.drift, data.summary.driftScore);
  console.log();
}
