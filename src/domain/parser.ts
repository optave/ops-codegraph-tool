import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tree } from 'web-tree-sitter';
import { Language, Parser, Query } from 'web-tree-sitter';
import { debug, warn } from '../infrastructure/logger.js';
import { getNative, getNativePackageVersion, loadNative } from '../infrastructure/native.js';
import { toErrorMessage } from '../shared/errors.js';
import type {
  EngineMode,
  ExtractorOutput,
  LanguageId,
  LanguageRegistryEntry,
  TypeMapEntry,
} from '../types.js';

// Re-export all extractors for backward compatibility
export {
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function grammarPath(name: string): string {
  return path.join(__dirname, '..', '..', 'grammars', name);
}

let _initialized: boolean = false;

// Memoized parsers — avoids reloading WASM grammars on every createParsers() call
let _cachedParsers: Map<string, Parser | null> | null = null;

// Cached Language objects — WASM-backed, must be .delete()'d explicitly
let _cachedLanguages: Map<string, Language> | null = null;

// Query cache for JS/TS/TSX extractors (populated during createParsers)
const _queryCache: Map<string, Query> = new Map();

// Tracks whether ALL grammars have been loaded (vs. a lazy subset)
let _allParsersLoaded: boolean = false;

// In-flight grammar loads keyed by language id — prevents concurrent duplicate loads
const _loadingPromises: Map<string, Promise<void>> = new Map();

// Extensions that need typeMap backfill (type annotations only exist in TS/TSX)
const TS_BACKFILL_EXTS = new Set(['.ts', '.tsx']);

// Re-export for backward compatibility
export type { LanguageRegistryEntry } from '../types.js';

interface ParseEngineOpts {
  engine?: EngineMode;
  dataflow?: boolean;
  ast?: boolean;
}

interface ResolvedEngine {
  name: 'native' | 'wasm';
  native: any;
}

interface WasmExtractResult {
  symbols: ExtractorOutput;
  tree: Tree;
  langId: LanguageId;
}

// Shared patterns for all JS/TS/TSX (class_declaration excluded — name type differs)
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

// JS: class name is (identifier)
const JS_CLASS_PATTERN: string = '(class_declaration name: (identifier) @cls_name) @cls_node';

// TS/TSX: class name is (type_identifier), plus interface and type alias
const TS_EXTRA_PATTERNS: string[] = [
  '(class_declaration name: (type_identifier) @cls_name) @cls_node',
  '(interface_declaration name: (type_identifier) @iface_name) @iface_node',
  '(type_alias_declaration name: (type_identifier) @type_name) @type_node',
];

/**
 * Load a single language grammar and cache the parser + language + query.
 * Uses in-flight deduplication so concurrent callers awaiting the same grammar
 * share a single load rather than producing orphaned WASM instances.
 * Assumes Parser.init() has already been called and _cachedParsers/_cachedLanguages exist.
 */
async function loadLanguage(entry: LanguageRegistryEntry): Promise<void> {
  if (_cachedParsers!.has(entry.id)) return;
  const inflight = _loadingPromises.get(entry.id);
  if (inflight) return inflight;
  const p = doLoadLanguage(entry).finally(() => _loadingPromises.delete(entry.id));
  _loadingPromises.set(entry.id, p);
  return p;
}

async function doLoadLanguage(entry: LanguageRegistryEntry): Promise<void> {
  try {
    const lang = await Language.load(grammarPath(entry.grammarFile));
    const parser = new Parser();
    parser.setLanguage(lang);
    _cachedParsers!.set(entry.id, parser);
    _cachedLanguages!.set(entry.id, lang);
    if (entry.extractor === extractSymbols && !_queryCache.has(entry.id)) {
      const isTS = entry.id === 'typescript' || entry.id === 'tsx';
      const patterns = isTS
        ? [...COMMON_QUERY_PATTERNS, ...TS_EXTRA_PATTERNS]
        : [...COMMON_QUERY_PATTERNS, JS_CLASS_PATTERN];
      _queryCache.set(entry.id, new Query(lang, patterns.join('\n')));
    }
  } catch (e: unknown) {
    if (entry.required) throw e;
    warn(
      `${entry.id} parser failed to initialize: ${(e as Error).message}. ${entry.id} files will be skipped.`,
    );
    _cachedParsers!.set(entry.id, null);
  }
}

async function initParserRuntime(): Promise<void> {
  if (!_initialized) {
    await Parser.init();
    _initialized = true;
  }
  if (!_cachedParsers) _cachedParsers = new Map();
  if (!_cachedLanguages) _cachedLanguages = new Map();
}

/**
 * Load only the WASM grammars needed for the given file paths.
 * Grammars already in cache are reused. This avoids the ~500ms cold-start
 * penalty of loading all 23+ grammars when only 1-2 are needed (e.g. incremental rebuilds).
 */
async function ensureParsersForFiles(filePaths: string[]): Promise<Map<string, Parser | null>> {
  await initParserRuntime();
  const needed = new Set<LanguageRegistryEntry>();
  for (const fp of filePaths) {
    const ext = path.extname(fp).toLowerCase();
    const entry = _extToLang.get(ext);
    if (entry && !_cachedParsers!.has(entry.id)) needed.add(entry);
  }
  for (const entry of needed) {
    await loadLanguage(entry);
  }
  return _cachedParsers!;
}

/**
 * Load ALL WASM grammars. Used by full builds and feature modules (CFG, dataflow, complexity)
 * that may process files of any language.
 */
export async function createParsers(): Promise<Map<string, Parser | null>> {
  if (_cachedParsers && _allParsersLoaded) return _cachedParsers;

  await initParserRuntime();
  for (const entry of LANGUAGE_REGISTRY) {
    if (!_cachedParsers!.has(entry.id)) {
      await loadLanguage(entry);
    }
  }
  _allParsersLoaded = true;
  return _cachedParsers!;
}

/**
 * Dispose all cached WASM parsers and queries to free WASM linear memory.
 * Call this between repeated builds in the same process (e.g. benchmarks)
 * to prevent memory accumulation that can cause segfaults.
 */
function disposeMapEntries(entries: Iterable<[string, any]>, label: string): void {
  for (const [id, item] of entries) {
    if (item && typeof item.delete === 'function') {
      try {
        item.delete();
      } catch (e: unknown) {
        debug(`Failed to dispose ${label} ${id}: ${(e as Error).message}`);
      }
    }
  }
}

export function disposeParsers(): void {
  if (_cachedParsers) {
    disposeMapEntries(_cachedParsers, 'parser');
    _cachedParsers = null;
  }
  disposeMapEntries(_queryCache, 'query');
  _queryCache.clear();
  if (_cachedLanguages) {
    disposeMapEntries(_cachedLanguages, 'language');
    _cachedLanguages = null;
  }
  _initialized = false;
  _allParsersLoaded = false;
  _loadingPromises.clear();
}

export function getParser(parsers: Map<string, Parser | null>, filePath: string): Parser | null {
  const ext = path.extname(filePath);
  const entry = _extToLang.get(ext);
  if (!entry) return null;
  return parsers.get(entry.id) || null;
}

/**
 * Pre-parse files missing `_tree` via WASM so downstream phases (CFG, dataflow)
 * don't each need to create parsers and re-parse independently.
 * Only parses files whose extension is in SUPPORTED_EXTENSIONS.
 */
export async function ensureWasmTrees(
  fileSymbols: Map<string, any>,
  rootDir: string,
): Promise<void> {
  // Single pass: collect absolute paths for files that need parsing
  const filePaths: string[] = [];
  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree && _extToLang.has(path.extname(relPath).toLowerCase())) {
      filePaths.push(path.join(rootDir, relPath));
    }
  }
  if (filePaths.length === 0) return;
  const parsers = await ensureParsersForFiles(filePaths);

  for (const [relPath, symbols] of fileSymbols) {
    if (symbols._tree) continue;
    const ext = path.extname(relPath).toLowerCase();
    const entry = _extToLang.get(ext);
    if (!entry) continue;
    const parser = parsers.get(entry.id);
    if (!parser) continue;

    const absPath = path.join(rootDir, relPath);
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e: unknown) {
      debug(`ensureWasmTrees: cannot read ${relPath}: ${(e as Error).message}`);
      continue;
    }
    try {
      symbols._tree = parser.parse(code);
      symbols._langId = entry.id;
    } catch (e: unknown) {
      debug(`ensureWasmTrees: parse failed for ${relPath}: ${(e as Error).message}`);
    }
  }
}

