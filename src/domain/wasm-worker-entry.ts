/**
 * WASM parse worker entry point.
 *
 * Runs as a Node.js `worker_threads` worker. Owns every tree-sitter WASM call
 * so that fatal V8 aborts from the grammar (#965) kill only this worker —
 * never the main build process.
 *
 * For each `parse` request:
 *   1. Pick the language by file extension.
 *   2. Lazy-load the WASM grammar (first request per language).
 *   3. Parse the source.
 *   4. Run the extractor.
 *   5. Run the unified AST visitor walk (ast-store, complexity, CFG, dataflow)
 *      so that all analysis data is pre-computed before the tree is freed.
 *   6. `tree.delete()` in a finally block to release WASM linear memory.
 *   7. Serialize ExtractorOutput to a structured-clone-safe form and respond.
 *
 * The worker does NOT import from `./parser.js` — that module owns
 * process-global parser/grammar caches that are not worker-safe. Instead
 * this file keeps its own per-worker caches and its own (local) language
 * registry. Extractors are imported directly from `../extractors/index.js`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import type { Tree } from 'web-tree-sitter';
import { Language, Parser, Query } from 'web-tree-sitter';
import { computeLOCMetrics, computeMaintainabilityIndex } from '../ast-analysis/metrics.js';
import {
  AST_TYPE_MAPS,
  CFG_RULES,
  COMPLEXITY_RULES,
  DATAFLOW_RULES,
  HALSTEAD_RULES,
} from '../ast-analysis/rules/index.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { functionName as getFuncName } from '../ast-analysis/visitor-utils.js';
import { createAstStoreVisitor } from '../ast-analysis/visitors/ast-store-visitor.js';
import { createCfgVisitor } from '../ast-analysis/visitors/cfg-visitor.js';
import { createComplexityVisitor } from '../ast-analysis/visitors/complexity-visitor.js';
import { createDataflowVisitor } from '../ast-analysis/visitors/dataflow-visitor.js';
import {
  extractBashSymbols,
  extractClojureSymbols,
  extractCppSymbols,
  extractCSharpSymbols,
  extractCSymbols,
  extractCudaSymbols,
  extractDartSymbols,
  extractElixirSymbols,
  extractErlangSymbols,
  extractFSharpSymbols,
  extractGleamSymbols,
  extractGoSymbols,
  extractGroovySymbols,
  extractHaskellSymbols,
  extractHCLSymbols,
  extractJavaSymbols,
  extractJuliaSymbols,
  extractKotlinSymbols,
  extractLuaSymbols,
  extractObjCSymbols,
  extractOCamlSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractScalaSymbols,
  extractSoliditySymbols,
  extractSwiftSymbols,
  extractSymbols,
  extractVerilogSymbols,
  extractZigSymbols,
} from '../extractors/index.js';
import type {
  CfgBlock,
  CfgEdge,
  DataflowResult,
  Definition,
  ExtractorOutput,
  LanguageId,
  LanguageRegistryEntry,
  TreeSitterNode,
  Visitor,
  WalkOptions,
  WalkResults,
} from '../types.js';
import type {
  SerializedExtractorOutput,
  WorkerParseRequest,
  WorkerRequest,
  WorkerResponse,
} from './wasm-worker-protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Grammars ship at `<repo-root>/grammars/`. Worker file is at
 *  `src/domain/wasm-worker-entry.ts` (or `dist/domain/wasm-worker-entry.js`);
 *  both resolve to the same relative path. */
function grammarPath(name: string): string {
  return path.join(__dirname, '..', '..', 'grammars', name);
}

// ── Shared JS/TS/TSX query patterns (mirrors parser.ts) ─────────────────────

const COMMON_QUERY_PATTERNS: string[] = [
  '(function_declaration name: (identifier) @fn_name) @fn_node',
  '(variable_declarator name: (identifier) @varfn_name value: (arrow_function) @varfn_value)',
  '(variable_declarator name: (identifier) @varfn_name value: (function_expression) @varfn_value)',
  '(method_definition name: (property_identifier) @meth_name) @meth_node',
  '(method_definition name: (private_property_identifier) @meth_name) @meth_node',
  '(import_statement source: (string) @imp_source) @imp_node',
  '(export_statement) @exp_node',
  '(call_expression function: (identifier) @callfn_name) @callfn_node',
  '(call_expression function: (member_expression) @callmem_fn) @callmem_node',
  '(call_expression function: (subscript_expression) @callsub_fn) @callsub_node',
  '(new_expression constructor: (identifier) @newfn_name) @newfn_node',
  '(new_expression constructor: (member_expression) @newmem_fn) @newmem_node',
  '(expression_statement (assignment_expression left: (member_expression) @assign_left right: (_) @assign_right)) @assign_node',
];

