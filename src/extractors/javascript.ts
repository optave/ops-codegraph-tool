import { debug } from '../infrastructure/logger.js';
import type {
  ArrayCallbackBinding,
  ArrayElemBinding,
  Call,
  CallAssignment,
  ClassRelation,
  Definition,
  DynamicKind,
  Export,
  ExtractorOutput,
  FnRefBinding,
  ForOfBinding,
  Import,
  ObjectPropBinding,
  ObjectRestParamBinding,
  ParamBinding,
  SpreadArgBinding,
  SubDeclaration,
  ThisCallBinding,
  TreeSitterNode,
  TreeSitterQuery,
  TreeSitterTree,
  TypeMapEntry,
} from '../types.js';
import {
  findChild,
  findParentNode,
  MAX_WALK_DEPTH,
  nodeEndLine,
  nodeStartLine,
  setTypeMapEntry,
} from './helpers.js';

/** Built-in globals that start with uppercase but are not user-defined types. */
const BUILTIN_GLOBALS: Set<string> = new Set([
  'Math',
  'JSON',
  'Promise',
  'Array',
  'Object',
  'Date',
  'Error',
  'Symbol',
  'Map',
  'Set',
  'RegExp',
  'Number',
  'String',
  'Boolean',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Proxy',
  'Reflect',
  'Intl',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'BigInt',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Uint8ClampedArray',
  'URL',
  'URLSearchParams',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'Headers',
  'Request',
  'Response',
  'FormData',
  'Blob',
  'File',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'console',
  'Buffer',
  'EventEmitter',
  'Stream',
  'process',
  'window',
  'document',
  'globalThis',
]);

/** Maximum chain depth for inter-procedural return-type propagation (Phase 8.2). */
const MAX_PROPAGATION_DEPTH = 3;
/** Confidence penalty applied per propagation hop (1.0 → 0.9 → 0.8 → 0.7). */
export const PROPAGATION_HOP_PENALTY = 0.1;
/**
 * Confidence score for a return type inferred from `return new Constructor()` with no
 * explicit TypeScript annotation.  Registered as `analysis.typeInferenceConfidence` in
 * `src/infrastructure/config.ts` DEFAULTS — kept in sync manually until config is
 * threaded through to `extractSymbols`.
 */
const INFERRED_RETURN_TYPE_CONFIDENCE = 0.85;

/**
 * Extract symbols from a JS/TS parsed AST.
 * When a compiled tree-sitter Query is provided (from parser.js),
 * uses the fast query-based path. Falls back to manual tree walk otherwise.
 */
export function extractSymbols(
  tree: TreeSitterTree,
  _filePath: string,
  query?: TreeSitterQuery,
): ExtractorOutput {
  if (query) return extractSymbolsQuery(tree, query);
  return extractSymbolsWalk(tree);
}

// ── Query-based extraction (fast path) ──────────────────────────────────────

/** Handle function_declaration capture. */
function handleFnCapture(c: Record<string, TreeSitterNode>, definitions: Definition[]): void {
  const fnChildren = extractParameters(c.fn_node!);
  definitions.push({
    name: c.fn_name!.text,
    kind: 'function',
    line: nodeStartLine(c.fn_node!),
    endLine: nodeEndLine(c.fn_node!),
    children: fnChildren.length > 0 ? fnChildren : undefined,
  });
}

/** Handle variable_declarator with arrow_function / function_expression capture. */
function handleVarFnCapture(c: Record<string, TreeSitterNode>, definitions: Definition[]): void {
  const declNode = c.varfn_name!.parent?.parent;
  const line = declNode ? nodeStartLine(declNode) : nodeStartLine(c.varfn_name!);
  const varFnChildren = extractParameters(c.varfn_value!);
  definitions.push({
    name: c.varfn_name!.text,
    kind: 'function',
    line,
    endLine: nodeEndLine(c.varfn_value!),
    children: varFnChildren.length > 0 ? varFnChildren : undefined,
  });
}

/** Handle class_declaration capture. */
function handleClassCapture(
  c: Record<string, TreeSitterNode>,
  definitions: Definition[],
  classes: ClassRelation[],
): void {
  const className = c.cls_name!.text;
  const startLine = nodeStartLine(c.cls_node!);
  const clsChildren = extractClassProperties(c.cls_node!);
  definitions.push({
    name: className,
    kind: 'class',
    line: startLine,
    endLine: nodeEndLine(c.cls_node!),
    children: clsChildren.length > 0 ? clsChildren : undefined,
  });
  const heritage =
    c.cls_node!.childForFieldName('heritage') || findChild(c.cls_node!, 'class_heritage');
  if (heritage) {
    const superName = extractSuperclass(heritage);
    if (superName) classes.push({ name: className, extends: superName, line: startLine });
    const implementsList = extractImplements(heritage);
    for (const iface of implementsList) {
      classes.push({ name: className, implements: iface, line: startLine });
    }
  }
}

/** Handle method_definition capture. */
function handleMethodCapture(c: Record<string, TreeSitterNode>, definitions: Definition[]): void {
  const methNameNode = c.meth_name!;
  // Non-string computed keys (e.g. `[Symbol.iterator]`) resolve to '' and are skipped.
  const methName = resolveMethodDefinitionName(methNameNode);
  if (!methName) return;
  // extractObjectLiteralFunctions already emits this node's bare + qualified definitions
  // together (#1818) — skip here to avoid a duplicate, differently-positioned bare entry.
  if (isObjectLiteralDeclaratorMethod(c.meth_node!)) return;
  const parentClass = findParentClass(c.meth_node!);
  const fullName = parentClass ? `${parentClass}.${methName}` : methName;
  definitions.push(buildMethodDefinition(c.meth_node!, fullName));
}

/** Node types whose own `name` field is the exported symbol's name. */
const EXPORT_DECL_KIND: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
};

/**
 * Push Export entries for the declaration wrapped by an `export` statement.
 * Shared by both extraction paths (query-based `handleExportCapture` and
 * walk-based `handleExportStmt`) so they can't drift apart on what counts as
 * an export — see the "two code paths" gotcha for this extractor.
 *
 * Named function/class/interface/type declarations carry their own `name`
 * field. `export const/let/var …` has no such field — each declarator's value
 * is classified the same way `handleVariableDeclarator` classifies it when
 * building the matching Definition (function-valued → kind 'function'; any
 * other `const` initializer shape → kind 'constant', regardless of complexity —
 * mirroring how function declarations are captured regardless of body
 * complexity, #1819). This predicate must stay identical to the
 * Definition-building one: the exported=1 UPDATE it feeds matches DB rows by
 * (name, kind, file, line), so a mismatched kind silently no-ops instead of
 * marking the symbol exported (#1728).
 */
