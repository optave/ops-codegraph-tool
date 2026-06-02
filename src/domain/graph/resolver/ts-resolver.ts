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
 *
 * The `typescript` package is a peer/optional dependency — it is present on any
 * machine that compiles TypeScript but is not bundled with codegraph itself. This
 * module lazy-imports it at runtime; if the import fails the pass is silently
 * skipped so JS-only projects and environments without `typescript` installed are
 * unaffected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { debug } from '../../../infrastructure/logger.js';
import type { ExtractorOutput, TypeMapEntry } from '../../../types.js';

// typescript is not a hard dependency — lazy-load it so JS-only projects
// and environments without typescript installed work without error.
type TsModule = typeof import('typescript');
let _ts: TsModule | null | undefined; // undefined = not yet tried; null = unavailable

async function loadTs(): Promise<TsModule | null> {
  if (_ts !== undefined) return _ts;
  try {
    _ts = (await import('typescript')).default as TsModule;
  } catch {
    _ts = null;
    debug('ts-resolver: typescript package not available — skipping TSC type enrichment');
  }
  return _ts;
}

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
export async function enrichTypeMapWithTsc(
  rootDir: string,
  fileSymbols: Map<string, ExtractorOutput>,
): Promise<void> {
  const tsRelPaths = [...fileSymbols.keys()].filter(isTsFile);
  if (tsRelPaths.length === 0) return;

  const ts = await loadTs();
  if (!ts) return;

  const tsconfigPath = findTsconfig(rootDir);
  if (!tsconfigPath) {
    debug('ts-resolver: no tsconfig.json found — skipping TypeScript type enrichment');
    return;
  }

  const t0 = Date.now();
  const program = createProgram(ts, tsconfigPath, rootDir);
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
    enrichSourceFile(ts, sourceFile, checker, symbols.typeMap);
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

/**
 * Walk up from rootDir looking for tsconfig.json (up to 4 levels).
 * Handles monorepo setups where rootDir is a package subdirectory but
 * the tsconfig lives at the repository root.
 */
function findTsconfig(rootDir: string): string | null {
  let dir = rootDir;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

function createProgram(
  ts: TsModule,
  tsconfigPath: string,
  rootDir: string,
): import('typescript').Program | null {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      debug(
        `ts-resolver: tsconfig error — ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
      );
      return null;
    }

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, rootDir);

    if (parsed.errors.length > 0) {
      for (const err of parsed.errors) {
        debug(
          `ts-resolver: tsconfig parse warning — ${ts.flattenDiagnosticMessageText(err.messageText, '\n')}`,
        );
      }
    }

    if (parsed.fileNames.length === 0) {
      // Empty fileNames usually means a solution-style tsconfig that only has
      // `references:[]` and no `files`/`include`. In this case ts.createProgram
      // would receive [tsconfigPath] as source — a JSON file — and every
      // subsequent getSourceFile() call for real .ts files returns undefined,
      // producing zero enrichment silently. Warn instead of wasting time.
      debug(
        'ts-resolver: tsconfig resolved no source files (solution-style tsconfig?) — skipping enrichment',
      );
      return null;
    }

    return ts.createProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        noEmit: true,
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
 * Keys are scoped as `<line>:<col>:<name>` to avoid collisions across functions
 * that share parameter names (e.g., two functions both taking `service`). The
 * call-edge resolver looks up by bare name, so we only write bare-name entries
 * when there is no ambiguity (i.e., the name appears exactly once in this file).
 *
 * Entries already at confidence 1.0 (e.g., `new Foo()` from tree-sitter) are
 * left unchanged. New entries from the compiler are added at confidence 1.0.
 */
function enrichSourceFile(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  checker: import('typescript').TypeChecker,
  typeMap: Map<string, TypeMapEntry>,
): void {
  // First pass: collect all resolved types keyed by bare name
  const nameToTypes = new Map<string, string[]>();

  function visit(node: import('typescript').Node): void {
    let identName: string | null = null;
    let nameNode: import('typescript').Identifier | null = null;

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      identName = node.name.text;
      nameNode = node.name;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      identName = node.name.text;
      nameNode = node.name;
    }

    if (identName && nameNode) {
      const typeName = resolveTypeName(nameNode, checker);
      if (typeName) {
        const existing = nameToTypes.get(identName);
        if (existing) {
          existing.push(typeName);
        } else {
          nameToTypes.set(identName, [typeName]);
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);

  // Second pass: only write unambiguous entries (single unique type for a name)
  for (const [name, types] of nameToTypes) {
    const uniqueTypes = [...new Set(types)];
    if (uniqueTypes.length !== 1) continue; // ambiguous — skip to avoid wrong edges
    const typeName = uniqueTypes[0] as string;
    const existing = typeMap.get(name);
    if (!existing || existing.confidence < 1.0) {
      typeMap.set(name, { type: typeName, confidence: 1.0 });
    }
  }
}

/**
 * Ask the type checker for the type of a name node and return its symbol name,
 * or null when the type is a primitive, anonymous, or otherwise not useful for
 * method-call resolution.
 */
function resolveTypeName(
  nameNode: import('typescript').Identifier,
  checker: import('typescript').TypeChecker,
): string | null {
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