const JS_CLASS_PATTERN: string = '(class_declaration name: (identifier) @cls_name) @cls_node';

const TS_EXTRA_PATTERNS: string[] = [
  '(class_declaration name: (type_identifier) @cls_name) @cls_node',
  '(interface_declaration name: (type_identifier) @iface_name) @iface_node',
  '(type_alias_declaration name: (type_identifier) @type_name) @type_node',
];

// ── Local language registry ─────────────────────────────────────────────────
// Local copy — re-using parser.ts's registry would drag in its process-wide
// parser/grammar caches, which are not safe to share across worker threads.

const LANGUAGE_REGISTRY: LanguageRegistryEntry[] = [
  {
    id: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammarFile: 'tree-sitter-javascript.wasm',
    extractor: extractSymbols,
    required: true,
  },
  {
    id: 'typescript',
    extensions: ['.ts'],
    grammarFile: 'tree-sitter-typescript.wasm',
    extractor: extractSymbols,
    required: true,
  },
  {
    id: 'tsx',
    extensions: ['.tsx'],
    grammarFile: 'tree-sitter-tsx.wasm',
    extractor: extractSymbols,
    required: true,
  },
  {
    id: 'hcl',
    extensions: ['.tf', '.hcl'],
    grammarFile: 'tree-sitter-hcl.wasm',
    extractor: extractHCLSymbols,
    required: false,
  },
  {
    id: 'python',
    extensions: ['.py', '.pyi'],
    grammarFile: 'tree-sitter-python.wasm',
    extractor: extractPythonSymbols,
    required: false,
  },
  {
    id: 'go',
    extensions: ['.go'],
    grammarFile: 'tree-sitter-go.wasm',
    extractor: extractGoSymbols,
    required: false,
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    grammarFile: 'tree-sitter-rust.wasm',
    extractor: extractRustSymbols,
    required: false,
  },
  {
    id: 'java',
    extensions: ['.java'],
    grammarFile: 'tree-sitter-java.wasm',
    extractor: extractJavaSymbols,
    required: false,
  },
  {
    id: 'csharp',
    extensions: ['.cs'],
    grammarFile: 'tree-sitter-c_sharp.wasm',
    extractor: extractCSharpSymbols,
    required: false,
  },
  {
    id: 'ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    grammarFile: 'tree-sitter-ruby.wasm',
    extractor: extractRubySymbols,
    required: false,
  },
  {
    id: 'php',
    extensions: ['.php', '.phtml'],
    grammarFile: 'tree-sitter-php.wasm',
    extractor: extractPHPSymbols,
    required: false,
  },
  {
    id: 'c',
    extensions: ['.c', '.h'],
    grammarFile: 'tree-sitter-c.wasm',
    extractor: extractCSymbols,
    required: false,
  },
  {
    id: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp'],
    grammarFile: 'tree-sitter-cpp.wasm',
    extractor: extractCppSymbols,
    required: false,
  },
  {
    id: 'kotlin',
    extensions: ['.kt', '.kts'],
    grammarFile: 'tree-sitter-kotlin.wasm',
    extractor: extractKotlinSymbols,
    required: false,
  },
  {
    id: 'swift',
    extensions: ['.swift'],
    grammarFile: 'tree-sitter-swift.wasm',
    extractor: extractSwiftSymbols,
    required: false,
  },
  {
    id: 'scala',
    extensions: ['.scala'],
    grammarFile: 'tree-sitter-scala.wasm',
    extractor: extractScalaSymbols,
    required: false,
  },
  {
    id: 'bash',
    extensions: ['.sh', '.bash'],
    grammarFile: 'tree-sitter-bash.wasm',
    extractor: extractBashSymbols,
    required: false,
  },
  {
    id: 'elixir',
    extensions: ['.ex', '.exs'],
    grammarFile: 'tree-sitter-elixir.wasm',
    extractor: extractElixirSymbols,
    required: false,
  },
  {
    id: 'lua',
    extensions: ['.lua'],
    grammarFile: 'tree-sitter-lua.wasm',
    extractor: extractLuaSymbols,
    required: false,
  },
  {
    id: 'dart',
    extensions: ['.dart'],
    grammarFile: 'tree-sitter-dart.wasm',
    extractor: extractDartSymbols,
    required: false,
  },
  {
    id: 'zig',
    extensions: ['.zig'],
    grammarFile: 'tree-sitter-zig.wasm',
    extractor: extractZigSymbols,
    required: false,
  },
  {
    id: 'haskell',
    extensions: ['.hs'],
    grammarFile: 'tree-sitter-haskell.wasm',
    extractor: extractHaskellSymbols,
    required: false,
  },
  {
    id: 'ocaml',
    extensions: ['.ml'],
    grammarFile: 'tree-sitter-ocaml.wasm',
    extractor: extractOCamlSymbols,
    required: false,
  },
  {
    id: 'ocaml-interface',
    extensions: ['.mli'],
    grammarFile: 'tree-sitter-ocaml_interface.wasm',
    extractor: extractOCamlSymbols,
    required: false,
  },
  {
    id: 'fsharp',
    extensions: ['.fs', '.fsx', '.fsi'],
    grammarFile: 'tree-sitter-fsharp.wasm',
    extractor: extractFSharpSymbols,
    required: false,
  },
  {
    id: 'gleam',
    extensions: ['.gleam'],
    grammarFile: 'tree-sitter-gleam.wasm',
    extractor: extractGleamSymbols,
    required: false,
  },
  {
    id: 'clojure',
    extensions: ['.clj', '.cljs', '.cljc'],
    grammarFile: 'tree-sitter-clojure.wasm',
    extractor: extractClojureSymbols,
    required: false,
  },
  {
    id: 'julia',
    extensions: ['.jl'],
    grammarFile: 'tree-sitter-julia.wasm',
    extractor: extractJuliaSymbols,
    required: false,
  },
  {
    id: 'r',
    extensions: ['.r', '.R'],
    grammarFile: 'tree-sitter-r.wasm',
    extractor: extractRSymbols,
    required: false,
  },
  {
    id: 'erlang',
    extensions: ['.erl', '.hrl'],
    grammarFile: 'tree-sitter-erlang.wasm',
    extractor: extractErlangSymbols,
    required: false,
  },
  {
    id: 'solidity',
    extensions: ['.sol'],
    grammarFile: 'tree-sitter-solidity.wasm',
    extractor: extractSoliditySymbols,
    required: false,
  },
  {
    id: 'objc',
    extensions: ['.m'],
    grammarFile: 'tree-sitter-objc.wasm',
    extractor: extractObjCSymbols,
    required: false,
  },
  {
    id: 'cuda',
    extensions: ['.cu', '.cuh'],
    grammarFile: 'tree-sitter-cuda.wasm',
    extractor: extractCudaSymbols,
    required: false,
  },
  {
    id: 'groovy',
    extensions: ['.groovy', '.gvy'],
    grammarFile: 'tree-sitter-groovy.wasm',
    extractor: extractGroovySymbols,
    required: false,
  },
  {
    id: 'verilog',
    extensions: ['.v', '.sv'],
    grammarFile: 'tree-sitter-verilog.wasm',
    extractor: extractVerilogSymbols,
    required: false,
  },
];