function collectExportedDeclarations(
  decl: TreeSitterNode,
  exportLine: number,
  exps: Export[],
): void {
  const kind = EXPORT_DECL_KIND[decl.type];
  if (kind) {
    const n = decl.childForFieldName('name');
    if (n) exps.push({ name: n.text, kind: kind as Export['kind'], line: exportLine });
    return;
  }
  if (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration') return;
  const isConst = decl.text.startsWith('const ');
  for (let i = 0; i < decl.childCount; i++) {
    const declarator = decl.child(i);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameN = declarator.childForFieldName('name');
    const valueN = declarator.childForFieldName('value');
    if (nameN?.type !== 'identifier' || !valueN) continue;
    const valType = valueN.type;
    if (
      valType === 'arrow_function' ||
      valType === 'function_expression' ||
      valType === 'function' ||
      valType === 'generator_function'
    ) {
      exps.push({ name: nameN.text, kind: 'function', line: exportLine });
    } else if (isConst) {
      exps.push({ name: nameN.text, kind: 'constant', line: exportLine });
    }
  }
}

/** Handle export_statement capture. */
function handleExportCapture(
  c: Record<string, TreeSitterNode>,
  exps: Export[],
  imports: Import[],
): void {
  const exportLine = nodeStartLine(c.exp_node!);
  const decl = c.exp_node!.childForFieldName('declaration');
  if (decl) collectExportedDeclarations(decl, exportLine, exps);
  const source = c.exp_node!.childForFieldName('source') || findChild(c.exp_node!, 'string');
  if (source && !decl) {
    const modPath = source.text.replace(/['"]/g, '');
    const reexportRenames: Array<{ local: string; imported: string }> = [];
    const reexportNames = extractImportNames(c.exp_node!, reexportRenames);
    const nodeText = c.exp_node!.text;
    const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
    imports.push({
      source: modPath,
      names: reexportNames,
      line: exportLine,
      reexport: true,
      wildcardReexport: isWildcard && reexportNames.length === 0,
      ...(reexportRenames.length > 0 ? { renamedImports: reexportRenames } : {}),
    });
  }
}

function handleInterfaceCapture(
  c: Record<string, TreeSitterNode>,
  definitions: Definition[],
): void {
  const ifaceNode = c.iface_node!;
  const ifaceName = c.iface_name!.text;
  definitions.push({
    name: ifaceName,
    kind: 'interface',
    line: nodeStartLine(ifaceNode),
    endLine: nodeEndLine(ifaceNode),
  });
  const body =
    ifaceNode.childForFieldName('body') ||
    findChild(ifaceNode, 'interface_body') ||
    findChild(ifaceNode, 'object_type');
  if (body) extractInterfaceMethods(body, ifaceName, definitions);
}

function handleTypeCapture(c: Record<string, TreeSitterNode>, definitions: Definition[]): void {
  const typeNode = c.type_node!;
  definitions.push({
    name: c.type_name!.text,
    kind: 'type',
    line: nodeStartLine(typeNode),
    endLine: nodeEndLine(typeNode),
  });
}

function handleImportCapture(c: Record<string, TreeSitterNode>, imports: Import[]): void {
  const impNode = c.imp_node!;
  const isTypeOnly = impNode.text.startsWith('import type');
  const modPath = c.imp_source!.text.replace(/['"]/g, '');
  const renamedImports: Array<{ local: string; imported: string }> = [];
  const typeOnlyNames: string[] = [];
  const names = extractImportNames(impNode, renamedImports, typeOnlyNames);
  imports.push({
    source: modPath,
    names,
    line: nodeStartLine(impNode),
    typeOnly: isTypeOnly,
    ...(renamedImports.length > 0 ? { renamedImports } : {}),
    ...(typeOnlyNames.length > 0 ? { typeOnlyNames } : {}),
  });
}

/** Dispatch a single query match to the appropriate handler. */
function dispatchQueryMatch(
  c: Record<string, TreeSitterNode>,
  definitions: Definition[],
  calls: Call[],
  imports: Import[],
  classes: ClassRelation[],
  exps: Export[],
  callbackParamShapes: CallbackParamShapes,
  arrayElemBindings: ArrayElemBinding[],
): void {
  if (c.fn_node) {
    handleFnCapture(c, definitions);
  } else if (c.varfn_name) {
    handleVarFnCapture(c, definitions);
  } else if (c.cls_node) {
    handleClassCapture(c, definitions, classes);
  } else if (c.meth_node) {
    handleMethodCapture(c, definitions);
  } else if (c.iface_node) {
    handleInterfaceCapture(c, definitions);
  } else if (c.type_node) {
    handleTypeCapture(c, definitions);
  } else if (c.imp_node) {
    handleImportCapture(c, imports);
  } else if (c.exp_node) {
    handleExportCapture(c, exps, imports);
  } else if (c.callfn_node) {
    // Route through extractCallInfo so special identifier calls (eval) get classified.
    const callfnInfo = extractCallInfo(c.callfn_name!, c.callfn_node);
    if (callfnInfo) calls.push(callfnInfo);
    calls.push(...extractCallbackReferenceCalls(c.callfn_node, callbackParamShapes));
  } else if (c.callmem_node) {
    // extractCallInfo → extractMemberExprCallInfo tags .call/.apply/.bind (e.g. `fn.call(ctx)`)
    // as dynamic/reflection regardless of receiver shape, matching the walk path and native
    // engine (#1778). The #1687 dedup-collision case — the same target already reached by a
    // direct call from the same caller in the same scope — is resolved downstream in
    // build-edges.ts's emitDirectCallEdgesForCall, not here.
    const callInfo = extractCallInfo(c.callmem_fn!, c.callmem_node);
    if (callInfo) calls.push(callInfo);
    const cbDef = extractCallbackDefinition(c.callmem_node, c.callmem_fn);
    if (cbDef) definitions.push(cbDef);
    calls.push(...extractCallbackReferenceCalls(c.callmem_node, callbackParamShapes));
  } else if (c.callsub_node) {
    const callInfo = extractCallInfo(c.callsub_fn!, c.callsub_node, arrayElemBindings);
    if (callInfo) calls.push(callInfo);
    calls.push(...extractCallbackReferenceCalls(c.callsub_node, callbackParamShapes));
  } else if (c.newfn_node) {
    if (c.newfn_name!.text === 'Function') {
      // new Function(body) — dynamic code execution; classify as eval kind
      calls.push({
        name: '<dynamic:eval>',
        line: nodeStartLine(c.newfn_node),
        dynamic: true,
        dynamicKind: 'eval',
      });
    } else {
      calls.push({
        name: c.newfn_name!.text,
        line: nodeStartLine(c.newfn_node),
      });
    }
  } else if (c.newmem_node) {
    const callInfo = extractCallInfo(c.newmem_fn!, c.newmem_node);
    if (callInfo) calls.push(callInfo);
  } else if (c.callsuper_node) {
    // Bare `super(...)` constructor call — see extractCallInfo's 'super' branch.
    const callInfo = extractCallInfo(c.callsuper_fn!, c.callsuper_node);
    if (callInfo) calls.push(callInfo);
    calls.push(...extractCallbackReferenceCalls(c.callsuper_node, callbackParamShapes));
  } else if (c.assign_node) {
    handleCommonJSAssignment(c.assign_left!, c.assign_right!, c.assign_node, imports);
    handleFuncPropAssignment(c.assign_left!, c.assign_right!, definitions);
  }
}

function extractSymbolsQuery(tree: TreeSitterTree, query: TreeSitterQuery): ExtractorOutput {
  const definitions: Definition[] = [];
  const calls: Call[] = [];
  const imports: Import[] = [];
  const classes: ClassRelation[] = [];
  const exps: Export[] = [];
  const typeMap: Map<string, TypeMapEntry> = new Map();
  const returnTypeMap: Map<string, TypeMapEntry> = new Map();
  const callAssignments: CallAssignment[] = [];
  const fnRefBindings: FnRefBinding[] = [];
  const paramBindings: ParamBinding[] = [];
  const arrayElemBindings: ArrayElemBinding[] = [];
  const spreadArgBindings: SpreadArgBinding[] = [];
  const forOfBindings: ForOfBinding[] = [];
  const arrayCallbackBindings: ArrayCallbackBinding[] = [];
  const objectRestParamBindings: ObjectRestParamBinding[] = [];
  const objectPropBindings: ObjectPropBinding[] = [];
  const thisCallBindings: ThisCallBinding[] = [];

  const matches = query.matches(tree.rootNode);
  // Issue #1845: collected once up front so identifier-argument calls to
  // same-file user-defined higher-order functions can be recognized
  // regardless of match order.
  const callbackParamShapes = collectCallbackParamShapes(tree.rootNode);

  for (const match of matches) {
    // Build capture lookup for this match (1-3 captures each, very fast)
    const c: Record<string, TreeSitterNode> = Object.create(null);
    for (const cap of match.captures) c[cap.name] = cap.node;
    dispatchQueryMatch(
      c,
      definitions,
      calls,
      imports,
      classes,
      exps,
      callbackParamShapes,
      arrayElemBindings,
    );
  }

  // Extract top-level constants via targeted walk (query patterns don't cover these)
  extractConstantsWalk(tree.rootNode, definitions);

  // Phase 8.2: Extract function return types first — runContextCollectorWalk's
  // declarator handler reads the *complete* per-file map for inter-procedural
  // propagation, so this cannot be folded into that pass.
  extractReturnTypeMapWalk(tree.rootNode, returnTypeMap);

  // Context-tracking collector pass: typeMap (with return-type propagation),
  // object-rest param bindings, and spread/for-of/Array.from bindings.
  runContextCollectorWalk(tree.rootNode, {
    typeMap,
    returnTypeMap,
    callAssignments,
    fnRefBindings,
    objectRestParamBindings,
    spreadArgBindings,
    forOfBindings,
    arrayCallbackBindings,
  });

  // Extract definitions from destructured bindings (query patterns don't match object_pattern).
  // Also collects CJS require bindings (const { X } = require('…')) into a separate list so
  // importedNames can classify them as import artifacts without creating DB edges (#1661).
  const cjsRequireBindings: Array<{ names: string[]; source: string }> = [];
  extractDestructuredBindingsWalk(tree.rootNode, definitions, cjsRequireBindings);

  // Everything without bespoke traversal semantics is collected in ONE pass:
  // dynamic import() calls, prototype-method definitions, param bindings,
  // array-element bindings, object-prop bindings, `new X()` names,
  // Object.defineProperty receivers, class members (fields/static blocks,
  // which query patterns don't capture), and this()/call/apply bindings.
  const newExpressions: string[] = [];
  const definePropertyReceivers: Map<string, string> = new Map();
  // #1893: same-file get/set accessor registry, needed before the collector
  // walk below so bare property reads can be recognized regardless of
  // whether the accessing code appears before or after the class declaration.
  const localAccessors = collectLocalAccessors(tree.rootNode);
  runCollectorWalk(tree.rootNode, {
    definitions,
    typeMap,
    paramBindings,
    arrayElemBindings,
    objectPropBindings,
    newExpressions,
    definePropertyReceivers,
    valueRefCalls: calls,
    localAccessors,
    imports,
    calls,
    thisCallBindings,
    classMemberDefs: definitions,
  });

  return {
    definitions,
    calls,
    imports,
    classes,
    exports: exps,
    typeMap,
    returnTypeMap,
    callAssignments,
    fnRefBindings,
    paramBindings,
    arrayElemBindings,
    spreadArgBindings,
    forOfBindings,
    arrayCallbackBindings,
    objectRestParamBindings,
    objectPropBindings,
    thisCallBindings,
    newExpressions,
    ...(definePropertyReceivers.size > 0 ? { definePropertyReceivers } : {}),
    ...(cjsRequireBindings.length > 0 ? { cjsRequireBindings } : {}),
  };
}

/** Node types that define a function scope — constants inside these are skipped. */
const FUNCTION_SCOPE_TYPES = new Set([
  'function_declaration',
  'arrow_function',
  'function_expression',
  'method_definition',
  'generator_function_declaration',
  'generator_function',
]);

/**
 * Return true when `node` has an ancestor whose type is in FUNCTION_SCOPE_TYPES.
 * Used by the walk path to skip declarations inside function bodies, matching
 * the query path's top-down FUNCTION_SCOPE_TYPES filter.
 */
function hasFunctionScopeAncestor(node: TreeSitterNode): boolean {
  let p: TreeSitterNode | null = node.parent ?? null;
  while (p) {
    if (FUNCTION_SCOPE_TYPES.has(p.type)) return true;
    p = p.parent ?? null;
  }
  return false;
}

/**
 * True when `declarator` is the shape extractObjectLiteralFunctions qualifies: a plain
 * identifier name, outside any function scope. Shared by that function's four call sites
 * (extractConstDeclarators, extractLetVarObjLiteralDeclarators, handleVariableDeclarator's
 * const/let/var branches) and by `isObjectLiteralDeclaratorMethod` below, which walks the
 * same shape from a nested method_definition upward — keeping both directions in sync (#1818).
 */
function isEligibleObjectLiteralDeclarator(declarator: TreeSitterNode): boolean {
  if (declarator.type !== 'variable_declarator') return false;
  const nameN = declarator.childForFieldName('name');
  if (nameN?.type !== 'identifier') return false;
  return !hasFunctionScopeAncestor(declarator);
}

/**
 * True when `methNode` (a method_definition) is a shorthand method whose enclosing object
 * literal is the direct value of an eligible variable declarator (see
 * `isEligibleObjectLiteralDeclarator`) AND has no enclosing class — the common shape
 * extractObjectLiteralFunctions already emits both the qualified (`varName.method`) and bare
 * (`method`) definitions for, together, in source position order relative to the declaration
 * itself. The generic method_definition handlers (handleMethodCapture, handleMethodDef) skip
 * these nodes to avoid pushing a second, differently-positioned bare entry that makes native
 * and WASM disagree on `definitions` array order (#1818).
 *
 * The enclosing-class check excludes a rarer, unrelated nested shape — e.g. a const declared
 * inside a class `static { }` block (not itself function-scoped) — where the generic handlers
 * already produce a *class*-qualified entry (`ClassName.method`, via findParentClass) rather
 * than a bare one; that entry must be left alone, not duplicated by a spurious bare push.
 */
function isObjectLiteralDeclaratorMethod(methNode: TreeSitterNode): boolean {
  const obj = methNode.parent;
  if (obj?.type !== 'object') return false;
  const declarator = obj.parent;
  if (!declarator || !isEligibleObjectLiteralDeclarator(declarator)) return false;
  return findParentClass(methNode) === null;
}

/** Build the generic (possibly class-qualified) method_definition Definition entry. */
function buildMethodDefinition(node: TreeSitterNode, name: string): Definition {
  const methChildren = extractParameters(node);
  const methVis = extractVisibility(node);
  return {
    name,
    kind: 'method',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: methChildren.length > 0 ? methChildren : undefined,
    visibility: methVis,
  };
}

// ── ES6 getter/setter property-read call attribution (#1893) ────────────────
//
// A bare (non-call) property read/write on an ES6 `get`/`set` class accessor
// (`obj.isReady`, no call parens) invokes the accessor function just as surely
// as `obj.isReady()` would if written explicitly — but call-site extraction
// only ever looked at `member_expression` nodes used as a call_expression's
// callee, so accessor reads/writes never produced a `calls` edge at all.
//
// Scoped to the *same-file* case: `this.prop` inside one of the accessor's own
// class's methods, or `varName.prop` where `varName`'s type (from this file's
// own typeMap) is a class also declared in this file. Cross-file accessor
// reads (the accessor's class declared in a different file than the read
// site) are not yet covered — see #2030.

/** Per-property record of which accessor kinds a same-file class declares. */
interface LocalAccessorInfo {
  get: boolean;
  set: boolean;
}

/** `ClassName.propName` → which accessor kinds are declared, for this file only. */
type LocalAccessorRegistry = Map<string, LocalAccessorInfo>;

/**
 * True when `methNode` (a method_definition) carries a `get` or `set` accessor
 * modifier — an unnamed token child preceding the `name` field (tree-sitter
 * represents `get`/`set`/`static`/`async` as literal unnamed children, not a
 * dedicated field). Returns null for a plain (non-accessor) method.
 */
function getMethodAccessorKind(methNode: TreeSitterNode): 'get' | 'set' | null {
  const nameNode = methNode.childForFieldName('name');
  for (let i = 0; i < methNode.childCount; i++) {
    const child = methNode.child(i);
    // Node identity must be compared via `.id` — tree-sitter (WASM) mints a
    // fresh wrapper object on every childForFieldName()/child() access, so
    // `===` between two independently-fetched references to the same AST
    // node is always false. The grammar places all get/set modifiers
    // strictly before the name node, so this guard is exercised in practice.
    if (!child || child.id === nameNode?.id) break;
    if (child.type === 'get' || child.type === 'set') return child.type;
  }
  return null;
}

/**
 * Pre-scan pass: collect every ES6 get/set class-accessor declared in this
 * file, keyed by its qualified `ClassName.propName` name — the same
 * qualification `buildMethodDefinition`'s caller already gives the accessor's
 * own Definition entry. Must run before the property-read walk below so the
 * registry is complete regardless of source order (a class can be declared
 * after code that reads its instances' accessors).
 */
function collectLocalAccessors(rootNode: TreeSitterNode): LocalAccessorRegistry {
  const registry: LocalAccessorRegistry = new Map();
  const walk = (node: TreeSitterNode, depth: number): void => {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'method_definition') {
      const accessorKind = getMethodAccessorKind(node);
      if (accessorKind) {
        const nameNode = node.childForFieldName('name');
        const className = findParentClass(node);
        const propName = nameNode ? resolveMethodDefinitionName(nameNode) : '';
        if (className && propName) {
          const key = `${className}.${propName}`;
          const entry = registry.get(key) ?? { get: false, set: false };
          entry[accessorKind] = true;
          registry.set(key, entry);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  };
  walk(rootNode, 0);
  return registry;
}

/** Unwrap a typeMap entry (always `{type, confidence}` in this file's own typeMap) to its type name. */
function localTypeMapTypeName(typeMap: Map<string, TypeMapEntry>, varName: string): string | null {
  return typeMap.get(varName)?.type ?? null;
}

/**
 * Detect a bare (non-call) `this.prop` / `varName.prop` member-expression that
 * reads or writes a same-file accessor property, and record it as an ordinary
 * `Call` — indistinguishable from a real `this.prop()`/`varName.prop()` call
 * site, so it flows through the existing (unchanged) call-resolution cascade.
 *
 * A plain assignment (`obj.prop = value`) invokes the setter; every other bare
 * usage (reads, compound-assignment targets, etc.) invokes the getter. When a
 * property declares *both* a getter and a setter, the two accessors share the
 * same qualified name and resolution has no way to tell them apart — rather
 * than risk an edge to the wrong one, that case is skipped entirely (mirrors
 * resolveExactGlobalMatch's "ambiguous → drop rather than fan out" precedent
 * in resolver/strategy.ts).
 */
function collectAccessorPropertyRead(
  node: TreeSitterNode,
  localAccessors: LocalAccessorRegistry,
  typeMap: Map<string, TypeMapEntry>,
  valueRefCalls: Call[],
): void {
  const parent = node.parent;
  // obj.method() — already a real call, handled by the regular call path
  // regardless of whether `method` also happens to be an accessor. Node
  // identity must be compared via `.id` — tree-sitter (WASM) mints a fresh
  // wrapper object on every childForFieldName()/parent access, so `===`
  // between two independently-fetched references to the same AST node is
  // always false.
  if (parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id) {
    return;
  }

  const obj = node.childForFieldName('object');
  const propNode = node.childForFieldName('property');
  if (!obj || !propNode || propNode.type !== 'property_identifier') return;
  const propName = propNode.text;

  let receiver: string;
  let className: string | null;
  if (obj.type === 'this') {
    receiver = 'this';
    className = findParentClass(node);
  } else if (obj.type === 'identifier') {
    receiver = obj.text;
    className = localTypeMapTypeName(typeMap, obj.text);
  } else {
    return;
  }
  if (!className) return;

  const accessorInfo = localAccessors.get(`${className}.${propName}`);
  if (!accessorInfo || (accessorInfo.get && accessorInfo.set)) return;

  const isPlainAssignTarget =
    parent?.type === 'assignment_expression' && parent.childForFieldName('left')?.id === node.id;
  const neededKind = isPlainAssignTarget ? 'set' : 'get';
  if (!accessorInfo[neededKind]) return;

  valueRefCalls.push({ name: propName, receiver, line: nodeStartLine(node) });
}

/**
 * Recursively walk the AST to extract `const x = <literal>` as constants.
 * Skips nodes inside function scopes so only file-level / block-level constants
 * are captured — matching the native engine's behaviour.
 */
function extractConstantsWalk(node: TreeSitterNode, definitions: Definition[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Don't descend into function scopes
    if (FUNCTION_SCOPE_TYPES.has(child.type)) continue;

    let declNode = child;
    // Handle `export const …` — unwrap the export_statement to its declaration child
    if (child.type === 'export_statement') {
      const inner = child.childForFieldName('declaration');
      if (inner) declNode = inner;
    }

    extractConstDeclarators(declNode, definitions);
    extractLetVarObjLiteralDeclarators(declNode, definitions);

    // Recurse into non-function, non-export-statement children (blocks, if-statements, etc.)
    if (child.type !== 'export_statement') {
      extractConstantsWalk(child, definitions);
    }
  }
}

// Class field definitions and static initializer blocks (which query patterns
// don't capture) are collected inline in runCollectorWalk's field_definition /
// class_static_block cases when `classMemberDefs` is set. The walk-based path
// (extractSymbolsWalk) handles these node types via walkJavaScriptNode instead.

/**
 * Walk the AST to find destructured const bindings (query patterns don't match object_pattern).
 * e.g. `const { handleToken, checkPermissions } = initAuth(config)`
 *
 * When `cjsRequireBindings` is provided, also records `const { X } = require('./path')` patterns
 * so the edge builder can classify X as an import artifact rather than a local definition (#1661).
 */
function extractDestructuredBindingsWalk(
  node: TreeSitterNode,
  definitions: Definition[],
  cjsRequireBindings?: Array<{ names: string[]; source: string }>,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (FUNCTION_SCOPE_TYPES.has(child.type)) continue;

    let declNode = child;
    if (child.type === 'export_statement') {
      const inner = child.childForFieldName('declaration');
      if (inner) declNode = inner;
    }

    extractDestructuredDeclarators(declNode, definitions, cjsRequireBindings);

    if (child.type !== 'export_statement') {
      extractDestructuredBindingsWalk(child, definitions, cjsRequireBindings);
    }
  }
}

/**
 * Extract object/array-pattern destructured const bindings from a single declaration
 * node — the per-declaration counterpart to extractDestructuredBindingsWalk's tree walk.
 */
function extractDestructuredDeclarators(
  declNode: TreeSitterNode,
  definitions: Definition[],
  cjsRequireBindings?: Array<{ names: string[]; source: string }>,
): void {
  const t = declNode.type;
  if (
    (t !== 'lexical_declaration' && t !== 'variable_declaration') ||
    !declNode.text.startsWith('const ')
  ) {
    return;
  }

  for (let j = 0; j < declNode.childCount; j++) {
    const declarator = declNode.child(j);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameN = declarator.childForFieldName('name');
    if (nameN && nameN.type === 'object_pattern') {
      extractDestructuredBindings(
        nameN,
        nodeStartLine(declNode),
        nodeEndLine(declNode),
        definitions,
      );
      // Record CJS require bindings so importedNames can classify these names
      // as import artifacts, preventing false local-definition blocking (#1661).
      if (cjsRequireBindings) {
        const valueN = declarator.childForFieldName('value');
        const binding = extractCjsRequireBinding(nameN, valueN);
        if (binding) cjsRequireBindings.push(binding);
      }
    } else if (nameN && nameN.type === 'array_pattern') {
      // `const [x, y] = ...` — one constant Definition per bound identifier (#1901).
      extractArrayPatternBindings(
        nameN,
        nodeStartLine(declNode),
        nodeEndLine(declNode),
        definitions,
      );
    }
  }
}

/**
 * Compute a `const { X } = require('./path')` CJS binding record from a destructured
 * object-pattern name node and its declarator's value node, for import-artifact
 * classification (#1661). Returns null when the value isn't a static require() call or
 * no destructured names could be extracted. Shared by the walk-based
 * (extractDestructuredDeclarators) and query-based (handleVariableDecl) const-destructuring
 * paths, which independently need the identical extraction.
 */
function extractCjsRequireBinding(
  nameN: TreeSitterNode,
  valueN: TreeSitterNode | null | undefined,
): { names: string[]; source: string } | null {
  if (valueN?.type !== 'call_expression') return null;
  const fn = valueN.childForFieldName('function');
  if (fn?.text !== 'require') return null;
  const args = valueN.childForFieldName('arguments');
  const strArg = args && findChild(args, 'string');
  if (!strArg) return null;
  const modPath = strArg.text.replace(/['"]/g, '');
  const names: string[] = [];
  for (let k = 0; k < nameN.childCount; k++) {
    const prop = nameN.child(k);
    if (!prop) continue;
    if (
      prop.type === 'shorthand_property_identifier_pattern' ||
      prop.type === 'shorthand_property_identifier'
    ) {
      names.push(prop.text);
    } else if (prop.type === 'pair_pattern' || prop.type === 'pair') {
      const val = prop.childForFieldName('value');
      if (val?.type === 'identifier' || val?.type === 'shorthand_property_identifier_pattern') {
        names.push(val.text);
      }
    }
  }
  if (names.length === 0) return null;
  return { names, source: modPath };
}

/** Extract constant definitions from a `const` declaration node. */
function extractConstDeclarators(declNode: TreeSitterNode, definitions: Definition[]): void {
  const t = declNode.type;
  if (t !== 'lexical_declaration' && t !== 'variable_declaration') return;
  if (!declNode.text.startsWith('const ')) return;

  for (let j = 0; j < declNode.childCount; j++) {
    const declarator = declNode.child(j);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameN = declarator.childForFieldName('name');
    const valueN = declarator.childForFieldName('value');
    if (nameN?.type !== 'identifier' || !valueN) continue;
    // Skip functions — already captured by query patterns
    const valType = valueN.type;
    if (
      valType === 'arrow_function' ||
      valType === 'function_expression' ||
      valType === 'function' ||
      valType === 'generator_function'
    )
      continue;
    // Any other initializer shape becomes a 'constant' Definition, regardless of
    // complexity (call/member/parenthesized expressions, etc.) — mirroring how
    // function declarations are captured regardless of body complexity (#1819).
    definitions.push({
      name: nameN.text,
      kind: 'constant',
      line: nodeStartLine(declNode),
      endLine: nodeEndLine(declNode),
    });
    // Phase 8.3f: extract function/arrow properties from object literals.
    // Scope guard: extractConstDeclarators is only called from extractConstantsWalk, which
    // already skips const declarations inside function scopes (line ~412). So these definitions
    // are always top-level. Any new call site must add a hasFunctionScopeAncestor guard
    // (the walk path at handleVariableDecl does this).
    if (valueN.type === 'object') {
      extractObjectLiteralFunctions(valueN, nameN.text, definitions);
    }
  }
}

/**
 * Extract qualified method definitions from `let`/`var` object-literal declarations.
 * Mirrors `match_js_objlit_qualified_method_defs` in `javascript.rs`, which emits
 * qualified definitions for `method_definition` (all declaration kinds) and
 * `pair+arrow/function` (`let`/`var` only, since `const` is already handled by
 * `extractConstDeclarators` → `extractObjectLiteralFunctions`).
 *
 * Called from extractConstantsWalk which already provides the function-scope guard.
 * `var q1 = { m1() {} }` → emits Definition { name: 'q1.m1', kind: 'function' }
 */
function extractLetVarObjLiteralDeclarators(
  declNode: TreeSitterNode,
  definitions: Definition[],
): void {
  const t = declNode.type;
  if (t !== 'lexical_declaration' && t !== 'variable_declaration') return;
  if (declNode.text.startsWith('const ')) return; // handled by extractConstDeclarators

  for (let j = 0; j < declNode.childCount; j++) {
    const declarator = declNode.child(j);
    if (declarator?.type !== 'variable_declarator') continue;
    const nameN = declarator.childForFieldName('name');
    const valueN = declarator.childForFieldName('value');
    if (nameN?.type !== 'identifier' || !valueN || valueN.type !== 'object') continue;
    extractObjectLiteralFunctions(valueN, nameN.text, definitions);
  }
}

/**
 * Recursive walk to find dynamic import() calls.
 * Query patterns match call_expression with identifier/member_expression/subscript_expression
 * functions, but import() has function type `import` which none of those patterns cover.
 */
/**
 * Collect a dynamic `import()` call at `node` (a call_expression).
 * Returns true when the node *is* an import() call — the collector walk uses
 * this to suppress dynamic-import collection inside the import's own argument
 * subtree, preserving the former standalone walk's "don't recurse into
 * import() children" behaviour without hiding those children from the other
 * collectors.
 */
function collectDynamicImport(node: TreeSitterNode, imports: Import[]): boolean {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'import') return false;
  const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
  if (args) {
    const strArg = findChild(args, 'string');
    if (strArg) {
      const modPath = strArg.text.replace(/['"]/g, '');
      const renamedImports: Array<{ local: string; imported: string }> = [];
      const names = extractDynamicImportNames(node, renamedImports);
      imports.push({
        source: modPath,
        names,
        line: nodeStartLine(node),
        dynamicImport: true,
        ...(renamedImports.length > 0 ? { renamedImports } : {}),
      });
    } else {
      debug(
        `Skipping non-static dynamic import() at line ${nodeStartLine(node)} (template literal or variable)`,
      );
    }
  }
  return true;
}

function handleCommonJSAssignment(
  left: TreeSitterNode,
  right: TreeSitterNode,
  node: TreeSitterNode,
  imports: Import[],
): void {
  if (!left || !right) return;
  const leftText = left.text;
  if (!leftText.startsWith('module.exports') && leftText !== 'exports') return;

  const assignLine = nodeStartLine(node);

  // module.exports = require("…") — direct re-export
  if (right.type === 'call_expression') {
    extractRequireReexport(right, assignLine, imports);
  }

  // module.exports = { ...require("…") } — spread re-export
  if (right.type === 'object') {
    extractSpreadRequireReexports(right, assignLine, imports);
  }
}

/** Extract a direct `require()` re-export from a call_expression. */
function extractRequireReexport(callExpr: TreeSitterNode, line: number, imports: Import[]): void {
  const fn = callExpr.childForFieldName('function');
  const args = callExpr.childForFieldName('arguments') || findChild(callExpr, 'arguments');
  if (fn && fn.text === 'require' && args) {
    const strArg = findChild(args, 'string');
    if (strArg) {
      imports.push({
        source: strArg.text.replace(/['"]/g, ''),
        names: [],
        line,
        reexport: true,
        wildcardReexport: true,
      });
    }
  }
}

/** Extract `...require()` re-exports from spread elements inside an object literal. */
function extractSpreadRequireReexports(
  objectNode: TreeSitterNode,
  line: number,
  imports: Import[],
): void {
  for (let ci = 0; ci < objectNode.childCount; ci++) {
    const child = objectNode.child(ci);
    if (child && child.type === 'spread_element') {
      const spreadExpr = child.child(1) || child.childForFieldName('value');
      if (spreadExpr && spreadExpr.type === 'call_expression') {
        extractRequireReexport(spreadExpr, line, imports);
      }
    }
  }
}

// ── Manual tree walk (fallback when Query not available) ────────────────────

function extractSymbolsWalk(tree: TreeSitterTree): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
    returnTypeMap: new Map(),
    callAssignments: [],
    fnRefBindings: [],
    paramBindings: [],
    arrayElemBindings: [],
    spreadArgBindings: [],
    forOfBindings: [],
    arrayCallbackBindings: [],
    objectRestParamBindings: [],
    objectPropBindings: [],
    thisCallBindings: [],
  };

  // Issue #1845: collected once up front so identifier-argument calls to
  // same-file user-defined higher-order functions can be recognized during
  // the single forward walk below, regardless of declaration order.
  const callbackParamShapes = collectCallbackParamShapes(tree.rootNode);
  walkJavaScriptNode(tree.rootNode, ctx, callbackParamShapes);
  // Phase 8.2: Extract function return types first — runContextCollectorWalk's
  // declarator handler reads the *complete* per-file map for inter-procedural
  // propagation, so this cannot be folded into that pass.
  extractReturnTypeMapWalk(tree.rootNode, ctx.returnTypeMap!);
  // Context-tracking collector pass: typeMap (with return-type propagation),
  // object-rest param bindings, and spread/for-of/Array.from bindings.
  runContextCollectorWalk(tree.rootNode, {
    typeMap: ctx.typeMap!,
    returnTypeMap: ctx.returnTypeMap,
    callAssignments: ctx.callAssignments,
    fnRefBindings: ctx.fnRefBindings!,
    objectRestParamBindings: ctx.objectRestParamBindings!,
    spreadArgBindings: ctx.spreadArgBindings!,
    forOfBindings: ctx.forOfBindings!,
    arrayCallbackBindings: ctx.arrayCallbackBindings!,
  });
  // Single collector pass for everything else: prototype-method and func-prop
  // definitions, param bindings, array-element bindings, object-prop bindings,
  // `new X()` names, and Object.defineProperty receivers. Dynamic imports,
  // this()/call/apply bindings, and class members are omitted here —
  // walkJavaScriptNode already covers those node types on this path.
  const newExpressions: string[] = [];
  const definePropertyReceivers: Map<string, string> = new Map();
  // #1893: same-file get/set accessor registry — see the query-path call site
  // of collectLocalAccessors for why this must be computed up front.
  const localAccessors = collectLocalAccessors(tree.rootNode);
  runCollectorWalk(tree.rootNode, {
    definitions: ctx.definitions,
    typeMap: ctx.typeMap!,
    paramBindings: ctx.paramBindings!,
    arrayElemBindings: ctx.arrayElemBindings!,
    objectPropBindings: ctx.objectPropBindings!,
    newExpressions,
    definePropertyReceivers,
    valueRefCalls: ctx.calls,
    localAccessors,
    funcPropDefs: ctx.definitions,
  });
  ctx.newExpressions = newExpressions;
  if (definePropertyReceivers.size > 0) ctx.definePropertyReceivers = definePropertyReceivers;
  return ctx;
}

function walkJavaScriptNode(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  callbackParamShapes: CallbackParamShapes,
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      handleFunctionDecl(node, ctx);
      break;
    case 'class_declaration':
    case 'abstract_class_declaration':
    // class expressions: `return class Foo extends Bar { ... }` or `const X = class Foo { ... }`
    case 'class':
      handleClassDecl(node, ctx);
      break;
    case 'class_static_block':
      handleStaticBlock(node, ctx.definitions);
      break;
    case 'field_definition':
    case 'public_field_definition':
      handleFieldDef(node, ctx.definitions);
      break;
    case 'method_definition':
      handleMethodDef(node, ctx);
      break;
    case 'interface_declaration':
      handleInterfaceDecl(node, ctx);
      break;
    case 'type_alias_declaration':
      handleTypeAliasDecl(node, ctx);
      break;
    case 'lexical_declaration':
    case 'variable_declaration':
      handleVariableDecl(node, ctx);
      break;
    case 'enum_declaration':
      handleEnumDecl(node, ctx);
      break;
    case 'decorator':
      handleDecorator(node, ctx.calls);
      break;
    case 'call_expression':
      handleCallExpr(node, ctx, callbackParamShapes);
      break;
    case 'new_expression':
      handleNewExpr(node, ctx);
      break;
    case 'import_statement':
      handleImportStmt(node, ctx);
      break;
    case 'export_statement':
      handleExportStmt(node, ctx);
      break;
    case 'expression_statement':
      handleExpressionStmt(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walkJavaScriptNode(node.child(i)!, ctx, callbackParamShapes);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    const fnChildren = extractParameters(node);
    ctx.definitions.push({
      name: nameNode.text,
      kind: 'function',
      line: nodeStartLine(node),
      endLine: nodeEndLine(node),
      children: fnChildren.length > 0 ? fnChildren : undefined,
    });
  }
}

function handleClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const className = nameNode.text;
  const startLine = nodeStartLine(node);
  const clsChildren = extractClassProperties(node);
  ctx.definitions.push({
    name: className,
    kind: 'class',
    line: startLine,
    endLine: nodeEndLine(node),
    children: clsChildren.length > 0 ? clsChildren : undefined,
  });
  const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
  if (heritage) {
    const superName = extractSuperclass(heritage);
    if (superName) {
      ctx.classes.push({ name: className, extends: superName, line: startLine });
    }
    const implementsList = extractImplements(heritage);
    for (const iface of implementsList) {
      ctx.classes.push({ name: className, implements: iface, line: startLine });
    }
  }
}

function handleMethodDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    // Non-string computed keys (e.g. `[Symbol.iterator]`) resolve to '' and are skipped.
    const methName = resolveMethodDefinitionName(nameNode);
    if (!methName) return;
    // extractObjectLiteralFunctions already emits this node's bare + qualified definitions
    // together (#1818) — skip here to avoid a duplicate, differently-positioned bare entry.
    if (isObjectLiteralDeclaratorMethod(node)) return;
    const parentClass = findParentClass(node);
    const fullName = parentClass ? `${parentClass}.${methName}` : methName;
    ctx.definitions.push(buildMethodDefinition(node, fullName));
  }
}

/**
 * Create a synthetic `ClassName.<static:L:C>` definition for a class static block
 * so that calls inside the block can be attributed to a method-kind node and
 * `resolveThisDispatch` can walk up to the parent class for `super.method()`.
 *
 * The start line and column are appended to the name to ensure uniqueness when a
 * class has multiple `static { }` blocks (each has a distinct start position even
 * if on the same line).
 *
 * Tree-sitter uses `class_static_block` (not `static_block`) for `static { ... }`.
 */
function handleStaticBlock(node: TreeSitterNode, definitions: Definition[]): void {
  const parentClass = findParentClass(node);
  if (!parentClass) return;
  const line = nodeStartLine(node);
  const col = node.startPosition.column;
  definitions.push({
    name: `${parentClass}.<static:${line}:${col}>`,
    kind: 'method',
    line,
    endLine: nodeEndLine(node),
  });
}

/**
 * Emit a `ClassName.fieldName` definition for class fields that have an initializer.
 * This lets `findCaller` attribute calls inside field initializers (e.g. static field
 * side-effects) to the field rather than the enclosing class.
 *
 * JS `field_definition` uses the `'property'` field name; TS
 * `public_field_definition` uses `'name'`. As a third fallback (Rust/TS parity) we
 * also check for a positional `property_identifier` child.
 */
const CALLABLE_FIELD_TYPES = new Set([
  'arrow_function',
  'function_expression',
  'generator_function',
]);

function handleFieldDef(node: TreeSitterNode, definitions: Definition[]): void {
  // JS field_definition uses 'property' field; TS public_field_definition uses 'name' field
  const nameNode =
    node.childForFieldName('name') ||
    node.childForFieldName('property') ||
    findChild(node, 'property_identifier');
  const valueNode = node.childForFieldName('value');
  if (!nameNode || !valueNode) return;
  if (nameNode.type === 'computed_property_name') return;
  // Only emit a callable definition when the initializer is a function/arrow expression.
  // Scalar fields like `static x = 42` should not appear as method-kind nodes.
  if (!CALLABLE_FIELD_TYPES.has(valueNode.type)) return;
  const fieldName = nameNode.text;
  if (!fieldName) return;
  const parentClass = findParentClass(node);
  if (!parentClass) return;
  definitions.push({
    name: `${parentClass}.${fieldName}`,
    kind: 'method',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
  });
}

function handleInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
  });
  const body =
    node.childForFieldName('body') ||
    findChild(node, 'interface_body') ||
    findChild(node, 'object_type');
  if (body) {
    extractInterfaceMethods(body, nameNode.text, ctx.definitions);
  }
}

function handleTypeAliasDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    ctx.definitions.push({
      name: nameNode.text,
      kind: 'type',
      line: nodeStartLine(node),
      endLine: nodeEndLine(node),
    });
  }
}

/**
 * Extract definitions from destructured object bindings.
 * `const { handleToken, checkPermissions } = initAuth(...)` creates definitions
 * for handleToken and checkPermissions, kind `constant` — matching the
 * convention for plain `const x = <literal>` bindings (handleConstIdentifierAssignment)
 * and array-pattern destructuring (the sibling branch in the callers below).
 *
 * Every call site of this function is already gated to `const` declarations
 * (never `let`/`var`), so `constant` is unconditionally correct here — there is
 * no live binding-mutability to branch on. Prior to #1773 this used `kind:
 * 'function'` on the theory that destructured names are usually callbacks, but
 * that miscategorized every non-function destructured value (e.g. `const {
 * dbPath } = workerData`), which polluted `--kind function` queries and caused
 * the dead-code classifier to misjudge them via the wrong kind's heuristics.
 * `constant`-kind nodes remain fully resolvable as call targets — call-target
 * resolution (`resolveByGlobal`'s exact by-name lookup) is kind-agnostic, and
 * `constant` is already in the caller-attribution fallback tier
 * (`TOP_LEVEL_BINDING_KINDS` in call-resolver.ts) — so callback-style
 * destructured bindings (`const { handleToken } = router; handleToken(req)`)
 * still resolve correctly.
 */
function extractDestructuredBindings(
  pattern: TreeSitterNode,
  line: number,
  endLine: number,
  definitions: Definition[],
): void {
  for (let i = 0; i < pattern.childCount; i++) {
    const child = pattern.child(i);
    if (!child) continue;
    if (
      child.type === 'shorthand_property_identifier_pattern' ||
      child.type === 'shorthand_property_identifier'
    ) {
      // { handleToken } — shorthand binding
      definitions.push({ name: child.text, kind: 'constant', line, endLine });
    } else if (child.type === 'pair_pattern' || child.type === 'pair') {
      // { original: renamed } — renamed binding, use the local alias
      const value = child.childForFieldName('value');
      if (
        value &&
        (value.type === 'identifier' || value.type === 'shorthand_property_identifier_pattern')
      ) {
        definitions.push({ name: value.text, kind: 'constant', line, endLine });
      }
    }
  }
}

/**
 * Extract a per-element `constant` Definition from each bound identifier in an
 * array-destructuring pattern (`const [a, b] = fn()`) — the array-pattern
 * counterpart to `extractDestructuredBindings`'s per-property handling of
 * object patterns (#1773). Each bound name becomes its own resolvable node
 * (e.g. `a()`, `b()` calls can resolve to `a`/`b` directly), superseding the
 * prior single-node-named-by-raw-pattern-text approach (`[a, b]` as one
 * unresolvable node), which was never a real identifier and could never be a
 * call target (#1901).
 */
function extractArrayPatternBindings(
  pattern: TreeSitterNode,
  line: number,
  endLine: number,
  definitions: Definition[],
): void {
  for (let i = 0; i < pattern.childCount; i++) {
    const child = pattern.child(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      // [a, b] — plain positional binding
      definitions.push({ name: child.text, kind: 'constant', line, endLine });
    } else if (child.type === 'assignment_pattern') {
      // [a = defaultValue] — the bound name is the left-hand identifier
      const left = child.childForFieldName('left');
      if (left && left.type === 'identifier') {
        definitions.push({ name: left.text, kind: 'constant', line, endLine });
      }
    } else if (child.type === 'rest_pattern' || child.type === 'rest_element') {
      // `rest_pattern`/`rest_element` has no named fields at all (verified against
      // tree-sitter-javascript/typescript's node-types.json) — its single named
      // child (after the `...` token) is whichever pattern the rest binds to.
      // [...rest] binds a plain identifier; [...[a, b]] nests another array
      // pattern whose own elements each need their own Definition. Scan all
      // children (rather than assuming a fixed index) and recurse into a nested
      // array_pattern instead of silently dropping it, matching extractParameters'
      // own rest_pattern scan.
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (!inner) continue;
        if (inner.type === 'identifier') {
          definitions.push({ name: inner.text, kind: 'constant', line, endLine });
          break;
        } else if (inner.type === 'array_pattern') {
          // [...[a, b]] — recurse so the nested pattern's own bound
          // identifiers each get their own Definition.
          extractArrayPatternBindings(inner, line, endLine, definitions);
          break;
        }
      }
    }
  }
}

function handleVariableDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isConst = node.text.startsWith('const ');
  for (let i = 0; i < node.childCount; i++) {
    const declarator = node.child(i);
    if (declarator && declarator.type === 'variable_declarator') {
      handleVariableDeclarator(node, declarator, isConst, ctx);
    }
  }
}

/**
 * Dispatch a single variable_declarator within a variable/lexical declaration to the
 * handler matching its value/name-pattern kind. Mirrors the query-based path's
 * per-capture handler functions (handleFnCapture, etc.) already used elsewhere in this file.
 */
function handleVariableDeclarator(
  node: TreeSitterNode,
  declarator: TreeSitterNode,
  isConst: boolean,
  ctx: ExtractorOutput,
): void {
  const nameN = declarator.childForFieldName('name');
  const valueN = declarator.childForFieldName('value');
  if (!nameN || !valueN) return;

  const valType = valueN.type;
  if (
    valType === 'arrow_function' ||
    valType === 'function_expression' ||
    valType === 'function' ||
    valType === 'generator_function'
  ) {
    handleVarFnAssignment(node, nameN, valueN, ctx);
  } else if (isConst && nameN.type === 'identifier' && !hasFunctionScopeAncestor(node)) {
    // Any other initializer shape becomes a 'constant' Definition, regardless of
    // complexity (call/member/parenthesized expressions, etc.) — mirroring how
    // function declarations are captured regardless of body complexity (#1819).
    handleConstIdentifierAssignment(node, nameN, valueN, ctx);
  } else if (
    !isConst &&
    nameN.type === 'identifier' &&
    valueN.type === 'object' &&
    !hasFunctionScopeAncestor(node)
  ) {
    // `let`/`var` object literals: extract qualified method definitions so that
    // `obj.method()` calls resolve correctly. Mirrors Rust match_js_objlit_qualified_method_defs
    // which emits method_definition qualified names for ALL declaration kinds and
    // pair+arrow/function for let/var only (const is already handled above).
    // Scope guard prevents local object properties from polluting the global index.
    extractObjectLiteralFunctions(valueN, nameN.text, ctx.definitions);
  } else if (isConst && nameN.type === 'object_pattern' && !hasFunctionScopeAncestor(node)) {
    handleConstObjectPatternAssignment(node, nameN, valueN, ctx);
  } else if (isConst && nameN.type === 'array_pattern' && !hasFunctionScopeAncestor(node)) {
    // Array destructuring: `const [x, y] = ...` — one constant Definition per
    // bound identifier (#1901). Scope guard mirrors the object_pattern branch above.
    extractArrayPatternBindings(nameN, nodeStartLine(node), nodeEndLine(node), ctx.definitions);
  }
}

/** Handle `const/let fn = (...) => {...}` — a function/arrow value assigned to a variable. */
function handleVarFnAssignment(
  node: TreeSitterNode,
  nameN: TreeSitterNode,
  valueN: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  const varFnChildren = extractParameters(valueN);
  ctx.definitions.push({
    name: nameN.text,
    kind: 'function',
    line: nodeStartLine(node),
    endLine: nodeEndLine(valueN),
    children: varFnChildren.length > 0 ? varFnChildren : undefined,
  });
}

/** Handle `const X = <literal>` — a plain constant identifier assignment. */
function handleConstIdentifierAssignment(
  node: TreeSitterNode,
  nameN: TreeSitterNode,
  valueN: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  ctx.definitions.push({
    name: nameN.text,
    kind: 'constant',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
  });
  // Phase 8.3f: extract function/arrow properties from object literals so that
  // this.method() calls inside Object.defineProperty accessors can resolve them.
  // Scope guard: hasFunctionScopeAncestor mirrors the Rust path's find_parent_of_types
  // check and the sibling destructured-binding branch below — skips object literals
  // inside function bodies to avoid polluting the global definition index with
  // local variable properties (e.g. `localObj.fn` from `const localObj = { fn: ... }`
  // inside a function).
  if (valueN.type === 'object') {
    extractObjectLiteralFunctions(valueN, nameN.text, ctx.definitions);
  }
}

/** Handle `const { a, b } = value` — destructured object-pattern const bindings. */
function handleConstObjectPatternAssignment(
  node: TreeSitterNode,
  nameN: TreeSitterNode,
  valueN: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  // Destructured bindings: const { handleToken, checkPermissions } = initAuth(...)
  // Each destructured property becomes a constant definition (#1773) — still
  // resolvable when passed as a callback (e.g. router.use(handleToken)), since
  // call-target resolution is kind-agnostic (see extractDestructuredBindings).
  // Restricted to const to avoid creating spurious definitions for
  // transient let/var destructuring (e.g. let { userId } = parseRequest(req)).
  // Scope guard mirrors extractDestructuredBindingsWalk (query path) and
  // handle_var_decl (Rust path) — skips bindings inside function bodies.
  extractDestructuredBindings(nameN, nodeStartLine(node), nodeEndLine(node), ctx.definitions);
  // Record CJS require bindings for import-artifact classification (#1661).
  const binding = extractCjsRequireBinding(nameN, valueN);
  if (binding) {
    if (!ctx.cjsRequireBindings) ctx.cjsRequireBindings = [];
    ctx.cjsRequireBindings.push(binding);
  }
}

/**
 * Resolve an object-literal `pair`'s key node to its plain string name.
 * Computed string-literal keys (e.g. `['foo']: fn`) are unwrapped the same way as
 * method_definition's name field; non-string computed keys (e.g. `[Symbol.iterator]: fn`)
 * resolve to '' (no resolvable name), mirroring the method_definition branch.
 */
function resolveObjectLiteralKeyName(keyNode: TreeSitterNode): string {
  return keyNode.type === 'string'
    ? keyNode.text.replace(/^['"]|['"]$/g, '')
    : keyNode.type === 'computed_property_name'
      ? resolveComputedKeyName(keyNode)
      : keyNode.text;
}

/**
 * Phase 8.3f: extract function/arrow function properties from an object literal as standalone
 * definitions so that `this.method()` calls inside Object.defineProperty accessor functions can
 * resolve them via the same-file definition lookup.
 *
 * Definitions are emitted as qualified names (`obj.baz` rather than bare `baz`) to avoid
 * polluting the global definition index with common property names like `init`, `run`, or
 * `render`. The typeMap value stored by the caller also uses the qualified name so the resolver
 * looks up `lookup.byName('obj.baz')` rather than `lookup.byName('baz')`.
 *
 * `const obj = { baz: () => {} }` → emits Definition { name: 'obj.baz', kind: 'function' }
 *
 * For `method_definition` children (shorthand methods), also emits the bare, unqualified
 * `Definition { name: 'baz', kind: 'method' }` that the generic method_definition handlers
 * (handleMethodCapture, handleMethodDef) would otherwise produce on their own — see
 * `isObjectLiteralDeclaratorMethod`, which skips them for exactly these nodes so both entries
 * are always emitted here together, in a fixed relative order (bare first). Keeping them
 * adjacent (rather than one inline and one from a separate pass) is what keeps native and WASM
 * agreeing on `definitions` array order (#1818).
 */
function extractObjectLiteralFunctions(
  objNode: TreeSitterNode,
  varName: string,
  definitions: Definition[],
): void {
  for (let i = 0; i < objNode.childCount; i++) {
    const child = objNode.child(i);
    if (!child) continue;
    if (child.type === 'pair') {
      const keyNode = child.childForFieldName('key');
      const valueNode = child.childForFieldName('value');
      if (!keyNode || !valueNode) continue;
      const keyName = resolveObjectLiteralKeyName(keyNode);
      if (!keyName) continue;
      if (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression' ||
        valueNode.type === 'function'
      ) {
        definitions.push({
          name: `${varName}.${keyName}`,
          kind: 'function',
          line: nodeStartLine(child),
          endLine: nodeEndLine(valueNode),
        });
      }
    } else if (child.type === 'method_definition') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        // Non-string computed keys (e.g. `[Symbol.iterator]`) resolve to '' and are skipped.
        const methodName = resolveMethodDefinitionName(nameNode);
        if (!methodName) continue;
        // Bare entry first (when the generic handlers would have produced one — see
        // isObjectLiteralDeclaratorMethod) — matches the tie-break generic
        // call-attribution (findCaller) relies on for equal-span duplicates: the first
        // entry wins, so the bare method (not the qualified one) is picked as the call
        // target. When there's an enclosing class, the generic handlers already push a
        // class-qualified entry on their own; skip here to avoid a duplicate.
        if (isObjectLiteralDeclaratorMethod(child)) {
          definitions.push(buildMethodDefinition(child, methodName));
        }
        definitions.push({
          name: `${varName}.${methodName}`,
          kind: 'function',
          line: nodeStartLine(child),
          endLine: nodeEndLine(child),
        });
      }
    }
  }
}

function handleEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const enumChildren: SubDeclaration[] = [];
  const body = node.childForFieldName('body') || findChild(node, 'enum_body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const member = body.child(i);
      if (!member) continue;
      if (member.type === 'enum_assignment' || member.type === 'property_identifier') {
        const mName = member.childForFieldName('name') || member.child(0);
        if (mName) {
          enumChildren.push({
            name: mName.text,
            kind: 'constant',
            line: nodeStartLine(member),
          });
        }
      }
    }
  }
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: enumChildren.length > 0 ? enumChildren : undefined,
  });
}

function handleCallExpr(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  callbackParamShapes: CallbackParamShapes,
): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'import') {
    handleDynamicImportCall(node, ctx.imports);
  } else {
    // this() calls: `this` used as a function (not as a receiver).
    if (fn.type === 'this') {
      ctx.calls.push({ name: 'this', line: nodeStartLine(node) });
      return; // no further processing needed for this()-style calls
    }
    const callInfo = extractCallInfo(fn, node, ctx.arrayElemBindings);
    if (callInfo) ctx.calls.push(callInfo);
    if (fn.type === 'member_expression') {
      const cbDef = extractCallbackDefinition(node, fn);
      if (cbDef) ctx.definitions.push(cbDef);
      // this-call bindings: `fn.call(namedCtx, ...)` / `fn.apply(namedCtx, ...)`
      const obj = fn.childForFieldName('object');
      const prop = fn.childForFieldName('property');
      if (
        obj?.type === 'identifier' &&
        prop &&
        (prop.text === 'call' || prop.text === 'apply') &&
        !BUILTIN_GLOBALS.has(obj.text)
      ) {
        const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
        if (args) {
          for (let i = 0; i < args.childCount; i++) {
            const child = args.child(i);
            if (!child) continue;
            const t = child.type;
            if (t === '(' || t === ')' || t === ',') continue;
            if (
              t === 'identifier' &&
              !BUILTIN_GLOBALS.has(child.text) &&
              child.text !== 'undefined' &&
              child.text !== 'null'
            ) {
              ctx.thisCallBindings!.push({ callee: obj.text, thisArg: child.text });
            }
            break;
          }
        }
      }
    }
    ctx.calls.push(...extractCallbackReferenceCalls(node, callbackParamShapes));
  }
}

function handleNewExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const ctor = node.childForFieldName('constructor') || node.child(1);
  if (!ctor) return;
  if (ctor.type === 'identifier') {
    if (ctor.text === 'Function') {
      // new Function(body) — dynamic code execution; undecidable static target
      ctx.calls.push({
        name: '<dynamic:eval>',
        line: nodeStartLine(node),
        dynamic: true,
        dynamicKind: 'eval' as DynamicKind,
      });
    } else {
      ctx.calls.push({ name: ctor.text, line: nodeStartLine(node) });
    }
  } else if (ctor.type === 'member_expression') {
    const callInfo = extractCallInfo(ctor, node);
    if (callInfo) ctx.calls.push(callInfo);
  }
}

/**
 * Handle a TypeScript/JS decorator node.
 *
 * Only handles bare-identifier and bare-member-expression decorators
 * (`@Foo`, `@Foo.bar`) since decorated call expressions (`@Foo()`, `@Foo.bar()`)
 * are already visited as `call_expression` children by the recursive walker.
 */
function handleDecorator(node: TreeSitterNode, calls: Call[]): void {
  // Decorators wrap their expression; find the first non-@ child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type === '@') continue;
    const t = child.type;
    if (t === 'identifier') {
      // @Foo — the identifier is the decorator factory; emit as reflection call
      calls.push({
        name: child.text,
        line: nodeStartLine(node),
        dynamic: true,
        dynamicKind: 'reflection',
      });
    } else if (t === 'member_expression') {
      // @Foo.bar — emit as reflection; always mark dynamic since it's decorator dispatch
      const callInfo = extractCallInfo(child, node);
      if (callInfo) calls.push({ ...callInfo, dynamic: true, dynamicKind: 'reflection' });
    }
    // call_expression / other — handled by the recursive walker automatically
    break;
  }
}

/** Handle a dynamic import() call expression and add to imports if static. */
function handleDynamicImportCall(node: TreeSitterNode, imports: Import[]): void {
  const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
  if (!args) return;
  const strArg = findChild(args, 'string');
  if (strArg) {
    const modPath = strArg.text.replace(/['"]/g, '');
    const renamedImports: Array<{ local: string; imported: string }> = [];
    const names = extractDynamicImportNames(node, renamedImports);
    imports.push({
      source: modPath,
      names,
      line: nodeStartLine(node),
      dynamicImport: true,
      ...(renamedImports.length > 0 ? { renamedImports } : {}),
    });
  } else {
    debug(
      `Skipping non-static dynamic import() at line ${nodeStartLine(node)} (template literal or variable)`,
    );
  }
}

function handleImportStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isTypeOnly = node.text.startsWith('import type');
  const source = node.childForFieldName('source') || findChild(node, 'string');
  if (source) {
    const modPath = source.text.replace(/['"]/g, '');
    const renamedImports: Array<{ local: string; imported: string }> = [];
    const typeOnlyNames: string[] = [];
    const names = extractImportNames(node, renamedImports, typeOnlyNames);
    ctx.imports.push({
      source: modPath,
      names,
      line: nodeStartLine(node),
      typeOnly: isTypeOnly,
      ...(renamedImports.length > 0 ? { renamedImports } : {}),
      ...(typeOnlyNames.length > 0 ? { typeOnlyNames } : {}),
    });
  }
}

function handleExportStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const exportLine = nodeStartLine(node);
  const decl = node.childForFieldName('declaration');
  if (decl) collectExportedDeclarations(decl, exportLine, ctx.exports);
  const source = node.childForFieldName('source') || findChild(node, 'string');
  if (source && !decl) {
    const modPath = source.text.replace(/['"]/g, '');
    const reexportRenames: Array<{ local: string; imported: string }> = [];
    const reexportNames = extractImportNames(node, reexportRenames);
    const nodeText = node.text;
    const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
    ctx.imports.push({
      source: modPath,
      names: reexportNames,
      line: exportLine,
      reexport: true,
      wildcardReexport: isWildcard && reexportNames.length === 0,
      ...(reexportRenames.length > 0 ? { renamedImports: reexportRenames } : {}),
    });
  }
}

function handleExpressionStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const expr = node.child(0);
  if (expr && expr.type === 'assignment_expression') {
    const left = expr.childForFieldName('left');
    const right = expr.childForFieldName('right');
    if (left && right) handleCommonJSAssignment(left, right, node, ctx.imports);
  }
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractParameters(node: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode = node.childForFieldName('parameters') || findChild(node, 'formal_parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === 'identifier') {
      params.push({ name: child.text, kind: 'parameter', line: nodeStartLine(child) });
    } else if (
      t === 'required_parameter' ||
      t === 'optional_parameter' ||
      t === 'assignment_pattern'
    ) {
      const nameNode =
        child.childForFieldName('pattern') || child.childForFieldName('left') || child.child(0);
      if (
        nameNode &&
        (nameNode.type === 'identifier' ||
          nameNode.type === 'shorthand_property_identifier_pattern')
      ) {
        params.push({ name: nameNode.text, kind: 'parameter', line: nodeStartLine(child) });
      }
    } else if (t === 'rest_pattern' || t === 'rest_element') {
      const nameNode = child.child(1) || child.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier') {
        params.push({ name: nameNode.text, kind: 'parameter', line: nodeStartLine(child) });
      }
    }
  }
  return params;
}

function extractClassProperties(classNode: TreeSitterNode): SubDeclaration[] {
  const props: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'class_body');
  if (!body) return props;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    if (
      child.type === 'field_definition' ||
      child.type === 'public_field_definition' ||
      child.type === 'property_definition'
    ) {
      const nameNode =
        child.childForFieldName('name') || child.childForFieldName('property') || child.child(0);
      if (
        nameNode &&
        (nameNode.type === 'property_identifier' ||
          nameNode.type === 'identifier' ||
          nameNode.type === 'private_property_identifier')
      ) {
        // Private # fields: nameNode.type is 'private_property_identifier'
        // TS modifiers: accessibility_modifier child on the field_definition
        const vis =
          nameNode.type === 'private_property_identifier' ? 'private' : extractVisibility(child);
        props.push({
          name: nameNode.text,
          kind: 'property',
          line: nodeStartLine(child),
          visibility: vis,
        });
      }
    }
  }
  return props;
}

/**
 * Extract visibility modifier from a class member node.
 * Checks for TS access modifiers (public/private/protected) and JS private (#) fields.
 * Returns 'public' | 'private' | 'protected' | undefined.
 */
function extractVisibility(node: TreeSitterNode): 'public' | 'private' | 'protected' | undefined {
  // Check for TS accessibility modifiers (accessibility_modifier child)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'accessibility_modifier') {
      const text = child.text;
      if (text === 'private' || text === 'protected' || text === 'public') return text;
    }
  }
  // Check for JS private name (# prefix) — try multiple field names
  const nameNode =
    node.childForFieldName('name') || node.childForFieldName('property') || node.child(0);
  if (nameNode && nameNode.type === 'private_property_identifier') {
    return 'private';
  }
  return undefined;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function extractInterfaceMethods(
  bodyNode: TreeSitterNode,
  interfaceName: string,
  definitions: Definition[],
): void {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child) continue;
    if (child.type === 'method_signature' || child.type === 'property_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        definitions.push({
          name: `${interfaceName}.${nameNode.text}`,
          kind: child.type === 'method_signature' ? 'method' : 'property',
          line: nodeStartLine(child),
          endLine: nodeEndLine(child),
          bodyless: !child.childForFieldName('body'),
        });
      }
    }
  }
}

