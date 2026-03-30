import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
  TypeMapEntry,
} from '../types.js';
import {
  findChild,
  findParentNode,
  MAX_WALK_DEPTH,
  nodeEndLine,
  pythonVisibility,
} from './helpers.js';

/** Built-in globals that start with uppercase but are not user-defined types. */
const BUILTIN_GLOBALS_PY: Set<string> = new Set([
  // Uppercase builtins that would false-positive on the factory heuristic
  'Exception',
  'BaseException',
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'AttributeError',
  'RuntimeError',
  'OSError',
  'IOError',
  'FileNotFoundError',
  'PermissionError',
  'NotImplementedError',
  'StopIteration',
  'GeneratorExit',
  'SystemExit',
  'KeyboardInterrupt',
  'ArithmeticError',
  'LookupError',
  'UnicodeError',
  'UnicodeDecodeError',
  'UnicodeEncodeError',
  'ImportError',
  'ModuleNotFoundError',
  'ConnectionError',
  'TimeoutError',
  'OverflowError',
  'ZeroDivisionError',
  'NameError',
  'SyntaxError',
  'RecursionError',
  'MemoryError',
  // Common standard library uppercase classes
  'Path',
  'PurePath',
  'OrderedDict',
  'Counter',
  'Decimal',
  'Fraction',
]);

/**
 * Extract symbols from Python files.
 */
export function extractPythonSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkPythonNode(tree.rootNode, ctx);
  extractPythonTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkPythonNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handlePyFunctionDef(node, ctx);
      break;
    case 'class_definition':
      handlePyClassDef(node, ctx);
      break;
    case 'decorated_definition':
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walkPythonNode(child, ctx);
      }
      return;
    case 'call':
      handlePyCall(node, ctx);
      break;
    case 'import_statement':
      handlePyImport(node, ctx);
      break;
    case 'expression_statement':
      handlePyExpressionStmt(node, ctx);
      break;
    case 'import_from_statement':
      handlePyImportFrom(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkPythonNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handlePyFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const decorators: string[] = [];
  if (node.previousSibling && node.previousSibling.type === 'decorator') {
    decorators.push(node.previousSibling.text);
  }
  const parentClass = findPythonParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const kind = parentClass ? 'method' : 'function';
  const fnChildren = extractPythonParameters(node);
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    decorators,
    children: fnChildren.length > 0 ? fnChildren : undefined,
    visibility: pythonVisibility(nameNode.text),
  });
}

function handlePyClassDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const clsChildren = extractPythonClassProperties(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: clsChildren.length > 0 ? clsChildren : undefined,
  });
  const superclasses = node.childForFieldName('superclasses') || findChild(node, 'argument_list');
  if (superclasses) {
    for (let i = 0; i < superclasses.childCount; i++) {
      const child = superclasses.child(i);
      if (child && child.type === 'identifier') {
        ctx.classes.push({
          name: nameNode.text,
          extends: child.text,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handlePyCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  let callName: string | null = null;
  let receiver: string | undefined;
  if (fn.type === 'identifier') callName = fn.text;
  else if (fn.type === 'attribute') {
    const attr = fn.childForFieldName('attribute');
    if (attr) callName = attr.text;
    const obj = fn.childForFieldName('object');
    if (obj) receiver = obj.text;
  }
  if (callName) {
    const call: Call = { name: callName, line: node.startPosition.row + 1 };
    if (receiver) call.receiver = receiver;
    ctx.calls.push(call);
  }
}

function handlePyImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'dotted_name' || child.type === 'aliased_import')) {
      const name =
        child.type === 'aliased_import'
          ? (child.childForFieldName('alias') || child.childForFieldName('name'))?.text
          : child.text;
      if (name) names.push(name);
    }
  }
  if (names.length > 0)
    ctx.imports.push({
      source: names[0] ?? '',
      names,
      line: node.startPosition.row + 1,
      pythonImport: true,
    });
}

function handlePyExpressionStmt(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (node.parent && node.parent.type === 'module') {
    const assignment = findChild(node, 'assignment');
    if (assignment) {
      const left = assignment.childForFieldName('left');
      if (left && left.type === 'identifier' && /^[A-Z_][A-Z0-9_]*$/.test(left.text)) {
        ctx.definitions.push({
          name: left.text,
          kind: 'constant',
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handlePyImportFrom(node: TreeSitterNode, ctx: ExtractorOutput): void {
  let source = '';
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'dotted_name' || child.type === 'relative_import') {
      if (!source) source = child.text;
      else names.push(child.text);
    }
    if (child.type === 'aliased_import') {
      const n = child.childForFieldName('name') || child.child(0);
      if (n) names.push(n.text);
    }
    if (child.type === 'wildcard_import') names.push('*');
  }
  if (source)
    ctx.imports.push({ source, names, line: node.startPosition.row + 1, pythonImport: true });
}

// ── Python-specific helpers ─────────────────────────────────────────────────

function extractPythonParameters(fnNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode = fnNode.childForFieldName('parameters') || findChild(fnNode, 'parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === 'identifier') {
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
    } else if (
      t === 'typed_parameter' ||
      t === 'default_parameter' ||
      t === 'typed_default_parameter'
    ) {
      const nameNode = child.childForFieldName('name') || child.child(0);
      if (nameNode && nameNode.type === 'identifier') {
        params.push({
          name: nameNode.text,
          kind: 'parameter',
          line: child.startPosition.row + 1,
        });
      }
    } else if (t === 'list_splat_pattern' || t === 'dictionary_splat_pattern') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && inner.type === 'identifier') {
          params.push({ name: inner.text, kind: 'parameter', line: child.startPosition.row + 1 });
          break;
        }
      }
    }
  }
  return params;
}

