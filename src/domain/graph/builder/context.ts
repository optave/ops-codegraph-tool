/**
 * PipelineContext — shared mutable state threaded through all build stages.
 *
 * Each stage reads what it needs and writes what it produces.
 * This replaces the closure-captured locals in the old monolithic buildGraph().
 */
import type {
  BetterSqlite3Database,
  BuildGraphOpts,
  CodegraphConfig,
  EngineOpts,
  ExtractorOutput,
  FileToParse,
  MetadataUpdate,
  NativeDatabase,
  NodeRow,
  ParseChange,
  PathAliases,
} from '../../../types.js';

export class PipelineContext {
  // ── Inputs (set during setup) ──────────────────────────────────────
  rootDir!: string;
  db!: BetterSqlite3Database;
  dbPath!: string;
  config!: CodegraphConfig;
  opts!: BuildGraphOpts;
  engineOpts!: EngineOpts;
  engineName!: 'native' | 'wasm';
  engineVersion!: string | null;
  aliases!: PathAliases;
  incremental!: boolean;
  forceFullRebuild: boolean = false;
  schemaVersion!: number;
  nativeDb?: NativeDatabase;
  /** Whether native engine is available (deferred — DB opened only when needed). */
  nativeAvailable: boolean = false;
  /** True when ctx.db is a NativeDbProxy — single rusqlite connection for the entire pipeline. */
  nativeFirstProxy: boolean = false;

  // ── File collection (set by collectFiles stage) ────────────────────
  allFiles!: string[];
  discoveredDirs!: Set<string>;

  // ── Change detection (set by detectChanges stage) ──────────────────
  isFullBuild!: boolean;
  parseChanges!: ParseChange[];
  metadataUpdates!: MetadataUpdate[];
  removed!: string[];
  earlyExit: boolean = false;

  // ── Parsing (set by parseFiles stage) ──────────────────────────────
  allSymbols!: Map<string, ExtractorOutput>;
  fileSymbols!: Map<string, ExtractorOutput>;
  filesToParse!: FileToParse[];

  // ── Import resolution (set by resolveImports stage) ────────────────
  batchResolved!: Map<string, string> | null;
  reexportMap!: Map<string, unknown[]>;
  barrelOnlyFiles!: Set<string>;

  // ── Node lookup (set by insertNodes / buildEdges stages) ───────────
  nodesByName!: Map<string, NodeRow[]>;
  nodesByNameAndFile!: Map<string, NodeRow[]>;

  // ── Misc state ─────────────────────────────────────────────────────
  hasEmbeddings: boolean = false;
  lineCountMap!: Map<string, number>;

  // ── Phase timing ───────────────────────────────────────────────────
  timing: {
    setupMs?: number;
    parseMs?: number;
    insertMs?: number;
    resolveMs?: number;
    edgesMs?: number;
    structureMs?: number;
    rolesMs?: number;
    astMs?: number;
    complexityMs?: number;
    cfgMs?: number;
    dataflowMs?: number;
    finalizeMs?: number;
    [key: string]: number | undefined;
  } = {};
  buildStart!: number;
}