function extractImplements(heritage: TreeSitterNode): string[] {
  const interfaces: string[] = [];
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i);
    if (!child) continue;
    if (child.text === 'implements') {
      for (let j = i + 1; j < heritage.childCount; j++) {
        const next = heritage.child(j);
        if (!next) continue;
        if (next.type === 'identifier') interfaces.push(next.text);
        else if (next.type === 'type_identifier') interfaces.push(next.text);
        if (next.childCount > 0) interfaces.push(...extractImplementsFromNode(next));
      }
      break;
    }
    if (child.type === 'implements_clause') {
      interfaces.push(...extractImplementsFromNode(child));
    }
  }
  return interfaces;
}

function extractImplementsFromNode(node: TreeSitterNode): string[] {
  const result: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'type_identifier') result.push(child.text);
    if (child.childCount > 0) result.push(...extractImplementsFromNode(child));
  }
  return result;
}

// ── Type inference helpers ───────────────────────────────────────────────

function extractSimpleTypeName(typeAnnotationNode: TreeSitterNode): string | null {
  if (!typeAnnotationNode) return null;
  for (let i = 0; i < typeAnnotationNode.childCount; i++) {
    const child = typeAnnotationNode.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === 'type_identifier' || t === 'identifier') return child.text;
    if (t === 'generic_type') return child.child(0)?.text || null;
    if (t === 'parenthesized_type') return extractSimpleTypeName(child);
    // Skip union, intersection, and array types — too ambiguous
  }
  return null;
}

function extractNewExprTypeName(newExprNode: TreeSitterNode): string | null {
  if (newExprNode?.type !== 'new_expression') return null;
  const ctor = newExprNode.childForFieldName('constructor') || newExprNode.child(1);
  if (!ctor) return null;
  if (ctor.type === 'identifier') return ctor.text;
  if (ctor.type === 'member_expression') {
    const prop = ctor.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

// ── Phase 8.2: Inter-Procedural Return Type Propagation ─────────────────────

/**
 * Walk the AST and record the return type of every function/method definition.
 *
 * Keys: plain name (e.g. "createUser") or "ClassName.methodName" for methods.
 * Confidence:
 *   - 1.0: explicit TypeScript return type annotation
 *   - 0.85: inferred from the first `return new Constructor()` in the body
 */
function extractReturnTypeMapWalk(
  rootNode: TreeSitterNode,
  returnTypeMap: Map<string, TypeMapEntry>,
): void {
  function walk(node: TreeSitterNode, depth: number, currentClass: string | null): void {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;

    if (t === 'class_declaration' || t === 'abstract_class_declaration' || t === 'class') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode?.text ?? null;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, depth + 1, className);
      }
      return;
    }

    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'identifier' && nameNode.text !== 'constructor') {
        const fnName = currentClass ? `${currentClass}.${nameNode.text}` : nameNode.text;
        storeReturnType(node, fnName, returnTypeMap);
      }
      // Recurse into the function body with null currentClass so nested
      // function declarations are not stored under the enclosing class name.
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, depth + 1, null);
      }
      return;
    } else if (t === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode && currentClass && nameNode.text !== 'constructor') {
        storeReturnType(node, `${currentClass}.${nameNode.text}`, returnTypeMap);
      }
      // Recurse into the method body with null currentClass so nested
      // function declarations are not stored under the enclosing class name.
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, depth + 1, null);
      }
      return;
    } else if (t === 'variable_declarator') {
      // const foo = (): ReturnType => …  or  const foo = function(): ReturnType { … }
      const nameN = node.childForFieldName('name');
      const valueN = node.childForFieldName('value');
      if (nameN?.type === 'identifier' && valueN) {
        const vt = valueN.type;
        if (
          vt === 'arrow_function' ||
          vt === 'function_expression' ||
          vt === 'generator_function'
        ) {
          const fnName = currentClass ? `${currentClass}.${nameN.text}` : nameN.text;
          storeReturnType(valueN, fnName, returnTypeMap);
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1, currentClass);
    }
  }
  walk(rootNode, 0, null);
}

/** Extract the return type of a function node and store it in the returnTypeMap. */
function storeReturnType(
  fnNode: TreeSitterNode,
  fnName: string,
  returnTypeMap: Map<string, TypeMapEntry>,
): void {
  const returnTypeNode = fnNode.childForFieldName('return_type');
  if (returnTypeNode) {
    const typeName = extractSimpleTypeName(returnTypeNode);
    if (typeName) {
      const existing = returnTypeMap.get(fnName);
      if (!existing || existing.confidence < 1.0)
        returnTypeMap.set(fnName, { type: typeName, confidence: 1.0 });
      return;
    }
  }
  // Infer from first `return new Constructor()` in the function body
  const body = fnNode.childForFieldName('body');
  if (body) {
    const inferred = findReturnNewExprType(body);
    if (inferred) {
      const existing = returnTypeMap.get(fnName);
      if (!existing || INFERRED_RETURN_TYPE_CONFIDENCE > existing.confidence)
        returnTypeMap.set(fnName, { type: inferred, confidence: INFERRED_RETURN_TYPE_CONFIDENCE });
    }
  }
}

/** Return the constructor name from the first `return new Constructor()` in a body, or null. */
function findReturnNewExprType(bodyNode: TreeSitterNode): string | null {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (child?.type !== 'return_statement') continue;
    for (let j = 0; j < child.childCount; j++) {
      const expr = child.child(j);
      if (expr?.type === 'new_expression') return extractNewExprTypeName(expr);
    }
  }
  return null;
}

/**
 * Resolve the return type of a call_expression node using returnTypeMap.
 * Handles: createUser() (identifier), service.getRepo() (member), and
 * getService().getRepo() (chained call) up to MAX_PROPAGATION_DEPTH hops.
 *
 * `depth` tracks total chain hops consumed so far.  Each call boundary — both
 * resolving the receiver and resolving the final return type — costs one hop.
 * Confidence = annotated return type confidence − 0.1 × (depth + 1).
 *
 * Examples (annotated sources → confidence 1.0):
 *   createUser()          depth=0 → 1.0 − 0.1 = 0.9 (1 hop)
 *   svc.getUser()         depth=0 → 1.0 − 0.1 = 0.9 (1 hop; receiver from typeMap)
 *   getService().getRepo() depth=0 → inner resolved at depth=1, outer at depth+1 → 0.8 (2 hops)
 */
function resolveCallExprReturnType(
  callNode: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  returnTypeMap: Map<string, TypeMapEntry>,
  depth: number,
): TypeMapEntry | null {
  if (depth >= MAX_PROPAGATION_DEPTH) return null;

  const fn = callNode.childForFieldName('function');
  if (!fn) return null;

  if (fn.type === 'identifier') {
    const entry = returnTypeMap.get(fn.text);
    if (!entry) return null;
    const confidence = entry.confidence - PROPAGATION_HOP_PENALTY * (depth + 1);
    return confidence > 0 ? { type: entry.type, confidence } : null;
  }

  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!obj || !prop) return null;

    let receiverType: string | null = null;
    // effectiveDepth tracks the depth at which THIS call's return type is charged.
    // When the receiver is itself a call expression (chain), we've already consumed
    // a hop resolving it, so charge this call at depth+1.
    let effectiveDepth = depth;

    if (obj.type === 'identifier') {
      const typeEntry = typeMap.get(obj.text);
      receiverType = typeEntry ? typeEntry.type : null;
    } else if (obj.type === 'call_expression') {
      // Each link in a call chain costs an extra hop.
      const innerResult = resolveCallExprReturnType(obj, typeMap, returnTypeMap, depth + 1);
      receiverType = innerResult ? innerResult.type : null;
      effectiveDepth = depth + 1;
    }

    if (receiverType) {
      const entry = returnTypeMap.get(`${receiverType}.${prop.text}`);
      if (entry) {
        const confidence = entry.confidence - PROPAGATION_HOP_PENALTY * (effectiveDepth + 1);
        return confidence > 0 ? { type: entry.type, confidence } : null;
      }
    }
  }

  return null;
}

/**
 * Record a call assignment into callAssignments for cross-file propagation.
 * Only records cases where the callee is a simple identifier or a method call
 * on a known-typed variable — chain expressions are skipped (handled locally).
 */
function recordCallAssignment(
  callNode: TreeSitterNode,
  varName: string,
  typeMap: Map<string, TypeMapEntry>,
  callAssignments: CallAssignment[],
): void {
  const fn = callNode.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    callAssignments.push({ varName, calleeName: fn.text });
  } else if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (obj?.type === 'identifier' && prop) {
      const receiverEntry = typeMap.get(obj.text);
      callAssignments.push({
        varName,
        calleeName: prop.text,
        receiverTypeName: receiverEntry?.type,
      });
    }
  }
}

/**
 * Phase 8.5 (RTA): collect all constructor names from `new X()` expressions
 * in the file. Captures both assigned (`const x = new Foo()`) and unassigned
 * (`doSomething(new Foo())`) usages that the typeMap-based approach would miss.
 */
// `new X()` constructor-name collection (Phase 8.5 RTA instantiation tracking)
// happens inline in runCollectorWalk's new_expression case.

/**
 * Walk the AST to find `Object.defineProperty(obj, "bar", { get: getter })` patterns
 * and record which functions are used as getter/setter accessors for which objects.
 *
 * Result is stored in the provided map as `funcName → receiverVarName`.
 */
function collectDefinePropertyReceiver(node: TreeSitterNode, out: Map<string, string>): void {
  const fn = node.childForFieldName('function');
  // Match `Object.defineProperty`
  if (fn?.type !== 'member_expression') return;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (obj?.type !== 'identifier' || obj.text !== 'Object' || prop?.text !== 'defineProperty') {
    return;
  }
  const argsNode = node.childForFieldName('arguments') ?? findChild(node, 'arguments');
  if (!argsNode) return;
  // Collect non-punctuation children: arg0 (target obj), arg1 (prop name string), arg2 (descriptor)
  const argChildren: TreeSitterNode[] = [];
  for (let i = 0; i < argsNode.childCount; i++) {
    const c = argsNode.child(i);
    if (!c) continue;
    if (c.type === ',' || c.type === '(' || c.type === ')') continue;
    argChildren.push(c);
  }
  if (argChildren.length < 3) return;
  const targetObj = argChildren[0];
  const descriptor = argChildren[2];
  if (targetObj?.type !== 'identifier' || descriptor?.type !== 'object') return;
  const targetName = targetObj.text;
  // Walk the descriptor object's pair children looking for get/set
  for (let i = 0; i < descriptor.childCount; i++) {
    const pair = descriptor.child(i);
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const val = pair.childForFieldName('value');
    if (
      key &&
      (key.text === 'get' || key.text === 'set') &&
      val?.type === 'identifier' &&
      !BUILTIN_GLOBALS.has(val.text)
    ) {
      // Known limitation: if the same function is registered as an
      // accessor on multiple objects, last-write-wins — only the
      // last target object is retained. This is an unusual pattern
      // (sharing one function across multiple defineProperty calls)
      // and covering it would require Map<string, string[]> which
      // changes the consumer API. Tracked as a known edge case.
      out.set(val.text, targetName);
    }
  }
}

/** Outputs for {@link runContextCollectorWalk}. */
interface ContextCollectorOutputs {
  typeMap: Map<string, TypeMapEntry>;
  returnTypeMap?: Map<string, TypeMapEntry>;
  callAssignments?: CallAssignment[];
  fnRefBindings: FnRefBinding[];
  objectRestParamBindings: ObjectRestParamBinding[];
  spreadArgBindings: SpreadArgBinding[];
  forOfBindings: ForOfBinding[];
  arrayCallbackBindings: ArrayCallbackBinding[];
}

/**
 * Single context-tracking pass combining what were three separate full-tree
 * walks (typeMap, object-rest params, spread/for-of) — see runCollectorWalk
 * for why traversal count dominates extraction cost on WASM trees.
 *
 * Each concern keeps its own enclosing-class register because their reset
 * rules intentionally differ:
 *
 * - typeMap (`typeMapClass`): extracts variable-to-type assignments.
 *   Values are `{ type: string, confidence: number }`:
 *     - 1.0: explicit constructor (`new Foo()`)
 *     - 0.9: type annotation (`: Foo`) or typed parameter
 *     - 0.85: property write (`obj.prop = fn` — Phase 8.3d pts tracking)
 *     - 0.7–0.9: inter-procedural propagation from return-type map (Phase 8.2)
 *     - 0.7: factory method call (`Foo.create()` — uppercase-first heuristic)
 *   Higher-confidence entries take priority when the same variable is seen
 *   twice. Class declarations propagate their name into the subtree; class
 *   *expressions* (`const Foo = class Bar { … }`) propagate null because the
 *   expression-internal name is never visible to the resolver, preserving the
 *   `this.prop` fallback in resolveByMethodOrGlobal. No reset at function
 *   boundaries.
 *
 * - object-rest params (`objectRestClass`, Phase 8.3f): context flows only
 *   class_declaration/class → class_body → method_definition so methods are
 *   keyed "ClassName.method"; every other node type resets to null, and
 *   function/method bodies recurse with null so nested declarations don't
 *   inherit the class context.
 *
 * - spread/for-of (`funcStack`/`classStack`, Phase 8.3e): tracks the
 *   enclosing *function* (not just class) via push/pop so for-of bindings
 *   record the qualified enclosing callable (e.g. 'Foo.bar', 'obj.method',
 *   or '<module>' at top level).
 *
 * NOTE: returnTypeMap population stays a separate, earlier pass
 * (extractReturnTypeMapWalk) — handleVarDeclaratorTypeMap reads it for
 * inter-procedural propagation, so it must be complete for the whole file
 * before any declarator is processed (a function declared *after* its first
 * use would otherwise be missed).
 */
/**
 * Push node onto classStack when it's a named class declaration/expression, for
 * method_definition qualification below. Returns whether a push happened.
 * The `identifier`-only check keeps the original walk's behaviour (TS class names
 * parse as type_identifier and were never pushed), while typeMapClass/objectRestClass
 * elsewhere use the bare text like their original walks did.
 */
function pushClassContext(
  classStack: string[],
  className: string | null,
  classNameIsIdentifier: boolean,
): boolean {
  if (className && classNameIsIdentifier) {
    classStack.push(className);
    return true;
  }
  return false;
}

/** Push node onto funcStack when it's a named function_declaration/generator_function_declaration. */
function pushFnDeclContext(funcStack: string[], node: TreeSitterNode): boolean {
  const nameNode = node.childForFieldName('name');
  if (nameNode?.type === 'identifier') {
    funcStack.push(nameNode.text);
    return true;
  }
  return false;
}

/**
 * Unwrap a `computed_property_name` node (e.g. `['foo']`) to its inner string-literal text
 * with quotes stripped, or '' when the computed key isn't a plain string literal (e.g.
 * `[Symbol.iterator]`, `[x]`) — there's no statically resolvable name in that case.
 */
