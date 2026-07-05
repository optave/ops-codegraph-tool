import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../../infrastructure/logger.js';
import type { TreeSitterNode } from '../../types.js';

export interface ResolveFileTreeOptions {
  /** Repo-relative path of the file being resolved. */
  relPath: string;
  /** Absolute root directory the repo-relative path is joined against. */
  rootDir: string;
  /** Already-parsed tree, if the caller has one cached (e.g. from a fresh build). */
  cachedTree?: { rootNode: TreeSitterNode } | null;
  /** Language id paired with `cachedTree`, if known. */
  cachedLangId?: string | null;
  /** Extensions this analysis supports — gates whether a fallback parse is attempted. */
  extensions: Set<string>;
  /** Extension → language id map used both for the allowlist gate and langId lookup. */
  extToLang: Map<string, string> | null | undefined;
  /** Opaque parser table passed through to `getParser`. */
  parsers: unknown;
  /** Resolves a tree-sitter parser instance for a given absolute path. */
  getParser:
    | ((parsers: unknown, absPath: string) => { parse(code: string): unknown } | null | undefined)
    | null;
  /** Prefix used in debug log messages (e.g. "complexity", "dataflow"). */
  logPrefix: string;
}

export interface ResolvedFileTree {
  tree: { rootNode: TreeSitterNode };
  langId: string;
}

/**
 * Resolve a parsed tree-sitter tree for a file: prefer an already-cached
 * tree/langId pair, otherwise read the file from disk and parse it, with
 * debug-logged fallback on read/parse errors. Shared by
 * complexity.ts's getTreeForFile and dataflow.ts's getDataflowForFile,
 * which previously duplicated this ~20-line cache/read/parse dance.
 */
export function resolveFileTree(opts: ResolveFileTreeOptions): ResolvedFileTree | null {
  const { relPath, rootDir, extensions, extToLang, parsers, getParser, logPrefix } = opts;
  let tree = opts.cachedTree;
  let langId = opts.cachedLangId;

  if (!tree) {
    if (!getParser) return null;
    const ext = path.extname(relPath).toLowerCase();
    if (!extensions.has(ext)) return null;
    if (!extToLang) return null;
    langId = extToLang.get(ext);
    if (!langId) return null;

    const absPath = path.join(rootDir, relPath);
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e: unknown) {
      debug(`${logPrefix}: cannot read ${relPath}: ${(e as Error).message}`);
      return null;
    }

    const parser = getParser(parsers, absPath);
    if (!parser) return null;

    try {
      tree = parser.parse(code) as { rootNode: TreeSitterNode };
    } catch (e: unknown) {
      debug(`${logPrefix}: parse failed for ${relPath}: ${(e as Error).message}`);
      return null;
    }
  }

  if (!langId) {
    const ext = path.extname(relPath).toLowerCase();
    langId = extToLang?.get(ext);
    if (!langId) return null;
  }

  return tree && langId ? { tree, langId } : null;
}