/**
 * Check whether the required WASM grammar files exist on disk.
 */
export function isWasmAvailable(): boolean {
  return LANGUAGE_REGISTRY.filter((e) => e.required).every((e) =>
    fs.existsSync(grammarPath(e.grammarFile)),
  );
}

// ── Unified API ──────────────────────────────────────────────────────────────

function resolveEngine(opts: ParseEngineOpts = {}): ResolvedEngine {
  const pref = opts.engine || 'auto';
  if (pref === 'wasm') return { name: 'wasm', native: null };
  if (pref === 'native' || pref === 'auto') {
    const native = loadNative();
    if (native) return { name: 'native', native };
    if (pref === 'native') {
      getNative(); // throws with detailed error + install instructions
    }
  }
  return { name: 'wasm', native: null };
}

/**
 * Patch native engine output in-place for the few remaining semantic transforms.
 * With #[napi(js_name)] on Rust types, most fields already arrive as camelCase.
 * This only handles:
 *  - _lineCount compat for builder.js
 *  - Backward compat for older native binaries missing js_name annotations
 *  - dataflow argFlows/mutations bindingType -> binding wrapper
 */
/** Patch definition fields for backward compat with older native binaries. */
function patchDefinitions(definitions: any[]): void {
  for (const d of definitions) {
    if (d.endLine === undefined && d.end_line !== undefined) {
      d.endLine = d.end_line;
    }
  }
}

