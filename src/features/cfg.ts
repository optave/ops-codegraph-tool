import fs from 'node:fs';
import path from 'node:path';
import { CFG_RULES } from '../ast-analysis/rules/index.js';
import {
  makeCfgRules as _makeCfgRules,
  buildExtensionSet,
  buildExtToLangMap,
} from '../ast-analysis/shared.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { createCfgVisitor } from '../ast-analysis/visitors/cfg-visitor.js';
import {
  deleteCfgForNode,
  getCfgBlocks,
  getCfgEdges,
  getFunctionNodeId,
  hasCfgTables,
  openReadonlyOrFail,
} from '../db/index.js';
import { debug, info } from '../infrastructure/logger.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, Definition, NodeRow, TreeSitterNode } from '../types.js';
import { findNodes } from './shared/find-nodes.js';

export { _makeCfgRules as makeCfgRules, CFG_RULES };

const CFG_EXTENSIONS = buildExtensionSet(CFG_RULES);

// ─── Core Algorithm: AST → CFG ──────────────────────────────────────────

interface CfgBuildBlock {
  index: number;
  type: string;
  startLine: number;
  endLine: number;
  label: string;
}

interface CfgBuildEdge {
  sourceIndex: number;
  targetIndex: number;
  kind: string;
}

interface CfgBuildResult {
  blocks: CfgBuildBlock[];
  edges: CfgBuildEdge[];
  cyclomatic: number;
}

export function buildFunctionCFG(functionNode: TreeSitterNode, langId: string): CfgBuildResult {
  const rules = CFG_RULES.get(langId);
  if (!rules) return { blocks: [], edges: [], cyclomatic: 0 };

  const visitor = createCfgVisitor(rules);
  const walkerOpts = {
    functionNodeTypes: new Set(rules.functionNodes),
    nestingNodeTypes: new Set<string>(),
    getFunctionName: (node: TreeSitterNode) => {
      const nameNode = node.childForFieldName?.('name');
      return nameNode ? nameNode.text : null;
    },
  };

  const results = walkWithVisitors(functionNode, [visitor], langId, walkerOpts);
  const cfgResults = (results.cfg || []) as Array<{
    funcNode: TreeSitterNode;
    blocks: CfgBuildBlock[];
    edges: CfgBuildEdge[];
    cyclomatic: number;
  }>;
  if (cfgResults.length === 0) return { blocks: [], edges: [], cyclomatic: 0 };

  const r = cfgResults.find((result) => result.funcNode === functionNode);
  if (!r) return { blocks: [], edges: [], cyclomatic: 0 };
  return { blocks: r.blocks, edges: r.edges, cyclomatic: r.cyclomatic };
}

// ─── Build-Time Helpers ─────────────────────────────────────────────────

interface FileSymbols {
  definitions: Definition[];
  _tree?: { rootNode: TreeSitterNode };
  _langId?: string;
}

/**
 * Check whether all function/method definitions in a single file already
 * have native CFG data (blocks populated by the Rust extractor).
 * cfg === null means no body (expected); cfg with empty blocks means not computed.
 */
function hasNativeCfgForFile(symbols: FileSymbols): boolean {
  return symbols.definitions
    .filter(
      (d) =>
        (d.kind === 'function' || d.kind === 'method') &&
        d.line > 0 &&
        d.endLine != null &&
        d.endLine > d.line &&
        !d.name.includes('.'),
    )
    .every((d) => d.cfg === null || (d.cfg?.blocks?.length ?? 0) > 0);
}

async function initCfgParsers(
  fileSymbols: Map<string, FileSymbols>,
): Promise<{ parsers: unknown; getParserFn: unknown }> {
  let needsFallback = false;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (CFG_EXTENSIONS.has(ext)) {
        if (!hasNativeCfgForFile(symbols)) {
          needsFallback = true;
          break;
        }
      }
    }
  }

  let parsers: unknown = null;
  let getParserFn: unknown = null;

  if (needsFallback) {
    const { createParsers } = await import('../domain/parser.js');
    parsers = await createParsers();
    const mod = await import('../domain/parser.js');
    getParserFn = mod.getParser;
  }

  return { parsers, getParserFn };
}

