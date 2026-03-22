import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Ruby files.
 */
export function extractRubySymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  } as ExtractorOutput;

  walkRubyNode(tree.rootNode, ctx);
  return ctx;
}

function walkRubyNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class':
      handleRubyClass(node, ctx);
      break;
    case 'module':
      handleRubyModule(node, ctx);
      break;
    case 'method':
      handleRubyMethod(node, ctx);
      break;
    case 'singleton_method':
      handleRubySingletonMethod(node, ctx);
      break;
    case 'assignment':
      handleRubyAssignment(node, ctx);
      break;
    case 'call':
      handleRubyCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkRubyNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleRubyClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classChildren = extractRubyClassChildren(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: classChildren.length > 0 ? classChildren : undefined,
  });
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    for (let i = 0; i < superclass.childCount; i++) {
      const child = superclass.child(i);
      if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
        ctx.classes.push({
          name: nameNode.text,
          extends: child.text,
          line: node.startPosition.row + 1,
        });
        break;
      }
    }
    if (superclass.type === 'superclass') {
      for (let i = 0; i < superclass.childCount; i++) {
        const child = superclass.child(i);
        if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
          ctx.classes.push({
            name: nameNode.text,
            extends: child.text,
            line: node.startPosition.row + 1,
          });
          break;
        }
      }
    }
  }
}

function handleRubyModule(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const moduleChildren = extractRubyBodyConstants(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: moduleChildren.length > 0 ? moduleChildren : undefined,
  });
}

function handleRubyMethod(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findRubyParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const params = extractRubyParameters(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handleRubySingletonMethod(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findRubyParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const params = extractRubyParameters(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handleRubyAssignment(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (node.parent && node.parent.type === 'program') {
    const left = node.childForFieldName('left');
    if (left && left.type === 'constant') {
      ctx.definitions.push({
        name: left.text,
        kind: 'constant',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
      });
    }
  }
}

function handleRubyCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const methodNode = node.childForFieldName('method');
  if (!methodNode) return;
  if (methodNode.text === 'require' || methodNode.text === 'require_relative') {
    handleRubyRequire(node, ctx);
  } else if (
    methodNode.text === 'include' ||
    methodNode.text === 'extend' ||
    methodNode.text === 'prepend'
  ) {
    handleRubyModuleInclusion(node, methodNode, ctx);
  } else {
    const recv = node.childForFieldName('receiver');
    const call: Call = { name: methodNode.text, line: node.startPosition.row + 1 };
    if (recv) call.receiver = recv.text;
    ctx.calls.push(call);
  }
}

function handleRubyRequire(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const args = node.childForFieldName('arguments');
  if (!args) return;
  for (let i = 0; i < args.childCount; i++) {
    const arg = args.child(i);
    if (arg && (arg.type === 'string' || arg.type === 'string_content')) {
      const strContent = arg.text.replace(/^['"]|['"]$/g, '');
      ctx.imports.push({
        source: strContent,
        names: [strContent.split('/').pop() ?? strContent],
        line: node.startPosition.row + 1,
        rubyRequire: true,
      });
      break;
    }
    if (arg && arg.type === 'string') {
      const content = findChild(arg, 'string_content');
      if (content) {
        ctx.imports.push({
          source: content.text,
          names: [content.text.split('/').pop() ?? content.text],
          line: node.startPosition.row + 1,
          rubyRequire: true,
        });
        break;
      }
    }
  }
}

function handleRubyModuleInclusion(
  node: TreeSitterNode,
  _methodNode: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  const parentClass = findRubyParentClass(node);
  if (!parentClass) return;
  const args = node.childForFieldName('arguments');
  if (!args) return;
  for (let i = 0; i < args.childCount; i++) {
    const arg = args.child(i);
    if (arg && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
      ctx.classes.push({
        name: parentClass,
        implements: arg.text,
        line: node.startPosition.row + 1,
      });
    }
  }
}

function findRubyParentClass(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'class' || current.type === 'module') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Child extraction helpers ────────────────────────────────────────────────

const RUBY_PARAM_TYPES: Set<string> = new Set([
  'identifier',
  'optional_parameter',
  'splat_parameter',
  'hash_splat_parameter',
  'block_parameter',
  'keyword_parameter',
]);

function extractRubyParameters(methodNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList =
    methodNode.childForFieldName('parameters') || findChild(methodNode, 'method_parameters');
  if (!paramList) return params;
  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || !RUBY_PARAM_TYPES.has(param.type)) continue;
    let name: string;
    if (param.type === 'identifier') {
      name = param.text;
    } else {
      // Compound parameter types have an identifier child for the name
      const id = findChild(param, 'identifier');
      name = id ? id.text : param.text;
    }
    params.push({ name, kind: 'parameter', line: param.startPosition.row + 1 });
  }
  return params;
}

function extractRubyBodyConstants(containerNode: TreeSitterNode): SubDeclaration[] {
  const children: SubDeclaration[] = [];
  const body = containerNode.childForFieldName('body') || findChild(containerNode, 'body');
  if (!body) return children;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child || child.type !== 'assignment') continue;
    const left = child.childForFieldName('left');
    if (left && left.type === 'constant') {
      children.push({ name: left.text, kind: 'constant', line: child.startPosition.row + 1 });
    }
  }
  return children;
}

function extractRubyClassChildren(classNode: TreeSitterNode): SubDeclaration[] {
  const children: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'body');
  if (!body) return children;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child || child.type !== 'assignment') continue;
    const left = child.childForFieldName('left');
    if (!left) continue;
    if (left.type === 'instance_variable') {
      children.push({ name: left.text, kind: 'property', line: child.startPosition.row + 1 });
    } else if (left.type === 'constant') {
      children.push({ name: left.text, kind: 'constant', line: child.startPosition.row + 1 });
    }
  }
  return children;
}