/** Patch import fields for backward compat with older native binaries. */
function patchImports(imports: any[]): void {
  for (const i of imports) {
    if (i.typeOnly === undefined) i.typeOnly = i.type_only;
    if (i.wildcardReexport === undefined) i.wildcardReexport = i.wildcard_reexport;
    if (i.pythonImport === undefined) i.pythonImport = i.python_import;
    if (i.goImport === undefined) i.goImport = i.go_import;
    if (i.rustUse === undefined) i.rustUse = i.rust_use;
    if (i.javaImport === undefined) i.javaImport = i.java_import;
    if (i.csharpUsing === undefined) i.csharpUsing = i.csharp_using;
    if (i.rubyRequire === undefined) i.rubyRequire = i.ruby_require;
    if (i.phpUse === undefined) i.phpUse = i.php_use;
    if (i.cInclude === undefined) i.cInclude = i.c_include;
    if (i.kotlinImport === undefined) i.kotlinImport = i.kotlin_import;
    if (i.swiftImport === undefined) i.swiftImport = i.swift_import;
    if (i.scalaImport === undefined) i.scalaImport = i.scala_import;
    if (i.bashSource === undefined) i.bashSource = i.bash_source;
    if (i.dynamicImport === undefined) i.dynamicImport = i.dynamic_import;
  }
}

/** Normalize native typeMap array to a Map instance.
 *  Uses first-wins semantics at equal confidence to match the WASM/JS extractor. */
function patchTypeMap(r: any): void {
  if (!r.typeMap) {
    r.typeMap = new Map();
  } else if (!(r.typeMap instanceof Map)) {
    const map = new Map<string, TypeMapEntry>();
    for (const e of r.typeMap as Array<{ name: string; typeName: string }>) {
      if (!map.has(e.name)) {
        map.set(e.name, { type: e.typeName, confidence: (e as any).confidence ?? 0.9 });
      }
    }
    r.typeMap = map;
  }
}

/** Wrap bindingType into binding object for dataflow argFlows and mutations. */
function patchDataflow(dataflow: any): void {
  if (dataflow.argFlows) {
    for (const f of dataflow.argFlows) {
      f.binding = f.bindingType ? { type: f.bindingType } : null;
    }
  }
  if (dataflow.mutations) {
    for (const m of dataflow.mutations) {
      m.binding = m.bindingType ? { type: m.bindingType } : null;
    }
  }
}

function patchNativeResult(r: any): ExtractorOutput {
  // lineCount: napi(js_name) emits "lineCount"; older binaries may emit "line_count"
  r.lineCount = r.lineCount ?? r.line_count ?? null;
  r._lineCount = r.lineCount;

  if (r.definitions) patchDefinitions(r.definitions);
  if (r.imports) patchImports(r.imports);
  patchTypeMap(r);
  if (r.dataflow) patchDataflow(r.dataflow);

  return r;
}

/**
 * Declarative registry of all supported languages.
 * Adding a new language requires only a new entry here + its extractor function.
 */
export const LANGUAGE_REGISTRY: LanguageRegistryEntry[] = [
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
    _extToLang.set(ext, entry);
  }
}

export const SUPPORTED_EXTENSIONS: Set<string> = new Set(_extToLang.keys());

/**
 * WASM-based typeMap backfill for TS/TSX files parsed by the native engine.
 * Serves two purposes:
 * 1. Compatibility with older native binaries that don't emit typeMap (< 3.2.0).
 * 2. Workaround for native parser scope-collision bugs — when the same variable
 *    name appears at multiple scopes, native type extraction can produce
 *    incorrect results. WASM's JS-based extractor handles scope traversal
 *    more accurately. TODO: Remove purpose (2) once the Rust extractor handles
 *    nested scopes correctly.
 *
 * Uses tree-sitter AST extraction instead of regex to avoid false positives from
 * matches inside comments and string literals.
 */
