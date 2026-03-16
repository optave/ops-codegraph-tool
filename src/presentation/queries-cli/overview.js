import path from 'node:path';
import { kindIcon, moduleMapData, rolesData, statsData } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

export async function stats(customDbPath, opts = {}) {
  const data = statsData(customDbPath, { noTests: opts.noTests });

  // Community detection summary (async import for lazy-loading)
  try {
    const { communitySummaryForStats } = await import('../../features/communities.js');
    data.communities = communitySummaryForStats(customDbPath, { noTests: opts.noTests });
  } catch {
    /* graphology may not be available */
  }

  if (outputResult(data, null, opts)) return;

  // Human-readable output
  console.log('\n# Codegraph Stats\n');

  // Nodes
  console.log(`Nodes:     ${data.nodes.total} total`);
  const kindEntries = Object.entries(data.nodes.byKind).sort((a, b) => b[1] - a[1]);
  const kindParts = kindEntries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < kindParts.length; i += 3) {
    const row = kindParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Edges
  console.log(`\nEdges:     ${data.edges.total} total`);
  const edgeEntries = Object.entries(data.edges.byKind).sort((a, b) => b[1] - a[1]);
  const edgeParts = edgeEntries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < edgeParts.length; i += 3) {
    const row = edgeParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Files
  console.log(`\nFiles:     ${data.files.total} (${data.files.languages} languages)`);
  const langEntries = Object.entries(data.files.byLanguage).sort((a, b) => b[1] - a[1]);
  const langParts = langEntries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < langParts.length; i += 3) {
    const row = langParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Cycles
  console.log(
    `\nCycles:    ${data.cycles.fileLevel} file-level, ${data.cycles.functionLevel} function-level`,
  );

  // Hotspots
  if (data.hotspots.length > 0) {
    console.log(`\nTop ${data.hotspots.length} coupling hotspots:`);
    for (let i = 0; i < data.hotspots.length; i++) {
      const h = data.hotspots[i];
      console.log(
        `  ${String(i + 1).padStart(2)}. ${h.file.padEnd(35)} fan-in: ${String(h.fanIn).padStart(3)}  fan-out: ${String(h.fanOut).padStart(3)}`,
      );
    }
  }

  // Embeddings
  if (data.embeddings) {
    const e = data.embeddings;
    console.log(
      `\nEmbeddings: ${e.count} vectors (${e.model || 'unknown'}, ${e.dim || '?'}d) built ${e.builtAt || 'unknown'}`,
    );
  } else {
    console.log('\nEmbeddings: not built');
  }

  // Quality
  if (data.quality) {
    const q = data.quality;
    const cc = q.callerCoverage;
    const cf = q.callConfidence;
    console.log(`\nGraph Quality: ${q.score}/100`);
    console.log(
      `  Caller coverage:  ${(cc.ratio * 100).toFixed(1)}% (${cc.covered}/${cc.total} functions have >=1 caller)`,
    );
    console.log(
      `  Call confidence:  ${(cf.ratio * 100).toFixed(1)}% (${cf.highConf}/${cf.total} call edges are high-confidence)`,
    );
    if (q.falsePositiveWarnings.length > 0) {
      console.log('  False-positive warnings:');
      for (const fp of q.falsePositiveWarnings) {
        console.log(`    ! ${fp.name} (${fp.callerCount} callers) -- ${fp.file}:${fp.line}`);
      }
    }
  }

  // Roles
  if (data.roles && Object.keys(data.roles).length > 0) {
    const total = Object.values(data.roles).reduce((a, b) => a + b, 0);
    console.log(`\nRoles:     ${total} classified symbols`);
    const roleParts = Object.entries(data.roles)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`);
    for (let i = 0; i < roleParts.length; i += 3) {
      const row = roleParts
        .slice(i, i + 3)
        .map((p) => p.padEnd(18))
        .join('');
      console.log(`  ${row}`);
    }
  }

  // Complexity
  if (data.complexity) {
    const cx = data.complexity;
    const miPart = cx.avgMI != null ? ` | avg MI: ${cx.avgMI} | min MI: ${cx.minMI}` : '';
    console.log(
      `\nComplexity: ${cx.analyzed} functions | avg cognitive: ${cx.avgCognitive} | avg cyclomatic: ${cx.avgCyclomatic} | max cognitive: ${cx.maxCognitive}${miPart}`,
    );
  }

  // Communities
  if (data.communities) {
    const cm = data.communities;
    console.log(
      `\nCommunities: ${cm.communityCount} detected | modularity: ${cm.modularity} | drift: ${cm.driftScore}%`,
    );
  }

  console.log();
}

export function moduleMap(customDbPath, limit = 20, opts = {}) {
  const data = moduleMapData(customDbPath, limit, { noTests: opts.noTests });
  if (outputResult(data, 'topNodes', opts)) return;

  console.log(`\nModule map (top ${limit} most-connected nodes):\n`);
  const dirs = new Map();
  for (const n of data.topNodes) {
    if (!dirs.has(n.dir)) dirs.set(n.dir, []);
    dirs.get(n.dir).push(n);
  }
  for (const [dir, files] of [...dirs].sort()) {
    console.log(`  [${dir}/]`);
    for (const f of files) {
      const coupling = f.inEdges + f.outEdges;
      const bar = '#'.repeat(Math.min(coupling, 40));
      console.log(
        `    ${path.basename(f.file).padEnd(35)} <-${String(f.inEdges).padStart(3)} ->${String(f.outEdges).padStart(3)}  =${String(coupling).padStart(3)}  ${bar}`,
      );
    }
  }
  console.log(
    `\n  Total: ${data.stats.totalFiles} files, ${data.stats.totalNodes} symbols, ${data.stats.totalEdges} edges\n`,
  );
}

export function roles(customDbPath, opts = {}) {
  const data = rolesData(customDbPath, opts);
  if (outputResult(data, 'symbols', opts)) return;

  if (data.count === 0) {
    console.log('No classified symbols found. Run "codegraph build" first.');
    return;
  }

  const total = data.count;
  console.log(`\nNode roles (${total} symbols):\n`);

  const summaryParts = Object.entries(data.summary)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}: ${count}`);
  console.log(`  ${summaryParts.join('  ')}\n`);

  const byRole = {};
  for (const s of data.symbols) {
    if (!byRole[s.role]) byRole[s.role] = [];
    byRole[s.role].push(s);
  }

  for (const [role, symbols] of Object.entries(byRole)) {
    console.log(`## ${role} (${symbols.length})`);
    for (const s of symbols.slice(0, 30)) {
      console.log(`  ${kindIcon(s.kind)} ${s.name}  ${s.file}:${s.line}`);
    }
    if (symbols.length > 30) {
      console.log(`  ... and ${symbols.length - 30} more`);
    }
    console.log();
  }
}