function getTreeAndLang(
  symbols: FileSymbols,
  relPath: string,
  rootDir: string,
  extToLang: Map<string, string>,
  parsers: unknown,
  getParserFn: unknown,
): { tree: { rootNode: TreeSitterNode } | null; langId: string } | null {
  const ext = path.extname(relPath).toLowerCase();
  let tree = symbols._tree;
  let langId = symbols._langId;

  if (!tree && !hasNativeCfgForFile(symbols)) {
    if (!getParserFn) return null;
    langId = extToLang.get(ext);
    if (!langId || !CFG_RULES.has(langId)) return null;

    const absPath = path.join(rootDir, relPath);
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      debug(`cfg: cannot read ${relPath}: ${(e as Error).message}`);
      return null;
    }

    const parser = (getParserFn as (parsers: unknown, absPath: string) => unknown)(
      parsers,
      absPath,
    );
    if (!parser) return null;

    try {
      tree = (parser as { parse: (code: string) => { rootNode: TreeSitterNode } }).parse(code);
    } catch (e) {
      debug(`cfg: parse failed for ${relPath}: ${(e as Error).message}`);
      return null;
    }
  }

  if (!langId) {
    langId = extToLang.get(ext);
    if (!langId) return null;
  }

  return { tree: tree ?? null, langId };
}

interface VisitorCfgResult {
  funcNode: TreeSitterNode;
  blocks: CfgBuildBlock[];
  edges: CfgBuildEdge[];
}

function buildVisitorCfgMap(
  tree: { rootNode: TreeSitterNode } | null | undefined,
  cfgRules: unknown,
  symbols: FileSymbols,
  langId: string,
): Map<number, VisitorCfgResult[]> | null {
  const needsVisitor =
    tree &&
    symbols.definitions.some(
      (d) =>
        (d.kind === 'function' || d.kind === 'method') &&
        d.line &&
        d.cfg !== null &&
        !d.cfg?.blocks?.length,
    );
  if (!needsVisitor) return null;

  const visitor = createCfgVisitor(cfgRules);
  const typedRules = cfgRules as { functionNodes: string[] };
  const walkerOpts = {
    functionNodeTypes: new Set(typedRules.functionNodes),
    nestingNodeTypes: new Set<string>(),
    getFunctionName: (node: TreeSitterNode) => {
      const nameNode = node.childForFieldName?.('name');
      return nameNode ? nameNode.text : null;
    },
  };
  const walkResults = walkWithVisitors(tree?.rootNode, [visitor], langId, walkerOpts);
  const cfgResults = (walkResults.cfg || []) as VisitorCfgResult[];
  const visitorCfgByLine = new Map<number, VisitorCfgResult[]>();
  for (const r of cfgResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!visitorCfgByLine.has(line)) visitorCfgByLine.set(line, []);
      visitorCfgByLine.get(line)?.push(r);
    }
  }
  return visitorCfgByLine;
}

function persistCfg(
  cfg: { blocks: CfgBuildBlock[]; edges: CfgBuildEdge[] },
  nodeId: number,
  insertBlock: ReturnType<BetterSqlite3Database['prepare']>,
  insertEdge: ReturnType<BetterSqlite3Database['prepare']>,
): void {
  const blockDbIds = new Map<number, number | bigint>();
  for (const block of cfg.blocks) {
    const result = insertBlock.run(
      nodeId,
      block.index,
      block.type,
      block.startLine,
      block.endLine,
      block.label,
    );
    blockDbIds.set(block.index, result.lastInsertRowid);
  }

  for (const edge of cfg.edges) {
    const sourceDbId = blockDbIds.get(edge.sourceIndex);
    const targetDbId = blockDbIds.get(edge.targetIndex);
    if (sourceDbId && targetDbId) {
      insertEdge.run(nodeId, sourceDbId, targetDbId, edge.kind);
    }
  }
}

// ─── Build-Time: Compute CFG for Changed Files ─────────────────────────

/**
 * Check if all function/method definitions across all files already have
 * native CFG data (blocks array populated by the Rust extractor).
 * When true, the WASM parser and JS CFG visitor can be fully bypassed.
 */
function allCfgNative(fileSymbols: Map<string, FileSymbols>): boolean {
  let hasCfgFile = false;
  for (const [relPath, symbols] of fileSymbols) {
    if (symbols._tree) continue; // already parsed via WASM; will use _tree in slow path
    const ext = path.extname(relPath).toLowerCase();
    if (!CFG_EXTENSIONS.has(ext)) continue;
    hasCfgFile = true;

    if (!hasNativeCfgForFile(symbols)) return false;
  }
  // Return false when no CFG files found (empty map, all _tree, or all non-CFG
  // extensions) to avoid vacuously triggering the fast path.
  return hasCfgFile;
}

