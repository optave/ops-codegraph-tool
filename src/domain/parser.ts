import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tree } from 'web-tree-sitter';
import { Language, Parser, Query } from 'web-tree-sitter';
import { debug, warn } from '../infrastructure/logger.js';
import { getNative, getNativePackageVersion, loadNative } from '../infrastructure/native.js';

// Re-export all extractors for backward compatibility
export {
  extractCSharpSymbols,
  extractGoSymbols,
  extractHCLSymbols,
  extractJavaSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractSymbols,
} from '../extractors/index.js';

import {
  extractCSharpSymbols,
  extractGoSymbols,
  extractHCLSymbols,
  extractJavaSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractSymbols,
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

// Extensions that need typeMap backfill (type annotations only exist in TS/TSX)
const TS_BACKFILL_EXTS = new Set(['.ts', '.tsx']);

/**
 * Declarative registry entry for a supported language.
 */
export interface LanguageRegistryEntry {
  id: string;
  extensions: string[];
  grammarFile: string;
  // biome-ignore lint/suspicious/noExplicitAny: extractor signatures vary per language
  extractor: (...args: any[]) => any;
  required: boolean;
}

interface EngineOpts {
  engine?: string;
  dataflow?: boolean;
  ast?: boolean;
}

interface ResolvedEngine {
  name: 'native' | 'wasm';
  // biome-ignore lint/suspicious/noExplicitAny: native addon has no type declarations
  native: any;
}

// biome-ignore lint/suspicious/noExplicitAny: extractor return types vary per language
interface WasmExtractResult {
  // biome-ignore lint/suspicious/noExplicitAny: extractor return shapes vary per language
  symbols: any;
  tree: Tree;
  langId: string;
}

// Shared patterns for all JS/TS/TSX (class_declaration excluded — name type differs)
const COMMON_QUERY_PATTERNS: string[] = [
  '(function_declaration name: (identifier) @fn_name) @fn_node',
  '(variable_declarator name: (identifier) @varfn_name value: (arrow_function) @varfn_value)',
  '(variable_declarator name: (identifier) @varfn_name value: (function_expression) @varfn_value)',
  '(method_definition name: (property_identifier) @meth_name) @meth_node',
  '(import_statement source: (string) @imp_source) @imp_node',
  '(export_statement) @exp_node',
  '(call_expression function: (identifier) @callfn_name) @callfn_node',
  '(call_expression function: (member_expression) @callmem_fn) @callmem_node',
  '(call_expression function: (subscript_expression) @callsub_fn) @callsub_node',
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

export async function createParsers(): Promise<Map<string, Parser | null>> {
  if (_cachedParsers) return _cachedParsers;

  if (!_initialized) {
    await Parser.init();
    _initialized = true;
  }

  const parsers = new Map<string, Parser | null>();
  const languages = new Map<string, Language>();
  for (const entry of LANGUAGE_REGISTRY) {
    try {
      const lang = await Language.load(grammarPath(entry.grammarFile));
      const parser = new Parser();
      parser.setLanguage(lang);
      parsers.set(entry.id, parser);
      languages.set(entry.id, lang);
      // Compile and cache tree-sitter Query for JS/TS/TSX extractors
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
      parsers.set(entry.id, null);
    }
  }
  _cachedParsers = parsers;
  _cachedLanguages = languages;
  return parsers;
}

/**
 * Dispose all cached WASM parsers and queries to free WASM linear memory.
 * Call this between repeated builds in the same process (e.g. benchmarks)
 * to prevent memory accumulation that can cause segfaults.
 */
export function disposeParsers(): void {
  if (_cachedParsers) {
    for (const [id, parser] of _cachedParsers) {
      if (parser && typeof parser.delete === 'function') {
        try {
          parser.delete();
        } catch (e: unknown) {
          debug(`Failed to dispose parser ${id}: ${(e as Error).message}`);
        }
      }
    }
    _cachedParsers = null;
  }
  for (const [id, query] of _queryCache) {
    if (query && typeof query.delete === 'function') {
      try {
        query.delete();
      } catch (e: unknown) {
        debug(`Failed to dispose query ${id}: ${(e as Error).message}`);
      }
    }
  }
  _queryCache.clear();
  if (_cachedLanguages) {
    for (const [id, lang] of _cachedLanguages) {
      // biome-ignore lint/suspicious/noExplicitAny: .delete() exists at runtime on WASM Language objects but is missing from typings
      if (lang && typeof (lang as any).delete === 'function') {
        try {
          (lang as any).delete();
        } catch (e: unknown) {
          debug(`Failed to dispose language ${id}: ${(e as Error).message}`);
        }
      }
    }
    _cachedLanguages = null;
  }
  _initialized = false;
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
// biome-ignore lint/suspicious/noExplicitAny: fileSymbols values have dynamic shape from extractors
export async function ensureWasmTrees(
  fileSymbols: Map<string, any>,
  rootDir: string,
): Promise<void> {
  // Check if any file needs a tree
  let needsParse = false;
  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (_extToLang.has(ext)) {
        needsParse = true;
        break;
      }
    }
  }
  if (!needsParse) return;

  const parsers = await createParsers();

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

function resolveEngine(opts: EngineOpts = {}): ResolvedEngine {
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
// biome-ignore lint/suspicious/noExplicitAny: native result has dynamic shape
function patchNativeResult(r: any): any {
  // lineCount: napi(js_name) emits "lineCount"; older binaries may emit "line_count"
  r.lineCount = r.lineCount ?? r.line_count ?? null;
  r._lineCount = r.lineCount;

  // Backward compat for older binaries missing js_name annotations
  if (r.definitions) {
    for (const d of r.definitions) {
      if (d.endLine === undefined && d.end_line !== undefined) {
        d.endLine = d.end_line;
      }
    }
  }
  if (r.imports) {
    for (const i of r.imports) {
      if (i.typeOnly === undefined) i.typeOnly = i.type_only;
      if (i.wildcardReexport === undefined) i.wildcardReexport = i.wildcard_reexport;
      if (i.pythonImport === undefined) i.pythonImport = i.python_import;
      if (i.goImport === undefined) i.goImport = i.go_import;
      if (i.rustUse === undefined) i.rustUse = i.rust_use;
      if (i.javaImport === undefined) i.javaImport = i.java_import;
      if (i.csharpUsing === undefined) i.csharpUsing = i.csharp_using;
      if (i.rubyRequire === undefined) i.rubyRequire = i.ruby_require;
      if (i.phpUse === undefined) i.phpUse = i.php_use;
      if (i.dynamicImport === undefined) i.dynamicImport = i.dynamic_import;
    }
  }

  // dataflow: wrap bindingType into binding object for argFlows and mutations
  if (r.dataflow) {
    if (r.dataflow.argFlows) {
      for (const f of r.dataflow.argFlows) {
        f.binding = f.bindingType ? { type: f.bindingType } : null;
      }
    }
    if (r.dataflow.mutations) {
      for (const m of r.dataflow.mutations) {
        m.binding = m.bindingType ? { type: m.bindingType } : null;
      }
    }
  }

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
];

const _extToLang: Map<string, LanguageRegistryEntry> = new Map();
for (const entry of LANGUAGE_REGISTRY) {
  for (const ext of entry.extensions) {
    _extToLang.set(ext, entry);
  }
}

export const SUPPORTED_EXTENSIONS: Set<string> = new Set(_extToLang.keys());

/**
 * WASM-based typeMap backfill for older native binaries that don't emit typeMap.
 * Uses tree-sitter AST extraction instead of regex to avoid false positives from
 * matches inside comments and string literals.
 * TODO: Remove once all published native binaries include typeMap extraction (>= 3.2.0)
 */
// biome-ignore lint/suspicious/noExplicitAny: return shape matches native result typeMap
async function backfillTypeMap(
  filePath: string,
  source?: string,
): Promise<{ typeMap: any; backfilled: boolean }> {
  let code = source;
  if (!code) {
    try {
      code = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { typeMap: [], backfilled: false };
    }
  }
  const parsers = await createParsers();
  const extracted = wasmExtractSymbols(parsers, filePath, code);
  try {
    if (!extracted?.symbols?.typeMap) {
      return { typeMap: [], backfilled: false };
    }
    const tm = extracted.symbols.typeMap;
    return {
      typeMap:
        tm instanceof Map
          ? tm
          : new Map(tm.map((e: { name: string; typeName: string }) => [e.name, e.typeName])),
      backfilled: true,
    };
  } finally {
    // Free the WASM tree to prevent memory accumulation across repeated builds
    if (extracted?.tree && typeof extracted.tree.delete === 'function') {
      try {
        extracted.tree.delete();
      } catch {}
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
  const query = _queryCache.get(entry.id) || null;
  const symbols = entry.extractor(tree, filePath, query);
  return symbols ? { symbols, tree, langId: entry.id } : null;
}

/**
 * Parse a single file and return normalized symbols.
 */
// biome-ignore lint/suspicious/noExplicitAny: return shape varies between native and WASM engines
export async function parseFileAuto(
  filePath: string,
  source: string,
  opts: EngineOpts = {},
): Promise<any> {
  const { native } = resolveEngine(opts);

  if (native) {
    const result = native.parseFile(filePath, source, !!opts.dataflow, opts.ast !== false);
    if (!result) return null;
    const patched = patchNativeResult(result);
    // Only backfill typeMap for TS/TSX — JS files have no type annotations,
    // and the native engine already handles `new Expr()` patterns.
    if (
      (!patched.typeMap || patched.typeMap.length === 0) &&
      TS_BACKFILL_EXTS.has(path.extname(filePath))
    ) {
      const { typeMap, backfilled } = await backfillTypeMap(filePath, source);
      patched.typeMap = typeMap;
      if (backfilled) patched._typeMapBackfilled = true;
    }
    return patched;
  }

  // WASM path
  const parsers = await createParsers();
  const extracted = wasmExtractSymbols(parsers, filePath, source);
  return extracted ? extracted.symbols : null;
}

/**
 * Parse multiple files in bulk and return a Map<relPath, symbols>.
 */
// biome-ignore lint/suspicious/noExplicitAny: return shape varies between native and WASM engines
export async function parseFilesAuto(
  filePaths: string[],
  rootDir: string,
  opts: EngineOpts = {},
): Promise<Map<string, any>> {
  const { native } = resolveEngine(opts);
  // biome-ignore lint/suspicious/noExplicitAny: result values have dynamic shape from extractors
  const result = new Map<string, any>();

  if (native) {
    const nativeResults = native.parseFiles(
      filePaths,
      rootDir,
      !!opts.dataflow,
      opts.ast !== false,
    );
    const needsTypeMap: { filePath: string; relPath: string }[] = [];
    for (const r of nativeResults) {
      if (!r) continue;
      const patched = patchNativeResult(r);
      const relPath = path.relative(rootDir, r.file).split(path.sep).join('/');
      result.set(relPath, patched);
      if (!patched.typeMap || patched.typeMap.length === 0) {
        needsTypeMap.push({ filePath: r.file, relPath });
      }
    }
    // Backfill typeMap via WASM for native binaries that predate the type-map feature
    if (needsTypeMap.length > 0) {
      // Only backfill for languages where WASM extraction can produce typeMap
      // (TS/TSX have type annotations; JS only has `new Expr()` which native already handles)
      const tsFiles = needsTypeMap.filter(({ filePath }) =>
        TS_BACKFILL_EXTS.has(path.extname(filePath)),
      );
      if (tsFiles.length > 0) {
        const parsers = await createParsers();
        for (const { filePath, relPath } of tsFiles) {
          let extracted: WasmExtractResult | null | undefined;
          try {
            const code = fs.readFileSync(filePath, 'utf-8');
            extracted = wasmExtractSymbols(parsers, filePath, code);
            if (extracted?.symbols?.typeMap) {
              const symbols = result.get(relPath);
              symbols.typeMap =
                extracted.symbols.typeMap instanceof Map
                  ? extracted.symbols.typeMap
                  : new Map(
                      extracted.symbols.typeMap.map((e: { name: string; typeName: string }) => [
                        e.name,
                        e.typeName,
                      ]),
                    );
              symbols._typeMapBackfilled = true;
            }
          } catch {
            /* skip — typeMap is a best-effort backfill */
          } finally {
            // Free the WASM tree to prevent memory accumulation across repeated builds
            if (extracted?.tree && typeof extracted.tree.delete === 'function') {
              try {
                extracted.tree.delete();
              } catch {}
            }
          }
        }
      }
    }
    return result;
  }

  // WASM path
  const parsers = await createParsers();
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
 * Report which engine is active.
 */
export function getActiveEngine(opts: EngineOpts = {}): {
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
// biome-ignore lint/suspicious/noExplicitAny: native ParseTreeCache has no type declarations
export function createParseTreeCache(): any {
  const native = loadNative();
  if (!native || !native.ParseTreeCache) return null;
  return new native.ParseTreeCache();
}

/**
 * Parse a file incrementally using the cache, or fall back to full parse.
 */
// biome-ignore lint/suspicious/noExplicitAny: cache is native ParseTreeCache with no type declarations; return shape varies
export async function parseFileIncremental(
  cache: any,
  filePath: string,
  source: string,
  opts: EngineOpts = {},
): Promise<any> {
  if (cache) {
    const result = cache.parseFile(filePath, source);
    if (!result) return null;
    const patched = patchNativeResult(result);
    // Only backfill typeMap for TS/TSX — JS files have no type annotations,
    // and the native engine already handles `new Expr()` patterns.
    if (
      (!patched.typeMap || patched.typeMap.length === 0) &&
      TS_BACKFILL_EXTS.has(path.extname(filePath))
    ) {
      const { typeMap, backfilled } = await backfillTypeMap(filePath, source);
      patched.typeMap = typeMap;
      if (backfilled) patched._typeMapBackfilled = true;
    }
    return patched;
  }
  return parseFileAuto(filePath, source, opts);
}