function resolveComputedKeyName(nameNode: TreeSitterNode): string {
  const inner = nameNode.child(1);
  if (!inner || (inner.type !== 'string' && inner.type !== 'string_fragment')) {
    // Non-string computed key — no resolvable name.
    return '';
  }
  return inner.text.replace(/^['"]|['"]$/g, '');
}

/**
 * Resolve the raw method name from a method_definition's name field, unwrapping
 * computed_property_name string literals (e.g. `['foo']() {}` -> 'foo'). Returns ''
 * for non-string computed keys (no resolvable name).
 */
function resolveMethodDefinitionName(nameNode: TreeSitterNode): string {
  if (nameNode.type !== 'computed_property_name') return nameNode.text;
  return resolveComputedKeyName(nameNode);
}

/**
 * Resolve an object-literal `pair` node's key field to its plain string form.
 *
 * Mirrors resolveMethodDefinitionName's computed-key handling so `{ ['foo']: () => {} }` and
 * `{ ['foo']() {} }` resolve identically: quoted string keys have their quotes stripped,
 * computed string-literal keys (`['foo']`) are unwrapped, and non-string computed keys
 * (e.g. `[Symbol.iterator]`) return '' (no resolvable name — caller skips the pair) rather
 * than falling back to the raw bracket/quote source text.
 */
function resolvePairKeyName(keyNode: TreeSitterNode): string {
  if (keyNode.type === 'string') return keyNode.text.replace(/^['"]|['"]$/g, '');
  if (keyNode.type === 'computed_property_name') return resolveComputedKeyName(keyNode);
  return keyNode.text;
}

/**
 * Push node onto funcStack for a method_definition, qualified with the enclosing class
 * name so the PTS key matches callerName from findCaller (which uses
 * def.name = 'ClassName.method').
 */
function pushMethodDefContext(
  classStack: string[],
  funcStack: string[],
  node: TreeSitterNode,
): boolean {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return false;
  const enclosingClass = classStack.length > 0 ? classStack[classStack.length - 1] : null;
  const rawName = resolveMethodDefinitionName(nameNode);
  if (!rawName) return false;
  const qualifiedName = enclosingClass ? `${enclosingClass}.${rawName}` : rawName;
  funcStack.push(qualifiedName);
  return true;
}

/**
 * Push node onto funcStack for `const process = (arr) => { ... }` — arrow/expression
 * functions assigned to a variable have no `name` field on the function node itself.
 */
function pushArrowVarContext(funcStack: string[], node: TreeSitterNode): boolean {
  const nameNode = node.childForFieldName('name');
  const valueNode = node.childForFieldName('value');
  if (
    nameNode?.type === 'identifier' &&
    (valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression')
  ) {
    funcStack.push(nameNode.text);
    return true;
  }
  return false;
}

/**
 * Push node onto funcStack for `obj.method = function() { ... }` func-prop assignment.
 * Mirrors handleFuncPropAssignment's logic so for-of loops inside the body get the
 * correct enclosingFunc (e.g. 'obj.method') instead of '<module>' or the wrong outer
 * function name.
 */
function pushFuncPropContext(funcStack: string[], node: TreeSitterNode): boolean {
  const lhs = node.childForFieldName('left');
  const rhs = node.childForFieldName('right');
  if (
    lhs?.type === 'member_expression' &&
    (rhs?.type === 'function_expression' || rhs?.type === 'arrow_function')
  ) {
    const obj = lhs.childForFieldName('object');
    const prop = lhs.childForFieldName('property');
    if (
      obj?.type === 'identifier' &&
      (prop?.type === 'property_identifier' || prop?.type === 'identifier') &&
      !BUILTIN_GLOBALS.has(obj.text) &&
      prop.text !== 'prototype'
    ) {
      funcStack.push(`${obj.text}.${prop.text}`);
      return true;
    }
  }
  return false;
}

/**
 * Compute the class name (and whether it's a plain identifier) for a class_declaration/
 * class-expression node — read once, shared by pushClassContext and computeChildContext.
 * Returns nulls/false for any other node type.
 */
function computeClassNameContext(
  node: TreeSitterNode,
  isClassDecl: boolean,
  isClassExpr: boolean,
): { className: string | null; classNameIsIdentifier: boolean } {
  if (!isClassDecl && !isClassExpr) return { className: null, classNameIsIdentifier: false };
  const nameNode = node.childForFieldName('name');
  return {
    className: nameNode?.text ?? null,
    classNameIsIdentifier: nameNode?.type === 'identifier',
  };
}

/**
 * Dispatch the enclosing-context stack push for a node to the handler matching its type.
 * Returns which stack (if any) was pushed, so the caller can pop the matching stack
 * after visiting children.
 */
function pushEnclosingContext(
  node: TreeSitterNode,
  t: string,
  isClassDecl: boolean,
  isClassExpr: boolean,
  isFnDecl: boolean,
  className: string | null,
  classNameIsIdentifier: boolean,
  classStack: string[],
  funcStack: string[],
): { pushedFunc: boolean; pushedClass: boolean } {
  if (isClassDecl || isClassExpr) {
    return {
      pushedFunc: false,
      pushedClass: pushClassContext(classStack, className, classNameIsIdentifier),
    };
  }
  if (isFnDecl) {
    return { pushedFunc: pushFnDeclContext(funcStack, node), pushedClass: false };
  }
  if (t === 'method_definition') {
    return { pushedFunc: pushMethodDefContext(classStack, funcStack, node), pushedClass: false };
  }
  if (t === 'variable_declarator') {
    return { pushedFunc: pushArrowVarContext(funcStack, node), pushedClass: false };
  }
  if (t === 'assignment_expression') {
    return { pushedFunc: pushFuncPropContext(funcStack, node), pushedClass: false };
  }
  return { pushedFunc: false, pushedClass: false };
}

/**
 * Run the per-node-type collectors (typeMap/binding extraction) for a single node during
 * runContextCollectorWalk's traversal, mirroring the query-based path's capture-handler
 * pattern (handleFnCapture, etc.) already used elsewhere in this file.
 */
function dispatchNodeCollectors(
  node: TreeSitterNode,
  t: string,
  typeMapClass: string | null,
  objectRestClass: string | null,
  funcStack: string[],
  out: ContextCollectorOutputs,
): void {
  if (t === 'variable_declarator') {
    handleVarDeclaratorTypeMap(
      node,
      out.typeMap,
      out.returnTypeMap,
      out.callAssignments,
      out.fnRefBindings,
    );
    collectCollectionWrapBinding(node, out.fnRefBindings);
  } else if (t === 'required_parameter' || t === 'optional_parameter') {
    handleParamTypeMap(node, out.typeMap);
  } else if (t === 'public_field_definition' || t === 'field_definition') {
    handleFieldDefTypeMap(node, out.typeMap, typeMapClass);
  } else if (t === 'assignment_expression') {
    handlePropWriteTypeMap(node, out.typeMap, typeMapClass);
  } else if (t === 'call_expression') {
    handleDefinePropertyTypeMap(node, out.typeMap);
    collectSpreadAndArrayFromBindings(node, out.spreadArgBindings, out.arrayCallbackBindings);
  } else if (t === 'for_in_statement') {
    const enclosingFunc = funcStack.length > 0 ? funcStack[funcStack.length - 1]! : '<module>';
    collectForOfBinding(node, enclosingFunc, out.forOfBindings);
  }
  collectObjectRestParams(node, t, objectRestClass, out.objectRestParamBindings);
}

/**
 * Compute the typeMapClass/objectRestClass context to thread into this node's children —
 * each concern keeps its own reset rules (see runContextCollectorWalk's doc comment).
 */
function computeChildContext(
  t: string,
  isClassDecl: boolean,
  isClassExpr: boolean,
  className: string | null,
  typeMapClass: string | null,
  objectRestClass: string | null,
): { childTypeMapClass: string | null; childObjectRestClass: string | null } {
  const childTypeMapClass = isClassDecl ? className : isClassExpr ? null : typeMapClass;
  let childObjectRestClass: string | null = null;
  if (t === 'class_declaration' || t === 'class') {
    childObjectRestClass = className;
  } else if (t === 'class_body') {
    childObjectRestClass = objectRestClass;
  }
  return { childTypeMapClass, childObjectRestClass };
}

function runContextCollectorWalk(rootNode: TreeSitterNode, out: ContextCollectorOutputs): void {
  const funcStack: string[] = [];
  const classStack: string[] = [];

  const walk = (
    node: TreeSitterNode,
    depth: number,
    typeMapClass: string | null,
    objectRestClass: string | null,
  ): void => {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;

    const isClassDecl = t === 'class_declaration' || t === 'abstract_class_declaration';
    const isClassExpr = t === 'class';
    const isFnDecl = t === 'function_declaration' || t === 'generator_function_declaration';

    const { className, classNameIsIdentifier } = computeClassNameContext(
      node,
      isClassDecl,
      isClassExpr,
    );

    // ── spread/for-of enclosing-context stacks (push on enter, pop after children) ──
    const { pushedFunc, pushedClass } = pushEnclosingContext(
      node,
      t,
      isClassDecl,
      isClassExpr,
      isFnDecl,
      className,
      classNameIsIdentifier,
      classStack,
      funcStack,
    );

    // ── per-node collectors (class nodes match none of these types) ──
    dispatchNodeCollectors(node, t, typeMapClass, objectRestClass, funcStack, out);

    // ── child context per concern ──
    const { childTypeMapClass, childObjectRestClass } = computeChildContext(
      t,
      isClassDecl,
      isClassExpr,
      className,
      typeMapClass,
      objectRestClass,
    );

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1, childTypeMapClass, childObjectRestClass);
    }

    if (pushedFunc) funcStack.pop();
    if (pushedClass) classStack.pop();
  };

  walk(rootNode, 0, null, null);
}

/**
 * Record function-reference bindings from a variable_declarator's value node.
 *
 * Captures three patterns (Phase 8.3):
 *   - `const fn = handler`          (identifier alias)
 *   - `const fn = obj.method`       (member_expression alias)
 *   - `const f = fn.bind(ctx)`      (bind creates a bound alias)
 *
 * Must be called before any type-analysis early returns so every declarator
 * contributes to fnRefBindings regardless of whether it has a type annotation.
 */
function collectFnRefBindings(
  lhsName: string,
  valueN: TreeSitterNode,
  fnRefBindings: FnRefBinding[],
): void {
  if (valueN.type === 'identifier' && !BUILTIN_GLOBALS.has(valueN.text)) {
    fnRefBindings.push({ lhs: lhsName, rhs: valueN.text });
    return;
  }
  if (valueN.type === 'member_expression') {
    const prop = valueN.childForFieldName('property');
    const obj = valueN.childForFieldName('object');
    // Guard: only static property access (property_identifier or identifier), not
    // computed subscript expressions like obj[expr] where prop.text would be the
    // full expression rather than a simple name — those can never match pts keys.
    if (
      prop &&
      (prop.type === 'property_identifier' || prop.type === 'identifier') &&
      obj?.type === 'identifier' &&
      !BUILTIN_GLOBALS.has(obj.text)
    ) {
      fnRefBindings.push({ lhs: lhsName, rhs: prop.text, rhsReceiver: obj.text });
    }
    return;
  }
  if (valueN.type === 'call_expression') {
    // `const f = fn.bind(ctx)` — bind returns a bound copy of fn; track f → fn so
    // pts(f) ⊇ pts(fn) and subsequent `f(args)` calls resolve to fn.
    // Note: only flat-identifier binds (fn.bind) are tracked here; method-receiver
    // binds like `obj.method.bind(ctx)` are not captured (boundFn must be an identifier).
    const callFn = valueN.childForFieldName('function');
    if (callFn?.type === 'member_expression') {
      const bindProp = callFn.childForFieldName('property');
      if (bindProp?.text === 'bind') {
        const boundFn = callFn.childForFieldName('object');
        if (boundFn?.type === 'identifier' && !BUILTIN_GLOBALS.has(boundFn.text)) {
          fnRefBindings.push({ lhs: lhsName, rhs: boundFn.text });
        }
      }
    }
  }
}

/**
 * Handle the `call_expression` branch of variable_declarator type-map seeding.
 *
 * Processes three sub-cases in priority order:
 *   1. Object.create({ ... }) — seeds composite pts keys from the prototype object (Phase 8.3e)
 *   2. Inter-procedural return-type propagation via returnTypeMap (Phase 8.2)
 *   3. Factory method heuristic: `const x = Foo.create()` → type Foo at confidence 0.7
 */
function handleCallExprTypeMap(
  lhsName: string,
  valueN: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  returnTypeMap: Map<string, TypeMapEntry> | undefined,
  callAssignments: CallAssignment[] | undefined,
): void {
  const createFn = valueN.childForFieldName('function');
  // Phase 8.3e: Object.create({ f1, f2 }) — seed composite pts keys obj.f1 → f1, etc.
  if (createFn?.type === 'member_expression') {
    const createObj = createFn.childForFieldName('object');
    const createProp = createFn.childForFieldName('property');
    if (createObj?.text === 'Object' && createProp?.text === 'create') {
      const createArgs = valueN.childForFieldName('arguments') || findChild(valueN, 'arguments');
      if (createArgs) {
        let proto: TreeSitterNode | null = null;
        for (let i = 0; i < createArgs.childCount; i++) {
          const n = createArgs.child(i);
          if (n && n.type !== '(' && n.type !== ')' && n.type !== ',') {
            proto = n;
            break;
          }
        }
        if (proto?.type === 'object') {
          seedProtoProperties(lhsName, proto, typeMap);
        }
      }
      return;
    }
  }
  // Phase 8.2: inter-procedural propagation — try to resolve return type from
  // the local returnTypeMap before falling back to factory heuristics.
  if (returnTypeMap) {
    const result = resolveCallExprReturnType(valueN, typeMap, returnTypeMap, 0);
    if (result) {
      setTypeMapEntry(typeMap, lhsName, result.type, result.confidence);
      return;
    }
  }
  // Record for cross-file resolution in build-edges.ts (imported functions)
  if (callAssignments) {
    recordCallAssignment(valueN, lhsName, typeMap, callAssignments);
  }
  // Factory method heuristic: const x = Foo.create() → type Foo, confidence 0.7
  if (createFn?.type === 'member_expression') {
    const obj = createFn.childForFieldName('object');
    if (obj?.type === 'identifier') {
      const objName = obj.text;
      if (objName[0] && objName[0] !== objName[0].toLowerCase() && !BUILTIN_GLOBALS.has(objName)) {
        setTypeMapEntry(typeMap, lhsName, objName, 0.7);
      }
    }
  }
}

/**
 * Seed composite pts keys from a module-level object literal assignment (Phase 8.3f).
 *
 * `const obj = { baz: () => {} }` → typeMap['obj.baz'] = 'obj.baz'
 * `const obj = { baz }` (shorthand) → typeMap['obj.baz'] = 'baz'  (bare identifier target)
 * `const obj = { baz: otherFn }` → typeMap['obj.baz'] = 'otherFn'  (identifier alias)
 * `const obj = { baz() {} }` (method shorthand) → typeMap['obj.baz'] = 'obj.baz'
 *
 * For function/arrow values, the value is the qualified name ('obj.baz') because
 * extractObjectLiteralFunctions registers definitions under that qualified name to avoid
 * polluting the global index with bare property names like 'init', 'run', or 'render'.
 * Enables accessor this-dispatch: when typeMap['getter:this'] = 'obj',
 * resolving this.baz() inside getter → typeMap['obj.baz'] → 'obj.baz' → lookup.byName('obj.baz').
 *
 * Scope guard: caller must ensure `node` is not inside a function body
 * (mirrors Rust handle_var_decl's find_parent_of_types check — function-scoped
 * `const localObj = { fn: ... }` must not shadow a module-level `const obj`).
 */
function handleObjectLiteralTypeMap(
  lhsName: string,
  valueN: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
): void {
  for (let i = 0; i < valueN.childCount; i++) {
    const child = valueN.child(i);
    if (!child) continue;
    if (child.type === 'shorthand_property_identifier') {
      setTypeMapEntry(typeMap, `${lhsName}.${child.text}`, child.text, 0.85);
    } else if (child.type === 'pair') {
      const keyNode = child.childForFieldName('key');
      const valNode = child.childForFieldName('value');
      if (!keyNode || !valNode) continue;
      const keyName = resolvePairKeyName(keyNode);
      if (!keyName) continue;
      const qualifiedKey = `${lhsName}.${keyName}`;
      if (
        valNode.type === 'arrow_function' ||
        valNode.type === 'function_expression' ||
        valNode.type === 'function'
      ) {
        // Store the qualified name so the resolver finds the qualified definition.
        setTypeMapEntry(typeMap, qualifiedKey, qualifiedKey, 0.85);
      } else if (valNode.type === 'identifier') {
        setTypeMapEntry(typeMap, qualifiedKey, valNode.text, 0.85);
      }
    } else if (child.type === 'method_definition') {
      // Method shorthand: `const obj = { baz() {} }` → typeMap['obj.baz'] = 'obj.baz'
      // extractObjectLiteralFunctions registers a definition under the qualified name;
      // seed the matching typeMap entry so the two-step accessor dispatch finds it.
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const methName = resolveMethodDefinitionName(nameNode);
      if (!methName) continue;
      setTypeMapEntry(typeMap, `${lhsName}.${methName}`, `${lhsName}.${methName}`, 0.85);
    }
  }
}

/**
 * Extract type info from a variable_declarator: type annotation, constructor, or factory.
 *
 * Orchestrates four concerns in priority order:
 *   1. fnRefBindings — always collected first (before any early return)
 *   2. new_expression — constructor wins over annotation (runtime type is authoritative)
 *   3. type_annotation — confidence 0.9 for static analysis
 *   4. call_expression / object literal — delegated to handleCallExprTypeMap /
 *      handleObjectLiteralTypeMap
 */
function handleVarDeclaratorTypeMap(
  node: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  returnTypeMap?: Map<string, TypeMapEntry>,
  callAssignments?: CallAssignment[],
  fnRefBindings?: FnRefBinding[],
): void {
  const nameN = node.childForFieldName('name');
  if (nameN?.type !== 'identifier') return;

  const typeAnno = findChild(node, 'type_annotation');
  const valueN = node.childForFieldName('value');

  // 1. fnRefBindings — must run before any early return so every declarator contributes.
  if (fnRefBindings && valueN) {
    collectFnRefBindings(nameN.text, valueN, fnRefBindings);
  }

  // 2. Constructor wins over annotation: `const x: Base = new Derived()` resolves to Derived.
  if (valueN?.type === 'new_expression') {
    const ctorType = extractNewExprTypeName(valueN);
    if (ctorType) {
      setTypeMapEntry(typeMap, nameN.text, ctorType, 1.0);
      return;
    }
  }

  // 3. Type annotation — confidence 0.9.
  if (typeAnno) {
    const typeName = extractSimpleTypeName(typeAnno);
    if (typeName) {
      setTypeMapEntry(typeMap, nameN.text, typeName, 0.9);
      return;
    }
  }

  if (!valueN) return;
  if (valueN.type === 'new_expression') return;

  // 4a. call_expression — Object.create / return-type propagation / factory heuristic.
  if (valueN.type === 'call_expression') {
    handleCallExprTypeMap(nameN.text, valueN, typeMap, returnTypeMap, callAssignments);
    return;
  }

  // 4b. Object literal — seed composite pts keys for module-level const objects.
  if (valueN.type === 'object' && !hasFunctionScopeAncestor(node)) {
    handleObjectLiteralTypeMap(nameN.text, valueN, typeMap);
  }
}

/** Extract type info from a required_parameter or optional_parameter. */
function handleParamTypeMap(node: TreeSitterNode, typeMap: Map<string, TypeMapEntry>): void {
  const nameNode =
    node.childForFieldName('pattern') || node.childForFieldName('left') || node.child(0);
  if (nameNode?.type !== 'identifier') return;
  const typeAnno = findChild(node, 'type_annotation');
  if (typeAnno) {
    const typeName = extractSimpleTypeName(typeAnno);
    if (typeName) setTypeMapEntry(typeMap, nameNode.text, typeName, 0.9);
  }
}

/**
 * Extract type info from a class field declaration: `private repo: Repository<User>`.
 *
 * Seeds a class-scoped key `ClassName.field` (confidence 0.9) as the primary entry
 * so that two classes with identically-named fields don't overwrite each other's
 * typeMap entry (issue #1458). The resolver's `CallerClass.X` fallback (call-resolver.ts
 * line 110) looks up exactly this key.
 *
 * Bare `field` and `this.field` keys are kept at lower confidence (0.6) as fallbacks
 * for single-class files where the resolver may not have a callerClass context.
 *
 * Mirrors the field_definition branch of match_js_type_map in
 * crates/codegraph-core/src/extractors/javascript.rs.
 */
function handleFieldDefTypeMap(
  node: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  currentClass: string | null,
): void {
  const nameNode =
    node.childForFieldName('name') ||
    node.childForFieldName('property') ||
    findChild(node, 'property_identifier');
  if (!nameNode) return;
  const kind = nameNode.type;
  if (
    kind !== 'property_identifier' &&
    kind !== 'identifier' &&
    kind !== 'private_property_identifier'
  )
    return;
  const typeAnno = findChild(node, 'type_annotation');
  if (!typeAnno) return;
  const typeName = extractSimpleTypeName(typeAnno);
  if (!typeName) return;
  if (currentClass) {
    // Primary: class-scoped key prevents cross-class collision (issue #1458).
    setTypeMapEntry(typeMap, `${currentClass}.${nameNode.text}`, typeName, 0.9);
    // Fallback: bare keys at lower confidence for single-class files or when
    // the resolver does not have a callerClass in scope.
    setTypeMapEntry(typeMap, nameNode.text, typeName, 0.6);
    setTypeMapEntry(typeMap, `this.${nameNode.text}`, typeName, 0.6);
  } else {
    // No enclosing class declaration (e.g. class expression) — use bare keys only.
    setTypeMapEntry(typeMap, nameNode.text, typeName, 0.9);
    setTypeMapEntry(typeMap, `this.${nameNode.text}`, typeName, 0.9);
  }
}

/**
 * Phase 8.3d: seed the pts map from object property writes.
 *
 * `handlers.auth = authMiddleware` → typeMap.set('handlers.auth', { type: 'authMiddleware', confidence: 0.85 })
 * `this.logger = new Logger(...)` → typeMap.set('UserService.logger', { type: 'Logger', confidence: 1.0 })
 *   (keyed as ClassName.prop when currentClass is known, to avoid collisions across classes)
 *
 * Only simple `obj.prop = identifier` and `this.prop = new Ctor()` writes are tracked
 * (not chained `a.b.c = x`). BUILTIN_GLOBALS are skipped (e.g. `console.log = fn`).
 */
function handlePropWriteTypeMap(
  node: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  currentClass: string | null,
): void {
  const lhsN = node.childForFieldName('left');
  const rhsN = node.childForFieldName('right');
  if (!lhsN || !rhsN) return;
  if (lhsN.type !== 'member_expression') return;

  const obj = lhsN.childForFieldName('object');
  const prop = lhsN.childForFieldName('property');
  if (!obj || !prop) return;
  // Guard: only static property access (property_identifier or identifier), not
  // computed subscript expressions — consistent with the adjacent fnRefBindings block.
  if (prop.type !== 'property_identifier' && prop.type !== 'identifier') return;

  // this.prop = new ClassName(...) — constructor-assigned property type.
  // Key as ClassName.prop (class-scoped) so two classes with identically-named
  // properties don't overwrite each other's typeMap entry.
  if (obj.type === 'this' && rhsN.type === 'new_expression') {
    const ctorType = extractNewExprTypeName(rhsN);
    if (ctorType) {
      const key = currentClass ? `${currentClass}.${prop.text}` : `this.${prop.text}`;
      setTypeMapEntry(typeMap, key, ctorType, 1.0);
    }
    return;
  }

  // obj.prop = identifier — existing behaviour (skip chained a.b.c = x and builtins)
  if (rhsN.type !== 'identifier') return;
  if (obj.type !== 'identifier') return;
  const objName = obj.text;
  if (BUILTIN_GLOBALS.has(objName)) return;
  setTypeMapEntry(typeMap, `${objName}.${prop.text}`, rhsN.text, 0.85);
}

/**
 * Phase 8.3e/8.3f: seed composite pts keys from Object.defineProperty / defineProperties.
 *
 * `Object.defineProperty(obj, "key", { value: fn })` → typeMap.set('obj.key', fn, 0.85)
 * `Object.defineProperties(obj, { "k1": { value: v1 } })` → typeMap.set('obj.k1', v1, 0.85)
 * `Object.defineProperty(obj, "key", { get: getter })` → typeMap.set('getter:this', obj, 0.85)
 */
function handleDefinePropertyTypeMap(
  node: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
): void {
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'member_expression') return;
  const fnObj = fn.childForFieldName('object');
  const fnProp = fn.childForFieldName('property');
  if (fnObj?.text !== 'Object') return;
  const method = fnProp?.text;
  if (method !== 'defineProperty' && method !== 'defineProperties') return;

  const argsNode = node.childForFieldName('arguments') || findChild(node, 'arguments');
  if (!argsNode) return;

  const args: TreeSitterNode[] = [];
  for (let i = 0; i < argsNode.childCount; i++) {
    const n = argsNode.child(i);
    if (n && n.type !== '(' && n.type !== ')' && n.type !== ',') args.push(n);
  }

  if (method === 'defineProperty') {
    if (args.length < 3) return;
    const arg0 = args[0]!,
      arg1 = args[1]!,
      arg2 = args[2]!;
    if (arg0.type !== 'identifier') return;
    if (arg1.type !== 'string') return;
    const key = arg1.text.replace(/^['"]|['"]$/g, '');
    if (!key) return;
    // Phase 8.3e: { value: fn } → obj.key pts to fn
    const target = findDescriptorValue(arg2);
    if (target) {
      setTypeMapEntry(typeMap, `${arg0.text}.${key}`, target, 0.85);
    }
    // Phase 8.3f: { get: getter } and/or { set: setter } → this inside each accessor is arg0 (obj)
    // Key format: '<accessorName>:this' — colon is a reserved separator used only by this phase.
    // JS identifiers cannot contain ':', so this key never collides with real variable names.
    for (const accessor of findDescriptorAccessors(arg2)) {
      setTypeMapEntry(typeMap, `${accessor}:this`, arg0.text, 0.85);
    }
  } else {
    // defineProperties
    if (args.length < 2) return;
    const arg0 = args[0]!,
      arg1 = args[1]!;
    if (arg0.type !== 'identifier') return;
    if (arg1.type !== 'object') return;
    for (let i = 0; i < arg1.childCount; i++) {
      const pair = arg1.child(i);
      if (pair?.type !== 'pair') continue;
      const keyN = pair.childForFieldName('key');
      const valN = pair.childForFieldName('value');
      if (!keyN || !valN) continue;
      const key = resolvePairKeyName(keyN);
      if (!key) continue;
      const target = findDescriptorValue(valN);
      if (!target) continue;
      setTypeMapEntry(typeMap, `${arg0.text}.${key}`, target, 0.85);
    }
  }
}

/** Return the identifier text of the `value` field in a property descriptor object. */
function findDescriptorValue(desc: TreeSitterNode): string | undefined {
  if (desc.type !== 'object') return undefined;
  for (let i = 0; i < desc.childCount; i++) {
    const pair = desc.child(i);
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const val = pair.childForFieldName('value');
    if (key?.text === 'value' && val?.type === 'identifier') return val.text;
  }
  return undefined;
}

/**
 * Phase 8.3f: return the identifier texts of all `get` and `set` accessors in a property
 * descriptor. `{ get: getter, set: setter }` → ['getter', 'setter'].
 * Returns all accessors so that each one gets a `callerName:this = obj` typeMap entry.
 */
function findDescriptorAccessors(desc: TreeSitterNode): string[] {
  if (desc.type !== 'object') return [];
  const result: string[] = [];
  for (let i = 0; i < desc.childCount; i++) {
    const pair = desc.child(i);
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const val = pair.childForFieldName('value');
    if ((key?.text === 'get' || key?.text === 'set') && val?.type === 'identifier') {
      result.push(val.text);
    }
  }
  return result;
}

/** Seed composite pts keys for each property in a prototype object literal. */
function seedProtoProperties(
  varName: string,
  proto: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
): void {
  for (let i = 0; i < proto.childCount; i++) {
    const child = proto.child(i);
    if (!child) continue;
    if (child.type === 'shorthand_property_identifier') {
      setTypeMapEntry(typeMap, `${varName}.${child.text}`, child.text, 0.85);
    } else if (child.type === 'pair') {
      const keyN = child.childForFieldName('key');
      const valN = child.childForFieldName('value');
      if (!keyN || !valN || valN.type !== 'identifier') continue;
      const key = resolvePairKeyName(keyN);
      if (!key) continue;
      setTypeMapEntry(typeMap, `${varName}.${key}`, valN.text, 0.85);
    }
  }
}

/**
 * Phase 8.3c: record argument-to-parameter bindings at call sites.
 *
 * For each `f(x, y)` where the callee is a simple identifier and an argument
 * is a simple identifier, emits a ParamBinding so the pts solver can add
 * constraint: pts(param_i_of_f) ⊇ pts(arg_i). The solver uses the
 * definitionParams map to resolve the actual parameter names.
 *
 * Scope: intra-module only (the solver only materialises constraints for
 * locally-defined callees, so cross-module calls produce no spurious flow).
 */
function collectParamBindings(node: TreeSitterNode, paramBindings: ParamBinding[]): void {
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments') ?? findChild(node, 'arguments');
  if (fn?.type === 'identifier' && !BUILTIN_GLOBALS.has(fn.text) && args) {
    let argIdx = 0;
    for (let i = 0; i < args.childCount; i++) {
      const child = args.child(i);
      if (!child) continue;
      const ct = child.type;
      if (ct === ',' || ct === '(' || ct === ')') continue;
      if (ct === 'identifier' && !BUILTIN_GLOBALS.has(child.text)) {
        paramBindings.push({ callee: fn.text, argIndex: argIdx, argName: child.text });
      } else if (ct === 'spread_element') {
        // f(...[a, b]) — inline array literal: expand each element as a direct param binding.
        const inner =
          child.childForFieldName('argument') ?? (child.childCount > 1 ? child.child(1) : null);
        if (inner?.type === 'array') {
          let elemCount = 0;
          for (let j = 0; j < inner.childCount; j++) {
            const elem = inner.child(j);
            if (!elem) continue;
            if (elem.type === ',' || elem.type === '[' || elem.type === ']') continue;
            if (elem.type === 'identifier' && !BUILTIN_GLOBALS.has(elem.text)) {
              paramBindings.push({
                callee: fn.text,
                argIndex: argIdx + elemCount,
                argName: elem.text,
              });
            }
            elemCount++;
          }
          // Advance by the exact number of slots this spread occupies and skip
          // the unconditional argIdx++ below so that zero-element spreads (...[])
          // do not shift subsequent argument indices.
          argIdx += elemCount;
          continue;
        }
      }
      argIdx++;
    }
  }
}

/** Collection constructors whose argument is treated as an element source. */
const COLLECTION_CTOR_SET = new Set(['Set', 'Map']);

/**
 * Phase 8.3e: Extract array-element bindings from `const arr = [fn1, fn2]` patterns.
 * Emits an ArrayElemBinding for each identifier element in an array literal assigned
 * to a variable.
 */
function collectArrayElemBindings(
  node: TreeSitterNode,
  arrayElemBindings: ArrayElemBinding[],
): void {
  const nameN = node.childForFieldName('name');
  const valueN = node.childForFieldName('value');
  if (nameN?.type === 'identifier' && valueN?.type === 'array') {
    let idx = 0;
    for (let i = 0; i < valueN.childCount; i++) {
      const elem = valueN.child(i);
      if (!elem) continue;
      if (elem.type === ',' || elem.type === '[' || elem.type === ']') continue;
      if (elem.type === 'identifier' && !BUILTIN_GLOBALS.has(elem.text)) {
        arrayElemBindings.push({ arrayName: nameN.text, index: idx, elemName: elem.text });
      }
      idx++;
    }
  }
}

/**
 * Phase 8.3e collectors (spread-argument, Array.from, collection-wrap, for-of
 * bindings), invoked from runContextCollectorWalk:
 *
 * - Spread: `f(...arr)` → SpreadArgBinding
 * - Array.from: `Array.from(src, cb)` → ArrayCallbackBinding
 * - Collection wrap: `new Set(arr)` / `new Map(arr)` → FnRefBinding lhs=s[*] rhs=arr[*]
 * - For-of: `for (const x of arr)` → ForOfBinding
 */
function collectSpreadAndArrayFromBindings(
  node: TreeSitterNode,
  spreadArgBindings: SpreadArgBinding[],
  arrayCallbackBindings: ArrayCallbackBinding[],
): void {
  const fn = node.childForFieldName('function');
  const argsNode = node.childForFieldName('arguments') ?? findChild(node, 'arguments');

  // Spread: f(...arr)
  if (fn?.type === 'identifier' && !BUILTIN_GLOBALS.has(fn.text) && argsNode) {
    let argIdx = 0;
    for (let i = 0; i < argsNode.childCount; i++) {
      const child = argsNode.child(i);
      if (!child) continue;
      if (child.type === ',' || child.type === '(' || child.type === ')') continue;
      if (child.type === 'spread_element') {
        const spreadTarget =
          child.childForFieldName('argument') ?? (child.childCount > 1 ? child.child(1) : null);
        if (spreadTarget?.type === 'identifier' && !BUILTIN_GLOBALS.has(spreadTarget.text)) {
          spreadArgBindings.push({
            callee: fn.text,
            arrayName: spreadTarget.text,
            startIndex: argIdx,
          });
        }
      }
      argIdx++;
    }
  }

  // Array.from(source, cb)
  if (fn?.type === 'member_expression' && argsNode) {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (obj?.text === 'Array' && prop?.text === 'from') {
      const fnArgs: TreeSitterNode[] = [];
      for (let i = 0; i < argsNode.childCount; i++) {
        const child = argsNode.child(i);
        if (!child) continue;
        if (child.type === ',' || child.type === '(' || child.type === ')') continue;
        fnArgs.push(child);
      }
      if (fnArgs.length >= 2) {
        const srcArg = fnArgs[0]!;
        const cbArg = fnArgs[1]!;
        if (
          srcArg.type === 'identifier' &&
          !BUILTIN_GLOBALS.has(srcArg.text) &&
          cbArg.type === 'identifier' &&
          !BUILTIN_GLOBALS.has(cbArg.text)
        ) {
          arrayCallbackBindings.push({ sourceName: srcArg.text, calleeName: cbArg.text });
        }
      }
    }
  }
}

/** Collection wrap: `const s = new Set(arr)` or `new Map(arr)` (variable_declarator). */
function collectCollectionWrapBinding(node: TreeSitterNode, fnRefBindings: FnRefBinding[]): void {
  const nameN = node.childForFieldName('name');
  const valueN = node.childForFieldName('value');
  if (nameN?.type === 'identifier' && valueN?.type === 'new_expression') {
    const ctor = valueN.childForFieldName('constructor');
    const args = valueN.childForFieldName('arguments');
    if (ctor && COLLECTION_CTOR_SET.has(ctor.text) && args) {
      for (let i = 0; i < args.childCount; i++) {
        const arg = args.child(i);
        if (!arg || arg.type === '(' || arg.type === ')') continue;
        if (arg.type === 'identifier' && !BUILTIN_GLOBALS.has(arg.text)) {
          fnRefBindings.push({ lhs: `${nameN.text}[*]`, rhs: `${arg.text}[*]` });
          break;
        }
      }
    }
  }
}

/** For-of: `for (const x of arr)` (for_in_statement with an `of` keyword). */
function collectForOfBinding(
  node: TreeSitterNode,
  enclosingFunc: string,
  forOfBindings: ForOfBinding[],
): void {
  let isForOf = false;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.text === 'of') {
      isForOf = true;
      break;
    }
  }
  if (!isForOf) return;
  const right = node.childForFieldName('right');
  if (right?.type !== 'identifier' || BUILTIN_GLOBALS.has(right.text)) return;
  const left = node.childForFieldName('left');
  let varName: string | null = null;
  if (left?.type === 'identifier') {
    varName = left.text;
  } else if (left) {
    for (let i = 0; i < left.childCount; i++) {
      const lc = left.child(i);
      if (lc?.type === 'variable_declarator') {
        const nc = lc.childForFieldName('name');
        if (nc?.type === 'identifier') {
          varName = nc.text;
          break;
        }
      } else if (
        lc?.type === 'identifier' &&
        lc.text !== 'const' &&
        lc.text !== 'let' &&
        lc.text !== 'var'
      ) {
        varName = lc.text;
        break;
      }
    }
  }
  if (varName && !BUILTIN_GLOBALS.has(varName)) {
    forOfBindings.push({ varName, sourceName: right.text, enclosingFunc });
  }
}

/**
 * Phase 8.3f: record object-destructuring rest-parameter bindings from function definitions.
 *
 * For each `function f({ a, ...rest })` (or arrow/function-expression equivalent),
 * records { callee: 'f', restName: 'rest', argIndex: N }. Also covers class methods
 * (`callee: 'ClassName.method'`) and object-literal methods (`callee: 'method'`).
 * The edge builder uses these to seed typeMap[rest] = { type: argName } when f(obj)
 * is called with an identifier, enabling `rest.method()` calls to resolve.
 */
function collectObjectRestParams(
  node: TreeSitterNode,
  t: string,
  currentClass: string | null,
  bindings: ObjectRestParamBinding[],
): void {
  let fnName: string | null = null;
  let paramsNode: TreeSitterNode | null = null;

  if (t === 'function_declaration' || t === 'generator_function_declaration') {
    const nameN = node.childForFieldName('name');
    if (nameN?.type === 'identifier') fnName = nameN.text;
    paramsNode = node.childForFieldName('parameters') ?? findChild(node, 'formal_parameters');
  } else if (t === 'variable_declarator') {
    const nameN = node.childForFieldName('name');
    const valueN = node.childForFieldName('value');
    if (nameN?.type === 'identifier' && valueN) {
      const vt = valueN.type;
      if (vt === 'arrow_function' || vt === 'function_expression' || vt === 'generator_function') {
        fnName = nameN.text;
        paramsNode =
          valueN.childForFieldName('parameters') ?? findChild(valueN, 'formal_parameters');
      }
    }
  } else if (t === 'method_definition') {
    // class method: `class Foo { bar({ a, ...rest }) {} }`
    // object-literal shorthand method: `{ bar({ a, ...rest }) {} }`
    const nameN = node.childForFieldName('name');
    if (nameN) {
      fnName = currentClass ? `${currentClass}.${nameN.text}` : nameN.text;
      paramsNode = node.childForFieldName('parameters') ?? findChild(node, 'formal_parameters');
    }
  } else if (t === 'pair') {
    // object-literal method: `{ bar: function({ a, ...rest }) {} }`
    // Computed keys resolve through resolvePairKeyName, which unwraps resolvable
    // string literals (e.g. `['bar']`) and returns '' for non-string computed keys
    // (e.g. `[Symbol.iterator]`) — `callee: ''` can never match a paramBinding callee.
    const keyN = node.childForFieldName('key');
    const valueN = node.childForFieldName('value');
    if (keyN && valueN) {
      const vt = valueN.type;
      if (vt === 'arrow_function' || vt === 'function_expression' || vt === 'generator_function') {
        const keyName = resolvePairKeyName(keyN);
        if (keyName) {
          fnName = keyName;
          paramsNode =
            valueN.childForFieldName('parameters') ?? findChild(valueN, 'formal_parameters');
        }
      }
    }
  }

  if (fnName && paramsNode) {
    let paramIdx = 0;
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (!child) continue;
      const ct = child.type;
      if (ct === ',' || ct === '(' || ct === ')') continue;
      if (ct === 'object_pattern') {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (!inner) continue;
          if (inner.type === 'rest_pattern' || inner.type === 'rest_element') {
            // rest_pattern node: `...identifier` — the identifier is at child index 1
            const restId = inner.child(1) ?? inner.childForFieldName('name');
            if (restId?.type === 'identifier') {
              bindings.push({ callee: fnName, restName: restId.text, argIndex: paramIdx });
            }
          }
        }
      }
      paramIdx++;
    }
  }
}