function extractPythonClassProperties(classNode: TreeSitterNode): SubDeclaration[] {
  const props: SubDeclaration[] = [];
  const seen = new Set<string>();
  const body = classNode.childForFieldName('body') || findChild(classNode, 'block');
  if (!body) return props;

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;

    if (child.type === 'expression_statement') {
      const assignment = findChild(child, 'assignment');
      if (assignment) {
        const left = assignment.childForFieldName('left');
        if (left && left.type === 'identifier' && !seen.has(left.text)) {
          seen.add(left.text);
          props.push({
            name: left.text,
            kind: 'property',
            line: child.startPosition.row + 1,
            visibility: pythonVisibility(left.text),
          });
        }
      }
    }

    if (child.type === 'function_definition') {
      const fnName = child.childForFieldName('name');
      if (fnName && fnName.text === '__init__') {
        const initBody = child.childForFieldName('body') || findChild(child, 'block');
        if (initBody) {
          walkInitBody(initBody, seen, props);
        }
      }
    }

    if (child.type === 'decorated_definition') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && inner.type === 'function_definition') {
          const fnName = inner.childForFieldName('name');
          if (fnName && fnName.text === '__init__') {
            const initBody = inner.childForFieldName('body') || findChild(inner, 'block');
            if (initBody) {
              walkInitBody(initBody, seen, props);
            }
          }
        }
      }
    }
  }
  return props;
}

function walkInitBody(bodyNode: TreeSitterNode, seen: Set<string>, props: SubDeclaration[]): void {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const stmt = bodyNode.child(i);
    if (!stmt || stmt.type !== 'expression_statement') continue;
    const assignment = findChild(stmt, 'assignment');
    if (!assignment) continue;
    const left = assignment.childForFieldName('left');
    if (!left || left.type !== 'attribute') continue;
    const obj = left.childForFieldName('object');
    const attr = left.childForFieldName('attribute');
    if (obj && obj.text === 'self' && attr && attr.type === 'identifier' && !seen.has(attr.text)) {
      seen.add(attr.text);
      props.push({
        name: attr.text,
        kind: 'property',
        line: stmt.startPosition.row + 1,
        visibility: pythonVisibility(attr.text),
      });
    }
  }
}

function extractPythonTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractPythonTypeMapDepth(node, ctx, 0);
}

function setIfHigherPy(
  typeMap: Map<string, TypeMapEntry>,
  name: string,
  type: string,
  confidence: number,
): void {
  const existing = typeMap.get(name);
  if (!existing || confidence > existing.confidence) {
    typeMap.set(name, { type, confidence });
  }
}

function extractPythonTypeMapDepth(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  depth: number,
): void {
  if (depth >= MAX_WALK_DEPTH) return;

  // typed_parameter: identifier : type (confidence 0.9)
  if (node.type === 'typed_parameter') {
    const nameNode = node.child(0);
    const typeNode = node.childForFieldName('type');
    if (nameNode && nameNode.type === 'identifier' && typeNode) {
      const typeName = extractPythonTypeName(typeNode);
      if (typeName && nameNode.text !== 'self' && nameNode.text !== 'cls') {
        if (ctx.typeMap) setIfHigherPy(ctx.typeMap, nameNode.text, typeName, 0.9);
      }
    }
  }

  // typed_default_parameter: name : type = default (confidence 0.9)
  if (node.type === 'typed_default_parameter') {
    const nameNode = node.childForFieldName('name');
    const typeNode = node.childForFieldName('type');
    if (nameNode && nameNode.type === 'identifier' && typeNode) {
      const typeName = extractPythonTypeName(typeNode);
      if (typeName && nameNode.text !== 'self' && nameNode.text !== 'cls') {
        if (ctx.typeMap) setIfHigherPy(ctx.typeMap, nameNode.text, typeName, 0.9);
      }
    }
  }

  // assignment: x = SomeClass(...) → constructor (confidence 1.0)
  //             x = SomeClass.create(...) → factory (confidence 0.7)
  if (node.type === 'assignment') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (left && left.type === 'identifier' && right && right.type === 'call') {
      const fn = right.childForFieldName('function');
      if (fn && fn.type === 'identifier') {
        const name = fn.text;
        if (name[0] && name[0] !== name[0].toLowerCase()) {
          if (ctx.typeMap) setIfHigherPy(ctx.typeMap, left.text, name, 1.0);
        }
      }
      if (fn && fn.type === 'attribute') {
        const obj = fn.childForFieldName('object');
        if (obj && obj.type === 'identifier') {
          const objName = obj.text;
          if (
            objName[0] &&
            objName[0] !== objName[0].toLowerCase() &&
            !BUILTIN_GLOBALS_PY.has(objName)
          ) {
            if (ctx.typeMap) setIfHigherPy(ctx.typeMap, left.text, objName, 0.7);
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractPythonTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractPythonTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'identifier') return typeNode.text;
  if (t === 'attribute') return typeNode.text; // module.Type
  // Generic: List[int] → subscript → value is identifier
  if (t === 'subscript') {
    const value = typeNode.childForFieldName('value');
    return value ? value.text : null;
  }
  // None type, string, etc → skip
  if (t === 'none' || t === 'string') return null;
  return null;
}

const PY_CLASS_TYPES = ['class_definition'] as const;
function findPythonParentClass(node: TreeSitterNode): string | null {
  return findParentNode(node, PY_CLASS_TYPES);
}