const _extToLang: Map<string, LanguageRegistryEntry> = new Map();
for (const entry of LANGUAGE_REGISTRY) {
  for (const ext of entry.extensions) {
    _extToLang.set(ext.toLowerCase(), entry);
  }
}

// ── Per-worker caches (not shared across workers) ───────────────────────────

let _runtimeInitialized = false;
// Value of `null` means "tried to load, grammar is optional and failed" —
// we cache the failure so we don't retry on every file.
const _parsers: Map<string, Parser | null> = new Map();
const _queries: Map<string, Query> = new Map();

async function initRuntime(): Promise<void> {
  if (_runtimeInitialized) return;
  await Parser.init();
  _runtimeInitialized = true;
}

/**
 * Load the grammar for a language on demand. Returns the cached parser, or
 * `null` if the grammar is optional and failed to load (same convention as
 * parser.ts). Throws for required grammars that fail.
 */
async function loadLanguageLazy(entry: LanguageRegistryEntry): Promise<Parser | null> {
  if (_parsers.has(entry.id)) return _parsers.get(entry.id) ?? null;

  try {
    const lang = await Language.load(grammarPath(entry.grammarFile));
    const parser = new Parser();
    parser.setLanguage(lang);
    _parsers.set(entry.id, parser);

    // Build the JS/TS/TSX query (mirrors parser.ts::doLoadLanguage)
    if (entry.extractor === extractSymbols && !_queries.has(entry.id)) {
      const isTS = entry.id === 'typescript' || entry.id === 'tsx';
      const patterns = isTS
        ? [...COMMON_QUERY_PATTERNS, ...TS_EXTRA_PATTERNS]
        : [...COMMON_QUERY_PATTERNS, JS_CLASS_PATTERN];
      _queries.set(entry.id, new Query(lang, patterns.join('\n')));
    }
    return parser;
  } catch (e: unknown) {
    if (entry.required) {
      throw new Error(`Required parser ${entry.id} failed to initialize: ${(e as Error).message}`);
    }
    _parsers.set(entry.id, null);
    return null;
  }
}