/**
 * Phase 8.3f: collect object-property bindings from object literals.
 *
 * `const obj = { e4 }` → `{ objectName: "obj", propName: "e4", valueName: "e4" }`
 * `const obj = { e1: fn }` → `{ objectName: "obj", propName: "e1", valueName: "fn" }`
 *
 * Only tracks shorthand and `key: identifier` pairs; skips function literals.
 */
function collectObjectPropBindings(node: TreeSitterNode, bindings: ObjectPropBinding[]): void {
  const nameN = node.childForFieldName('name');
  const valueN = node.childForFieldName('value');
  if (nameN?.type === 'identifier' && valueN?.type === 'object') {
    const objectName = nameN.text;
    for (let i = 0; i < valueN.childCount; i++) {
      const child = valueN.child(i);
      if (!child) continue;
      if (child.type === 'shorthand_property_identifier') {
        bindings.push({ objectName, propName: child.text, valueName: child.text });
      } else if (child.type === 'pair') {
        const keyN = child.childForFieldName('key');
        const valN = child.childForFieldName('value');
        if (
          keyN?.type === 'property_identifier' &&
          valN?.type === 'identifier' &&
          !BUILTIN_GLOBALS.has(valN.text)
        ) {
          bindings.push({ objectName, propName: keyN.text, valueName: valN.text });
        }
      }
    }
  }
}

/**
 * Collect a dynamic value-ref `Call` for an object-literal `pair` node whose
 * value is a bare identifier — e.g. `{ resolve: someFunction }`, the
 * "dispatch table" pattern (`{ matches, resolve }`-style handler arrays,
 * issue #1771). Restricted to plain `identifier` values: call expressions,
 * member expressions, and inline function/arrow values are handled by their
 * own extraction paths (regular call resolution, `extractObjectLiteralFunctions`)
 * and must not be double-counted here.
 *
 * Emitted unconditionally for every bare-identifier property value in the
 * file — `dynamicKind: 'value-ref'` is resolved downstream (build-edges.ts /
 * incremental.ts) against function/method-kind targets ONLY, so plain data
 * references (`{ name: SOME_CONSTANT }`) naturally fail to resolve into an
 * edge rather than needing a structural allowlist gate here.
 *
 * `keyExpr` carries the property KEY (e.g. `resolve`), distinct from `name`
 * (the referenced value's own identifier, e.g. `someFunction`) — the
 * downstream "is this property ever invoked" liveness check (#1895) needs the
 * key, since that's the name a dispatch consumer would actually call
 * (`table.resolve(...)`), not the function's own declared name.
 */
function collectObjectLiteralValueRefCall(pairNode: TreeSitterNode, calls: Call[]): void {
  const valueNode = pairNode.childForFieldName('value');
  if (valueNode?.type !== 'identifier' || BUILTIN_GLOBALS.has(valueNode.text)) return;
  const keyNode = pairNode.childForFieldName('key');
  const keyExpr = keyNode ? resolveObjectLiteralKeyName(keyNode) || undefined : undefined;
  calls.push({
    name: valueNode.text,
    line: nodeStartLine(valueNode),
    dynamic: true,
    dynamicKind: 'value-ref',
    keyExpr,
  });
}

/**
 * Collect a dynamic value-ref `Call` for the right-hand operand of an
 * `instanceof` binary expression when it's a bare identifier — e.g.
 * `err instanceof CodegraphError` (issue #1784). `instanceof` reads its
 * right operand as a value (a prototype-chain check), never calls it, so
 * this is the same "referenced as a value, not a call site" shape as the
 * object-literal (#1771) and Lua builtin-reassignment (#1776) sites — reused
 * rather than given its own DynamicKind (see ADR-002).
 *
 * Restricted to plain `identifier` right operands: `a instanceof B.C`
 * (`member_expression`) and `a instanceof (foo())` (parenthesized/call
 * expressions) are left unresolved rather than guessing — same
 * "restrict to the simplest syntactic shape" precedent as #1771.
 *
 * Unlike the function/method-only value-ref sites, `instanceof`'s operand is
 * always a class/constructor — the resolver-side kind filter
 * (`resolveFallbackTargets` / `build_edges.rs`) accepts `class`-kind targets
 * in addition to function/method for this reason.
 */
function collectInstanceofValueRefCall(binaryNode: TreeSitterNode, calls: Call[]): void {
  if (binaryNode.childForFieldName('operator')?.text !== 'instanceof') return;
  const rightNode = binaryNode.childForFieldName('right');
  if (rightNode?.type !== 'identifier' || BUILTIN_GLOBALS.has(rightNode.text)) return;
  calls.push({
    name: rightNode.text,
    line: nodeStartLine(rightNode),
    dynamic: true,
    dynamicKind: 'value-ref',
  });
}

function extractReceiverName(objNode: TreeSitterNode | null): string | undefined {
  if (!objNode) return undefined;
  const t = objNode.type;
  if (t === 'identifier' || t === 'this' || t === 'super') return objNode.text;
  // `(new Foo(...)).method()` — extract the constructor name so the resolver can
  // look up `Foo.method` directly without relying on a text-based regex heuristic.
  if (t === 'new_expression') {
    const name = extractNewExprTypeName(objNode);
    if (name) return name;
  }
  if (t === 'parenthesized_expression') {
    // Only one level of parentheses is unwrapped here. Doubly-nested parens
    // (e.g. `((new Dog())).bark()`) and cast expressions inside parens
    // (e.g. `(new Dog() as Animal).bark()`) fall through to raw-text handling
    // below and are caught by the regex fallback in call-resolver.ts.
    for (let i = 0; i < objNode.childCount; i++) {
      const child = objNode.child(i);
      if (child?.type === 'new_expression') {
        const name = extractNewExprTypeName(child);
        if (name) return name;
      }
    }
  }
  return objNode.text;
}

function extractCallInfo(
  fn: TreeSitterNode,
  callNode: TreeSitterNode,
  arrayElemBindings?: ArrayElemBinding[],
): Call | null {
  const fnType = fn.type;
  if (fnType === 'identifier') {
    if (fn.text === 'eval') {
      // eval(code) — dynamic code execution; capture first arg if it's a string literal
      const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
      let keyExpr: string | undefined;
      if (args) {
        for (let i = 0; i < args.childCount; i++) {
          const child = args.child(i);
          if (!child) continue;
          const t = child.type;
          if (t === '(' || t === ')' || t === ',') continue;
          if (t === 'string' || t === 'template_string') keyExpr = child.text;
          break;
        }
      }
      return {
        name: '<dynamic:eval>',
        line: nodeStartLine(callNode),
        dynamic: true,
        dynamicKind: 'eval',
        keyExpr,
      };
    }
    return { name: fn.text, line: nodeStartLine(callNode) };
  }
  if (fnType === 'member_expression') {
    return extractMemberExprCallInfo(fn, callNode);
  }
  if (fnType === 'subscript_expression') {
    return extractSubscriptCallInfo(fn, callNode, arrayElemBindings);
  }
  if (fnType === 'super') {
    // Bare `super(...)` — invokes the parent class's constructor. Modeled as a
    // `constructor` call with receiver `super` so it flows through the same
    // this/super hierarchy dispatch as `super.method()` (resolveThisDispatch
    // in cha.ts walks to the caller's parent class and looks up
    // `ParentClass.constructor`), rather than needing a bespoke resolution path.
    return { name: 'constructor', line: nodeStartLine(callNode), receiver: 'super' };
  }
  return null;
}

/** Return the first non-punctuation argument node from a call_expression. */
function getFirstCallArg(callNode: TreeSitterNode): TreeSitterNode | null {
  const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === '(' || t === ')' || t === ',') continue;
    return child;
  }
  return null;
}

/** Extract the logical callee from a Reflect.apply/call/construct first-arg. */
function extractReflectCalleeFromArg(firstArg: TreeSitterNode | null, callLine: number): Call {
  if (firstArg?.type === 'identifier') {
    return { name: firstArg.text, line: callLine, dynamic: true, dynamicKind: 'reflection' };
  }
  if (firstArg?.type === 'member_expression') {
    const innerProp = firstArg.childForFieldName('property');
    if (innerProp?.type === 'identifier') {
      return {
        name: innerProp.text,
        line: callLine,
        dynamic: true,
        dynamicKind: 'reflection',
        receiver: extractReceiverName(firstArg.childForFieldName('object')),
      };
    }
  }
  return {
    name: '<dynamic:unresolved>',
    line: callLine,
    dynamic: true,
    dynamicKind: 'unresolved-dynamic',
  };
}

