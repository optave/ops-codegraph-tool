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
import type { CallAssignment, ExtractorOutput, TypeMapEntry } from '../../../types.js';

// typescript is not a hard dependency — lazy-load it so JS-only projects
// and environments without typescript installed work without error.
type TsModule = typeof import('typescript');
let _ts: TsModule | null | undefined; // undefined = not yet tried; null = unavailable

async function loadTs(): Promise<TsModule | null> {
  if (_ts !== undefined) return _ts;
  try {
    // TypeScript 6+ ships dual CJS/ESM exports; `.default` is the CJS interop
    // namespace and is present and non-null in both TS 5.x and TS 6.x.
    _ts = (await import('typescript')).default as TsModule;
  } catch {
    _ts = null;
    debug('ts-resolver: typescript package not available — skipping TSC type enrichment');
  }
  return _ts;
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function isTsFile(relPath: string): boolean {
  // Exclude .d.ts declaration files — path.extname('.d.ts') returns '.ts',
  // so we must check the full suffix explicitly.
  return TS_EXTENSIONS.has(path.extname(relPath)) && !relPath.endsWith('.d.ts');
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
  const program = createProgram(ts, tsconfigPath);
  if (!program) return;

  const checker = program.getTypeChecker();
  let enrichedFiles = 0;
  let enrichedEntries = 0;
  let backfilledFiles = 0;

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

    // Phase 8.2 parity: backfill returnTypeMap and callAssignments for engines
    // (native Rust) that don't populate them during extraction. The JS extractor
    // sets these fields; native leaves them undefined.
    // Guards are intentionally independent so a future extractor that sets one
    // but not the other is handled correctly without silently skipping either.
    let didBackfill = false;
    if (symbols.returnTypeMap === undefined) {
      symbols.returnTypeMap = new Map();
      enrichReturnTypeMap(ts, sourceFile, checker, symbols.returnTypeMap);
      if (symbols.returnTypeMap.size > 0) didBackfill = true;
    }
    if (symbols.callAssignments === undefined) {
      symbols.callAssignments = [];
      enrichCallAssignments(ts, sourceFile, symbols.typeMap, symbols.callAssignments);
      if (symbols.callAssignments.length > 0) didBackfill = true;
    }
    if (didBackfill) backfilledFiles++;
  }

  debug(
    `ts-resolver: enriched ${enrichedEntries} typeMap entries across ${enrichedFiles} files` +
      (backfilledFiles > 0
        ? `, backfilled returnTypeMap/callAssignments in ${backfilledFiles} files`
        : '') +
      ` in ${Date.now() - t0}ms`,
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

function createProgram(ts: TsModule, tsconfigPath: string): import('typescript').Program | null {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      debug(
        `ts-resolver: tsconfig error — ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
      );
      return null;
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(tsconfigPath),
    );

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
  // First pass: collect resolved types keyed by bare identifier name.
  // Track both the short name (for typeMap writes) and the fully-qualified name
  // (module-path-prefixed) for ambiguity detection. Two classes may share the
  // same short name (e.g., `OrderService` from two different modules), and
  // symbol.getName() returns the declared name — not the local alias — so
  // deduplication on short names alone would incorrectly collapse them.
  const nameToEntries = new Map<string, { shortName: string; qualifiedName: string }[]>();
  // Track class property declaration names so we can also seed "this.X" entries.
  const propertyDeclNames = new Set<string>();

  function visit(node: import('typescript').Node): void {
    let identName: string | null = null;
    let nameNode: import('typescript').Identifier | null = null;

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      identName = node.name.text;
      nameNode = node.name;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      identName = node.name.text;
      nameNode = node.name;
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      // TypeScript class field: `private repo: Repository<User>`
      // Seeds typeMap so `this.repo.method()` can be resolved via receiver type.
      identName = node.name.text;
      nameNode = node.name;
      propertyDeclNames.add(node.name.text);
    }

    if (identName && nameNode) {
      const resolved = resolveTypeName(ts, nameNode, checker);
      if (resolved) {
        const existing = nameToEntries.get(identName);
        if (existing) {
          existing.push(resolved);
        } else {
          nameToEntries.set(identName, [resolved]);
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);

  // Second pass: only write unambiguous entries (single unique qualified type for a name)
  for (const [name, entries] of nameToEntries) {
    const uniqueQualified = [...new Set(entries.map((e) => e.qualifiedName))];
    if (uniqueQualified.length !== 1) continue; // ambiguous across modules — skip
    // entries is non-empty because we only set() on first occurrence and push() after —
    // TypeScript's noUncheckedIndexedAccess can flag [0] access, so assert the type.
    const first = entries[0];
    if (!first) continue;
    const shortName = first.shortName;
    const existing = typeMap.get(name);
    if (!existing || existing.confidence < 1.0) {
      typeMap.set(name, { type: shortName, confidence: 1.0 });
    }
    // For class property declarations, also seed "this.fieldName" so that
    // `this.repo.findById()` call sites resolve to the interface/class type.
    if (propertyDeclNames.has(name)) {
      const thisKey = `this.${name}`;
      const existingThis = typeMap.get(thisKey);
      if (!existingThis || existingThis.confidence < 1.0) {
        typeMap.set(thisKey, { type: shortName, confidence: 1.0 });
      }
    }
  }
}

/**
 * Walk a SourceFile and populate returnTypeMap with compiler-verified return types.
 * Handles function declarations, method declarations, and arrow/function-expression
 * variable initialisers at module scope. Methods are stored as `ClassName.methodName`.
 *
 * Only captures declarations at module scope or directly inside a class body —
 * local functions nested inside method bodies are excluded to avoid spurious
 * cross-file type matches (same guard as enrichSourceFile's "unambiguous names only"
 * heuristic). Recursion stops at function/method body boundaries.
 *
 * Async functions returning Promise<T> are unwrapped: the inner type argument T is
 * used so that async methods receive a returnTypeMap entry just like sync ones.
 */
function enrichReturnTypeMap(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  checker: import('typescript').TypeChecker,
  returnTypeMap: Map<string, TypeMapEntry>,
): void {
  let currentClass: string | null = null;

  /**
   * Resolve the concrete return type name for a signature, unwrapping
   * Promise<T> so async functions contribute their inner type.
   */
  function resolveReturnTypeName(sig: import('typescript').Signature | undefined): string | null {
    if (!sig) return null;
    try {
      let retType = checker.getReturnTypeOfSignature(sig);

      // Unwrap Promise<T> → T so async functions get a useful returnTypeMap entry.
      const outerSym = retType.getSymbol() ?? retType.aliasSymbol;
      if (outerSym?.getName() === 'Promise') {
        const args = checker.getTypeArguments(retType as import('typescript').TypeReference);
        if (args.length > 0) retType = args[0]!;
      }

      const sym = retType.getSymbol() ?? retType.aliasSymbol;
      if (!sym) return null;
      const name = sym.getName();
      if (!name || name === '__type' || name === '__object' || SKIP_TYPE_NAMES.has(name))
        return null;
      return name;
    } catch {
      return null;
    }
  }

  function writeEntry(fnName: string, sigNode: import('typescript').SignatureDeclaration): void {
    const typeName = resolveReturnTypeName(checker.getSignatureFromDeclaration(sigNode));
    if (typeName) {
      const existing = returnTypeMap.get(fnName);
      if (!existing || existing.confidence < 1.0)
        returnTypeMap.set(fnName, { type: typeName, confidence: 1.0 });
    }
  }

  /**
   * Visit nodes at the current lexical scope (module level or class body).
   * Does NOT recurse into function/method bodies to avoid capturing local
   * helper functions under bare names.
   */
  function visit(node: import('typescript').Node): void {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      // Enter class scope: visit direct children (method/property declarations).
      const saved = currentClass;
      currentClass =
        (node as import('typescript').ClassDeclaration | import('typescript').ClassExpression).name
          ?.text ?? null;
      ts.forEachChild(node, visit);
      currentClass = saved;
      return; // class body fully handled — stop here
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      // Module-level function declaration: record and stop (no body descent).
      writeEntry(node.name.text, node);
      return;
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      // Class method: record as ClassName.methodName and stop.
      const fnName = currentClass ? `${currentClass}.${node.name.text}` : node.name.text;
      writeEntry(fnName, node);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      // Arrow/function-expression assigned to a variable at the current scope.
      // Because we never recurse into function bodies, any VariableDeclaration
      // we see here is guaranteed to be at module scope or inside a class body
      // (not inside a method body), making the bare name safe for cross-file use.
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        writeEntry(node.name.text, init);
      }
      return; // variable declaration fully handled — stop here
    }

    // For all other node kinds (VariableStatement, VariableDeclarationList,
    // ExportDeclaration, etc.) recurse to reach nested function/class/var nodes.
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
}

/**
 * Walk a SourceFile and push call assignments (`const x = fn()`) whose variable
 * is not yet in typeMap into callAssignments for cross-file propagation.
 * Phase 8.1 already resolved the common case into typeMap; this captures the rest.
 *
 * Uses the same two-pass "unambiguous names only" strategy as `enrichSourceFile`:
 * collect all candidates first, then only push entries where a given `varName`
 * maps to exactly one distinct `calleeName`. This prevents multiple methods in the
 * same file that each bind a different imported function to a common local name
 * (e.g., `const result = getA()` in one method, `const result = getB()` in
 * another) from both landing in `callAssignments`, which would cause
 * `propagateReturnTypesAcrossFiles` to silently resolve one arbitrarily.
 */
function enrichCallAssignments(
  ts: TsModule,
  sourceFile: import('typescript').SourceFile,
  typeMap: Map<string, TypeMapEntry>,
  callAssignments: CallAssignment[],
): void {
  // First pass: collect all candidates keyed by varName.
  const candidates = new Map<string, CallAssignment[]>();

  function visit(node: import('typescript').Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const varName = node.name.text;
      if (!typeMap.has(varName)) {
        const call = node.initializer;
        let calleeName: string | null = null;
        let receiverTypeName: string | undefined;

        if (ts.isIdentifier(call.expression)) {
          calleeName = call.expression.text;
        } else if (ts.isPropertyAccessExpression(call.expression)) {
          calleeName = call.expression.name.text;
          const obj = call.expression.expression;
          if (ts.isIdentifier(obj)) {
            const entry = typeMap.get(obj.text);
            if (entry && typeof entry === 'object') receiverTypeName = entry.type;
          }
        }

        if (calleeName) {
          const ca: CallAssignment = { varName, calleeName, receiverTypeName };
          const existing = candidates.get(varName);
          if (existing) {
            existing.push(ca);
          } else {
            candidates.set(varName, [ca]);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  // Second pass: only push entries where varName maps to exactly one distinct
  // calleeName. Ambiguous varNames (same name, different callees across scopes)
  // are excluded to avoid silently resolving the wrong type cross-file.
  for (const entries of candidates.values()) {
    const uniqueCallees = new Set(entries.map((e) => e.calleeName));
    if (uniqueCallees.size === 1) {
      callAssignments.push(entries[0] as CallAssignment);
    }
  }
}

/**
 * Ask the type checker for the type of a name node and return both the short
 * declared name and the fully-qualified module-prefixed name. Returns null when
 * the type is a primitive, anonymous, or otherwise not useful for resolution.
 *
 * The fully-qualified name (e.g., `"./legacy/service".OrderService`) is used for
 * ambiguity detection — it distinguishes two classes that share the same short
 * declaration name but come from different modules. The short name is what the
 * call-edge resolver looks up in the typeMap.
 */
function resolveTypeName(
  ts: TsModule,
  nameNode: import('typescript').Identifier,
  checker: import('typescript').TypeChecker,
): { shortName: string; qualifiedName: string } | null {
  try {
    const type = checker.getTypeAtLocation(nameNode);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    if (!symbol) return null;
    const shortName = symbol.getName();
    if (
      !shortName ||
      shortName === '__type' ||
      shortName === '__object' ||
      SKIP_TYPE_NAMES.has(shortName) ||
      // Skip generic type-parameter symbols (T, E, K, etc.) — they do not
      // correspond to any real class and would overwrite useful lower-confidence
      // heuristic entries, causing call edges to be silently dropped.
      (symbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.TypeAlias)) !== 0
    )
      return null;
    // getFullyQualifiedName returns e.g. `"./path/to/module".ClassName` for
    // imported symbols — unique across modules even when short names collide.
    const qualifiedName = checker.getFullyQualifiedName(symbol);
    return { shortName, qualifiedName };
  } catch {
    return null;
  }
}