// ── Per-function walk-result shapes (mirrors engine.ts, kept local) ─────────

interface ComplexityFuncResult {
  funcNode: TreeSitterNode;
  funcName: string | null;
  metrics: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    halstead?: { volume: number; difficulty: number; effort: number; bugs: number };
  };
}

interface CfgFuncResult {
  funcNode: TreeSitterNode;
  blocks: CfgBlock[];
  edges: CfgEdge[];
  cyclomatic?: number;
}

// ── Helpers mirroring engine.ts (copied, db-free) ───────────────────────────

function hasFuncBody(d: {
  name: string;
  kind: string;
  line: number;
  endLine?: number | null;
}): boolean {
  return (
    (d.kind === 'function' || d.kind === 'method') &&
    d.line > 0 &&
    d.endLine != null &&
    d.endLine > d.line &&
    !d.name.includes('.')
  );
}

function indexByLine<T extends { funcNode: TreeSitterNode }>(results: T[]): Map<number, T[]> {
  const byLine = new Map<number, T[]>();
  for (const r of results) {
    if (!r.funcNode) continue;
    const line = r.funcNode.startPosition.row + 1;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)?.push(r);
  }
  return byLine;
}

function matchResultToDef<T extends { funcNode: TreeSitterNode }>(
  candidates: T[] | undefined,
  defName: string,
): T | undefined {
  if (!candidates) return undefined;
  if (candidates.length === 1) return candidates[0];
  return (
    candidates.find((r) => {
      const n = r.funcNode.childForFieldName('name');
      return n && n.text === defName;
    }) ?? candidates[0]
  );
}

/** Override a definition's cyclomatic complexity with a CFG-derived value and recompute MI. */
function overrideCyclomaticFromCfg(def: Definition, cfgCyclomatic: number): void {
  if (!def.complexity) return;
  if (cfgCyclomatic <= 0) return;
  def.complexity.cyclomatic = cfgCyclomatic;
  const { loc, halstead } = def.complexity;
  const volume = halstead ? halstead.volume : 0;
  const commentRatio = loc && loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  def.complexity.maintainabilityIndex = computeMaintainabilityIndex(
    volume,
    cfgCyclomatic,
    loc?.sloc ?? 0,
    commentRatio,
  );
}

function storeComplexityResults(results: WalkResults, defs: Definition[], langId: string): void {
  const byLine = indexByLine((results.complexity || []) as ComplexityFuncResult[]);
  for (const def of defs) {
    if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
      const funcResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!funcResult) continue;
      const { metrics } = funcResult;
      const loc = computeLOCMetrics(funcResult.funcNode, langId);
      const volume = metrics.halstead ? metrics.halstead.volume : 0;
      const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
      const mi = computeMaintainabilityIndex(volume, metrics.cyclomatic, loc.sloc, commentRatio);
      def.complexity = {
        cognitive: metrics.cognitive,
        cyclomatic: metrics.cyclomatic,
        maxNesting: metrics.maxNesting,
        halstead: metrics.halstead,
        loc,
        maintainabilityIndex: mi,
      };
    }
  }
}