async function backfillTypeMap(
  filePath: string,
  source?: string,
): Promise<{ typeMap: Map<string, TypeMapEntry>; backfilled: boolean }> {
  let code = source;
  if (!code) {
    try {
      code = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      debug(`backfillTypeMap: failed to read ${filePath}: ${toErrorMessage(e)}`);
      return { typeMap: new Map(), backfilled: false };
    }
  }
  const parsers = await ensureParsersForFiles([filePath]);
  const extracted = wasmExtractSymbols(parsers, filePath, code);
  try {
    if (!extracted || extracted.symbols.typeMap.size === 0) {
      return { typeMap: new Map(), backfilled: false };
    }
    return { typeMap: extracted.symbols.typeMap, backfilled: true };
  } finally {
    // Free the WASM tree to prevent memory accumulation across repeated builds
    if (extracted?.tree && typeof extracted.tree.delete === 'function') {
      try {
        extracted.tree.delete();
      } catch (e) {
        debug(`backfillTypeMap: WASM tree cleanup failed: ${toErrorMessage(e)}`);
      }
    }
  }
}

/**
 * WASM extraction helper: picks the right extractor based on file extension.
 */
function wasmExtractSymbols(
  parsers: Map<string, Parser | null>,
  filePath: string,
  code: string,
): WasmExtractResult | null {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;

  let tree: Tree | null;
  try {
    tree = parser.parse(code);
  } catch (e: unknown) {
    warn(`Parse error in ${filePath}: ${(e as Error).message}`);
    return null;
  }
  if (!tree) return null;

  const ext = path.extname(filePath);
  const entry = _extToLang.get(ext);
  if (!entry) return null;
  const query = _queryCache.get(entry.id) ?? undefined;
  // Query (web-tree-sitter) is structurally compatible with TreeSitterQuery at runtime
  const symbols = entry.extractor(tree as any, filePath, query as any);
  return symbols ? { symbols, tree, langId: entry.id } : null;
}

/**
 * Parse a single file and return normalized symbols.
 */
export async function parseFileAuto(
  filePath: string,
  source: string,
  opts: ParseEngineOpts = {},
): Promise<ExtractorOutput | null> {
  const { native } = resolveEngine(opts);

  if (native) {
    const result = native.parseFile(filePath, source, !!opts.dataflow, opts.ast !== false);
    if (!result) return null;
    const patched = patchNativeResult(result);
    // Always backfill typeMap for TS/TSX from WASM — native parser's type
    // extraction can produce incorrect scope-collision results. Non-TS files
    // are skipped to stay consistent with the batch path (backfillTypeMapBatch).
    if (TS_BACKFILL_EXTS.has(path.extname(filePath))) {
      const { typeMap, backfilled } = await backfillTypeMap(filePath, source);
      if (backfilled) {
        patched.typeMap = typeMap;
        patched._typeMapBackfilled = true;
      }
    }
    return patched;
  }

  // WASM path
  const parsers = await ensureParsersForFiles([filePath]);
  const extracted = wasmExtractSymbols(parsers, filePath, source);
  return extracted ? extracted.symbols : null;
}

/** Backfill typeMap via WASM for TS/TSX files parsed by the native engine. */
async function backfillTypeMapBatch(
  needsTypeMap: { filePath: string; relPath: string }[],
  result: Map<string, ExtractorOutput>,
): Promise<void> {
  const tsFiles = needsTypeMap.filter(({ filePath }) =>
    TS_BACKFILL_EXTS.has(path.extname(filePath)),
  );
  if (tsFiles.length === 0) return;

  const parsers = await ensureParsersForFiles(tsFiles.map((f) => f.filePath));
  for (const { filePath, relPath } of tsFiles) {
    let extracted: WasmExtractResult | null | undefined;
    try {
      const code = fs.readFileSync(filePath, 'utf-8');
      extracted = wasmExtractSymbols(parsers, filePath, code);
      if (extracted?.symbols && extracted.symbols.typeMap.size > 0) {
        const symbols = result.get(relPath);
        if (!symbols) continue;
        symbols.typeMap = extracted.symbols.typeMap;
        symbols._typeMapBackfilled = true;
      }
    } catch (e) {
      debug(`batchExtract: typeMap backfill failed: ${toErrorMessage(e)}`);
    } finally {
      if (extracted?.tree && typeof extracted.tree.delete === 'function') {
        try {
          extracted.tree.delete();
        } catch (e) {
          debug(`batchExtract: WASM tree cleanup failed: ${toErrorMessage(e)}`);
        }
      }
    }
  }
}