/** Extract call info from a member_expression function node (obj.method()). */
function extractMemberExprCallInfo(fn: TreeSitterNode, callNode: TreeSitterNode): Call | null {
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!prop) return null;

  const callLine = nodeStartLine(callNode);
  const propText = prop.text;
  const isReflect = obj?.type === 'identifier' && obj.text === 'Reflect';

  // Reflect.apply(fn, thisArg, args) — extract the first arg as callee
  // Note: Reflect.call does not exist in the ECMAScript spec (only Reflect.apply, construct, get, etc.)
  if (isReflect && propText === 'apply') {
    return extractReflectCalleeFromArg(getFirstCallArg(callNode), callLine);
  }

  // Reflect.construct(Target, args) — extract the constructor as the callee
  if (isReflect && propText === 'construct') {
    return extractReflectCalleeFromArg(getFirstCallArg(callNode), callLine);
  }

  // Reflect.get(target, prop) — property access via reflection
  if (isReflect && propText === 'get') {
    const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
    if (args) {
      let argIdx = 0;
      let firstArg: TreeSitterNode | null = null;
      let secondArg: TreeSitterNode | null = null;
      for (let i = 0; i < args.childCount; i++) {
        const child = args.child(i);
        if (!child) continue;
        const t = child.type;
        if (t === '(' || t === ')' || t === ',') continue;
        if (argIdx === 0) firstArg = child;
        else if (argIdx === 1) secondArg = child;
        argIdx++;
      }
      if (secondArg) {
        const receiver = firstArg ? extractReceiverName(firstArg) : undefined;
        const st = secondArg.type;
        if (st === 'string' || st === 'string_fragment') {
          const propName = secondArg.text.replace(/['"]/g, '');
          if (propName) {
            return {
              name: propName,
              line: callLine,
              dynamic: true,
              dynamicKind: 'computed-literal',
              keyExpr: secondArg.text,
              receiver,
            };
          }
        }
        if (st === 'identifier') {
          return {
            name: '<dynamic:computed-key>',
            line: callLine,
            dynamic: true,
            dynamicKind: 'computed-key',
            keyExpr: secondArg.text,
            receiver,
          };
        }
      }
    }
    return {
      name: '<dynamic:unresolved>',
      line: callLine,
      dynamic: true,
      dynamicKind: 'unresolved-dynamic',
    };
  }

  // .call()/.apply()/.bind() — this-rebinding; the wrapped function is the real callee, but
  // invoking it through .call/.apply/.bind is a genuinely reflective mechanism (a distinct
  // invocation path from a plain `f()` call), so both identifier and member-expression
  // receivers are tagged dynamic/reflection — matching the native Rust engine and preserving
  // the informational value of the `reflection` DynamicKind (queryable via
  // `codegraph roles --dynamic`; see ADR-002). This does NOT reintroduce #1687: that bug was
  // a dedup-collision in build-edges.ts (a direct `f()` edge getting wrongly flipped to dyn=1
  // by a later `f.call()` to the same target in the same scope), fixed narrowly at the
  // edge-emission layer in emitDirectCallEdgesForCall rather than by suppressing the tag here.
  if (propText === 'call' || propText === 'apply' || propText === 'bind') {
    if (obj && obj.type === 'identifier')
      return { name: obj.text, line: callLine, dynamic: true, dynamicKind: 'reflection' };
    if (obj && obj.type === 'member_expression') {
      const innerProp = obj.childForFieldName('property');
      if (innerProp)
        return { name: innerProp.text, line: callLine, dynamic: true, dynamicKind: 'reflection' };
    }
  }

  // Computed string property: obj["method"]() — target is a literal; resolvable
  const propType = prop.type;
  if (propType === 'string' || propType === 'string_fragment') {
    const methodName = propText.replace(/['"]/g, '');
    if (methodName) {
      const receiver = extractReceiverName(obj);
      return {
        name: methodName,
        line: callLine,
        dynamic: true,
        dynamicKind: 'computed-literal',
        receiver,
      };
    }
  }

  const receiver = extractReceiverName(obj);
  return { name: propText, line: callLine, receiver };
}

/**
 * RES-2: inline object-literal dispatch table — `({a:fnA,b:fnB})[key]()`.
 *
 * Mirrors `extract_dispatch_table_call` in
 * `crates/codegraph-core/src/extractors/javascript.rs`. When the subscript's
 * object is an object literal (optionally unwrapped from a parenthesized
 * expression) and the index is a bare identifier, records each property's
 * identifier value as an `ArrayElemBinding` under a synthetic `<dt_line_col>`
 * name and returns a `<dt_line_col>[*]` call — the existing points-to
 * wildcard resolution path (already used for `const arr = [f1, f2]; arr[i]()`
 * patterns) then resolves it to each concrete target identically on both
 * engines (#1897).
 *
 * Returns `null` when the object isn't an object literal, or none of its
 * property values are resolvable bare identifiers.
 */
function extractDispatchTableCall(
  obj: TreeSitterNode | null,
  index: TreeSitterNode,
  callNode: TreeSitterNode,
  arrayElemBindings: ArrayElemBinding[],
): Call | null {
  if (!obj) return null;
  // Unwrap parenthesized_expression: ({a:fn})[key]()
  const objNode =
    obj.type === 'parenthesized_expression'
      ? (obj.childForFieldName('expression') ?? obj.child(1) ?? obj)
      : obj;
  if (objNode.type !== 'object') return null;

  const line = nodeStartLine(callNode);
  const col = callNode.startPosition.column;
  const tableName = `<dt_${line}_${col}>`;
  let idx = 0;
  for (let i = 0; i < objNode.childCount; i++) {
    const child = objNode.child(i);
    if (!child) continue;
    if (child.type === 'shorthand_property_identifier') {
      if (!BUILTIN_GLOBALS.has(child.text)) {
        arrayElemBindings.push({ arrayName: tableName, index: idx, elemName: child.text });
        idx++;
      }
    } else if (child.type === 'pair') {
      const val = child.childForFieldName('value');
      if (val?.type === 'identifier' && !BUILTIN_GLOBALS.has(val.text)) {
        arrayElemBindings.push({ arrayName: tableName, index: idx, elemName: val.text });
        idx++;
      }
    }
  }
  if (idx === 0) return null;
  return {
    name: `${tableName}[*]`,
    line,
    dynamic: true,
    dynamicKind: 'dispatch-table',
    keyExpr: index.text,
  };
}

/** Extract call info from a subscript_expression function node (obj[key]()). */
function extractSubscriptCallInfo(
  fn: TreeSitterNode,
  callNode: TreeSitterNode,
  arrayElemBindings?: ArrayElemBinding[],
): Call | null {
  const obj = fn.childForFieldName('object');
  const index = fn.childForFieldName('index');
  if (!index) return null;

  const indexType = index.type;
  if (indexType === 'string' || indexType === 'template_string') {
    const methodName = index.text.replace(/['"`]/g, '');
    if (methodName && !methodName.includes('$')) {
      const receiver = extractReceiverName(obj);
      return {
        name: methodName,
        line: nodeStartLine(callNode),
        dynamic: true,
        dynamicKind: 'computed-literal',
        receiver,
      };
    }
  }

  // obj[variable]() — key is a variable; may be resolvable via pts (RES-1/RES-2), else flagged
  if (indexType === 'identifier') {
    if (arrayElemBindings) {
      const dispatchCall = extractDispatchTableCall(obj, index, callNode, arrayElemBindings);
      if (dispatchCall) return dispatchCall;
    }
    const receiver = extractReceiverName(obj);
    return {
      name: '<dynamic:computed-key>',
      line: nodeStartLine(callNode),
      dynamic: true,
      dynamicKind: 'computed-key',
      keyExpr: index.text,
      receiver,
    };
  }

  // Any other index expression (binary, call, template with ${}…) — not statically resolvable
  return {
    name: '<dynamic:unresolved>',
    line: nodeStartLine(callNode),
    dynamic: true,
    dynamicKind: 'unresolved-dynamic',
  };
}

/**
 * Callee names that idiomatically accept callback references. Used to gate
 * both identifier and member_expression args in
 * {@link extractCallbackReferenceCalls}: arguments are only emitted as
 * dynamic callback calls when the callee is a known callback-accepting API
 * (router/middleware, promises, array methods, event emitters, scheduling
 * APIs). This avoids false positives from plain values passed as data, e.g.
 * `store.set(user.id, user)` or `findMergeCandidates(communities)`.
 *
 * Identifier args used to be exempted from this gate on the theory that
 * plain identifier data args rarely collide with real function names — but
 * issue #1741 found a concrete counter-example (`analyzeDrift(communities,
 * communityDirs)` colliding with the unrelated `communities` CLI command),
 * which the global-fallback resolver then bound into a fabricated call edge
 * (and, transitively, a phantom cycle). Gating identifiers the same way
 * removes that FP class while still preserving legitimate callback-by-
 * reference patterns like `arr.forEach(myCallback)`.
 */
const CALLBACK_ACCEPTING_CALLEES: ReadonlySet<string> = new Set([
  // Express / router / middleware
  'use',
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
  // Promises
  'then',
  'catch',
  'finally',
  // Array iteration / reduction
  'map',
  'filter',
  'forEach',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'flatMap',
  'sort',
  // Event emitters / DOM
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'addEventListener',
  'removeEventListener',
  'subscribe',
  'unsubscribe',
  // Scheduling / plain function callbacks
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
  'nextTick',
  // Commander / yargs / hooks
  'action',
  'command',
]);

/**
 * HTTP-verb callees that double as Map/cache/repository method names (`get`,
 * `post`, `put`, `delete`, `patch`, `options`, `head`, `all`). Express/router
 * invocations always take a string-literal route path as the first argument
 * (`app.get('/path', handler)`), whereas Map-like APIs pass values/keys
 * (`cache.get(user.id)`). Requiring a string-literal first arg keeps real
 * route handlers covered while dropping the Map/cache false-positive surface.
 *
 * `use` and `all` without a path are legitimate middleware registrations, so
 * `use` is intentionally excluded here — it stays in the general allowlist.
 */
const HTTP_VERB_CALLEES: ReadonlySet<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
]);

/**
 * Callees whose callback argument sits at one specific positional index
 * rather than "any position" (the assumption behind {@link CALLBACK_ACCEPTING_CALLEES},
 * needed for variadic Express/Router middleware chains like
 * `app.get(path, mw1, mw2, handler)`).
 *
 * `Array.from(arrayLike, mapFn, thisArg)` (also `Int8Array.from`, `Uint8Array.from`,
 * etc. — every TypedArray constructor mirrors the same signature) is the
 * motivating case: `arrayLike` (index 0) is plain data — treating it as a
 * callback candidate would reintroduce the exact name-collision false-positive
 * class issue #1741 fixes — while `mapFn` (index 1) is a genuine callback
 * reference that should still resolve. A callee listed here is implicitly
 * callback-accepting (no separate {@link CALLBACK_ACCEPTING_CALLEES} entry
 * needed); only the arg at its listed index is eligible.
 *
 * Invariant: this map and {@link CALLBACK_ACCEPTING_CALLEES} must stay
 * disjoint. A callee name present in both would have its any-position intent
 * silently narrowed to the single listed index (positional wins — see the
 * gate in {@link extractCallbackReferenceCalls}), with no error or warning.
 *
 * This is name-based, not receiver-typed (consistent with the rest of this
 * gate), so it can't distinguish `Array.from(x, mapFn)` from an unrelated
 * `.from(x, y)` on some other object shaped differently — e.g. `Buffer.from(data,
 * encoding)`, where `encoding` is conventionally a string but could in principle
 * be a colliding identifier. That residual risk is far narrower than the
 * unconditional-emission bug this gate fixes, so it's accepted rather than
 * adding receiver-type tracking here.
 */
const POSITIONAL_CALLBACK_ARG_INDEX: ReadonlyMap<string, number> = new Map([['from', 1]]);

/**
 * Extract the callee's final name (function identifier or member expression
 * property) for callback-eligibility filtering. Returns null if the callee
 * shape is not analyzable (e.g. computed subscripts, IIFEs).
 *
 * Optional-chaining (`obj?.method(...)`) is handled transparently: in both
 * tree-sitter-javascript and tree-sitter-typescript grammars `obj?.method` is
 * still a `member_expression` (the `?.` appears as an `optional_chain` child),
 * so the property extraction below returns `method` as expected.
 */
function extractCalleeName(callNode: TreeSitterNode): string | null {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

/**
 * True iff the first argument of an arguments node is a string literal.
 * Used to distinguish Express/router route handlers (`app.get('/path', h)`)
 * from Map/cache APIs that reuse the same verb names (`cache.get(user.id)`).
 */
function firstArgIsStringLiteral(argsNode: TreeSitterNode): boolean {
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (!child) continue;
    // Skip parens and commas; the first non-punctuation child is the first arg.
    if (child.type === '(' || child.type === ',' || child.type === ')') continue;
    return child.type === 'string' || child.type === 'template_string';
  }
  return false;
}

/**
 * Per-file map from a function/method's bare name (matching what
 * {@link extractCalleeName} returns) to the set of its own parameter
 * positions whose declared TypeScript type is function-shaped (an inline
 * arrow-function type, `Function`, or a `type X = (...) => ...` alias).
 * Built once per file by {@link collectCallbackParamShapes} and consulted by
 * {@link extractCallbackReferenceCalls} to recognize identifier arguments
 * passed to arbitrary user-defined higher-order functions (issue #1845),
 * not just the {@link CALLBACK_ACCEPTING_CALLEES} name allowlist.
 *
 * Name-keyed rather than receiver-typed, consistent with the rest of this
 * gate (see {@link POSITIONAL_CALLBACK_ARG_INDEX}'s doc comment for the same
 * tradeoff) — but unlike a plain name-keyed union, a position is only kept
 * when *every* same-named declaration in the file agrees it is
 * function-shaped (see {@link collectCallbackParamShapes}), so two unrelated
 * same-named declarations with different signatures (e.g. same-named
 * methods on two different classes) cancel out instead of merging into a
 * false positive.
 */
type CallbackParamShapes = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * True iff `typeNode` denotes a function-shaped TypeScript type: an inline
 * arrow-function type (`(x: T) => R`), the `Function` type, a parenthesized
 * function type, a generic instantiation of one (`UserProcessor<T>`), or a
 * `type` alias name that itself resolves to one of the above (see
 * {@link collectFunctionShapedTypeAliases}).
 *
 * Deliberately not full type-checking: union/intersection types and
 * interface call signatures are not recognized, matching the same
 * "defensible heuristic, not full inference" scope as {@link extractSimpleTypeName}.
 */
function isFunctionShapedTypeNode(
  typeNode: TreeSitterNode,
  aliasShapes: ReadonlyMap<string, boolean>,
): boolean {
  switch (typeNode.type) {
    case 'function_type':
      return true;
    case 'parenthesized_type': {
      const inner = typeNode.namedChild(0);
      return inner ? isFunctionShapedTypeNode(inner, aliasShapes) : false;
    }
    case 'type_identifier':
      return typeNode.text === 'Function' || aliasShapes.get(typeNode.text) === true;
    case 'generic_type': {
      const base = typeNode.child(0);
      return base ? isFunctionShapedTypeNode(base, aliasShapes) : false;
    }
    default:
      return false;
  }
}

/** True iff a `type_annotation` node's inner type is function-shaped. */
function isFunctionShapedTypeAnnotation(
  typeAnnotationNode: TreeSitterNode,
  aliasShapes: ReadonlyMap<string, boolean>,
): boolean {
  for (let i = 0; i < typeAnnotationNode.childCount; i++) {
    const child = typeAnnotationNode.child(i);
    if (child && child.type !== ':') return isFunctionShapedTypeNode(child, aliasShapes);
  }
  return false;
}

/**
 * Walk the file for `type X = ...` aliases and classify each by whether it
 * resolves to a function-shaped type, following one level of alias-to-alias
 * indirection (`type A = B` where `B` is itself function-shaped) with a
 * cycle guard. Motivating case: `export type UserProcessor = (user: User) => void;`.
 */
function collectFunctionShapedTypeAliases(root: TreeSitterNode): ReadonlyMap<string, boolean> {
  const directAliasOf = new Map<string, string>();
  const resolved = new Map<string, boolean>();

  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'type_alias_declaration') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && valueNode) {
        if (valueNode.type === 'type_identifier') {
          directAliasOf.set(nameNode.text, valueNode.text);
        } else {
          resolved.set(nameNode.text, isFunctionShapedTypeNode(valueNode, resolved));
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, depth + 1);
    }
  }
  walk(root, 0);

  // Resolve `type A = B` chains against the direct classifications above.
  for (const [name, aliasOf] of directAliasOf) {
    if (!resolved.has(name)) {
      resolved.set(name, aliasOf === 'Function' || resolved.get(aliasOf) === true);
    }
  }
  return resolved;
}

/**
 * Walk the whole file once to record, per {@link CallbackParamShapes}, which
 * parameter positions of every `function`/method declaration are
 * function-shaped — the callee-definition side of recognizing identifier
 * arguments to arbitrary user-defined higher-order functions (issue #1845).
 * Also covers same-file `const f = (...) => ...` / `const f = function(...) {}`
 * assignments, which are otherwise invisible to a walk that only looks at
 * `function_declaration`/`method_definition` nodes.
 *
 * Same-file only: a call site whose callee is defined in another file has no
 * entry here and falls back to the existing name/position allowlist.
 */
function collectCallbackParamShapes(root: TreeSitterNode): CallbackParamShapes {
  const aliasShapes = collectFunctionShapedTypeAliases(root);
  // One entry per same-named declaration; intersected below so a bare name
  // shared by two unrelated declarations only keeps a position that every
  // declaration agrees is function-shaped.
  const declarations = new Map<string, Set<number>[]>();

  function functionShapedParamIndices(fnNode: TreeSitterNode): Set<number> {
    const indices = new Set<number>();
    const paramsNode =
      fnNode.childForFieldName('parameters') || findChild(fnNode, 'formal_parameters');
    if (!paramsNode) return indices;
    let argIndex = -1;
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (!child) continue;
      const t = child.type;
      if (t === '(' || t === ')' || t === ',') continue;
      if (t === 'required_parameter' || t === 'optional_parameter') {
        // TypeScript's explicit `this` parameter (`function f(this: Foo, cb: Bar)`)
        // is compiled away and never appears at the call site, so it must not
        // consume an argument-index slot — otherwise every later parameter's
        // index would be off by one relative to the call's actual arguments.
        const patternNode = child.childForFieldName('pattern') || child.childForFieldName('name');
        if (patternNode?.type === 'this') continue;
      }
      argIndex++;
      if (t !== 'required_parameter' && t !== 'optional_parameter') continue;
      const typeAnno = findChild(child, 'type_annotation');
      if (typeAnno && isFunctionShapedTypeAnnotation(typeAnno, aliasShapes)) {
        indices.add(argIndex);
      }
    }
    return indices;
  }

  function recordDeclaration(nameNode: TreeSitterNode | null, fnNode: TreeSitterNode): void {
    if (!nameNode) return;
    let perName = declarations.get(nameNode.text);
    if (!perName) {
      perName = [];
      declarations.set(nameNode.text, perName);
    }
    perName.push(functionShapedParamIndices(fnNode));
  }

  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;
    if (t === 'function_declaration' || t === 'generator_function_declaration') {
      recordDeclaration(node.childForFieldName('name'), node);
    } else if (t === 'method_definition') {
      recordDeclaration(node.childForFieldName('name'), node);
    } else if (t === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      const vt = valueNode?.type;
      if (
        nameNode?.type === 'identifier' &&
        (vt === 'arrow_function' || vt === 'function_expression' || vt === 'generator_function')
      ) {
        recordDeclaration(nameNode, valueNode!);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, depth + 1);
    }
  }
  walk(root, 0);

  const shapes = new Map<string, ReadonlySet<number>>();
  for (const [name, perDeclIndices] of declarations) {
    const [first, ...rest] = perDeclIndices;
    const intersected = new Set(first);
    for (const other of rest) {
      for (const idx of intersected) {
        if (!other.has(idx)) intersected.delete(idx);
      }
    }
    if (intersected.size > 0) shapes.set(name, intersected);
  }
  return shapes;
}

/**
 * Extract Call entries for named function references passed as arguments.
 * e.g. `router.use(handleToken, checkAuth)` yields calls to handleToken and checkAuth.
 * `app.use(auth.validate)` yields a call to validate with receiver auth.
 * Skips literals, objects, arrays, anonymous functions, and call expressions (already handled).
 *
 * To avoid false positives where plain values are passed as data (e.g.
 * `store.set(user.id, user)` — `user.id` is a value, not a callback; or
 * `findMergeCandidates(communities)` — `communities` is a data argument, not
 * a callback), both identifier and member_expression args are only emitted
 * when the callee is in {@link CALLBACK_ACCEPTING_CALLEES}, the argument sits
 * at the specific index a {@link POSITIONAL_CALLBACK_ARG_INDEX} entry
 * designates (e.g. `Array.from(arrayLike, mapFn)` — only index 1 is eligible;
 * `arrayLike` at index 0 stays ungated data), or the callee is a same-file
 * function/method whose own parameter at that index is function-shaped per
 * {@link CallbackParamShapes} (issue #1845 — arbitrary user-defined
 * higher-order functions like `processEach(users, fn: UserProcessor)`,
 * which no name/position allowlist can enumerate).
 *
 * HTTP-verb callees (`get`, `post`, `put`, `delete`, `patch`, `options`,
 * `head`, `all`) double as Map/cache/repository method names, so their
 * args are only emitted when the first argument is a string literal route
 * path — matching Express/router shape and skipping `cache.get(user.id)`-style
 * calls.
 *
 * `.call()` / `.apply()` / `.bind()` — the first arg is the `this` context (not a callback of
 * the enclosing function) and subsequent args flow into the delegated function's parameters.
 * Emitting them here would produce false-positive edges from the *calling* function.
 * This-rebinding (fn::this → ctx) is handled separately by extractThisCallBindingsWalk.
 *
 * Known gap: {@link CallbackParamShapes} only covers callees defined in the
 * same file. A cross-file arbitrary higher-order function still falls back
 * to the name/position allowlist. Extending this to cross-file callees needs
 * the resolver's import-resolution machinery; tracked as a follow-up.
 */
function extractCallbackReferenceCalls(
  callNode: TreeSitterNode,
  callbackParamShapes: CallbackParamShapes,
): Call[] {
  const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
  if (!args) return [];

  const calleeName = extractCalleeName(callNode);
  // .call() / .apply() / .bind() — the first arg is the `this` context (not a callback of
  // the enclosing function) and subsequent args flow into the delegated function's parameters.
  // Emitting them here would produce false-positive edges from the *calling* function.
  // This-rebinding (fn::this → ctx) is handled separately by extractThisCallBindingsWalk.
  if (calleeName === 'call' || calleeName === 'apply' || calleeName === 'bind') return [];

  let callbackArgsAllowed = calleeName !== null && CALLBACK_ACCEPTING_CALLEES.has(calleeName);
  if (callbackArgsAllowed && calleeName !== null && HTTP_VERB_CALLEES.has(calleeName)) {
    // HTTP verbs require a string-literal route path to be treated as a
    // callback-accepting API; otherwise `cache.get(user.id)` etc. would
    // still emit `id` as a dynamic call.
    callbackArgsAllowed = firstArgIsStringLiteral(args);
  }

  const positionalIndex =
    calleeName !== null ? POSITIONAL_CALLBACK_ARG_INDEX.get(calleeName) : undefined;
  const calleeParamShapes = calleeName !== null ? callbackParamShapes.get(calleeName) : undefined;
  if (!callbackArgsAllowed && positionalIndex === undefined && !calleeParamShapes?.size) {
    return [];
  }

  const result: Call[] = [];
  const callLine = nodeStartLine(callNode);
  let argIndex = -1;

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === '(' || t === ')' || t === ',') continue;
    argIndex++;

    if (positionalIndex !== undefined) {
      // A positional entry restricts eligibility to its one designated
      // index, regardless of what the generic (any-position) gate above
      // decided.
      if (argIndex !== positionalIndex) continue;
    } else if (!callbackArgsAllowed && !calleeParamShapes?.has(argIndex)) {
      continue;
    }

    if (t === 'identifier') {
      result.push({ name: child.text, line: callLine, dynamic: true });
    } else if (t === 'member_expression') {
      const prop = child.childForFieldName('property');
      const obj = child.childForFieldName('object');
      if (prop) {
        const receiver = extractReceiverName(obj);
        result.push({ name: prop.text, line: callLine, dynamic: true, receiver });
      }
    }
  }

  return result;
}

/**
 * Collect, from a call_expression node:
 * - `this(args)` call expressions → `{name: 'this', ...}` entries in `calls`
 *   (where `this` is used as a function, not as a receiver)
 * - `fn.call(namedCtx, ...)` / `fn.apply(namedCtx, ...)` bindings →
 *   `{ callee: 'fn', thisArg: 'namedCtx' }` entries in `thisCallBindings`
 */
function collectThisCallAndBindings(
  node: TreeSitterNode,
  calls: Call[],
  thisCallBindings: ThisCallBinding[],
): void {
  const fn = node.childForFieldName('function');
  if (fn?.type === 'this') {
    calls.push({ name: 'this', line: nodeStartLine(node) });
  } else if (fn?.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (
      obj?.type === 'identifier' &&
      prop &&
      (prop.text === 'call' || prop.text === 'apply') &&
      !BUILTIN_GLOBALS.has(obj.text)
    ) {
      const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
      if (args) {
        for (let i = 0; i < args.childCount; i++) {
          const child = args.child(i);
          if (!child) continue;
          const t = child.type;
          if (t === '(' || t === ')' || t === ',') continue;
          // First real argument: only bind if it's a plain identifier
          if (
            t === 'identifier' &&
            !BUILTIN_GLOBALS.has(child.text) &&
            child.text !== 'undefined' &&
            child.text !== 'null'
          ) {
            thisCallBindings.push({ callee: obj.text, thisArg: child.text });
          }
          break;
        }
      }
    }
  }
}

/**
 * Outputs for {@link runCollectorWalk}. Required targets are collected on both
 * extraction paths; optional targets are path-specific:
 * - `imports` / `calls`+`thisCallBindings` / `classMemberDefs` — query path only
 *   (the walk path's walkJavaScriptNode covers those node types itself).
 * - `funcPropDefs` — walk path only (the query path captures `fn.method = …`
 *   assignments via the `assign_left`/`assign_right` query pattern).
 *
 * `valueRefCalls` is REQUIRED (unlike `calls`) — both paths route
 * object-literal value-ref extraction through this single field, since
 * neither `walkJavaScriptNode` (walk path) nor the compiled query patterns
 * (query path) visit `pair`/`shorthand_property_identifier`/`binary_expression`
 * nodes on their own (#1771, #1784). Both callers pass their own `calls`
 * array here; it's a separate field from the optional `calls` above purely
 * so this collector isn't accidentally gated off by the walk path's "don't
 * double-collect call_expression" omission.
 */
interface CollectorWalkTargets {
  definitions: Definition[];
  typeMap: Map<string, TypeMapEntry>;
  paramBindings: ParamBinding[];
  arrayElemBindings: ArrayElemBinding[];
  objectPropBindings: ObjectPropBinding[];
  newExpressions: string[];
  definePropertyReceivers: Map<string, string>;
  valueRefCalls: Call[];
  /** #1893: same-file `ClassName.propName` → declared get/set accessor kinds. */
  localAccessors: LocalAccessorRegistry;
  imports?: Import[];
  calls?: Call[];
  thisCallBindings?: ThisCallBinding[];
  classMemberDefs?: Definition[];
  funcPropDefs?: Definition[];
}

/**
 * Single-pass collector walk: one DFS that dispatches each node to every
 * collector interested in its type.
 *
 * This replaces what had grown to ten independent full-tree traversals (one
 * per collector). On WASM trees every node access (`child(i)`, `.type`,
 * `childForFieldName`) marshals through the JS↔WASM boundary, so traversal
 * count — not collector work — dominated extraction cost: the accumulated
 * per-collector walks made extraction ~2.4× slower between v3.11.2 and
 * v3.12.0 (7.5 → 17.7 ms/file on codegraph's own corpus).
 *
 * Collectors with bespoke traversal semantics stay separate:
 * - extractConstantsWalk / extractDestructuredBindingsWalk prune function
 *   scopes and unwrap export statements on the way down;
 * - extractReturnTypeMapWalk / extractTypeMapWalk / extractSpreadForOfWalk /
 *   extractObjectRestParamBindingsWalk thread enclosing-class context with
 *   per-walk reset rules that intentionally differ (see each walk's comments).
 */