function storeCfgResults(results: WalkResults, defs: Definition[]): void {
  const byLine = indexByLine((results.cfg || []) as CfgFuncResult[]);
  for (const def of defs) {
    if (
      (def.kind === 'function' || def.kind === 'method') &&
      def.line &&
      !def.cfg?.blocks?.length
    ) {
      const cfgResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!cfgResult) continue;
      def.cfg = { blocks: cfgResult.blocks, edges: cfgResult.edges };
      if (cfgResult.cyclomatic != null) {
        overrideCyclomaticFromCfg(def, cfgResult.cyclomatic);
      }
    }
  }
}

// ── Per-file visitor setup (db-free version of engine.ts::setupVisitors) ────

interface SetupResult {
  visitors: Visitor[];
  walkerOpts: WalkOptions;
  astVisitor: Visitor | null;
  complexityVisitor: Visitor | null;
  cfgVisitor: Visitor | null;
  dataflowVisitor: Visitor | null;
}

function setupVisitorsLocal(
  symbols: ExtractorOutput,
  relPath: string,
  langId: string,
  opts: WorkerParseRequest['opts'],
): SetupResult {
  const defs = symbols.definitions || [];
  const visitors: Visitor[] = [];
  const walkerOpts: WalkOptions = {
    functionNodeTypes: new Set<string>(),
    nestingNodeTypes: new Set<string>(),
    getFunctionName: (_node: TreeSitterNode) => null,
  };

  // AST-store: db-free — pass an empty nodeIdMap. The main thread re-resolves
  // parent node IDs in features/ast.ts::collectFileAstRows.
  let astVisitor: Visitor | null = null;
  if (opts.ast) {
    const astTypeMap = AST_TYPE_MAPS.get(langId);
    if (astTypeMap) {
      astVisitor = createAstStoreVisitor(astTypeMap, defs, relPath, new Map<string, number>());
      visitors.push(astVisitor);
    }
  }

  // Complexity
  let complexityVisitor: Visitor | null = null;
  if (opts.complexity) {
    const cRules = COMPLEXITY_RULES.get(langId);
    if (cRules && defs.some((d) => hasFuncBody(d) && !d.complexity)) {
      const hRules = HALSTEAD_RULES.get(langId);
      complexityVisitor = createComplexityVisitor(cRules, hRules, {
        fileLevelWalk: true,
        langId,
      });
      for (const t of cRules.nestingNodes) walkerOpts.nestingNodeTypes?.add(t);
      const dfRules = DATAFLOW_RULES.get(langId);
      walkerOpts.getFunctionName = (node: TreeSitterNode): string | null => {
        const nameNode = node.childForFieldName('name');
        if (nameNode) return nameNode.text;
        // dfRules shape varies per language; visitor-utils accepts any shape
        if (dfRules) return getFuncName(node, dfRules as any);
        return null;
      };
      visitors.push(complexityVisitor);
    }
  }

  // CFG
  let cfgVisitor: Visitor | null = null;
  if (opts.cfg) {
    const cfgRulesForLang = CFG_RULES.get(langId);
    if (
      cfgRulesForLang &&
      defs.some((d) => hasFuncBody(d) && d.cfg !== null && !Array.isArray(d.cfg?.blocks))
    ) {
      cfgVisitor = createCfgVisitor(cfgRulesForLang);
      visitors.push(cfgVisitor);
    }
  }

  // Dataflow
  let dataflowVisitor: Visitor | null = null;
  if (opts.dataflow) {
    const dfRules = DATAFLOW_RULES.get(langId);
    if (dfRules && !symbols.dataflow) {
      dataflowVisitor = createDataflowVisitor(dfRules);
      visitors.push(dataflowVisitor);
    }
  }

  return { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor };
}

// ── Main parse handler ──────────────────────────────────────────────────────

