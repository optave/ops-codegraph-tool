import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, Query } from 'web-tree-sitter';
import { warn } from './logger.js';
import { getNative, loadNative } from './native.js';

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
} from './extractors/index.js';

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
} from './extractors/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function grammarPath(name) {
  return path.join(__dirname, '..', 'grammars', name);
}

let _initialized = false;

// Memoized parsers — avoids reloading WASM grammars on every createParsers() call
let _cachedParsers = null;

// Query cache for JS/TS/TSX extractors (populated during createParsers)
const _queryCache = new Map();

// Shared patterns for all JS/TS/TSX (class_declaration excluded — name type differs)
const COMMON_QUERY_PATTERNS = [
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
const JS_CLASS_PATTERN = '(class_declaration name: (identifier) @cls_name) @cls_node';

// TS/TSX: class name is (type_identifier), plus interface and type alias
const TS_EXTRA_PATTERNS = [
  '(class_declaration name: (type_identifier) @cls_name) @cls_node',
  '(interface_declaration name: (type_identifier) @iface_name) @iface_node',
  '(type_alias_declaration name: (type_identifier) @type_name) @type_node',
];

export async function createParsers() {
  if (_cachedParsers) return _cachedParsers;

  if (!_initialized) {
    await Parser.init();
    _initialized = true;
  }

  const parsers = new Map();
  for (const entry of LANGUAGE_REGISTRY) {
    try {
      const lang = await Language.load(grammarPath(entry.grammarFile));
      const parser = new Parser();
      parser.setLanguage(lang);
      parsers.set(entry.id, parser);
      // Compile and cache tree-sitter Query for JS/TS/TSX extractors
      if (entry.extractor === extractSymbols && !_queryCache.has(entry.id)) {
        const isTS = entry.id === 'typescript' || entry.id === 'tsx';
        const patterns = isTS
          ? [...COMMON_QUERY_PATTERNS, ...TS_EXTRA_PATTERNS]
          : [...COMMON_QUERY_PATTERNS, JS_CLASS_PATTERN];
        _queryCache.set(entry.id, new Query(lang, patterns.join('\n')));
      }
    } catch (e) {
      if (entry.required) throw e;
      warn(
        `${entry.id} parser failed to initialize: ${e.message}. ${entry.id} files will be skipped.`,
      );
      parsers.set(entry.id, null);
    }
  }
  _cachedParsers = parsers;
  return parsers;
}

export function getParser(parsers, filePath) {
  const ext = path.extname(filePath);
  const entry = _extToLang.get(ext);
  if (!entry) return null;
  return parsers.get(entry.id) || null;
}

/**
 * Pre-parse files missing `_tree` via WASM so downstream phases (CFG, dataflow)
 * don't each need to create parsers and re-parse independently.
 * Only parses files whose extension is in SUPPORTED_EXTENSIONS.
 *
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, _tree, _langId, ... }>
 * @param {string} rootDir - absolute project root
 */
export async function ensureWasmTrees(fileSymbols, rootDir) {
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
    let code;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    try {
      symbols._tree = parser.parse(code);
      symbols._langId = entry.id;
    } catch {
      // skip files that fail to parse
    }
  }
}

/**
 * Check whether the required WASM grammar files exist on disk.
 */
export function isWasmAvailable() {
  return LANGUAGE_REGISTRY.filter((e) => e.required).every((e) =>
    fs.existsSync(grammarPath(e.grammarFile)),
  );
}

// ── Unified API ──────────────────────────────────────────────────────────────

