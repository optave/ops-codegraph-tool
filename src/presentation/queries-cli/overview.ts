import path from 'node:path';
import { kindIcon, moduleMapData, rolesData, statsData } from '../../domain/queries.js';
import { debug } from '../../infrastructure/logger.js';
import { outputResult } from '../../infrastructure/result-formatter.js';
import { toErrorMessage } from '../../shared/errors.js';

interface OutputOpts {
  json?: boolean;
  ndjson?: boolean;
  csv?: boolean;
  table?: boolean;
  noTests?: boolean;
  role?: string | null;
  file?: string;
  kind?: string;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

interface StatsNodes {
  total: number;
  byKind: Record<string, number>;
}

interface StatsEdges {
  total: number;
  byKind: Record<string, number>;
}

interface StatsFiles {
  total: number;
  languages: number;
  byLanguage: Record<string, number>;
}

interface StatsCycles {
  fileLevel: number;
  functionLevel: number;
}

interface Hotspot {
  file: string;
  fanIn: number;
  fanOut: number;
}

interface EmbeddingsInfo {
  count: number;
  model?: string;
  dim?: number;
  builtAt?: string;
}

interface QualityInfo {
  score: number;
  callerCoverage: { ratio: number; covered: number; total: number };
  callConfidence: { ratio: number; highConf: number; total: number };
  falsePositiveWarnings: { name: string; callerCount: number; file: string; line: number }[];
}

interface ComplexityInfo {
  analyzed: number;
  avgCognitive: number;
  avgCyclomatic: number;
  maxCognitive: number;
  avgMI?: number;
  minMI?: number;
}

interface CommunityInfo {
  communityCount: number;
  modularity: number;
  driftScore: number;
}

interface StatsData {
  nodes: StatsNodes;
  edges: StatsEdges;
  files: StatsFiles;
  cycles: StatsCycles;
  hotspots: Hotspot[];
  embeddings?: EmbeddingsInfo;
  quality?: QualityInfo;
  roles?: Record<string, number>;
  complexity?: ComplexityInfo;
  communities?: CommunityInfo;
}

interface TopNode {
  dir: string;
  file: string;
  inEdges: number;
  outEdges: number;
}

interface ModuleMapData {
  topNodes: TopNode[];
  stats: { totalFiles: number; totalNodes: number; totalEdges: number };
}

interface RoleSymbol {
  kind: string;
  name: string;
  file: string;
  line: number;
  role: string;
}

interface RolesData {
  count: number;
  summary: Record<string, number>;
  symbols: RoleSymbol[];
}

function printCountGrid(entries: [string, number][], padWidth: number): void {
  const parts = entries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < parts.length; i += 3) {
    const row = parts
      .slice(i, i + 3)
      .map((p) => p.padEnd(padWidth))
      .join('');
    console.log(`  ${row}`);
  }
}

function printNodes(data: StatsData): void {
  console.log(`Nodes:     ${data.nodes.total} total`);
  const kindEntries = Object.entries(data.nodes.byKind).sort((a, b) => b[1] - a[1]) as [
    string,
    number,
  ][];
  printCountGrid(kindEntries, 18);
}

function printEdges(data: StatsData): void {
  console.log(`\nEdges:     ${data.edges.total} total`);
  const edgeEntries = Object.entries(data.edges.byKind).sort((a, b) => b[1] - a[1]) as [
    string,
    number,
  ][];
  printCountGrid(edgeEntries, 18);
}

function printFiles(data: StatsData): void {
  console.log(`\nFiles:     ${data.files.total} (${data.files.languages} languages)`);
  const langEntries = Object.entries(data.files.byLanguage).sort((a, b) => b[1] - a[1]) as [
    string,
    number,
  ][];
  printCountGrid(langEntries, 18);
}

function printCycles(data: StatsData): void {
  console.log(
    `\nCycles:    ${data.cycles.fileLevel} file-level, ${data.cycles.functionLevel} function-level`,
  );
}