async function handleParse(msg: WorkerParseRequest): Promise<SerializedExtractorOutput | null> {
  const ext = path.extname(msg.filePath).toLowerCase();
  const entry = _extToLang.get(ext);
  if (!entry) return null;

  await initRuntime();
  const parser = await loadLanguageLazy(entry);
  if (!parser) return null;

  let tree: Tree | null = null;
  try {
    try {
      tree = parser.parse(msg.code);
    } catch (e: unknown) {
      // Parse error — report back but keep worker alive.
      throw new Error(`parse failed: ${(e as Error).message}`);
    }
    if (!tree) return null;

    // Extractor — on failure, skip file (ok:true, null) to match parser.ts
    // behavior where extractor issues don't crash the build.
    let symbols: ExtractorOutput | null;
    try {
      const query = _queries.get(entry.id);
      // tree-sitter's Tree/Query are structurally compatible with
      // TreeSitterTree/TreeSitterQuery at runtime — same cast style as
      // parser.ts::wasmExtractSymbols (parser.ts:789).
      symbols = entry.extractor(tree as any, msg.filePath, query as any) ?? null;
    } catch {
      return null;
    }
    if (!symbols) return null;

    // Unified visitor walk — mirrors engine.ts:791-829. Runs BEFORE tree.delete()
    // because storeComplexityResults/storeCfgResults read funcNode off live nodes.
    const { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor } =
      setupVisitorsLocal(symbols, msg.filePath, entry.id, msg.opts);

    // astNodes are kept in the serialized shape (without `file`/`parentNodeId`),
    // not assigned back to symbols.astNodes — ExtractorOutput.astNodes is
    // ASTNodeRow[] (DB row shape with node_id), which is a different type.
    let serializedAstNodes: SerializedExtractorOutput['astNodes'];

    if (visitors.length > 0) {
      // rootNode shape matches TreeSitterNode at runtime — same cast as parser.ts:789.
      const results = walkWithVisitors(tree.rootNode as any, visitors, entry.id, walkerOpts);

      const defs = symbols.definitions || [];
      if (astVisitor) {
        const astRows = (results['ast-store'] || []) as Array<{
          line: number;
          kind: string;
          name: string | null | undefined;
          text: string | null;
          receiver: string | null;
          file?: string;
          parentNodeId?: number | null;
        }>;
        if (astRows.length > 0) {
          // Strip `file` and `parentNodeId` — main thread re-resolves parent IDs
          // against its DB in features/ast.ts::collectFileAstRows, and `file` is
          // known from the map key.
          serializedAstNodes = astRows.map((n) => ({
            line: n.line,
            kind: n.kind,
            name: n.name ?? '',
            text: n.text ?? undefined,
            receiver: n.receiver ?? undefined,
          }));
        }
      }

      if (complexityVisitor) storeComplexityResults(results, defs, entry.id);
      if (cfgVisitor) storeCfgResults(results, defs);
      if (dataflowVisitor) symbols.dataflow = results.dataflow as DataflowResult;
    }

    // Serialize — convert Map<string, TypeMapEntry> to tuple array for the wire.
    const serialized: SerializedExtractorOutput = {
      definitions: symbols.definitions,
      calls: symbols.calls,
      imports: symbols.imports,
      classes: symbols.classes,
      exports: symbols.exports,
      typeMap: Array.from(symbols.typeMap.entries()),
      _langId: entry.id as LanguageId,
      _lineCount: msg.code.split('\n').length,
      dataflow: symbols.dataflow,
      astNodes: serializedAstNodes,
    };
    // _tree is deliberately not serialized — it cannot cross the worker boundary.
    return serialized;
  } finally {
    // ALWAYS release WASM memory before responding. Deferring this would let
    // trees accumulate in the worker's WASM heap across requests and defeat
    // the point of isolating parse calls.
    if (tree && typeof (tree as unknown as { delete?: () => void }).delete === 'function') {
      try {
        (tree as unknown as { delete: () => void }).delete();
      } catch {
        // best-effort cleanup — swallow; worker continues.
      }
    }
  }
}

// ── Worker message loop ─────────────────────────────────────────────────────

if (!parentPort) {
  throw new Error('wasm-worker-entry must be run as a worker_thread');
}

parentPort.on('message', async (msg: WorkerRequest) => {
  if (msg.type === 'shutdown') {
    process.exit(0);
  }
  if (msg.type !== 'parse') return;

  try {
    const result = await handleParse(msg);
    const res: WorkerResponse = { type: 'result', id: msg.id, ok: true, result };
    parentPort!.postMessage(res);
  } catch (e: unknown) {
    const res: WorkerResponse = {
      type: 'result',
      id: msg.id,
      ok: false,
      error: (e as Error).message ?? String(e),
    };
    parentPort!.postMessage(res);
  }
});