function resolveEngine(opts = {}) {
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
 *  - dataflow argFlows/mutations bindingType → binding wrapper
 */
function patchNativeResult(r) {
  // lineCount: napi(js_name) emits "lineCount"; older binaries may emit "line_count"
  r.lineCount = r.lineCount ?? r.line_count ?? null;
  r._lineCount = r.lineCount;

  // Backward compat for older binaries missing endLine js_name on definitions
  if (r.definitions) {
    for (const d of r.definitions) {
      if (d.endLine === undefined && d.end_line !== undefined) {
        d.endLine = d.end_line;
      }
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
export const LANGUAGE_REGISTRY = [
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
    extensions: ['.py'],
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
    extensions: ['.rb'],
    grammarFile: 'tree-sitter-ruby.wasm',
    extractor: extractRubySymbols,
    required: false,
  },
  {
    id: 'php',
    extensions: ['.php'],
    grammarFile: 'tree-sitter-php.wasm',
    extractor: extractPHPSymbols,
    required: false,
  },
];

const _extToLang = new Map();
for (const entry of LANGUAGE_REGISTRY) {
  for (const ext of entry.extensions) {
    _extToLang.set(ext, entry);
  }
}

export const SUPPORTED_EXTENSIONS = new Set(_extToLang.keys());

/**
 * WASM extraction helper: picks the right extractor based on file extension.
 */
function wasmExtractSymbols(parsers, filePath, code) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(code);
  } catch (e) {
    warn(`Parse error in ${filePath}: ${e.message}`);
    return null;
  }

  const ext = path.extname(filePath);
  const entry = _extToLang.get(ext);
  if (!entry) return null;
  const query = _queryCache.get(entry.id) || null;
  const symbols = entry.extractor(tree, filePath, query);
  return symbols ? { symbols, tree, langId: entry.id } : null;
}

/**
 * Parse a single file and return normalized symbols.
 *
 * @param {string} filePath  Absolute path to the file.
 * @param {string} source    Source code string.
 * @param {object} [opts]    Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {Promise<{definitions, calls, imports, classes, exports}|null>}
 */
export async function parseFileAuto(filePath, source, opts = {}) {
  const { native } = resolveEngine(opts);

  if (native) {
    const result = native.parseFile(filePath, source, !!opts.dataflow, opts.ast !== false);
    return result ? patchNativeResult(result) : null;
  }

  // WASM path
  const parsers = await createParsers();
  const extracted = wasmExtractSymbols(parsers, filePath, source);
  return extracted ? extracted.symbols : null;
}

/**
 * Parse multiple files in bulk and return a Map<relPath, symbols>.
 *
 * @param {string[]} filePaths  Absolute paths to files.
 * @param {string}   rootDir    Project root for computing relative paths.
 * @param {object}   [opts]     Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {Promise<Map<string, {definitions, calls, imports, classes, exports}>>}
 */
export async function parseFilesAuto(filePaths, rootDir, opts = {}) {
  const { native } = resolveEngine(opts);
  const result = new Map();

  if (native) {
    const nativeResults = native.parseFiles(
      filePaths,
      rootDir,
      !!opts.dataflow,
      opts.ast !== false,
    );
    for (const r of nativeResults) {
      if (!r) continue;
      const relPath = path.relative(rootDir, r.file).split(path.sep).join('/');
      result.set(relPath, patchNativeResult(r));
    }
    return result;
  }

  // WASM path
  const parsers = await createParsers();
  for (const filePath of filePaths) {
    let code;
    try {
      code = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      warn(`Skipping ${path.relative(rootDir, filePath)}: ${err.message}`);
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
 *
 * @param {object} [opts]  Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {{ name: 'native'|'wasm', version: string|null }}
 */
export function getActiveEngine(opts = {}) {
  const { name, native } = resolveEngine(opts);
  const version = native
    ? typeof native.engineVersion === 'function'
      ? native.engineVersion()
      : null
    : null;
  return { name, version };
}

/**
 * Create a native ParseTreeCache for incremental parsing.
 * Returns null if the native engine is unavailable (WASM fallback).
 */
export function createParseTreeCache() {
  const native = loadNative();
  if (!native || !native.ParseTreeCache) return null;
  return new native.ParseTreeCache();
}

/**
 * Parse a file incrementally using the cache, or fall back to full parse.
 *
 * @param {object|null} cache  ParseTreeCache instance (or null for full parse)
 * @param {string} filePath    Absolute path to the file
 * @param {string} source      Source code string
 * @param {object} [opts]      Options forwarded to parseFileAuto on fallback
 * @returns {Promise<{definitions, calls, imports, classes, exports}|null>}
 */
export async function parseFileIncremental(cache, filePath, source, opts = {}) {
  if (cache) {
    const result = cache.parseFile(filePath, source);
    return result ? patchNativeResult(result) : null;
  }
  return parseFileAuto(filePath, source, opts);
}