/** Parse files via WASM engine, returning a Map<relPath, symbols>. */
async function parseFilesWasm(
  filePaths: string[],
  rootDir: string,
): Promise<Map<string, ExtractorOutput>> {
  const result = new Map<string, ExtractorOutput>();
  const parsers = await ensureParsersForFiles(filePaths);
  for (const filePath of filePaths) {
    let code: string;
    try {
      code = fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      warn(`Skipping ${path.relative(rootDir, filePath)}: ${(err as Error).message}`);
      continue;
    }
    const extracted = wasmExtractSymbols(parsers, filePath, code);
    if (extracted) {
      const relPath = path.relative(rootDir, filePath).split(path.sep).join('/');
      extracted.symbols._tree = extracted.tree;
      extracted.symbols._langId = extracted.langId;
      extracted.symbols._lineCount = code.split('\n').length;
      result.set(relPath, extracted.symbols);
    }
  }
  return result;
}

/**
 * Parse multiple files in bulk and return a Map<relPath, symbols>.
 */
export async function parseFilesAuto(
  filePaths: string[],
  rootDir: string,
  opts: ParseEngineOpts = {},
): Promise<Map<string, ExtractorOutput>> {
  const { native } = resolveEngine(opts);

  if (!native) return parseFilesWasm(filePaths, rootDir);

  const result = new Map<string, ExtractorOutput>();
  const nativeResults = native.parseFiles(filePaths, rootDir, !!opts.dataflow, opts.ast !== false);
  const needsTypeMap: { filePath: string; relPath: string }[] = [];
  for (const r of nativeResults) {
    if (!r) continue;
    const patched = patchNativeResult(r);
    const relPath = path.relative(rootDir, r.file).split(path.sep).join('/');
    result.set(relPath, patched);
    // Always backfill TS/TSX type maps from WASM — the native parser's type
    // extraction can produce incorrect results when the same variable name
    // appears at multiple scopes (e.g. `node: TreeSitterNode` in one function
    // vs `node: NodeRow` in another). The WASM JS extractor handles scope
    // traversal order more accurately.
    if (TS_BACKFILL_EXTS.has(path.extname(r.file))) {
      needsTypeMap.push({ filePath: r.file, relPath });
    }
  }
  if (needsTypeMap.length > 0) {
    await backfillTypeMapBatch(needsTypeMap, result);
  }
  return result;
}

/**
 * Report which engine is active.
 */
export function getActiveEngine(opts: ParseEngineOpts = {}): {
  name: 'native' | 'wasm';
  version: string | null;
} {
  const { name, native } = resolveEngine(opts);
  let version: string | null = native
    ? typeof native.engineVersion === 'function'
      ? native.engineVersion()
      : null
    : null;
  // Prefer platform package.json version over binary-embedded version
  // to handle stale binaries that weren't recompiled during a release
  if (native) {
    try {
      version = getNativePackageVersion() ?? version;
    } catch (e: unknown) {
      debug(`getNativePackageVersion failed: ${(e as Error).message}`);
    }
  }
  return { name, version };
}

/**
 * Create a native ParseTreeCache for incremental parsing.
 * Returns null if the native engine is unavailable (WASM fallback).
 */
export function createParseTreeCache(): any {
  const native = loadNative();
  if (!native?.ParseTreeCache) return null;
  return new native.ParseTreeCache();
}

/**
 * Parse a file incrementally using the cache, or fall back to full parse.
 */
export async function parseFileIncremental(
  cache: any,
  filePath: string,
  source: string,
  opts: ParseEngineOpts = {},
): Promise<ExtractorOutput | null> {
  if (cache) {
    const result = cache.parseFile(filePath, source);
    if (!result) return null;
    const patched = patchNativeResult(result);
    // Always backfill typeMap for TS/TSX from WASM (see parseFileAuto comment).
    if (TS_BACKFILL_EXTS.has(path.extname(filePath))) {
      const { typeMap, backfilled } = await backfillTypeMap(filePath, source);
      if (backfilled) {
        patched.typeMap = typeMap;
        patched._typeMapBackfilled = true;
      }
    }
    return patched;
  }
  return parseFileAuto(filePath, source, opts);
}
