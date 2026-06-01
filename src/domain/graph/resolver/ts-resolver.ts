/**
 * TypeScript-native type resolver (Phase 8.1).
 *
 * Runs as a build-time enrichment pass after tree-sitter parsing. Uses the
 * TypeScript compiler API to resolve the actual runtime type of every variable
 * and parameter in .ts/.tsx files, replacing heuristic typeMap entries (0.7–0.9
 * confidence) with compiler-verified ones (1.0).
 *
 * Tree-sitter parses fast; this pass resolves accurately. Together they give
 * codegraph both speed and precision on its primary use case.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { debug } from '../../../infrastructure/logger.js';
import type { ExtractorOutput, TypeMapEntry } from '../../../types.js';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function isTsFile(relPath: string): boolean {
  return TS_EXTENSIONS.has(path.extname(relPath));
}

// Primitive and built-in type names that don't help call resolution.
const SKIP_TYPE_NAMES = new Set([
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'never',
  'void',
  'null',
  'undefined',
  'object',
  'symbol',
  'bigint',
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Error',
  'Function',
  'RegExp',
  'Date',
]);

/**
 * Enrich the typeMap for every .ts/.tsx file using the TypeScript compiler API.
 *
 * Called from buildEdges before call-edge construction. Only overwrites entries
 * with lower confidence than 1.0 (constructor calls are already exact).
 */
export function enrichTypeMapWithTsc(
  rootDir: string,
  fileSymbols: Map<string, ExtractorOutput>,
): void {
  const tsRelPaths = [...fileSymbols.keys()].filter(isTsFile);
  if (tsRelPaths.length === 0) return;

  const tsconfigPath = findTsconfig(rootDir);
  if (!tsconfigPath) {
    debug('ts-resolver: no tsconfig.json — skipping TypeScript type enrichment');
    return;
  }

  const t0 = Date.now();
  const program = createProgram(tsconfigPath, rootDir);
  if (!program) return;

  const checker = program.getTypeChecker();
  let enrichedFiles = 0;
  let enrichedEntries = 0;

  for (const relPath of tsRelPaths) {
    const symbols = fileSymbols.get(relPath)!;
    const absPath = path.resolve(rootDir, relPath);
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) continue;

    const before = symbols.typeMap.size;
    const countBefore = countLowConfidence(symbols.typeMap);
    enrichSourceFile(sourceFile, checker, symbols.typeMap);
    const countAfter = countLowConfidence(symbols.typeMap);
    const gained = countBefore - countAfter + (symbols.typeMap.size - before);
    if (gained > 0) {
      enrichedEntries += gained;
      enrichedFiles++;
    }
  }

  debug(
    `ts-resolver: enriched ${enrichedEntries} typeMap entries across ${enrichedFiles} files in ${Date.now() - t0}ms`,
  );
}

function countLowConfidence(typeMap: Map<string, TypeMapEntry>): number {
  let count = 0;
  for (const entry of typeMap.values()) {
    if (entry.confidence < 1.0) count++;
  }
  return count;
}

function findTsconfig(rootDir: string): string | null {
  const candidate = path.join(rootDir, 'tsconfig.json');
  return fs.existsSync(candidate) ? candidate : null;
}

function createProgram(tsconfigPath: string, rootDir: string): ts.Program | null {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      debug(`ts-resolver: tsconfig error — ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
      return null;
    }

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir);

    return ts.createProgram({
      rootNames: parsed.fileNames.length > 0 ? parsed.fileNames : [tsconfigPath],
      options: {
        ...parsed.options,
        noEmit: true,
        // Already set in tsconfig; keep but be explicit for safety.
        skipLibCheck: true,
      },
    });
  } catch (err) {
    debug(`ts-resolver: failed to create TS program — ${err}`);
    return null;
  }
}

/**
 * Walk a single SourceFile and update typeMap entries for:
 *   - Variable declarations: const/let/var names with inferred or annotated types
 *   - Function/method parameters with type annotations
 *
 * Entries already at confidence 1.0 (e.g., `new Foo()` from tree-sitter) are
 * left unchanged. New entries from the compiler are added at confidence 1.0.
 */
function enrichSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  typeMap: Map<string, TypeMapEntry>,
): void {
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const varName = node.name.text;
      const existing = typeMap.get(varName);
      if (!existing || existing.confidence < 1.0) {
        const typeName = resolveTypeName(node.name, checker);
        if (typeName) typeMap.set(varName, { type: typeName, confidence: 1.0 });
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const paramName = node.name.text;
      const existing = typeMap.get(paramName);
      if (!existing || existing.confidence < 1.0) {
        const typeName = resolveTypeName(node.name, checker);
        if (typeName) typeMap.set(paramName, { type: typeName, confidence: 1.0 });
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
}

/**
 * Ask the type checker for the type of a name node and return its symbol name,
 * or null when the type is a primitive, anonymous, or otherwise not useful for
 * method-call resolution.
 */
function resolveTypeName(nameNode: ts.Identifier, checker: ts.TypeChecker): string | null {
  try {
    const type = checker.getTypeAtLocation(nameNode);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    if (!symbol) return null;
    const name = symbol.getName();
    if (!name || name === '__type' || name === '__object' || SKIP_TYPE_NAMES.has(name)) return null;
    return name;
  } catch {
    return null;
  }
}
