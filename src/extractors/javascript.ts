import { debug } from '../infrastructure/logger.js';
import type {
  ArrayCallbackBinding,
  ArrayElemBinding,
  Call,
  CallAssignment,
  ClassRelation,
  Definition,
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
  const methName = c.meth_name!.text;
  const parentClass = findParentClass(c.meth_node!);
  const fullName = parentClass ? `${parentClass}.${methName}` : methName;
  const methChildren = extractParameters(c.meth_node!);
  const methVis = extractVisibility(c.meth_node!);
  definitions.push({
    name: fullName,
    kind: 'method',
    line: nodeStartLine(c.meth_node!),
    endLine: nodeEndLine(c.meth_node!),
    children: methChildren.length > 0 ? methChildren : undefined,
    visibility: methVis,
  });
}

/** Handle export_statement capture. */
function handleExportCapture(
  c: Record<string, TreeSitterNode>,
  exps: Export[],
  imports: Import[],
): void {
  const exportLine = nodeStartLine(c.exp_node!);
  const decl = c.exp_node!.childForFieldName('declaration');
  if (decl) {
    const declType = decl.type;
    const kindMap: Record<string, string> = {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      class_declaration: 'class',
      abstract_class_declaration: 'class',
      interface_declaration: 'interface',
      type_alias_declaration: 'type',
    };
    const kind = kindMap[declType];
    if (kind) {
      const n = decl.childForFieldName('name');
      if (n) exps.push({ name: n.text, kind: kind as Export['kind'], line: exportLine });
    }
  }
  const source = c.exp_node!.childForFieldName('source') || findChild(c.exp_node!, 'string');
  if (source && !decl) {
    const modPath = source.text.replace(/['"]/g, '');
    const reexportNames = extractImportNames(c.exp_node!);
    const nodeText = c.exp_node!.text;
    const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
    imports.push({
      source: modPath,
      names: reexportNames,
      line: exportLine,
      reexport: true,
      wildcardReexport: isWildcard && reexportNames.length === 0,
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
  const names = extractImportNames(impNode);
  imports.push({
    source: modPath,
    names,
    line: nodeStartLine(impNode),
    typeOnly: isTypeOnly,
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
    calls.push({
      name: c.callfn_name!.text,
      line: nodeStartLine(c.callfn_node),
    });
    calls.push(...extractCallbackReferenceCalls(c.callfn_node));
  } else if (c.callmem_node) {
    const callInfo = extractCallInfo(c.callmem_fn!, c.callmem_node);
    if (callInfo) calls.push(callInfo);
    const cbDef = extractCallbackDefinition(c.callmem_node, c.callmem_fn);
    if (cbDef) definitions.push(cbDef);
    calls.push(...extractCallbackReferenceCalls(c.callmem_node));
  } else if (c.callsub_node) {
    const callInfo = extractCallInfo(c.callsub_fn!, c.callsub_node);
    if (callInfo) calls.push(callInfo);
    calls.push(...extractCallbackReferenceCalls(c.callsub_node));
  } else if (c.newfn_node) {
    calls.push({
      name: c.newfn_name!.text,
      line: nodeStartLine(c.newfn_node),
    });
  } else if (c.newmem_node) {
    const callInfo = extractCallInfo(c.newmem_fn!, c.newmem_node);
    if (callInfo) calls.push(callInfo);
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

  const matches = query.matches(tree.rootNode);

  for (const match of matches) {
    // Build capture lookup for this match (1-3 captures each, very fast)
    const c: Record<string, TreeSitterNode> = Object.create(null);
    for (const cap of match.captures) c[cap.name] = cap.node;
    dispatchQueryMatch(c, definitions, calls, imports, classes, exps);
  }

  // Extract top-level constants via targeted walk (query patterns don't cover these)
  extractConstantsWalk(tree.rootNode, definitions);

  // Extract dynamic import() calls via targeted walk (query patterns don't match `import` function type)
  extractDynamicImportsWalk(tree.rootNode, imports);

  // Phase 8.2: Extract function return types first so propagation can use them
  extractReturnTypeMapWalk(tree.rootNode, returnTypeMap);

  // Extract typeMap with intra-file return-type propagation
  extractTypeMapWalk(tree.rootNode, typeMap, returnTypeMap, callAssignments, fnRefBindings);

  // Prototype-based method definitions: `Foo.prototype.bar = fn` and `Foo.prototype = { bar: fn }`
  extractPrototypeMethodsWalk(tree.rootNode, definitions, typeMap);

  // Phase 8.3c: Extract call-site argument bindings for parameter-flow pts analysis
  extractParamBindingsWalk(tree.rootNode, paramBindings);

  // Phase 8.3e: Extract array-element and spread/for-of/Array.from bindings
  extractArrayElemBindingsWalk(tree.rootNode, arrayElemBindings);
  extractSpreadForOfWalk(
    tree.rootNode,
    spreadArgBindings,
    forOfBindings,
    arrayCallbackBindings,
    fnRefBindings,
  );

  // Extract definitions from destructured bindings (query patterns don't match object_pattern)
  extractDestructuredBindingsWalk(tree.rootNode, definitions);

  // Extract class field definitions and static blocks (query patterns don't cover these)
  extractClassMembersWalk(tree.rootNode, definitions);

  // Phase 8.3f: Extract object-rest parameter and object-property bindings
  extractObjectRestParamBindingsWalk(tree.rootNode, objectRestParamBindings);
  extractObjectPropBindingsWalk(tree.rootNode, objectPropBindings);

  // Phase 8.5: collect all `new X()` constructor names for RTA instantiation tracking
  const newExpressions: string[] = [];
  extractNewExpressionsWalk(tree.rootNode, newExpressions);

  // Object.defineProperty accessor receiver bindings
  const definePropertyReceivers: Map<string, string> = new Map();
  extractDefinePropertyReceiversWalk(tree.rootNode, definePropertyReceivers);

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
    newExpressions,
    ...(definePropertyReceivers.size > 0 ? { definePropertyReceivers } : {}),
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

    // Recurse into non-function, non-export-statement children (blocks, if-statements, etc.)
    if (child.type !== 'export_statement') {
      extractConstantsWalk(child, definitions);
    }
  }
}

/**
 * Walk the AST to extract class field definitions and static initializer blocks.
 * Query patterns capture method_definition but not field_definition or class_static_block.
 * Called by the query-based fast path (extractSymbolsQuery); the walk-based path
 * (extractSymbolsWalk) handles these same node types via walkJavaScriptNode's switch cases.
 */
function extractClassMembersWalk(node: TreeSitterNode, definitions: Definition[]): void {
  function walk(n: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (n.type === 'field_definition' || n.type === 'public_field_definition') {
      handleFieldDef(n, definitions);
    } else if (n.type === 'class_static_block') {
      handleStaticBlock(n, definitions);
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!, depth + 1);
    }
  }
  walk(node, 0);
}

/**
 * Walk the AST to find destructured const bindings (query patterns don't match object_pattern).
 * e.g. `const { handleToken, checkPermissions } = initAuth(config)`
 */
function extractDestructuredBindingsWalk(node: TreeSitterNode, definitions: Definition[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (FUNCTION_SCOPE_TYPES.has(child.type)) continue;

    let declNode = child;
    if (child.type === 'export_statement') {
      const inner = child.childForFieldName('declaration');
      if (inner) declNode = inner;
    }

    const t = declNode.type;
    if (
      (t === 'lexical_declaration' || t === 'variable_declaration') &&
      declNode.text.startsWith('const ')
    ) {
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
        }
      }
    }

    if (child.type !== 'export_statement') {
      extractDestructuredBindingsWalk(child, definitions);
    }
  }
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
    if (isConstantValue(valueN)) {
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
}

/**
 * Recursive walk to find dynamic import() calls.
 * Query patterns match call_expression with identifier/member_expression/subscript_expression
 * functions, but import() has function type `import` which none of those patterns cover.
 */
function extractDynamicImportsWalk(node: TreeSitterNode, imports: Import[]): void {
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn && fn.type === 'import') {
      const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
      if (args) {
        const strArg = findChild(args, 'string');
        if (strArg) {
          const modPath = strArg.text.replace(/['"]/g, '');
          const names = extractDynamicImportNames(node);
          imports.push({
            source: modPath,
            names,
            line: nodeStartLine(node),
            dynamicImport: true,
          });
        } else {
          debug(
            `Skipping non-static dynamic import() at line ${nodeStartLine(node)} (template literal or variable)`,
          );
        }
      }
      return; // no need to recurse into import() children
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    extractDynamicImportsWalk(node.child(i)!, imports);
  }
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
  };

  walkJavaScriptNode(tree.rootNode, ctx);
  // Phase 8.2: Extract function return types first so propagation can use them
  extractReturnTypeMapWalk(tree.rootNode, ctx.returnTypeMap!);
  // Populate typeMap with type annotations and intra-file return-type propagation
  extractTypeMapWalk(
    tree.rootNode,
    ctx.typeMap!,
    ctx.returnTypeMap,
    ctx.callAssignments,
    ctx.fnRefBindings,
  );
  // Prototype-based method definitions: `Foo.prototype.bar = fn` and `Foo.prototype = { bar: fn }`
  extractPrototypeMethodsWalk(tree.rootNode, ctx.definitions, ctx.typeMap!);
  // Function-as-object property methods: `fn.method = function() { ... }`
  extractFuncPropMethodsWalk(tree.rootNode, ctx.definitions);
  // Phase 8.3c: Extract call-site argument bindings for parameter-flow pts analysis
  extractParamBindingsWalk(tree.rootNode, ctx.paramBindings!);
  // Phase 8.3e: Extract array-element and spread/for-of/Array.from bindings
  extractArrayElemBindingsWalk(tree.rootNode, ctx.arrayElemBindings!);
  extractSpreadForOfWalk(
    tree.rootNode,
    ctx.spreadArgBindings!,
    ctx.forOfBindings!,
    ctx.arrayCallbackBindings!,
    ctx.fnRefBindings!,
  );
  // Phase 8.3f: Extract object-rest parameter and object-property bindings
  extractObjectRestParamBindingsWalk(tree.rootNode, ctx.objectRestParamBindings!);
  extractObjectPropBindingsWalk(tree.rootNode, ctx.objectPropBindings!);
  // Phase 8.5: collect all `new X()` constructor names for RTA instantiation tracking
  const newExpressions: string[] = [];
  extractNewExpressionsWalk(tree.rootNode, newExpressions);
  ctx.newExpressions = newExpressions;
  // Object.defineProperty accessor receiver bindings
  const definePropertyReceivers: Map<string, string> = new Map();
  extractDefinePropertyReceiversWalk(tree.rootNode, definePropertyReceivers);
  if (definePropertyReceivers.size > 0) ctx.definePropertyReceivers = definePropertyReceivers;
  return ctx;
}

function walkJavaScriptNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      handleFunctionDecl(node, ctx);
      break;
    case 'class_declaration':
    case 'abstract_class_declaration':
      handleClassDecl(node, ctx);
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
    case 'call_expression':
      handleCallExpr(node, ctx);
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
    case 'field_definition':
    case 'public_field_definition':
      handleFieldDef(node, ctx.definitions);
      break;
    case 'class_static_block':
      handleStaticBlock(node, ctx.definitions);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walkJavaScriptNode(node.child(i)!, ctx);
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
    const parentClass = findParentClass(node);
    const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
    const methChildren = extractParameters(node);
    const methVis = extractVisibility(node);
    ctx.definitions.push({
      name: fullName,
      kind: 'method',
      line: nodeStartLine(node),
      endLine: nodeEndLine(node),
      children: methChildren.length > 0 ? methChildren : undefined,
      visibility: methVis,
    });
  }
}

/**
 * Emit a `ClassName.fieldName` definition for class fields that have an initializer.
 * This lets `findCaller` attribute calls inside field initializers (e.g. static field
 * side-effects) to the field rather than the enclosing class.
 */
function handleFieldDef(node: TreeSitterNode, definitions: Definition[]): void {
  // JS field_definition uses 'property' field; TS public_field_definition uses 'name' field
  const nameNode = node.childForFieldName('name') || node.childForFieldName('property');
  const valueNode = node.childForFieldName('value');
  if (!nameNode || !valueNode) return;
  if (nameNode.type === 'computed_property_name') return;
  const fieldName = nameNode.text;
  if (!fieldName) return;
  const className = findParentClass(node);
  if (!className) return;
  definitions.push({
    name: `${className}.${fieldName}`,
    kind: 'method',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
  });
}

/**
 * Emit a `ClassName.<static>` definition for each `static { }` block.
 * Enables `findCaller` to attribute calls inside static initializer blocks to
 * this synthetic node rather than to the enclosing class node.
 */
function handleStaticBlock(node: TreeSitterNode, definitions: Definition[]): void {
  const className = findParentClass(node);
  if (!className) return;
  definitions.push({
    name: `${className}.<static>`,
    kind: 'function',
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
 * for handleToken and checkPermissions so they can be resolved as call targets.
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
      definitions.push({ name: child.text, kind: 'function', line, endLine });
    } else if (child.type === 'pair_pattern' || child.type === 'pair') {
      // { original: renamed } — renamed binding, use the local alias
      const value = child.childForFieldName('value');
      if (
        value &&
        (value.type === 'identifier' || value.type === 'shorthand_property_identifier_pattern')
      ) {
        definitions.push({ name: value.text, kind: 'function', line, endLine });
      }
    }
  }
}

function handleVariableDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isConst = node.text.startsWith('const ');
  for (let i = 0; i < node.childCount; i++) {
    const declarator = node.child(i);
    if (declarator && declarator.type === 'variable_declarator') {
      const nameN = declarator.childForFieldName('name');
      const valueN = declarator.childForFieldName('value');

      if (nameN && valueN) {
        const valType = valueN.type;
        if (
          valType === 'arrow_function' ||
          valType === 'function_expression' ||
          valType === 'function' ||
          valType === 'generator_function'
        ) {
          const varFnChildren = extractParameters(valueN);
          ctx.definitions.push({
            name: nameN.text,
            kind: 'function',
            line: nodeStartLine(node),
            endLine: nodeEndLine(valueN),
            children: varFnChildren.length > 0 ? varFnChildren : undefined,
          });
        } else if (
          isConst &&
          nameN.type === 'identifier' &&
          isConstantValue(valueN) &&
          !hasFunctionScopeAncestor(node)
        ) {
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
        } else if (isConst && nameN.type === 'object_pattern' && !hasFunctionScopeAncestor(node)) {
          // Destructured bindings: const { handleToken, checkPermissions } = initAuth(...)
          // Each destructured property becomes a function definition so it can be
          // resolved when passed as a callback (e.g. router.use(handleToken)).
          // Restricted to const to avoid creating spurious definitions for
          // transient let/var destructuring (e.g. let { userId } = parseRequest(req)).
          // Scope guard mirrors extractDestructuredBindingsWalk (query path) and
          // handle_var_decl (Rust path) — skips bindings inside function bodies.
          extractDestructuredBindings(
            nameN,
            nodeStartLine(node),
            nodeEndLine(node),
            ctx.definitions,
          );
        }
      }
    }
  }
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
      const keyName =
        keyNode.type === 'string' ? keyNode.text.replace(/^['"]|['"]$/g, '') : keyNode.text;
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
        definitions.push({
          name: `${varName}.${nameNode.text}`,
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

function handleCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'import') {
    handleDynamicImportCall(node, ctx.imports);
  } else {
    const callInfo = extractCallInfo(fn, node);
    if (callInfo) ctx.calls.push(callInfo);
    if (fn.type === 'member_expression') {
      const cbDef = extractCallbackDefinition(node, fn);
      if (cbDef) ctx.definitions.push(cbDef);
    }
    ctx.calls.push(...extractCallbackReferenceCalls(node));
  }
}

function handleNewExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const ctor = node.childForFieldName('constructor') || node.child(1);
  if (!ctor) return;
  if (ctor.type === 'identifier') {
    ctx.calls.push({ name: ctor.text, line: nodeStartLine(node) });
  } else if (ctor.type === 'member_expression') {
    const callInfo = extractCallInfo(ctor, node);
    if (callInfo) ctx.calls.push(callInfo);
  }
}

/** Handle a dynamic import() call expression and add to imports if static. */
function handleDynamicImportCall(node: TreeSitterNode, imports: Import[]): void {
  const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
  if (!args) return;
  const strArg = findChild(args, 'string');
  if (strArg) {
    const modPath = strArg.text.replace(/['"]/g, '');
    const names = extractDynamicImportNames(node);
    imports.push({ source: modPath, names, line: nodeStartLine(node), dynamicImport: true });
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
    const names = extractImportNames(node);
    ctx.imports.push({
      source: modPath,
      names,
      line: nodeStartLine(node),
      typeOnly: isTypeOnly,
    });
  }
}

function handleExportStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const exportLine = nodeStartLine(node);
  const decl = node.childForFieldName('declaration');
  if (decl) {
    const declType = decl.type;
    const kindMap: Record<string, string> = {
      function_declaration: 'function',
      generator_function_declaration: 'function',
      class_declaration: 'class',
      abstract_class_declaration: 'class',
      interface_declaration: 'interface',
      type_alias_declaration: 'type',
    };
    const kind = kindMap[declType];
    if (kind) {
      const n = decl.childForFieldName('name');
      if (n) ctx.exports.push({ name: n.text, kind: kind as Export['kind'], line: exportLine });
    }
  }
  const source = node.childForFieldName('source') || findChild(node, 'string');
  if (source && !decl) {
    const modPath = source.text.replace(/['"]/g, '');
    const reexportNames = extractImportNames(node);
    const nodeText = node.text;
    const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
    ctx.imports.push({
      source: modPath,
      names: reexportNames,
      line: exportLine,
      reexport: true,
      wildcardReexport: isWildcard && reexportNames.length === 0,
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

function isConstantValue(valueNode: TreeSitterNode): boolean {
  if (!valueNode) return false;
  const t = valueNode.type;
  return (
    t === 'number' ||
    t === 'string' ||
    t === 'template_string' ||
    t === 'true' ||
    t === 'false' ||
    t === 'null' ||
    t === 'undefined' ||
    t === 'array' ||
    t === 'object' ||
    t === 'regex' ||
    t === 'unary_expression' ||
    t === 'binary_expression' ||
    t === 'new_expression'
  );
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
          kind: 'method',
          line: nodeStartLine(child),
          endLine: nodeEndLine(child),
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
      if (!existing || 0.85 > existing.confidence)
        returnTypeMap.set(fnName, { type: inferred, confidence: 0.85 });
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
function extractNewExpressionsWalk(rootNode: TreeSitterNode, newExpressions: string[]): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'new_expression') {
      const name = extractNewExprTypeName(node);
      if (name) newExpressions.push(name);
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

/**
 * Walk the AST to find `Object.defineProperty(obj, "bar", { get: getter })` patterns
 * and record which functions are used as getter/setter accessors for which objects.
 *
 * Result is stored in the provided map as `funcName → receiverVarName`.
 */
function extractDefinePropertyReceiversWalk(
  rootNode: TreeSitterNode,
  out: Map<string, string>,
): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      // Match `Object.defineProperty`
      if (fn?.type === 'member_expression') {
        const obj = fn.childForFieldName('object');
        const prop = fn.childForFieldName('property');
        if (
          obj?.type === 'identifier' &&
          obj.text === 'Object' &&
          prop?.text === 'defineProperty'
        ) {
          const argsNode = node.childForFieldName('arguments') ?? findChild(node, 'arguments');
          if (argsNode) {
            // Collect non-punctuation children: arg0 (target obj), arg1 (prop name string), arg2 (descriptor)
            const argChildren: TreeSitterNode[] = [];
            for (let i = 0; i < argsNode.childCount; i++) {
              const c = argsNode.child(i);
              if (!c) continue;
              if (c.type === ',' || c.type === '(' || c.type === ')') continue;
              argChildren.push(c);
            }
            if (argChildren.length >= 3) {
              const targetObj = argChildren[0];
              const descriptor = argChildren[2];
              if (targetObj?.type === 'identifier' && descriptor?.type === 'object') {
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
            }
          }
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, depth + 1);
    }
  }
  walk(rootNode, 0);
}

/**
 * Extract variable-to-type assignments into a per-file type map.
 *
 * Values are `{ type: string, confidence: number }`:
 *   - 1.0: explicit constructor (`new Foo()`)
 *   - 0.9: type annotation (`: Foo`) or typed parameter
 *   - 0.85: property write (`obj.prop = fn` — Phase 8.3d pts tracking)
 *   - 0.7–0.9: inter-procedural propagation from return-type map (Phase 8.2)
 *   - 0.7: factory method call (`Foo.create()` — uppercase-first heuristic)
 *
 * Higher-confidence entries take priority when the same variable is seen twice.
 */
function extractTypeMapWalk(
  rootNode: TreeSitterNode,
  typeMap: Map<string, TypeMapEntry>,
  returnTypeMap?: Map<string, TypeMapEntry>,
  callAssignments?: CallAssignment[],
  fnRefBindings?: FnRefBinding[],
): void {
  function walk(node: TreeSitterNode, depth: number, currentClass: string | null): void {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;
    if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode?.text ?? null;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, depth + 1, className);
      }
      return;
    }
    // Class expressions (e.g. `const Foo = class Bar { ... }`): the expression-internal
    // name (`Bar`) is never visible to the resolver, which derives callerClass from the
    // binding name (`Foo`). Walking with null preserves the pre-fix `this.prop` fallback
    // so the second lookup in resolveByMethodOrGlobal still finds the entry.
    if (t === 'class') {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, depth + 1, null);
      }
      return;
    }
    if (t === 'variable_declarator') {
      handleVarDeclaratorTypeMap(node, typeMap, returnTypeMap, callAssignments, fnRefBindings);
    } else if (t === 'required_parameter' || t === 'optional_parameter') {
      handleParamTypeMap(node, typeMap);
    } else if (t === 'assignment_expression') {
      handlePropWriteTypeMap(node, typeMap, currentClass);
    } else if (t === 'call_expression') {
      handleDefinePropertyTypeMap(node, typeMap);
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1, currentClass);
    }
  }
  walk(rootNode, 0, null);
}

/** Extract type info from a variable_declarator: type annotation, constructor, or factory. */
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

  // Phase 8.3: record function-reference bindings before any type-analysis early returns.
  // Captures `const fn = handler` (identifier) and `const fn = obj.method` (member_expression).
  // Also handles `const f = fn.bind(ctx)` — bind returns a new function aliasing fn.
  if (fnRefBindings && valueN) {
    if (valueN.type === 'identifier' && !BUILTIN_GLOBALS.has(valueN.text)) {
      fnRefBindings.push({ lhs: nameN.text, rhs: valueN.text });
    } else if (valueN.type === 'member_expression') {
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
        fnRefBindings.push({ lhs: nameN.text, rhs: prop.text, rhsReceiver: obj.text });
      }
    } else if (valueN.type === 'call_expression') {
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
            fnRefBindings.push({ lhs: nameN.text, rhs: boundFn.text });
          }
        }
      }
    }
  }

  // Constructor on the same declaration wins over annotation: the runtime type is
  // what matters for call resolution (e.g. `const x: Base = new Derived()` should
  // resolve `x.render()` to `Derived.render`, not `Base.render`).
  // When no constructor is present, annotation still takes precedence over factory.
  if (valueN?.type === 'new_expression') {
    const ctorType = extractNewExprTypeName(valueN);
    if (ctorType) {
      setTypeMapEntry(typeMap, nameN.text, ctorType, 1.0);
      return;
    }
  }

  // Type annotation: const x: Foo = … → confidence 0.9
  if (typeAnno) {
    const typeName = extractSimpleTypeName(typeAnno);
    if (typeName) {
      setTypeMapEntry(typeMap, nameN.text, typeName, 0.9);
      return;
    }
  }

  if (!valueN) return;
  if (valueN.type === 'new_expression') return;

  if (valueN.type === 'call_expression') {
    // Phase 8.3e: Object.create({ f1, f2 }) — seed composite pts keys obj.f1 → f1, etc.
    const createFn = valueN.childForFieldName('function');
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
            seedProtoProperties(nameN.text, proto, typeMap);
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
        setTypeMapEntry(typeMap, nameN.text, result.type, result.confidence);
        return;
      }
    }
    // Record for cross-file resolution in build-edges.ts (imported functions)
    if (callAssignments) {
      recordCallAssignment(valueN, nameN.text, typeMap, callAssignments);
    }
    // Factory method heuristic: const x = Foo.create() → type Foo, confidence 0.7
    const fn = valueN.childForFieldName('function');
    if (fn?.type === 'member_expression') {
      const obj = fn.childForFieldName('object');
      if (obj?.type === 'identifier') {
        const objName = obj.text;
        if (
          objName[0] &&
          objName[0] !== objName[0].toLowerCase() &&
          !BUILTIN_GLOBALS.has(objName)
        ) {
          setTypeMapEntry(typeMap, nameN.text, objName, 0.7);
        }
      }
    }
  }

  // Phase 8.3f: seed composite pts keys for object literal properties.
  // `const obj = { baz: () => {} }` → typeMap['obj.baz'] = 'obj.baz'
  // `const obj = { baz }` (shorthand) → typeMap['obj.baz'] = 'baz'  (bare identifier target)
  // `const obj = { baz: otherFn }` → typeMap['obj.baz'] = 'otherFn'  (identifier alias)
  //
  // For function/arrow values, the value is the qualified name ('obj.baz') because
  // extractObjectLiteralFunctions now registers definitions under that qualified name to avoid
  // polluting the global index with bare property names like 'init', 'run', or 'render'.
  // Enables accessor this-dispatch: when typeMap['getter:this'] = 'obj',
  // resolving this.baz() inside getter → typeMap['obj.baz'] → 'obj.baz' → lookup.byName('obj.baz').
  //
  // Scope guard: mirrors Rust handle_var_decl's find_parent_of_types check — skip object literals
  // inside function bodies so function-scoped `const localObj = { fn: ... }` never seeds
  // the typeMap (which would shadow a module-level `const obj` with the same property names).
  if (valueN.type === 'object' && !hasFunctionScopeAncestor(node)) {
    for (let i = 0; i < valueN.childCount; i++) {
      const child = valueN.child(i);
      if (!child) continue;
      if (child.type === 'shorthand_property_identifier') {
        setTypeMapEntry(typeMap, `${nameN.text}.${child.text}`, child.text, 0.85);
      } else if (child.type === 'pair') {
        const keyNode = child.childForFieldName('key');
        const valNode = child.childForFieldName('value');
        if (!keyNode || !valNode) continue;
        const keyName =
          keyNode.type === 'string' ? keyNode.text.replace(/^['"]|['"]$/g, '') : keyNode.text;
        if (!keyName) continue;
        const qualifiedKey = `${nameN.text}.${keyName}`;
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
        const qualifiedKey = `${nameN.text}.${nameNode.text}`;
        setTypeMapEntry(typeMap, qualifiedKey, qualifiedKey, 0.85);
      }
    }
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
      const key = keyN.type === 'string' ? keyN.text.replace(/^['"]|['"]$/g, '') : keyN.text;
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
      const key = keyN.type === 'string' ? keyN.text.replace(/^['"]|['"]$/g, '') : keyN.text;
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
function extractParamBindingsWalk(rootNode: TreeSitterNode, paramBindings: ParamBinding[]): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'call_expression') {
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
          }
          argIdx++;
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

/** Collection constructors whose argument is treated as an element source. */
const COLLECTION_CTOR_SET = new Set(['Set', 'Map']);

/**
 * Phase 8.3e: Extract array-element bindings from `const arr = [fn1, fn2]` patterns.
 * Emits an ArrayElemBinding for each identifier element in an array literal assigned
 * to a variable.
 */
function extractArrayElemBindingsWalk(
  rootNode: TreeSitterNode,
  arrayElemBindings: ArrayElemBinding[],
): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'variable_declarator') {
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
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

/**
 * Phase 8.3e: Extract spread-argument, for-of, Array.from, and collection-wrap bindings.
 *
 * - Spread: `f(...arr)` → SpreadArgBinding
 * - Array.from: `Array.from(src, cb)` → ArrayCallbackBinding
 * - Collection wrap: `new Set(arr)` / `new Map(arr)` → FnRefBinding lhs=s[*] rhs=arr[*]
 * - For-of: `for (const x of arr)` → ForOfBinding
 */
function extractSpreadForOfWalk(
  rootNode: TreeSitterNode,
  spreadArgBindings: SpreadArgBinding[],
  forOfBindings: ForOfBinding[],
  arrayCallbackBindings: ArrayCallbackBinding[],
  fnRefBindings: FnRefBinding[],
): void {
  const funcStack: string[] = [];
  // Tracks the enclosing class name so that method_definition nodes push a
  // qualified name (e.g. 'Foo.bar') matching what findCaller returns from the
  // definitions array (where class methods are stored as 'Foo.bar').
  const classStack: string[] = [];

  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;

    let pushedFunc = false;
    let pushedClass = false;
    if (
      node.type === 'class_declaration' ||
      node.type === 'abstract_class_declaration' ||
      node.type === 'class'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        classStack.push(nameNode.text);
        pushedClass = true;
      }
    } else if (
      node.type === 'function_declaration' ||
      node.type === 'generator_function_declaration'
    ) {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'identifier') {
        funcStack.push(nameNode.text);
        pushedFunc = true;
      }
    } else if (node.type === 'method_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        // Qualify with the enclosing class name so the PTS key matches
        // callerName from findCaller (which uses def.name = 'ClassName.method').
        const enclosingClass = classStack.length > 0 ? classStack[classStack.length - 1] : null;
        const qualifiedName = enclosingClass ? `${enclosingClass}.${nameNode.text}` : nameNode.text;
        funcStack.push(qualifiedName);
        pushedFunc = true;
      }
    } else if (node.type === 'variable_declarator') {
      // `const process = (arr) => { ... }` — arrow/expression functions assigned
      // to a variable have no `name` field on the function node itself.
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (
        nameNode?.type === 'identifier' &&
        (valueNode?.type === 'arrow_function' || valueNode?.type === 'function_expression')
      ) {
        funcStack.push(nameNode.text);
        pushedFunc = true;
      }
    }

    if (node.type === 'call_expression') {
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

    // Collection wrap: const s = new Set(arr) or new Map(arr)
    if (node.type === 'variable_declarator') {
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

    // For-of: for (const x of arr)
    if (node.type === 'for_in_statement') {
      let isForOf = false;
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.text === 'of') {
          isForOf = true;
          break;
        }
      }
      if (isForOf) {
        const right = node.childForFieldName('right');
        if (right?.type === 'identifier' && !BUILTIN_GLOBALS.has(right.text)) {
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
          // Use '<module>' as sentinel for top-level for-of outside any function.
          const enclosingFunc =
            funcStack.length > 0 ? funcStack[funcStack.length - 1]! : '<module>';
          if (varName && !BUILTIN_GLOBALS.has(varName)) {
            forOfBindings.push({ varName, sourceName: right.text, enclosingFunc });
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }

    if (pushedFunc) funcStack.pop();
    if (pushedClass) classStack.pop();
  }

  walk(rootNode, 0);
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
function extractObjectRestParamBindingsWalk(
  rootNode: TreeSitterNode,
  bindings: ObjectRestParamBinding[],
): void {
  function walk(node: TreeSitterNode, depth: number, currentClass: string | null): void {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;
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
        if (
          vt === 'arrow_function' ||
          vt === 'function_expression' ||
          vt === 'generator_function'
        ) {
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
      // Skip computed property keys (e.g. `{ [Symbol.iterator]: function({ ...rest }) {} }`)
      // because `callee: '[Symbol.iterator]'` can never match a paramBinding callee.
      const keyN = node.childForFieldName('key');
      const valueN = node.childForFieldName('value');
      if (keyN && valueN && keyN.type !== 'computed_property_name') {
        const vt = valueN.type;
        if (
          vt === 'arrow_function' ||
          vt === 'function_expression' ||
          vt === 'generator_function'
        ) {
          fnName = keyN.type === 'string' ? keyN.text.slice(1, -1) : keyN.text;
          paramsNode =
            valueN.childForFieldName('parameters') ?? findChild(valueN, 'formal_parameters');
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

    // Thread class name into class_body children; reset for all other contexts.
    let childClass: string | null = null;
    if (t === 'class_declaration' || t === 'class') {
      childClass = node.childForFieldName('name')?.text ?? null;
    } else if (t === 'class_body') {
      childClass = currentClass;
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1, childClass);
    }
  }
  walk(rootNode, 0, null);
}

/**
 * Phase 8.3f: collect object-property bindings from object literals.
 *
 * `const obj = { e4 }` → `{ objectName: "obj", propName: "e4", valueName: "e4" }`
 * `const obj = { e1: fn }` → `{ objectName: "obj", propName: "e1", valueName: "fn" }`
 *
 * Only tracks shorthand and `key: identifier` pairs; skips function literals.
 */
function extractObjectPropBindingsWalk(
  rootNode: TreeSitterNode,
  bindings: ObjectPropBinding[],
): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'variable_declarator') {
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
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

function extractReceiverName(objNode: TreeSitterNode | null): string | undefined {
  if (!objNode) return undefined;
  const t = objNode.type;
  if (t === 'identifier' || t === 'this' || t === 'super') return objNode.text;
  return objNode.text;
}

function extractCallInfo(fn: TreeSitterNode, callNode: TreeSitterNode): Call | null {
  const fnType = fn.type;
  if (fnType === 'identifier') {
    return { name: fn.text, line: nodeStartLine(callNode) };
  }
  if (fnType === 'member_expression') {
    return extractMemberExprCallInfo(fn, callNode);
  }
  if (fnType === 'subscript_expression') {
    return extractSubscriptCallInfo(fn, callNode);
  }
  return null;
}

/** Extract call info from a member_expression function node (obj.method()). */
function extractMemberExprCallInfo(fn: TreeSitterNode, callNode: TreeSitterNode): Call | null {
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!prop) return null;

  const callLine = nodeStartLine(callNode);
  const propText = prop.text;

  // .call()/.apply()/.bind() — dynamic invocation
  if (propText === 'call' || propText === 'apply' || propText === 'bind') {
    if (obj && obj.type === 'identifier') return { name: obj.text, line: callLine, dynamic: true };
    if (obj && obj.type === 'member_expression') {
      const innerProp = obj.childForFieldName('property');
      if (innerProp) return { name: innerProp.text, line: callLine, dynamic: true };
    }
  }

  // Computed property: obj["method"]()
  const propType = prop.type;
  if (propType === 'string' || propType === 'string_fragment') {
    const methodName = propText.replace(/['"]/g, '');
    if (methodName) {
      const receiver = extractReceiverName(obj);
      return { name: methodName, line: callLine, dynamic: true, receiver };
    }
  }

  const receiver = extractReceiverName(obj);
  return { name: propText, line: callLine, receiver };
}

/** Extract call info from a subscript_expression function node (obj["method"]()). */
function extractSubscriptCallInfo(fn: TreeSitterNode, callNode: TreeSitterNode): Call | null {
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
        receiver,
      };
    }
  }
  return null;
}

/**
 * Callee names that idiomatically accept callback references. Used to gate
 * member_expression args in {@link extractCallbackReferenceCalls}: arguments
 * like `user.id` are only emitted as dynamic callback calls when the callee
 * is a known callback-accepting API (router/middleware, promises, array
 * methods, event emitters, scheduling APIs). This avoids false positives
 * from plain property reads passed as data, e.g. `store.set(user.id, user)`.
 *
 * Identifier args (e.g. `router.use(handleToken)`) are always emitted — the
 * collateral damage of dropping them is larger than the FP risk, since plain
 * identifier data args rarely collide with real function names.
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
 * Extract Call entries for named function references passed as arguments.
 * e.g. `router.use(handleToken, checkAuth)` yields calls to handleToken and checkAuth.
 * `app.use(auth.validate)` yields a call to validate with receiver auth.
 * Skips literals, objects, arrays, anonymous functions, and call expressions (already handled).
 *
 * To avoid false positives where plain property reads are passed as data
 * (e.g. `store.set(user.id, user)` — `user.id` is a value, not a callback),
 * member_expression args are only emitted when the callee is in
 * {@link CALLBACK_ACCEPTING_CALLEES}. Identifier args are always emitted.
 *
 * HTTP-verb callees (`get`, `post`, `put`, `delete`, `patch`, `options`,
 * `head`, `all`) double as Map/cache/repository method names, so their
 * member-expr args are only emitted when the first argument is a string
 * literal route path — matching Express/router shape and skipping
 * `cache.get(user.id)`-style calls.
 */
function extractCallbackReferenceCalls(callNode: TreeSitterNode): Call[] {
  const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
  if (!args) return [];

  const calleeName = extractCalleeName(callNode);
  let memberExprArgsAllowed = calleeName !== null && CALLBACK_ACCEPTING_CALLEES.has(calleeName);
  if (memberExprArgsAllowed && calleeName !== null && HTTP_VERB_CALLEES.has(calleeName)) {
    // HTTP verbs require a string-literal route path to be treated as a
    // callback-accepting API; otherwise `cache.get(user.id)` etc. would
    // still emit `id` as a dynamic call.
    memberExprArgsAllowed = firstArgIsStringLiteral(args);
  }

  const result: Call[] = [];
  const callLine = nodeStartLine(callNode);

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;

    if (child.type === 'identifier') {
      result.push({ name: child.text, line: callLine, dynamic: true });
    } else if (child.type === 'member_expression' && memberExprArgsAllowed) {
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

function extractImportNames(node: TreeSitterNode): string[] {
  const names: string[] = [];
  function scan(n: TreeSitterNode): void {
    if (n.type === 'import_specifier' || n.type === 'export_specifier') {
      const nameNode = n.childForFieldName('name') || n.childForFieldName('alias');
      if (nameNode) names.push(nameNode.text);
      else names.push(n.text);
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
 * Extract destructured names from a dynamic import() call expression.
 *
 * Handles:
 *   const { a, b } = await import('./foo.js')   → ['a', 'b']
 *   const mod = await import('./foo.js')         → ['mod']
 *   import('./foo.js')                           → [] (no names extractable)
 *
 * Walks up the AST from the call_expression to find the enclosing
 * variable_declarator and reads the name/object_pattern.
 */
function extractDynamicImportNames(callNode: TreeSitterNode): string[] {
  // Walk up: call_expression → await_expression → variable_declarator
  let current = callNode.parent;
  // Skip await_expression wrapper if present
  if (current && current.type === 'await_expression') current = current.parent;
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
        // { a: localName } → use localName (the alias) for the local binding,
        // but use the key (original name) for import resolution
        const key = child.childForFieldName('key');
        if (key) names.push(key.text);
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
      else if (child.type === 'rest_pattern') {
        const inner = child.child(0) || child.childForFieldName('name');
        if (inner && inner.type === 'identifier') names.push(inner.text);
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
function extractPrototypeMethodsWalk(
  rootNode: TreeSitterNode,
  definitions: Definition[],
  typeMap: Map<string, TypeMapEntry>,
): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'expression_statement') {
      const expr = node.child(0);
      if (expr?.type === 'assignment_expression') {
        const lhs = expr.childForFieldName('left');
        const rhs = expr.childForFieldName('right');
        if (lhs && rhs) handlePrototypeAssignment(lhs, rhs, definitions, typeMap);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

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
    definitions.push({
      name: fullName,
      kind: 'method',
      line: nodeStartLine(rhs),
      endLine: nodeEndLine(rhs),
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
function extractFuncPropMethodsWalk(rootNode: TreeSitterNode, definitions: Definition[]): void {
  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    if (node.type === 'expression_statement') {
      const expr = node.child(0);
      if (expr?.type === 'assignment_expression') {
        const lhs = expr.childForFieldName('left');
        const rhs = expr.childForFieldName('right');
        if (lhs && rhs) handleFuncPropAssignment(lhs, rhs, definitions);
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, depth + 1);
    }
  }
  walk(rootNode, 0);
}

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
        definitions.push({
          name: `${className}.${nameNode.text}`,
          kind: 'method',
          line: nodeStartLine(child),
          endLine: nodeEndLine(child),
        });
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

    const methodName = keyNode.type === 'string' ? keyNode.text.replace(/['"]/g, '') : keyNode.text;
    if (!methodName) continue;

    emitPrototypeMethod(className, methodName, valueNode, definitions, typeMap);
  }
}
