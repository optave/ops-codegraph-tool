/**
 * queries-cli.js — CLI display wrappers for query data functions.
 *
 * Each function calls its corresponding *Data() function from queries.js,
 * handles JSON/NDJSON output via outputResult(), then formats human-readable
 * output for the terminal.
 */

import path from 'node:path';
import { outputResult } from './infrastructure/result-formatter.js';
import {
  childrenData,
  contextData,
  diffImpactData,
  diffImpactMermaid,
  explainData,
  exportsData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  kindIcon,
  moduleMapData,
  pathData,
  queryNameData,
  rolesData,
  statsData,
  whereData,
} from './queries.js';

// ─── symbolPath ─────────────────────────────────────────────────────────

export function symbolPath(from, to, customDbPath, opts = {}) {
  const data = pathData(from, to, customDbPath, opts);
  if (outputResult(data, null, opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }

  if (!data.found) {
    const dir = data.reverse ? 'reverse ' : '';
    console.log(`No ${dir}path from "${from}" to "${to}" within ${data.maxDepth} hops.`);
    if (data.fromCandidates.length > 1) {
      console.log(
        `\n  "${from}" matched ${data.fromCandidates.length} symbols — using top match: ${data.fromCandidates[0].name} (${data.fromCandidates[0].file}:${data.fromCandidates[0].line})`,
      );
    }
    if (data.toCandidates.length > 1) {
      console.log(
        `  "${to}" matched ${data.toCandidates.length} symbols — using top match: ${data.toCandidates[0].name} (${data.toCandidates[0].file}:${data.toCandidates[0].line})`,
      );
    }
    return;
  }

  if (data.hops === 0) {
    console.log(`\n"${from}" and "${to}" resolve to the same symbol (0 hops):`);
    const n = data.path[0];
    console.log(`  ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}\n`);
    return;
  }

  const dir = data.reverse ? ' (reverse)' : '';
  console.log(
    `\nPath from ${from} to ${to} (${data.hops} ${data.hops === 1 ? 'hop' : 'hops'})${dir}:\n`,
  );
  for (let i = 0; i < data.path.length; i++) {
    const n = data.path[i];
    const indent = '  '.repeat(i + 1);
    if (i === 0) {
      console.log(`${indent}${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`);
    } else {
      console.log(
        `${indent}--[${n.edgeKind}]--> ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`,
      );
    }
  }

  if (data.alternateCount > 0) {
    console.log(
      `\n  (${data.alternateCount} alternate shortest ${data.alternateCount === 1 ? 'path' : 'paths'} at same depth)`,
    );
  }
  console.log();
}

// ─── stats ──────────────────────────────────────────────────────────────

export async function stats(customDbPath, opts = {}) {
  const data = statsData(customDbPath, { noTests: opts.noTests });

  // Community detection summary (async import for lazy-loading)
  try {
    const { communitySummaryForStats } = await import('./communities.js');
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

// ─── queryName ──────────────────────────────────────────────────────────

export function queryName(name, customDbPath, opts = {}) {
  const data = queryNameData(name, customDbPath, {
    noTests: opts.noTests,
    limit: opts.limit,
    offset: opts.offset,
  });
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No results for "${name}"`);
    return;
  }

  console.log(`\nResults for "${name}":\n`);
  for (const r of data.results) {
    console.log(`  ${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}`);
    if (r.callees.length > 0) {
      console.log(`    -> calls/uses:`);
      for (const c of r.callees.slice(0, 15))
        console.log(`      -> ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callees.length > 15) console.log(`      ... and ${r.callees.length - 15} more`);
    }
    if (r.callers.length > 0) {
      console.log(`    <- called by:`);
      for (const c of r.callers.slice(0, 15))
        console.log(`      <- ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callers.length > 15) console.log(`      ... and ${r.callers.length - 15} more`);
    }
    console.log();
  }
}

// ─── impactAnalysis ─────────────────────────────────────────────────────

export function impactAnalysis(file, customDbPath, opts = {}) {
  const data = impactAnalysisData(file, customDbPath, opts);
  if (outputResult(data, 'sources', opts)) return;

  if (data.sources.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  console.log(`\nImpact analysis for files matching "${file}":\n`);
  for (const s of data.sources) console.log(`  # ${s} (source)`);

  const levels = data.levels;
  if (Object.keys(levels).length === 0) {
    console.log(`  No dependents found.`);
  } else {
    for (const level of Object.keys(levels).sort((a, b) => a - b)) {
      const nodes = levels[level];
      console.log(
        `\n  ${'--'.repeat(parseInt(level, 10))} Level ${level} (${nodes.length} files):`,
      );
      for (const n of nodes.slice(0, 30))
        console.log(`    ${'  '.repeat(parseInt(level, 10))}^ ${n.file}`);
      if (nodes.length > 30) console.log(`    ... and ${nodes.length - 30} more`);
    }
  }
  console.log(`\n  Total: ${data.totalDependents} files transitively depend on "${file}"\n`);
}

// ─── moduleMap ──────────────────────────────────────────────────────────

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

// ─── fileDeps ───────────────────────────────────────────────────────────

export function fileDeps(file, customDbPath, opts = {}) {
  const data = fileDepsData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n# ${r.file}\n`);
    console.log(`  -> Imports (${r.imports.length}):`);
    for (const i of r.imports) {
      const typeTag = i.typeOnly ? ' (type-only)' : '';
      console.log(`    -> ${i.file}${typeTag}`);
    }
    console.log(`\n  <- Imported by (${r.importedBy.length}):`);
    for (const i of r.importedBy) console.log(`    <- ${i.file}`);
    if (r.definitions.length > 0) {
      console.log(`\n  Definitions (${r.definitions.length}):`);
      for (const d of r.definitions.slice(0, 30))
        console.log(`    ${kindIcon(d.kind)} ${d.name} :${d.line}`);
      if (r.definitions.length > 30) console.log(`    ... and ${r.definitions.length - 30} more`);
    }
    console.log();
  }
}

// ─── fnDeps ─────────────────────────────────────────────────────────────

export function fnDeps(name, customDbPath, opts = {}) {
  const data = fnDepsData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}\n`);
    if (r.callees.length > 0) {
      console.log(`  -> Calls (${r.callees.length}):`);
      for (const c of r.callees)
        console.log(`    -> ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
    if (r.callers.length > 0) {
      console.log(`\n  <- Called by (${r.callers.length}):`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`    <- ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
    }
    for (const [d, fns] of Object.entries(r.transitiveCallers)) {
      console.log(
        `\n  ${'<-'.repeat(parseInt(d, 10))} Transitive callers (depth ${d}, ${fns.length}):`,
      );
      for (const n of fns.slice(0, 20))
        console.log(
          `    ${'  '.repeat(parseInt(d, 10) - 1)}<- ${kindIcon(n.kind)} ${n.name}  ${n.file}:${n.line}`,
        );
      if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
    }
    if (r.callees.length === 0 && r.callers.length === 0) {
      console.log(`  (no call edges found -- may be invoked dynamically or via re-exports)`);
    }
    console.log();
  }
}

// ─── context ────────────────────────────────────────────────────────────

export function context(name, customDbPath, opts = {}) {
  const data = contextData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
    const roleTag = r.role ? ` [${r.role}]` : '';
    console.log(`\n# ${r.name} (${r.kind})${roleTag} — ${r.file}:${lineRange}\n`);

    // Signature
    if (r.signature) {
      console.log('## Type/Shape Info');
      if (r.signature.params != null) console.log(`  Parameters: (${r.signature.params})`);
      if (r.signature.returnType) console.log(`  Returns: ${r.signature.returnType}`);
      console.log();
    }

    // Children
    if (r.children && r.children.length > 0) {
      console.log(`## Children (${r.children.length})`);
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
      console.log();
    }

    // Complexity
    if (r.complexity) {
      const cx = r.complexity;
      const miPart = cx.maintainabilityIndex ? ` | MI: ${cx.maintainabilityIndex}` : '';
      console.log('## Complexity');
      console.log(
        `  Cognitive: ${cx.cognitive} | Cyclomatic: ${cx.cyclomatic} | Max Nesting: ${cx.maxNesting}${miPart}`,
      );
      console.log();
    }

    // Source
    if (r.source) {
      console.log('## Source');
      for (const line of r.source.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log();
    }

    // Callees
    if (r.callees.length > 0) {
      console.log(`## Direct Dependencies (${r.callees.length})`);
      for (const c of r.callees) {
        const summary = c.summary ? ` — ${c.summary}` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${summary}`);
        if (c.source) {
          for (const line of c.source.split('\n').slice(0, 10)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    // Callers
    if (r.callers.length > 0) {
      console.log(`## Callers (${r.callers.length})`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
      console.log();
    }

    // Related tests
    if (r.relatedTests.length > 0) {
      console.log('## Related Tests');
      for (const t of r.relatedTests) {
        console.log(`  ${t.file} — ${t.testCount} tests`);
        for (const tn of t.testNames) {
          console.log(`    - ${tn}`);
        }
        if (t.source) {
          console.log('    Source:');
          for (const line of t.source.split('\n').slice(0, 20)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    if (r.callees.length === 0 && r.callers.length === 0 && r.relatedTests.length === 0) {
      console.log(
        '  (no call edges or tests found — may be invoked dynamically or via re-exports)',
      );
      console.log();
    }
  }
}

// ─── children ───────────────────────────────────────────────────────────

export function children(name, customDbPath, opts = {}) {
  const data = childrenData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No symbol matching "${name}"`);
    return;
  }
  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name}  ${r.file}:${r.line}`);
    if (r.children.length === 0) {
      console.log('  (no children)');
    } else {
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
    }
  }
}

// ─── explain ────────────────────────────────────────────────────────────

export function explain(target, customDbPath, opts = {}) {
  const data = explainData(target, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  if (data.kind === 'file') {
    for (const r of data.results) {
      const publicCount = r.publicApi.length;
      const internalCount = r.internal.length;
      const lineInfo = r.lineCount ? `${r.lineCount} lines, ` : '';
      console.log(`\n# ${r.file}`);
      console.log(
        `  ${lineInfo}${r.symbolCount} symbols (${publicCount} exported, ${internalCount} internal)`,
      );

      if (r.imports.length > 0) {
        console.log(`  Imports: ${r.imports.map((i) => i.file).join(', ')}`);
      }
      if (r.importedBy.length > 0) {
        console.log(`  Imported by: ${r.importedBy.map((i) => i.file).join(', ')}`);
      }

      if (r.publicApi.length > 0) {
        console.log(`\n## Exported`);
        for (const s of r.publicApi) {
          const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
          const roleTag = s.role ? ` [${s.role}]` : '';
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
        }
      }

      if (r.internal.length > 0) {
        console.log(`\n## Internal`);
        for (const s of r.internal) {
          const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
          const roleTag = s.role ? ` [${s.role}]` : '';
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
        }
      }

      if (r.dataFlow.length > 0) {
        console.log(`\n## Data Flow`);
        for (const df of r.dataFlow) {
          console.log(`  ${df.caller} -> ${df.callees.join(', ')}`);
        }
      }
      console.log();
    }
  } else {
    function printFunctionExplain(r, indent = '') {
      const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
      const lineInfo = r.lineCount ? `${r.lineCount} lines` : '';
      const summaryPart = r.summary ? ` | ${r.summary}` : '';
      const roleTag = r.role ? ` [${r.role}]` : '';
      const depthLevel = r._depth || 0;
      const heading = depthLevel === 0 ? '#' : '##'.padEnd(depthLevel + 2, '#');
      console.log(`\n${indent}${heading} ${r.name} (${r.kind})${roleTag}  ${r.file}:${lineRange}`);
      if (lineInfo || r.summary) {
        console.log(`${indent}  ${lineInfo}${summaryPart}`);
      }
      if (r.signature) {
        if (r.signature.params != null)
          console.log(`${indent}  Parameters: (${r.signature.params})`);
        if (r.signature.returnType) console.log(`${indent}  Returns: ${r.signature.returnType}`);
      }

      if (r.complexity) {
        const cx = r.complexity;
        const miPart = cx.maintainabilityIndex ? ` MI=${cx.maintainabilityIndex}` : '';
        console.log(
          `${indent}  Complexity: cognitive=${cx.cognitive} cyclomatic=${cx.cyclomatic} nesting=${cx.maxNesting}${miPart}`,
        );
      }

      if (r.callees.length > 0) {
        console.log(`\n${indent}  Calls (${r.callees.length}):`);
        for (const c of r.callees) {
          console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.callers.length > 0) {
        console.log(`\n${indent}  Called by (${r.callers.length}):`);
        for (const c of r.callers) {
          console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.relatedTests.length > 0) {
        const label = r.relatedTests.length === 1 ? 'file' : 'files';
        console.log(`\n${indent}  Tests (${r.relatedTests.length} ${label}):`);
        for (const t of r.relatedTests) {
          console.log(`${indent}    ${t.file}`);
        }
      }

      if (r.callees.length === 0 && r.callers.length === 0) {
        console.log(
          `${indent}  (no call edges found -- may be invoked dynamically or via re-exports)`,
        );
      }

      // Render recursive dependency details
      if (r.depDetails && r.depDetails.length > 0) {
        console.log(`\n${indent}  --- Dependencies (depth ${depthLevel + 1}) ---`);
        for (const dep of r.depDetails) {
          printFunctionExplain(dep, `${indent}  `);
        }
      }
      console.log();
    }

    for (const r of data.results) {
      printFunctionExplain(r);
    }
  }
}

// ─── where ──────────────────────────────────────────────────────────────

export function where(target, customDbPath, opts = {}) {
  const data = whereData(target, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(
      data.mode === 'file'
        ? `No file matching "${target}" in graph`
        : `No symbol matching "${target}" in graph`,
    );
    return;
  }

  if (data.mode === 'symbol') {
    for (const r of data.results) {
      const roleTag = r.role ? ` [${r.role}]` : '';
      const tag = r.exported ? '  (exported)' : '';
      console.log(`\n${kindIcon(r.kind)} ${r.name}${roleTag}  ${r.file}:${r.line}${tag}`);
      if (r.uses.length > 0) {
        const useStrs = r.uses.map((u) => `${u.file}:${u.line}`);
        console.log(`  Used in: ${useStrs.join(', ')}`);
      } else {
        console.log('  No uses found');
      }
    }
  } else {
    for (const r of data.results) {
      console.log(`\n# ${r.file}`);
      if (r.symbols.length > 0) {
        const symStrs = r.symbols.map((s) => `${s.name}:${s.line}`);
        console.log(`  Symbols: ${symStrs.join(', ')}`);
      }
      if (r.imports.length > 0) {
        console.log(`  Imports: ${r.imports.join(', ')}`);
      }
      if (r.importedBy.length > 0) {
        console.log(`  Imported by: ${r.importedBy.join(', ')}`);
      }
      if (r.exported.length > 0) {
        console.log(`  Exported: ${r.exported.join(', ')}`);
      }
    }
  }
  console.log();
}

// ─── roles ──────────────────────────────────────────────────────────────

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

// ─── fileExports ────────────────────────────────────────────────────────

export function fileExports(file, customDbPath, opts = {}) {
  const data = exportsData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    if (opts.unused) {
      console.log(`No unused exports found for "${file}".`);
    } else {
      console.log(`No exported symbols found for "${file}". Run "codegraph build" first.`);
    }
    return;
  }

  if (opts.unused) {
    console.log(
      `\n# ${data.file} — ${data.totalUnused} unused export${data.totalUnused !== 1 ? 's' : ''} (of ${data.totalExported} exported)\n`,
    );
  } else {
    const unusedNote = data.totalUnused > 0 ? ` (${data.totalUnused} unused)` : '';
    console.log(
      `\n# ${data.file} — ${data.totalExported} exported${unusedNote}, ${data.totalInternal} internal\n`,
    );
  }

  for (const sym of data.results) {
    const icon = kindIcon(sym.kind);
    const sig = sym.signature?.params ? `(${sym.signature.params})` : '';
    const role = sym.role ? ` [${sym.role}]` : '';
    console.log(`  ${icon} ${sym.name}${sig}${role} :${sym.line}`);
    if (sym.consumers.length === 0) {
      console.log('    (no consumers)');
    } else {
      for (const c of sym.consumers) {
        console.log(`    <- ${c.name} (${c.file}:${c.line})`);
      }
    }
  }

  if (data.reexports.length > 0) {
    console.log(`\n  Re-exports: ${data.reexports.map((r) => r.file).join(', ')}`);
  }
  console.log();
}

// ─── fnImpact ───────────────────────────────────────────────────────────

export function fnImpact(name, customDbPath, opts = {}) {
  const data = fnImpactData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\nFunction impact: ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}\n`);
    if (Object.keys(r.levels).length === 0) {
      console.log(`  No callers found.`);
    } else {
      for (const [level, fns] of Object.entries(r.levels).sort((a, b) => a[0] - b[0])) {
        const l = parseInt(level, 10);
        console.log(`  ${'--'.repeat(l)} Level ${level} (${fns.length} functions):`);
        for (const f of fns.slice(0, 20))
          console.log(`    ${'  '.repeat(l)}^ ${kindIcon(f.kind)} ${f.name}  ${f.file}:${f.line}`);
        if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
      }
    }
    console.log(`\n  Total: ${r.totalDependents} functions transitively depend on ${r.name}\n`);
  }
}

// ─── diffImpact ─────────────────────────────────────────────────────────

export function diffImpact(customDbPath, opts = {}) {
  if (opts.format === 'mermaid') {
    console.log(diffImpactMermaid(customDbPath, opts));
    return;
  }
  const data = diffImpactData(customDbPath, opts);
  if (opts.format === 'json') opts = { ...opts, json: true };
  if (outputResult(data, 'affectedFunctions', opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }
  if (data.changedFiles === 0) {
    console.log('No changes detected.');
    return;
  }
  if (data.affectedFunctions.length === 0) {
    console.log(
      '  No function-level changes detected (changes may be in imports, types, or config).',
    );
    return;
  }

  console.log(`\ndiff-impact: ${data.changedFiles} files changed\n`);
  console.log(`  ${data.affectedFunctions.length} functions changed:\n`);
  for (const fn of data.affectedFunctions) {
    console.log(`  ${kindIcon(fn.kind)} ${fn.name} -- ${fn.file}:${fn.line}`);
    if (fn.transitiveCallers > 0) console.log(`    ^ ${fn.transitiveCallers} transitive callers`);
  }
  if (data.historicallyCoupled && data.historicallyCoupled.length > 0) {
    console.log('\n  Historically coupled (not in static graph):\n');
    for (const c of data.historicallyCoupled) {
      const pct = `${(c.jaccard * 100).toFixed(0)}%`;
      console.log(
        `    ${c.file}  <- coupled with ${c.coupledWith} (${pct}, ${c.commitCount} commits)`,
      );
    }
  }
  if (data.ownership) {
    console.log(`\n  Affected owners: ${data.ownership.affectedOwners.join(', ')}`);
    console.log(`  Suggested reviewers: ${data.ownership.suggestedReviewers.join(', ')}`);
  }
  if (data.boundaryViolations && data.boundaryViolations.length > 0) {
    console.log(`\n  Boundary violations (${data.boundaryViolationCount}):\n`);
    for (const v of data.boundaryViolations) {
      console.log(`    [${v.name}] ${v.file} -> ${v.targetFile}`);
      if (v.message) console.log(`      ${v.message}`);
    }
  }
  if (data.summary) {
    let summaryLine = `\n  Summary: ${data.summary.functionsChanged} functions changed -> ${data.summary.callersAffected} callers affected across ${data.summary.filesAffected} files`;
    if (data.summary.historicallyCoupledCount > 0) {
      summaryLine += `, ${data.summary.historicallyCoupledCount} historically coupled`;
    }
    if (data.summary.ownersAffected > 0) {
      summaryLine += `, ${data.summary.ownersAffected} owners affected`;
    }
    if (data.summary.boundaryViolationCount > 0) {
      summaryLine += `, ${data.summary.boundaryViolationCount} boundary violations`;
    }
    console.log(`${summaryLine}\n`);
  }
}
