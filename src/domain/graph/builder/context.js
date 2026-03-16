/**
 * PipelineContext — shared mutable state threaded through all build stages.
 *
 * Each stage reads what it needs and writes what it produces.
 * This replaces the closure-captured locals in the old monolithic buildGraph().
 */
export class PipelineContext {
  // ── Inputs (set during setup) ──────────────────────────────────────
  /** @type {string} Absolute root directory */
  rootDir;
  /** @type {import('better-sqlite3').Database} */
  db;
  /** @type {string} Absolute path to the database file */
  dbPath;
  /** @type {object} From loadConfig() */
  config;
  /** @type {object} Original buildGraph opts */
  opts;
  /** @type {{ engine: string, dataflow: boolean, ast: boolean }} */
  engineOpts;
  /** @type {string} 'native' | 'wasm' */
  engineName;
  /** @type {string|null} */
  engineVersion;
  /** @type {{ baseUrl: string|null, paths: object }} */
  aliases;
  /** @type {boolean} Whether incremental mode is enabled */
  incremental;
  /** @type {boolean} Force full rebuild (engine/schema mismatch) */
  forceFullRebuild = false;
  /** @type {number} Current schema version */
  schemaVersion;

  // ── File collection (set by collectFiles stage) ────────────────────
  /** @type {string[]} Absolute file paths */
  allFiles;
  /** @type {Set<string>} Absolute directory paths */
  discoveredDirs;

  // ── Change detection (set by detectChanges stage) ──────────────────
  /** @type {boolean} */
  isFullBuild;
  /** @type {Array<{ file: string, relPath?: string, content?: string, hash?: string, stat?: object, _reverseDepOnly?: boolean }>} */
  parseChanges;
  /** @type {Array<{ relPath: string, hash: string, stat: object }>} Metadata-only self-heal updates */
  metadataUpdates;
  /** @type {string[]} Relative paths of deleted files */
  removed;
  /** @type {boolean} True when no changes detected — skip remaining stages */
  earlyExit = false;

  // ── Parsing (set by parseFiles stage) ──────────────────────────────
  /** @type {Map<string, object>} relPath → symbols from parseFilesAuto */
  allSymbols;
  /** @type {Map<string, object>} relPath → symbols (includes incrementally loaded) */
  fileSymbols;
  /** @type {Array<{ file: string, relPath?: string }>} Files to parse this build */
  filesToParse;

  // ── Import resolution (set by resolveImports stage) ────────────────
  /** @type {Map<string, string>|null} "absFile|source" → resolved path */
  batchResolved;
  /** @type {Map<string, Array>} relPath → re-export descriptors */
  reexportMap;
  /** @type {Set<string>} Files loaded only for barrel resolution (don't rebuild edges) */
  barrelOnlyFiles;

  // ── Node lookup (set by insertNodes / buildEdges stages) ───────────
  /** @type {Map<string, Array>} name → node rows */
  nodesByName;
  /** @type {Map<string, Array>} "name|file" → node rows */
  nodesByNameAndFile;

  // ── Misc state ─────────────────────────────────────────────────────
  /** @type {boolean} Whether embeddings table exists */
  hasEmbeddings = false;
  /** @type {Map<string, number>} relPath → line count */
  lineCountMap;

  // ── Phase timing ───────────────────────────────────────────────────
  timing = {};

  /** @type {number} performance.now() at build start */
  buildStart;
}