function runCollectorWalk(rootNode: TreeSitterNode, targets: CollectorWalkTargets): void {
  const walk = (node: TreeSitterNode, depth: number, inDynamicImport: boolean): void => {
    if (depth >= MAX_WALK_DEPTH) return;
    let childInDynamicImport = inDynamicImport;
    switch (node.type) {
      case 'call_expression': {
        // Matched import() calls suppress *dynamic-import* collection in their
        // argument subtree (mirrors the old walk's early return) while leaving
        // the subtree visible to every other collector. The !inDynamicImport
        // check runs first so nested import() calls are neither collected nor
        // re-matched.
        if (targets.imports && !inDynamicImport && collectDynamicImport(node, targets.imports)) {
          childInDynamicImport = true;
        }
        if (targets.calls && targets.thisCallBindings) {
          collectThisCallAndBindings(node, targets.calls, targets.thisCallBindings);
        }
        collectParamBindings(node, targets.paramBindings);
        collectDefinePropertyReceiver(node, targets.definePropertyReceivers);
        break;
      }
      case 'variable_declarator':
        collectArrayElemBindings(node, targets.arrayElemBindings);
        collectObjectPropBindings(node, targets.objectPropBindings);
        break;
      case 'expression_statement': {
        const expr = node.child(0);
        if (expr?.type === 'assignment_expression') {
          const lhs = expr.childForFieldName('left');
          const rhs = expr.childForFieldName('right');
          if (lhs && rhs) {
            handlePrototypeAssignment(lhs, rhs, targets.definitions, targets.typeMap);
            if (targets.funcPropDefs) handleFuncPropAssignment(lhs, rhs, targets.funcPropDefs);
          }
        }
        break;
      }
      case 'new_expression': {
        const name = extractNewExprTypeName(node);
        if (name) targets.newExpressions.push(name);
        break;
      }
      case 'decorator': {
        if (targets.calls) handleDecorator(node, targets.calls);
        break;
      }
      case 'field_definition':
      case 'public_field_definition':
        if (targets.classMemberDefs) handleFieldDef(node, targets.classMemberDefs);
        break;
      case 'class_static_block':
        if (targets.classMemberDefs) handleStaticBlock(node, targets.classMemberDefs);
        break;
      case 'pair':
        // #1771: dispatch-table-style object-literal property values, e.g.
        // `{ resolve: someFunction }`.
        collectObjectLiteralValueRefCall(node, targets.valueRefCalls);
        break;
      case 'shorthand_property_identifier':
        // #1771: shorthand form of the same pattern, e.g. `{ someFunction }`.
        // keyExpr equals name here — the property key and the referenced
        // value are the same identifier in shorthand form (#1895).
        if (!BUILTIN_GLOBALS.has(node.text)) {
          targets.valueRefCalls.push({
            name: node.text,
            line: nodeStartLine(node),
            dynamic: true,
            dynamicKind: 'value-ref',
            keyExpr: node.text,
          });
        }
        break;
      case 'binary_expression':
        // #1784: `instanceof ClassName` checks, e.g. `err instanceof CodegraphError`.
        collectInstanceofValueRefCall(node, targets.valueRefCalls);
        break;
      case 'member_expression':
        // #1893: bare (non-call) reads/writes of a same-file get/set class accessor.
        collectAccessorPropertyRead(
          node,
          targets.localAccessors,
          targets.typeMap,
          targets.valueRefCalls,
        );
        break;
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1, childInDynamicImport);
    }
  };
  walk(rootNode, 0, false);
}

function findAnonymousCallback(argsNode: TreeSitterNode): TreeSitterNode | null {
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child && (child.type === 'arrow_function' || child.type === 'function_expression')) {
      return child;
    }
  }
  return null;
}

function findFirstStringArg(argsNode: TreeSitterNode): string | null {
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child && child.type === 'string') {
      return child.text.replace(/['"]/g, '');
    }
  }
  return null;
}

function walkCallChain(startNode: TreeSitterNode, methodName: string): TreeSitterNode | null {
  let current: TreeSitterNode | null = startNode;
  while (current) {
    const curType = current.type;
    if (curType === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop && prop.text === methodName) {
          return current;
        }
      }
      current = fn;
    } else if (curType === 'member_expression') {
      current = current.childForFieldName('object');
    } else {
      break;
    }
  }
  return null;
}

const EXPRESS_METHODS: Set<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
  'use',
]);
const EVENT_METHODS: Set<string> = new Set(['on', 'once', 'addEventListener', 'addListener']);

function extractCallbackDefinition(
  callNode: TreeSitterNode,
  fn?: TreeSitterNode | null,
): Definition | null {
  if (!fn) fn = callNode.childForFieldName('function');
  if (fn?.type !== 'member_expression') return null;

  const prop = fn.childForFieldName('property');
  if (!prop) return null;
  const method = prop.text;

  const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
  if (!args) return null;

  // Commander: .action(callback) with .command('name') in chain
  if (method === 'action') {
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    const commandCall = walkCallChain(fn.childForFieldName('object')!, 'command');
    if (!commandCall) return null;
    const cmdArgs =
      commandCall.childForFieldName('arguments') || findChild(commandCall, 'arguments');
    if (!cmdArgs) return null;
    const cmdName = findFirstStringArg(cmdArgs);
    if (!cmdName) return null;
    const firstWord = cmdName.split(/\s/)[0]!;
    return {
      name: `command:${firstWord}`,
      kind: 'function',
      line: nodeStartLine(cb),
      endLine: nodeEndLine(cb),
    };
  }

  // Express: app.get('/path', callback)
  if (EXPRESS_METHODS.has(method)) {
    const strArg = findFirstStringArg(args);
    if (!strArg?.startsWith('/')) return null;
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    return {
      name: `route:${method.toUpperCase()} ${strArg}`,
      kind: 'function',
      line: nodeStartLine(cb),
      endLine: nodeEndLine(cb),
    };
  }

  // Events: emitter.on('event', callback)
  if (EVENT_METHODS.has(method)) {
    const eventName = findFirstStringArg(args);
    if (!eventName) return null;
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    return {
      name: `event:${eventName}`,
      kind: 'function',
      line: nodeStartLine(cb),
      endLine: nodeEndLine(cb),
    };
  }

  return null;
}

function extractSuperclass(heritage: TreeSitterNode): string | null {
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i)!;
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
    const found = extractSuperclass(child);
    if (found) return found;
  }
  return null;
}

const JS_CLASS_TYPES = ['class_declaration', 'abstract_class_declaration', 'class'] as const;
function findParentClass(node: TreeSitterNode): string | null {
  return findParentNode(node, JS_CLASS_TYPES);
}

/**
 * Extract the local binding names introduced by an import/export statement.
 *
 * `renamedOut`, when passed, collects `{ local, imported }` pairs for
 * `import_specifier` nodes that rename a binding (`import { X as Y }`).
 *
 * `typeOnlyOut`, when passed, collects the local binding name of every
 * `import_specifier` carrying an inline `type`/`typeof` modifier
 * (`import { type X }`) — the per-specifier form of type-only, distinct
 * from a whole-statement `import type { X }` (#1813). Per the
 * tree-sitter-typescript grammar, `import_specifier` is
 * `optional(choice('type', 'typeof'))` followed by the name/alias fields,
 * so the modifier — when present — is always the specifier's first child.
 *
 * Grammar note (see tree-sitter-javascript): for `import_specifier`, the
 * `name` field is *always* present — it holds the name as declared by the
 * source module. `alias` is only present for `X as Y` and holds the *local*
 * binding actually referenced by call sites in this file. Preferring `name`
 * unconditionally (as this function used to) silently drops the local alias
 * for every renamed import: call sites use `Y`, not `X` (#1730).
 *
 * `export_specifier` has the same `name`/`alias` shape but the opposite
 * consumer: `name` (X) is the declaration being re-exported, `alias` (Y) is
 * the external name a consumer of *this* barrel imports. `names` keeps
 * recording X (barrel/reexport tracing keys off the original declaration —
 * see `resolveBarrelExport`), but when the two differ, `renamedOut` also
 * receives the `{ local: Y, imported: X }` pair so barrel resolution can
 * translate a consumer's requested external name back to X (#1823).
 */
function extractImportNames(
  node: TreeSitterNode,
  renamedOut?: Array<{ local: string; imported: string }>,
  typeOnlyOut?: string[],
): string[] {
  const names: string[] = [];
  function scan(n: TreeSitterNode): void {
    if (n.type === 'import_specifier') {
      const sourceNameNode = n.childForFieldName('name');
      const aliasNode = n.childForFieldName('alias');
      const localNode = aliasNode || sourceNameNode;
      if (localNode) {
        names.push(localNode.text);
        if (aliasNode && sourceNameNode && aliasNode.text !== sourceNameNode.text) {
          renamedOut?.push({ local: aliasNode.text, imported: sourceNameNode.text });
        }
        const modifier = n.child(0);
        if (modifier && (modifier.type === 'type' || modifier.type === 'typeof')) {
          typeOnlyOut?.push(localNode.text);
        }
      } else {
        names.push(n.text);
      }
    } else if (n.type === 'export_specifier') {
      // export_specifier's `name` is the local declaration being (re-)exported;
      // `alias` is the external name it's exposed as. Barrel/reexport tracing
      // (resolveBarrelExport) keys off the *original* declaration name, so this
      // branch keeps picking `name` first — do not unify with the
      // import_specifier branch above. When `alias` differs from `name`, the
      // rename pair is recorded in renamedOut so resolveBarrelExport can map a
      // consumer's requested external name (Y) back to X (#1823).
      const sourceNameNode = n.childForFieldName('name');
      const aliasNode = n.childForFieldName('alias');
      const nameNode = sourceNameNode || aliasNode;
      if (nameNode) {
        names.push(nameNode.text);
        if (aliasNode && sourceNameNode && aliasNode.text !== sourceNameNode.text) {
          renamedOut?.push({ local: aliasNode.text, imported: sourceNameNode.text });
        }
      } else {
        names.push(n.text);
      }
    } else if (n.type === 'identifier' && n.parent && n.parent.type === 'import_clause') {
      names.push(n.text);
    } else if (n.type === 'namespace_import') {
      names.push(n.text);
    }
    for (let i = 0; i < n.childCount; i++) scan(n.child(i)!);
  }
  scan(node);
  return names;
}

/**
 * Wrapper node types that can sit between a dynamic `import()` call and its
 * enclosing `variable_declarator` without changing which value gets bound —
 * `await`, redundant parentheses, and TypeScript `as`/`satisfies` casts.
 * Real-world dynamic-import call sites often combine several of these, e.g.
 * `const { X } = (await import('./mod.js')) as { X: Fn }` nests
 * await_expression → parenthesized_expression → as_expression before
 * reaching the declarator (#1781). `satisfies_expression` (TS 4.9+
 * `... satisfies { X: Fn }`) is structurally identical to `as_expression`
 * here — same Greptile follow-up as the native mirror.
 */
const DYNAMIC_IMPORT_WRAPPER_TYPES = new Set([
  'await_expression',
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
]);

/**
 * Extract the bound identifier from a `rest_pattern`/`rest_element` node
 * (`...rest` → `rest`). Scans all children for the `identifier` node rather
 * than assuming a fixed index — the `...` token itself is child 0, so
 * indexing into a fixed slot silently returns the wrong node (#1920).
 * Mirrors `extract_rest_identifier` in the native engine.
 */
function extractRestPatternIdentifier(restNode: TreeSitterNode): string | undefined {
  for (let i = 0; i < restNode.childCount; i++) {
    const child = restNode.child(i);
    if (child?.type === 'identifier') return child.text;
  }
  return undefined;
}

/**
 * Extract destructured names from a dynamic import() call expression.
 *
 * Handles:
 *   const { a, b } = await import('./foo.js')                    → ['a', 'b']
 *   const mod = await import('./foo.js')                          → ['mod']
 *   const { a } = (await import('./foo.js')) as { a: Fn }         → ['a']
 *   const { a: b } = await import('./foo.js')                     → ['b']
 *   const { a, ...rest } = await import('./foo.js')                → ['a', 'rest']
 *   const { a = 1 } = await import('./foo.js')                    → ['a']
 *   import('./foo.js')                                            → [] (no names extractable)
 *
 * Walks up the AST from the call_expression — through any nesting of
 * await/parenthesized/as-cast wrappers — to find the enclosing
 * variable_declarator and reads the name/object_pattern.
 *
 * `renamedOut`, when supplied, is populated with `{ local, imported }` pairs
 * for every `{ imported: local }` specifier — mirrors `extractImportNames`'s
 * static-import convention (#1730) so call-edge resolution can recover the
 * original exported name when a call site uses the local alias (#1824).
 */
function extractDynamicImportNames(
  callNode: TreeSitterNode,
  renamedOut?: Array<{ local: string; imported: string }>,
): string[] {
  // Walk up through await_expression / parenthesized_expression / as_expression
  // wrappers, in any combination or order, to reach the variable_declarator.
  let current = callNode.parent;
  while (current && DYNAMIC_IMPORT_WRAPPER_TYPES.has(current.type)) {
    current = current.parent;
  }
  // We should now be at a variable_declarator (or not, if standalone import())
  if (current?.type !== 'variable_declarator') return [];

  const nameNode = current.childForFieldName('name');
  if (!nameNode) return [];

  // const { a, b } = await import(...)  →  object_pattern
  if (nameNode.type === 'object_pattern') {
    const names: string[] = [];
    for (let i = 0; i < nameNode.childCount; i++) {
      const child = nameNode.child(i)!;
      if (child.type === 'shorthand_property_identifier_pattern') {
        names.push(child.text);
      } else if (child.type === 'pair_pattern') {
        // { imported: local } → the local binding (`value`) is what call
        // sites actually reference; `key` is the name exported by the target
        // module. Preferring `key` unconditionally (as this branch used to)
        // silently dropped the local alias for every renamed destructure,
        // the same class of bug fixed for static `import { X as Y }`
        // specifiers in #1730 (#1824).
        const key = child.childForFieldName('key');
        const value = child.childForFieldName('value');
        let localNode: TreeSitterNode | undefined;
        if (
          value?.type === 'identifier' ||
          value?.type === 'shorthand_property_identifier_pattern'
        ) {
          localNode = value;
        } else if (value?.type === 'assignment_pattern') {
          // { imported: local = defaultValue } — the local binding is the
          // assignment_pattern's left-hand identifier.
          const left = value.childForFieldName('left');
          if (left?.type === 'identifier') localNode = left;
        }
        // A quoted (`{ 'foo-bar': local }`) or computed (`{ ['foo-bar']: local }`)
        // key's raw `.text` includes the quotes/brackets — using it verbatim as
        // `imported` makes the resolver look for an export literally named
        // `'foo-bar'`, which never matches (Greptile, #1824 follow-up). Resolve
        // to the clean export name the same way resolveComputedKeyName/
        // resolveMethodDefinitionName already do for object-literal keys.
        const keyName = key
          ? key.type === 'computed_property_name'
            ? resolveComputedKeyName(key)
            : key.type === 'string' || key.type === 'string_fragment'
              ? key.text.replace(/^['"]|['"]$/g, '')
              : key.text
          : '';
        if (localNode) {
          // The local binding is always trackable on its own, even when the
          // key isn't statically resolvable (e.g. `{ [Symbol()]: local }`) —
          // only the rename-pair mapping is skipped in that case.
          names.push(localNode.text);
          if (keyName && localNode.text !== keyName) {
            renamedOut?.push({ local: localNode.text, imported: keyName });
          }
        } else if (keyName) {
          // Nested pattern (`{ foo: { nested } }`) or other unsupported
          // value shape — no single local binding to extract; fall back to
          // the key so the specifier isn't dropped entirely.
          names.push(keyName);
        }
      } else if (child.type === 'object_assignment_pattern') {
        // { a = defaultValue } — plain shorthand binding with a default
        // value; the bound name is the `left`-hand identifier (#1920).
        const left = child.childForFieldName('left');
        if (left?.type === 'shorthand_property_identifier_pattern' || left?.type === 'identifier') {
          names.push(left.text);
        }
      } else if (child.type === 'rest_pattern' || child.type === 'rest_element') {
        // { a, ...rest } — the rest binding was silently dropped entirely
        // before (#1920).
        const inner = extractRestPatternIdentifier(child);
        if (inner) names.push(inner);
      }
    }
    return names;
  }

  // const mod = await import(...)  →  identifier (namespace-like import)
  if (nameNode.type === 'identifier') {
    return [nameNode.text];
  }

  // const [a, b] = await import(...)  →  array_pattern (rare but possible)
  if (nameNode.type === 'array_pattern') {
    const names: string[] = [];
    for (let i = 0; i < nameNode.childCount; i++) {
      const child = nameNode.child(i)!;
      if (child.type === 'identifier') names.push(child.text);
      else if (child.type === 'rest_pattern' || child.type === 'rest_element') {
        // [a, ...rest] — child(0) is the `...` token, not the identifier
        // (#1920); extractRestPatternIdentifier scans for the real one.
        const inner = extractRestPatternIdentifier(child);
        if (inner) names.push(inner);
      }
    }
    return names;
  }

  return [];
}

// ── Phase 8.X: Prototype-based method extraction ────────────────────────────

/**
 * Walk the AST and extract prototype-based method definitions and aliases.
 *
 * Handles three patterns:
 *   1. `Foo.prototype.bar = function(){...}` — emits Foo.bar as method definition
 *   2. `Foo.prototype.bar = identifier`       — sets typeMap['Foo.bar'] = { type: identifier }
 *   3. `Foo.prototype = { bar: fn, ... }`     — emits defs and typeMap entries per property
 *
 * Emitting definitions under the canonical `ClassName.methodName` name lets the
 * existing typeMap-based call resolver find them when a typed receiver dispatches
 * `instance.method()` (lookup.byName('C.foo') in resolveByMethodOrGlobal).
 *
 * typeMap entries for identifier aliases (`Foo.bar → { type: 'someId' }`) are
 * consumed by the prototype-alias fallback added to resolveByMethodOrGlobal.
 */
// Prototype-method assignments (`Foo.prototype.bar = fn`) are collected inline
// in runCollectorWalk's expression_statement case via handlePrototypeAssignment.

/**
 * Handle an assignment_expression that may be a prototype assignment.
 *
 * Matches:
 *   - `Foo.prototype.bar = rhs`  (lhs ends in .prototype.bar)
 *   - `Foo.prototype = { ... }`  (lhs ends in .prototype, rhs is object literal)
 */
function handlePrototypeAssignment(
  lhs: TreeSitterNode,
  rhs: TreeSitterNode,
  definitions: Definition[],
  typeMap: Map<string, TypeMapEntry>,
): void {
  if (lhs.type !== 'member_expression') return;

  const lhsObj = lhs.childForFieldName('object');
  const lhsProp = lhs.childForFieldName('property');
  if (!lhsObj || !lhsProp) return;

  // Pattern 1: `Foo.prototype.bar = rhs`
  // lhs.object is `Foo.prototype` (member_expression), lhs.property is `bar`
  if (
    lhsObj.type === 'member_expression' &&
    (lhsProp.type === 'property_identifier' || lhsProp.type === 'identifier')
  ) {
    const protoObj = lhsObj.childForFieldName('object');
    const protoProp = lhsObj.childForFieldName('property');
    if (
      protoObj?.type === 'identifier' &&
      protoProp?.text === 'prototype' &&
      !BUILTIN_GLOBALS.has(protoObj.text)
    ) {
      emitPrototypeMethod(protoObj.text, lhsProp.text, rhs, definitions, typeMap);
    }
    return;
  }

  // Pattern 2: `Foo.prototype = { bar: fn, ... }`
  // lhs.object is `Foo` (identifier), lhs.property is `prototype`
  if (
    lhsObj.type === 'identifier' &&
    lhsProp.text === 'prototype' &&
    !BUILTIN_GLOBALS.has(lhsObj.text) &&
    rhs.type === 'object'
  ) {
    extractPrototypeObjectLiteral(lhsObj.text, rhs, definitions, typeMap);
  }
}

/** Emit one prototype method definition or typeMap alias for `ClassName.methodName = rhs`. */
function emitPrototypeMethod(
  className: string,
  methodName: string,
  rhs: TreeSitterNode,
  definitions: Definition[],
  typeMap: Map<string, TypeMapEntry>,
): void {
  const fullName = `${className}.${methodName}`;
  if (rhs.type === 'function_expression' || rhs.type === 'arrow_function') {
    const params = extractParameters(rhs);
    definitions.push({
      name: fullName,
      kind: 'method',
      line: nodeStartLine(rhs),
      endLine: nodeEndLine(rhs),
      children: params.length > 0 ? params : undefined,
    });
  } else if (rhs.type === 'identifier' && !BUILTIN_GLOBALS.has(rhs.text)) {
    // Prototype alias: `A.prototype.t = f` → typeMap['A.t'] = { type: 'f' }
    // Consumed by the prototype-alias fallback in resolveByMethodOrGlobal.
    setTypeMapEntry(typeMap, fullName, rhs.text, 0.9);
  }
}

/**
 * Extract function-as-object property method definitions.
 *
 * Handles `fn.method = function() {}` and `fn.method = () => {}` patterns.
 * Emits a `method` definition named `fn.method` so that:
 *   1. `findCaller` attributes calls inside the body to `fn.method`
 *   2. `resolveByMethodOrGlobal` resolves `this.other()` inside `fn.method` to `fn.other`
 *
 * Excludes BUILTIN_GLOBALS objects and `.prototype` (handled by extractPrototypeMethodsWalk).
 */
// Function-as-object-property assignments (`fn.method = function(){}`) are
// collected inline in runCollectorWalk's expression_statement case (walk path
// only — the query path captures them via the `assign_left`/`assign_right`
// query pattern in dispatchQueryMatch).

function handleFuncPropAssignment(
  lhs: TreeSitterNode,
  rhs: TreeSitterNode,
  definitions: Definition[],
): void {
  if (lhs.type !== 'member_expression') return;
  if (rhs.type !== 'function_expression' && rhs.type !== 'arrow_function') return;

  const obj = lhs.childForFieldName('object');
  const prop = lhs.childForFieldName('property');
  if (!obj || !prop) return;
  if (obj.type !== 'identifier') return;
  if (prop.type !== 'property_identifier' && prop.type !== 'identifier') return;
  if (BUILTIN_GLOBALS.has(obj.text)) return;
  if (prop.text === 'prototype') return;

  const params = extractParameters(rhs);
  definitions.push({
    name: `${obj.text}.${prop.text}`,
    kind: 'method',
    line: nodeStartLine(rhs),
    endLine: nodeEndLine(rhs),
    children: params.length > 0 ? params : undefined,
  });
}

/** Iterate over an object literal assigned to `Foo.prototype` and emit defs/aliases. */
function extractPrototypeObjectLiteral(
  className: string,
  objNode: TreeSitterNode,
  definitions: Definition[],
  typeMap: Map<string, TypeMapEntry>,
): void {
  for (let i = 0; i < objNode.childCount; i++) {
    const child = objNode.child(i);
    if (!child) continue;

    if (child.type === 'method_definition') {
      // Shorthand method: `Foo.prototype = { bar() {} }`
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        const methodName = resolveMethodDefinitionName(nameNode);
        if (methodName) {
          definitions.push({
            name: `${className}.${methodName}`,
            kind: 'method',
            line: nodeStartLine(child),
            endLine: nodeEndLine(child),
          });
        }
      }
      continue;
    }

    if (child.type === 'shorthand_property_identifier') {
      // ES6 shorthand: `Foo.prototype = { bar }` → alias typeMap['Foo.bar'] = { type: 'bar' }
      if (!BUILTIN_GLOBALS.has(child.text)) {
        setTypeMapEntry(typeMap, `${className}.${child.text}`, child.text, 0.9);
      }
      continue;
    }

    if (child.type !== 'pair') continue;

    const keyNode = child.childForFieldName('key');
    const valueNode = child.childForFieldName('value');
    if (!keyNode || !valueNode) continue;

    const methodName = resolvePairKeyName(keyNode);
    if (!methodName) continue;

    emitPrototypeMethod(className, methodName, valueNode, definitions, typeMap);
  }
}