export async function buildCFGData(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbols>,
  rootDir: string,
  _engineOpts?: unknown,
): Promise<void> {
  // Fast path: when all function/method defs already have native CFG data,
  // skip WASM parser init, tree parsing, and JS visitor entirely — just persist.
  const allNative = allCfgNative(fileSymbols);

  const extToLang = buildExtToLangMap();
  let parsers: unknown = null;
  let getParserFn: unknown = null;

  if (!allNative) {
    ({ parsers, getParserFn } = await initCfgParsers(fileSymbols));
  }

  const insertBlock = db.prepare(
    `INSERT INTO cfg_blocks (function_node_id, block_index, block_type, start_line, end_line, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO cfg_edges (function_node_id, source_block_id, target_block_id, kind)
     VALUES (?, ?, ?, ?)`,
  );
  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!CFG_EXTENSIONS.has(ext)) continue;

      // Native fast path: skip tree/visitor setup when all CFG is pre-computed.
      // Only apply to files without _tree — files with _tree were WASM-parsed
      // and need the slow path (visitor) to compute CFG.
      if (allNative && !symbols._tree) {
        for (const def of symbols.definitions) {
          if (def.kind !== 'function' && def.kind !== 'method') continue;
          if (!def.line) continue;

          const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
          if (!nodeId) continue;

          // Always delete stale CFG rows (handles body-removed case)
          deleteCfgForNode(db, nodeId);
          if (!def.cfg?.blocks?.length) continue;

          persistCfg(
            def.cfg as unknown as { blocks: CfgBuildBlock[]; edges: CfgBuildEdge[] },
            nodeId,
            insertBlock,
            insertEdge,
          );
          analyzed++;
        }
        continue;
      }

      // When allNative=true, parsers/getParserFn are null. This is safe because
      // _tree files use symbols._tree directly in getTreeAndLang (the parser
      // code path is never reached). Non-_tree files are handled by the fast path above.
      const treeLang = getTreeAndLang(symbols, relPath, rootDir, extToLang, parsers, getParserFn);
      if (!treeLang) continue;
      const { tree, langId } = treeLang;

      const cfgRules = CFG_RULES.get(langId);
      if (!cfgRules) continue;

      const visitorCfgByLine = buildVisitorCfgMap(tree, cfgRules, symbols, langId);

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
        if (!nodeId) continue;

        let cfg: { blocks: CfgBuildBlock[]; edges: CfgBuildEdge[] } | null = null;
        if (def.cfg?.blocks?.length) {
          cfg = def.cfg as unknown as { blocks: CfgBuildBlock[]; edges: CfgBuildEdge[] };
        } else if (visitorCfgByLine) {
          const candidates = visitorCfgByLine.get(def.line);
          const r = !candidates
            ? undefined
            : candidates.length === 1
              ? candidates[0]
              : (candidates.find((c) => {
                  const n = c.funcNode.childForFieldName?.('name');
                  return n && n.text === def.name;
                }) ?? candidates[0]);
          if (r) cfg = { blocks: r.blocks, edges: r.edges };
        }

        // Always purge stale rows (handles body-removed case)
        deleteCfgForNode(db, nodeId);
        if (!cfg || cfg.blocks.length === 0) continue;

        persistCfg(cfg, nodeId, insertBlock, insertEdge);
        analyzed++;
      }
    }
  });

  tx();

  if (analyzed > 0) {
    info(`CFG: ${analyzed} functions analyzed`);
  }
}

// ─── Query-Time Functions ───────────────────────────────────────────────

const CFG_DEFAULT_KINDS = ['function', 'method'];

interface CfgQueryBlock {
  index: number;
  type: string;
  startLine: number;
  endLine: number;
  label: string | null;
}

interface CfgQueryEdge {
  source: number;
  sourceType: string;
  target: number;
  targetType: string;
  kind: string;
}

interface CfgQueryFunctionResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  blocks: CfgQueryBlock[];
  edges: CfgQueryEdge[];
  summary: { blockCount: number; edgeCount: number };
}

