import { debug } from '../infrastructure/logger.js';
import type {
  Call,
  ClassRelation,
  Definition,
  Export,
  ExtractorOutput,
  Import,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterQuery,
  TreeSitterTree,
  TypeMapEntry,
} from '../types.js';
import { findChild, MAX_WALK_DEPTH, nodeEndLine } from './helpers.js';

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
]);

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

function extractSymbolsQuery(tree: TreeSitterTree, query: TreeSitterQuery): ExtractorOutput {
  const definitions: Definition[] = [];
  const calls: Call[] = [];
  const imports: Import[] = [];
  const classes: ClassRelation[] = [];
  const exps: Export[] = [];
  const typeMap: Map<string, TypeMapEntry> = new Map();

  const matches = query.matches(tree.rootNode);

  for (const match of matches) {
    // Build capture lookup for this match (1-3 captures each, very fast)
    const c: Record<string, TreeSitterNode> = Object.create(null);
    for (const cap of match.captures) c[cap.name] = cap.node;

    if (c.fn_node) {
      // function_declaration
      const fnChildren = extractParameters(c.fn_node);
      definitions.push({
        name: c.fn_name!.text,
        kind: 'function',
        line: c.fn_node.startPosition.row + 1,
        endLine: nodeEndLine(c.fn_node),
        children: fnChildren.length > 0 ? fnChildren : undefined,
      });
    } else if (c.varfn_name) {
      // variable_declarator with arrow_function / function_expression
      const declNode = c.varfn_name.parent?.parent;
      const line = declNode ? declNode.startPosition.row + 1 : c.varfn_name.startPosition.row + 1;
      const varFnChildren = extractParameters(c.varfn_value!);
      definitions.push({
        name: c.varfn_name.text,
        kind: 'function',
        line,
        endLine: nodeEndLine(c.varfn_value!),
        children: varFnChildren.length > 0 ? varFnChildren : undefined,
      });
    } else if (c.cls_node) {
      // class_declaration
      const className = c.cls_name!.text;
      const startLine = c.cls_node.startPosition.row + 1;
      const clsChildren = extractClassProperties(c.cls_node);
      definitions.push({
        name: className,
        kind: 'class',
        line: startLine,
        endLine: nodeEndLine(c.cls_node),
        children: clsChildren.length > 0 ? clsChildren : undefined,
      });
      const heritage =
        c.cls_node.childForFieldName('heritage') || findChild(c.cls_node, 'class_heritage');
      if (heritage) {
        const superName = extractSuperclass(heritage);
        if (superName) classes.push({ name: className, extends: superName, line: startLine });
        const implementsList = extractImplements(heritage);
        for (const iface of implementsList) {
          classes.push({ name: className, implements: iface, line: startLine });
        }
      }
    } else if (c.meth_node) {
      // method_definition
      const methName = c.meth_name!.text;
      const parentClass = findParentClass(c.meth_node);
      const fullName = parentClass ? `${parentClass}.${methName}` : methName;
      const methChildren = extractParameters(c.meth_node);
      const methVis = extractVisibility(c.meth_node);
      definitions.push({
        name: fullName,
        kind: 'method',
        line: c.meth_node.startPosition.row + 1,
        endLine: nodeEndLine(c.meth_node),
        children: methChildren.length > 0 ? methChildren : undefined,
        visibility: methVis,
      });
    } else if (c.iface_node) {
      // interface_declaration (TS/TSX only)
      const ifaceName = c.iface_name!.text;
      definitions.push({
        name: ifaceName,
        kind: 'interface',
        line: c.iface_node.startPosition.row + 1,
        endLine: nodeEndLine(c.iface_node),
      });
      const body =
        c.iface_node.childForFieldName('body') ||
        findChild(c.iface_node, 'interface_body') ||
        findChild(c.iface_node, 'object_type');
      if (body) extractInterfaceMethods(body, ifaceName, definitions);
    } else if (c.type_node) {
      // type_alias_declaration (TS/TSX only)
      definitions.push({
        name: c.type_name!.text,
        kind: 'type',
        line: c.type_node.startPosition.row + 1,
        endLine: nodeEndLine(c.type_node),
      });
    } else if (c.imp_node) {
      // import_statement
      const isTypeOnly = c.imp_node.text.startsWith('import type');
      const modPath = c.imp_source!.text.replace(/['"]/g, '');
      const names = extractImportNames(c.imp_node);
      imports.push({
        source: modPath,
        names,
        line: c.imp_node.startPosition.row + 1,
        typeOnly: isTypeOnly,
      });
    } else if (c.exp_node) {
      // export_statement
      const exportLine = c.exp_node.startPosition.row + 1;
      const decl = c.exp_node.childForFieldName('declaration');
      if (decl) {
        const declType = decl.type;
        const kindMap: Record<string, string> = {
          function_declaration: 'function',
          class_declaration: 'class',
          interface_declaration: 'interface',
          type_alias_declaration: 'type',
        };
        const kind = kindMap[declType];
        if (kind) {
          const n = decl.childForFieldName('name');
          if (n) exps.push({ name: n.text, kind: kind as Export['kind'], line: exportLine });
        }
      }
      const source = c.exp_node.childForFieldName('source') || findChild(c.exp_node, 'string');
      if (source && !decl) {
        const modPath = source.text.replace(/['"]/g, '');
        const reexportNames = extractImportNames(c.exp_node);
        const nodeText = c.exp_node.text;
        const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
        imports.push({
          source: modPath,
          names: reexportNames,
          line: exportLine,
          reexport: true,
          wildcardReexport: isWildcard && reexportNames.length === 0,
        });
      }
    } else if (c.callfn_node) {
      // call_expression with identifier function
      calls.push({
        name: c.callfn_name!.text,
        line: c.callfn_node.startPosition.row + 1,
      });
    } else if (c.callmem_node) {
      // call_expression with member_expression function
      const callInfo = extractCallInfo(c.callmem_fn!, c.callmem_node);
      if (callInfo) calls.push(callInfo);
      const cbDef = extractCallbackDefinition(c.callmem_node, c.callmem_fn);
      if (cbDef) definitions.push(cbDef);
    } else if (c.callsub_node) {
      // call_expression with subscript_expression function
      const callInfo = extractCallInfo(c.callsub_fn!, c.callsub_node);
      if (callInfo) calls.push(callInfo);
    } else if (c.assign_node) {
      // CommonJS: module.exports = require(...) / module.exports = { ...require(...) }
      handleCommonJSAssignment(c.assign_left!, c.assign_right!, c.assign_node, imports);
    }
  }

  // Extract top-level constants via targeted walk (query patterns don't cover these)
  extractConstantsWalk(tree.rootNode, definitions);

  // Extract dynamic import() calls via targeted walk (query patterns don't match `import` function type)
  extractDynamicImportsWalk(tree.rootNode, imports);

  // Extract typeMap from type annotations and new expressions
  extractTypeMapWalk(tree.rootNode, typeMap);

  return { definitions, calls, imports, classes, exports: exps, typeMap };
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

    const t = declNode.type;
    if (t === 'lexical_declaration' || t === 'variable_declaration') {
      if (declNode.text.startsWith('const ')) {
        for (let j = 0; j < declNode.childCount; j++) {
          const declarator = declNode.child(j);
          if (!declarator || declarator.type !== 'variable_declarator') continue;
          const nameN = declarator.childForFieldName('name');
          const valueN = declarator.childForFieldName('value');
          if (!nameN || nameN.type !== 'identifier' || !valueN) continue;
          // Skip functions — already captured by query patterns
          const valType = valueN.type;
          if (
            valType === 'arrow_function' ||
            valType === 'function_expression' ||
            valType === 'function'
          )
            continue;
          if (isConstantValue(valueN)) {
            definitions.push({
              name: nameN.text,
              kind: 'constant',
              line: declNode.startPosition.row + 1,
              endLine: nodeEndLine(declNode),
            });
          }
        }
      }
    }

    // Recurse into non-function, non-export-statement children (blocks, if-statements, etc.)
    if (child.type !== 'export_statement') {
      extractConstantsWalk(child, definitions);
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
            line: node.startPosition.row + 1,
            dynamicImport: true,
          });
        } else {
          debug(
            `Skipping non-static dynamic import() at line ${node.startPosition.row + 1} (template literal or variable)`,
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

  const rightType = right.type;
  const assignLine = node.startPosition.row + 1;

  if (rightType === 'call_expression') {
    const fn = right.childForFieldName('function');
    const args = right.childForFieldName('arguments') || findChild(right, 'arguments');
    if (fn && fn.text === 'require' && args) {
      const strArg = findChild(args, 'string');
      if (strArg) {
        imports.push({
          source: strArg.text.replace(/['"]/g, ''),
          names: [],
          line: assignLine,
          reexport: true,
          wildcardReexport: true,
        });
      }
    }
  }

  if (rightType === 'object') {
    for (let ci = 0; ci < right.childCount; ci++) {
      const child = right.child(ci);
      if (child && child.type === 'spread_element') {
        const spreadExpr = child.child(1) || child.childForFieldName('value');
        if (spreadExpr && spreadExpr.type === 'call_expression') {
          const fn2 = spreadExpr.childForFieldName('function');
          const args2 =
            spreadExpr.childForFieldName('arguments') || findChild(spreadExpr, 'arguments');
          if (fn2 && fn2.text === 'require' && args2) {
            const strArg2 = findChild(args2, 'string');
            if (strArg2) {
              imports.push({
                source: strArg2.text.replace(/['"]/g, ''),
                names: [],
                line: assignLine,
                reexport: true,
                wildcardReexport: true,
              });
            }
          }
        }
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
  };

  walkJavaScriptNode(tree.rootNode, ctx);
  // Populate typeMap for variables and parameter type annotations
  extractTypeMapWalk(tree.rootNode, ctx.typeMap!);
  return ctx;
}

function walkJavaScriptNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_declaration':
      handleFunctionDecl(node, ctx);
      break;
    case 'class_declaration':
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
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: fnChildren.length > 0 ? fnChildren : undefined,
    });
  }
}

function handleClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const className = nameNode.text;
  const startLine = node.startPosition.row + 1;
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
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: methChildren.length > 0 ? methChildren : undefined,
      visibility: methVis,
    });
  }
}

function handleInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
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
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
    });
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
          valType === 'function'
        ) {
          const varFnChildren = extractParameters(valueN);
          ctx.definitions.push({
            name: nameN.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(valueN),
            children: varFnChildren.length > 0 ? varFnChildren : undefined,
          });
        } else if (isConst && nameN.type === 'identifier' && isConstantValue(valueN)) {
          ctx.definitions.push({
            name: nameN.text,
            kind: 'constant',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
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
            line: member.startPosition.row + 1,
          });
        }
      }
    }
  }
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: enumChildren.length > 0 ? enumChildren : undefined,
  });
}

function handleCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'import') {
    const args = node.childForFieldName('arguments') || findChild(node, 'arguments');
    if (args) {
      const strArg = findChild(args, 'string');
      if (strArg) {
        const modPath = strArg.text.replace(/['"]/g, '');
        const names = extractDynamicImportNames(node);
        ctx.imports.push({
          source: modPath,
          names,
          line: node.startPosition.row + 1,
          dynamicImport: true,
        });
      } else {
        debug(
          `Skipping non-static dynamic import() at line ${node.startPosition.row + 1} (template literal or variable)`,
        );
      }
    }
  } else {
    const callInfo = extractCallInfo(fn, node);
    if (callInfo) ctx.calls.push(callInfo);
    if (fn.type === 'member_expression') {
      const cbDef = extractCallbackDefinition(node, fn);
      if (cbDef) ctx.definitions.push(cbDef);
    }
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
      line: node.startPosition.row + 1,
      typeOnly: isTypeOnly,
    });
  }
}

function handleExportStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const exportLine = node.startPosition.row + 1;
  const decl = node.childForFieldName('declaration');
  if (decl) {
    const declType = decl.type;
    const kindMap: Record<string, string> = {
      function_declaration: 'function',
      class_declaration: 'class',
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
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
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
        params.push({ name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    } else if (t === 'rest_pattern' || t === 'rest_element') {
      const nameNode = child.child(1) || child.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier') {
        params.push({ name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 });
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
          line: child.startPosition.row + 1,
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
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
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
  if (!newExprNode || newExprNode.type !== 'new_expression') return null;
  const ctor = newExprNode.childForFieldName('constructor') || newExprNode.child(1);
  if (!ctor) return null;
  if (ctor.type === 'identifier') return ctor.text;
  if (ctor.type === 'member_expression') {
    const prop = ctor.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

/**
 * Extract variable-to-type assignments into a per-file type map.
 *
 * Values are `{ type: string, confidence: number }`:
 *   - 1.0: explicit constructor (`new Foo()`)
 *   - 0.9: type annotation (`: Foo`) or typed parameter
 *   - 0.7: factory method call (`Foo.create()` — uppercase-first heuristic)
 *
 * Higher-confidence entries take priority when the same variable is seen twice.
 */
function extractTypeMapWalk(rootNode: TreeSitterNode, typeMap: Map<string, TypeMapEntry>): void {
  function setIfHigher(name: string, type: string, confidence: number): void {
    const existing = typeMap.get(name);
    if (!existing || confidence > existing.confidence) {
      typeMap.set(name, { type, confidence });
    }
  }

  function walk(node: TreeSitterNode, depth: number): void {
    if (depth >= MAX_WALK_DEPTH) return;
    const t = node.type;
    if (t === 'variable_declarator') {
      const nameN = node.childForFieldName('name');
      if (nameN && nameN.type === 'identifier') {
        const typeAnno = findChild(node, 'type_annotation');
        if (typeAnno) {
          const typeName = extractSimpleTypeName(typeAnno);
          if (typeName) setIfHigher(nameN.text, typeName, 0.9);
        }
        const valueN = node.childForFieldName('value');
        if (valueN) {
          // Constructor: const x = new Foo() → confidence 1.0
          if (valueN.type === 'new_expression') {
            const ctorType = extractNewExprTypeName(valueN);
            if (ctorType) setIfHigher(nameN.text, ctorType, 1.0);
          }
          // Factory method: const x = Foo.create() → confidence 0.7
          else if (valueN.type === 'call_expression') {
            const fn = valueN.childForFieldName('function');
            if (fn && fn.type === 'member_expression') {
              const obj = fn.childForFieldName('object');
              if (obj && obj.type === 'identifier') {
                const objName = obj.text;
                if (objName[0]! !== objName[0]!.toLowerCase() && !BUILTIN_GLOBALS.has(objName)) {
                  setIfHigher(nameN.text, objName, 0.7);
                }
              }
            }
          }
        }
      }
    } else if (t === 'required_parameter' || t === 'optional_parameter') {
      const nameNode =
        node.childForFieldName('pattern') || node.childForFieldName('left') || node.child(0);
      if (nameNode && nameNode.type === 'identifier') {
        const typeAnno = findChild(node, 'type_annotation');
        if (typeAnno) {
          const typeName = extractSimpleTypeName(typeAnno);
          if (typeName) setIfHigher(nameNode.text, typeName, 0.9);
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
    return { name: fn.text, line: callNode.startPosition.row + 1 };
  }

  if (fnType === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!prop) return null;

    const callLine = callNode.startPosition.row + 1;
    const propText = prop.text;

    if (propText === 'call' || propText === 'apply' || propText === 'bind') {
      if (obj && obj.type === 'identifier')
        return { name: obj.text, line: callLine, dynamic: true };
      if (obj && obj.type === 'member_expression') {
        const innerProp = obj.childForFieldName('property');
        if (innerProp) return { name: innerProp.text, line: callLine, dynamic: true };
      }
    }

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

  if (fnType === 'subscript_expression') {
    const obj = fn.childForFieldName('object');
    const index = fn.childForFieldName('index');
    if (index) {
      const indexType = index.type;
      if (indexType === 'string' || indexType === 'template_string') {
        const methodName = index.text.replace(/['"`]/g, '');
        if (methodName && !methodName.includes('$')) {
          const receiver = extractReceiverName(obj);
          return {
            name: methodName,
            line: callNode.startPosition.row + 1,
            dynamic: true,
            receiver,
          };
        }
      }
    }
  }

  return null;
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
  if (!fn || fn.type !== 'member_expression') return null;

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
      line: cb.startPosition.row + 1,
      endLine: nodeEndLine(cb),
    };
  }

  // Express: app.get('/path', callback)
  if (EXPRESS_METHODS.has(method)) {
    const strArg = findFirstStringArg(args);
    if (!strArg || !strArg.startsWith('/')) return null;
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    return {
      name: `route:${method.toUpperCase()} ${strArg}`,
      kind: 'function',
      line: cb.startPosition.row + 1,
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
      line: cb.startPosition.row + 1,
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

function findParentClass(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    const t = current.type;
    if (t === 'class_declaration' || t === 'class') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
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
  if (!current || current.type !== 'variable_declarator') return [];

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
