import Database from 'better-sqlite3';
import { openRepo, type Repository } from '../db/index.js';
import { SqliteRepository } from '../db/repository/sqlite-repository.js';
import { findMatchingNodes } from '../domain/queries.js';
import { loadConfig } from '../infrastructure/config.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, CodegraphConfig, NodeRowWithFanIn } from '../types.js';
import { FRAMEWORK_ENTRY_PREFIXES } from './structure.js';

// ─── Alias generation ────────────────────────────────────────────────

function buildAliases(files: string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const basenames = new Map<string, string[]>();

  // Group by basename
  for (const file of files) {
    const base = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '');
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base)!.push(file);
  }

  for (const [base, paths] of basenames) {
    if (paths.length === 1) {
      aliases.set(paths[0]!, base);
    } else {
      // Collision — progressively add parent dirs until aliases are unique
      for (let depth = 2; depth <= 10; depth++) {
        const trial = new Map<string, string>();
        let allUnique = true;
        const seen = new Set<string>();

        for (const p of paths) {
          const parts = p.replace(/\.[^.]+$/, '').split('/');
          const alias = parts
            .slice(-depth)
            .join('_')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
          trial.set(p, alias);
          if (seen.has(alias)) allUnique = false;
          seen.add(alias);
        }

        if (allUnique || depth === 10) {
          for (const [p, alias] of trial) {
            aliases.set(p, alias);
          }
          break;
        }
      }
    }
  }

  return aliases;
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface MatchNode extends NodeRowWithFanIn {
  _relevance: number;
}

function findEntryNode(
  repo: Repository,
  name: string,
  opts: { noTests?: boolean; file?: string; kind?: string },
): MatchNode | null {
  let matchNode: MatchNode | null = findMatchingNodes(repo, name, opts)[0] ?? null;
  if (!matchNode) {
    for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
      matchNode = findMatchingNodes(repo, `${prefix}${name}`, opts)[0] ?? null;
      if (matchNode) break;
    }
  }
  return matchNode;
}

interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  type: 'call' | 'return';
  depth: number;
}

interface BfsResult {
  messages: SequenceMessage[];
  fileSet: Set<string>;
  idToNode: Map<number, { id: number; name: string; file: string; kind: string; line: number }>;
  truncated: boolean;
}