interface CfgDataResult {
  name: string;
  results: CfgQueryFunctionResult[];
  warning?: string;
  _pagination?: unknown;
}

interface CfgOpts {
  noTests?: boolean;
  file?: string | string[];
  kind?: string;
  limit?: number;
  offset?: number;
}

export function cfgData(
  name: string,
  customDbPath: string | undefined,
  opts: CfgOpts = {},
): CfgDataResult {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    if (!hasCfgTables(db)) {
      return {
        name,
        results: [],
        warning:
          'No CFG data found. Rebuild with `codegraph build` (CFG is now included by default).',
      };
    }

    const nodes = findNodes(
      db,
      name,
      { noTests, file: opts.file, kind: opts.kind },
      CFG_DEFAULT_KINDS,
    );
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results: CfgQueryFunctionResult[] = nodes.map((node: NodeRow) => {
      const cfgBlocks = getCfgBlocks(db, node.id);
      const cfgEdges = getCfgEdges(db, node.id);

      return {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        blocks: cfgBlocks.map((b) => ({
          index: b.block_index,
          type: b.block_type,
          startLine: b.start_line,
          endLine: b.end_line,
          label: b.label,
        })),
        edges: cfgEdges.map((e) => ({
          source: e.source_index,
          sourceType: e.source_type,
          target: e.target_index,
          targetType: e.target_type,
          kind: e.kind,
        })),
        summary: {
          blockCount: cfgBlocks.length,
          edgeCount: cfgEdges.length,
        },
      };
    });

    return paginateResult({ name, results }, 'results', opts);
  } finally {
    db.close();
  }
}

// ─── Export Formats ─────────────────────────────────────────────────────

export function cfgToDOT(cfgResult: CfgDataResult): string {
  const lines: string[] = [];

  for (const r of cfgResult.results) {
    lines.push(`digraph "${r.name}" {`);
    lines.push('  rankdir=TB;');
    lines.push('  node [shape=box, fontname="monospace", fontsize=10];');

    for (const block of r.blocks) {
      const label = blockLabel(block);
      const shape = block.type === 'entry' || block.type === 'exit' ? 'ellipse' : 'box';
      const style =
        block.type === 'condition' || block.type === 'loop_header'
          ? ', style=filled, fillcolor="#ffffcc"'
          : '';
      lines.push(`  B${block.index} [label="${label}", shape=${shape}${style}];`);
    }

    for (const edge of r.edges) {
      const style = edgeStyle(edge.kind);
      lines.push(`  B${edge.source} -> B${edge.target} [label="${edge.kind}"${style}];`);
    }

    lines.push('}');
  }

  return lines.join('\n');
}

export function cfgToMermaid(cfgResult: CfgDataResult): string {
  const lines: string[] = [];

  for (const r of cfgResult.results) {
    lines.push(`graph TD`);
    lines.push(`  subgraph "${r.name}"`);

    for (const block of r.blocks) {
      const label = blockLabel(block);
      if (block.type === 'entry' || block.type === 'exit') {
        lines.push(`    B${block.index}(["${label}"])`);
      } else if (block.type === 'condition' || block.type === 'loop_header') {
        lines.push(`    B${block.index}{"${label}"}`);
      } else {
        lines.push(`    B${block.index}["${label}"]`);
      }
    }

    for (const edge of r.edges) {
      const label = edge.kind;
      lines.push(`    B${edge.source} -->|${label}| B${edge.target}`);
    }

    lines.push('  end');
  }

  return lines.join('\n');
}

function blockLabel(block: CfgQueryBlock): string {
  const loc =
    block.startLine && block.endLine
      ? ` L${block.startLine}${block.endLine !== block.startLine ? `-${block.endLine}` : ''}`
      : '';
  const label = block.label ? ` (${block.label})` : '';
  return `${block.type}${label}${loc}`;
}

function edgeStyle(kind: string): string {
  if (kind === 'exception') return ', color=red, fontcolor=red';
  if (kind === 'branch_true') return ', color=green, fontcolor=green';
  if (kind === 'branch_false') return ', color=red, fontcolor=red';
  if (kind === 'loop_back') return ', style=dashed, color=blue';
  if (kind === 'loop_exit') return ', color=orange';
  if (kind === 'return') return ', color=purple';
  if (kind === 'break') return ', color=orange, style=dashed';
  if (kind === 'continue') return ', color=blue, style=dashed';
  return '';
}