function printHotspots(data: StatsData): void {
  if (data.hotspots.length > 0) {
    console.log(`\nTop ${data.hotspots.length} coupling hotspots:`);
    for (let i = 0; i < data.hotspots.length; i++) {
      const h = data.hotspots[i]!;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${h.file.padEnd(35)} fan-in: ${String(h.fanIn).padStart(3)}  fan-out: ${String(h.fanOut).padStart(3)}`,
      );
    }
  }
}

function printEmbeddings(data: StatsData): void {
  if (data.embeddings) {
    const e = data.embeddings;
    console.log(
      `\nEmbeddings: ${e.count} vectors (${e.model || 'unknown'}, ${e.dim || '?'}d) built ${e.builtAt || 'unknown'}`,
    );
  } else {
    console.log('\nEmbeddings: not built');
  }
}

function printQuality(data: StatsData): void {
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
}

function printRoles(data: StatsData): void {
  if (data.roles && Object.keys(data.roles).length > 0) {
    const total = Object.values(data.roles).reduce((a, b) => a + b, 0);
    console.log(`\nRoles:     ${total} classified symbols`);
    const roleEntries = Object.entries(data.roles).sort((a, b) => b[1] - a[1]) as [
      string,
      number,
    ][];
    printCountGrid(roleEntries, 18);
  }
}

function printComplexity(data: StatsData): void {
  if (data.complexity) {
    const cx = data.complexity;
    const miPart = cx.avgMI != null ? ` | avg MI: ${cx.avgMI} | min MI: ${cx.minMI}` : '';
    console.log(
      `\nComplexity: ${cx.analyzed} functions | avg cognitive: ${cx.avgCognitive} | avg cyclomatic: ${cx.avgCyclomatic} | max cognitive: ${cx.maxCognitive}${miPart}`,
    );
  }
}

function printCommunities(data: StatsData): void {
  if (data.communities) {
    const cm = data.communities;
    console.log(
      `\nCommunities: ${cm.communityCount} detected | modularity: ${cm.modularity} | drift: ${cm.driftScore}%`,
    );
  }
}

export async function stats(customDbPath: string, opts: OutputOpts = {}): Promise<void> {
  const data = statsData(customDbPath, { noTests: opts.noTests }) as StatsData;

  try {
    const { communitySummaryForStats } = await import('../../features/communities.js');
    data.communities = communitySummaryForStats(customDbPath, { noTests: opts.noTests });
  } catch (e) {
    debug(`stats: community detection failed (optional): ${toErrorMessage(e)}`);
  }

  if (outputResult(data as unknown as Record<string, unknown>, null, opts)) return;

  console.log('\n# Codegraph Stats\n');
  printNodes(data);
  printEdges(data);
  printFiles(data);
  printCycles(data);
  printHotspots(data);
  printEmbeddings(data);
  printQuality(data);
  printRoles(data);
  printComplexity(data);
  printCommunities(data);
  console.log();
}

export function moduleMap(customDbPath: string, limit = 20, opts: OutputOpts = {}): void {
  const data = moduleMapData(customDbPath, limit, { noTests: opts.noTests }) as ModuleMapData;
  if (outputResult(data as unknown as Record<string, unknown>, 'topNodes', opts)) return;

  console.log(`\nModule map (top ${limit} most-connected nodes):\n`);
  const dirs = new Map<string, TopNode[]>();
  for (const n of data.topNodes) {
    if (!dirs.has(n.dir)) dirs.set(n.dir, []);
    dirs.get(n.dir)!.push(n);
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

function groupByRole(symbols: RoleSymbol[]): Record<string, RoleSymbol[]> {
  const byRole: Record<string, RoleSymbol[]> = {};
  for (const s of symbols) {
    if (!byRole[s.role]) byRole[s.role] = [];
    byRole[s.role]!.push(s);
  }
  return byRole;
}

function printRoleGroup(role: string, symbols: RoleSymbol[]): void {
  console.log(`## ${role} (${symbols.length})`);
  for (const s of symbols.slice(0, 30)) {
    console.log(`  ${kindIcon(s.kind)} ${s.name}  ${s.file}:${s.line}`);
  }
  if (symbols.length > 30) {
    console.log(`  ... and ${symbols.length - 30} more`);
  }
  console.log();
}

export function roles(customDbPath: string, opts: OutputOpts = {}): void {
  const data = rolesData(customDbPath, opts) as RolesData;
  if (outputResult(data as unknown as Record<string, unknown>, 'symbols', opts)) return;

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

  const byRole = groupByRole(data.symbols);
  for (const [role, symbols] of Object.entries(byRole)) {
    printRoleGroup(role, symbols);
  }
}