function bfsCallees(
  repo: Repository,
  matchNode: MatchNode,
  maxDepth: number,
  noTests: boolean,
): BfsResult {
  const visited = new Set<number>([matchNode.id]);
  let frontier = [matchNode.id];
  const messages: SequenceMessage[] = [];
  const fileSet = new Set<string>([matchNode.file]);
  const idToNode = new Map<
    number,
    { id: number; name: string; file: string; kind: string; line: number }
  >();
  idToNode.set(matchNode.id, matchNode);
  let truncated = false;

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: number[] = [];

    for (const fid of frontier) {
      const callees = repo.findCallees(fid);
      const caller = idToNode.get(fid)!;

      for (const c of callees) {
        if (noTests && isTestFile(c.file)) continue;

        fileSet.add(c.file);
        messages.push({
          from: caller.file,
          to: c.file,
          label: c.name,
          type: 'call',
          depth: d,
        });

        if (visited.has(c.id)) continue;

        visited.add(c.id);
        nextFrontier.push(c.id);
        idToNode.set(c.id, c);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;

    if (d === maxDepth && frontier.length > 0) {
      const hasMoreCalls = frontier.some((fid) => repo.findCallees(fid).length > 0);
      if (hasMoreCalls) truncated = true;
    }
  }

  return { messages, fileSet, idToNode, truncated };
}

function annotateDataflow(
  repo: Repository,
  messages: SequenceMessage[],
  idToNode: Map<number, { id: number; name: string; file: string; kind: string; line: number }>,
  dbPath?: string,
): void {
  const hasTable = repo.hasDataflowTable();
  if (!hasTable) return;

  let db: BetterSqlite3Database;
  let ownDb = false;
  if (repo instanceof SqliteRepository) {
    db = repo.db;
  } else if (dbPath) {
    db = new Database(dbPath, { readonly: true }) as unknown as BetterSqlite3Database;
    ownDb = true;
  } else {
    return;
  }

  try {
    _annotateDataflowImpl(db, messages, idToNode);
  } finally {
    if (ownDb) db.close();
  }
}

function _annotateDataflowImpl(
  db: BetterSqlite3Database,
  messages: SequenceMessage[],
  idToNode: Map<number, { id: number; name: string; file: string; kind: string; line: number }>,
): void {
  const nodeByNameFile = new Map<string, { id: number; name: string; file: string }>();
  for (const n of idToNode.values()) {
    nodeByNameFile.set(`${n.name}|${n.file}`, n);
  }

  const getReturns = db.prepare(
    `SELECT d.expression FROM dataflow d
         WHERE d.source_id = ? AND d.kind = 'returns'`,
  );
  const getFlowsTo = db.prepare(
    `SELECT d.expression FROM dataflow d
         WHERE d.target_id = ? AND d.kind = 'flows_to'
         ORDER BY d.param_index`,
  );

  const seenReturns = new Set<string>();
  for (const msg of [...messages]) {
    if (msg.type !== 'call') continue;
    const targetNode = nodeByNameFile.get(`${msg.label}|${msg.to}`);
    if (!targetNode) continue;

    const returnKey = `${msg.to}->${msg.from}:${msg.label}`;
    if (seenReturns.has(returnKey)) continue;

    const returns = getReturns.all(targetNode.id) as { expression: string }[];

    if (returns.length > 0) {
      seenReturns.add(returnKey);
      const expr = returns[0]!.expression || 'result';
      messages.push({
        from: msg.to,
        to: msg.from,
        label: expr,
        type: 'return',
        depth: msg.depth,
      });
    }
  }

  for (const msg of messages) {
    if (msg.type !== 'call') continue;
    const targetNode = nodeByNameFile.get(`${msg.label}|${msg.to}`);
    if (!targetNode) continue;

    const params = getFlowsTo.all(targetNode.id) as { expression: string }[];

    if (params.length > 0) {
      const paramNames = params
        .map((p) => p.expression)
        .filter(Boolean)
        .slice(0, 3);
      if (paramNames.length > 0) {
        msg.label = `${msg.label}(${paramNames.join(', ')})`;
      }
    }
  }
}

interface Participant {
  id: string;
  label: string;
  file: string;
}

function buildParticipants(
  fileSet: Set<string>,
  entryFile: string,
): { participants: Participant[]; aliases: Map<string, string> } {
  const aliases = buildAliases([...fileSet]);
  const participants: Participant[] = [...fileSet].map((file) => ({
    id: aliases.get(file)!,
    label: file.split('/').pop() ?? file,
    file,
  }));

  participants.sort((a, b) => {
    if (a.file === entryFile) return -1;
    if (b.file === entryFile) return 1;
    return a.file.localeCompare(b.file);
  });

  return { participants, aliases };
}

// ─── Core data function ──────────────────────────────────────────────

interface SequenceDataOpts {
  depth?: number;
  noTests?: boolean;
  file?: string;
  kind?: string;
  dataflow?: boolean;
  limit?: number;
  offset?: number;
  config?: CodegraphConfig;
  repo?: Repository;
}

interface SequenceEntry {
  name: string;
  file: string;
  kind: string;
  line: number;
}

interface SequenceDataResult {
  entry: SequenceEntry | null;
  participants: Participant[];
  messages: SequenceMessage[];
  depth: number;
  totalMessages: number;
  truncated: boolean;
}

export function sequenceData(
  name: string,
  dbPath?: string,
  opts: SequenceDataOpts = {},
): SequenceDataResult {
  const { repo, close } = openRepo(dbPath, opts);
  try {
    const config = opts.config || loadConfig();
    const maxDepth = opts.depth || config.analysis.sequenceDepth || 10;
    const noTests = opts.noTests || false;

    const matchNode = findEntryNode(repo, name, opts);
    if (!matchNode) {
      return {
        entry: null,
        participants: [],
        messages: [],
        depth: maxDepth,
        totalMessages: 0,
        truncated: false,
      };
    }

    const entry: SequenceEntry = {
      name: matchNode.name,
      file: matchNode.file,
      kind: matchNode.kind,
      line: matchNode.line,
    };

    const { messages, fileSet, idToNode, truncated } = bfsCallees(
      repo,
      matchNode,
      maxDepth,
      noTests,
    );

    if (opts.dataflow && messages.length > 0) {
      annotateDataflow(repo, messages, idToNode, dbPath);
    }

    messages.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      if (a.type === 'call' && b.type === 'return') return -1;
      if (a.type === 'return' && b.type === 'call') return 1;
      return 0;
    });

    const { participants, aliases } = buildParticipants(fileSet, entry.file);

    for (const msg of messages) {
      msg.from = aliases.get(msg.from)!;
      msg.to = aliases.get(msg.to)!;
    }

    const base = {
      entry,
      participants,
      messages,
      depth: maxDepth,
      totalMessages: messages.length,
      truncated,
    };
    const result = paginateResult(base, 'messages', {
      limit: opts.limit,
      offset: opts.offset,
    }) as SequenceDataResult;
    if (opts.limit !== undefined || opts.offset !== undefined) {
      const activeFiles = new Set(result.messages.flatMap((m) => [m.from, m.to]));
      result.participants = result.participants.filter((p) => activeFiles.has(p.id));
    }
    return result;
  } finally {
    close();
  }
}

// Re-export Mermaid renderer from presentation layer
export { sequenceToMermaid } from '../presentation/sequence-renderer.js';
