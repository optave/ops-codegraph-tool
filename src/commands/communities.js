import { communitiesData } from '../communities.js';
import { outputResult } from '../infrastructure/result-formatter.js';

/**
 * CLI entry point: run community detection and print results.
 */
export function communities(customDbPath, opts = {}) {
  const data = communitiesData(customDbPath, opts);

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
    for (const c of data.communities) {
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

  // Drift analysis
  const d = data.drift;
  if (d.splitCandidates.length > 0 || d.mergeCandidates.length > 0) {
    console.log(`\n# Drift Analysis (score: ${data.summary.driftScore}%)\n`);

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

  console.log();
}
