import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractModifierVisibility,
  findChild,
  findParentNode,
  nodeEndLine,
  stripQuotes,
} from './helpers.js';

/**
 * Extract symbols from Solidity files.
 *
 * Solidity's tree-sitter grammar covers contracts, interfaces, libraries,
 * structs, enums, events, errors, functions, modifiers, and import paths.
 */
export function extractSoliditySymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkSolidityNode(tree.rootNode, ctx);
  return ctx;
}

function walkSolidityNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'contract_declaration':
      handleContractDecl(node, ctx, 'class');
      break;
    case 'interface_declaration':
      handleContractDecl(node, ctx, 'interface');
      break;
    case 'library_declaration':
      handleContractDecl(node, ctx, 'module');
      break;
    case 'struct_declaration':
      handleStructDecl(node, ctx);
      break;
    case 'enum_declaration':
      handleEnumDecl(node, ctx);
      break;
    case 'function_definition':
      handleFunctionDef(node, ctx);
      break;
    case 'modifier_definition':
      handleModifierDef(node, ctx);
      break;
    case 'event_definition':
      handleEventDef(node, ctx);
      break;
    case 'error_declaration':
      handleErrorDecl(node, ctx);
      break;
    case 'state_variable_declaration':
      handleStateVarDecl(node, ctx);
      break;
    case 'import_directive':
      handleImportDirective(node, ctx);
      break;
    case 'call_expression':
    case 'function_call':
      handleCallExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkSolidityNode(child, ctx);
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

const SOL_PARENT_TYPES = [
  'contract_declaration',
  'interface_declaration',
  'library_declaration',
] as const;

function handleContractDecl(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  kind: 'class' | 'interface' | 'module',
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  const body = node.childForFieldName('body') || findChild(node, 'contract_body');
  const members = body ? extractContractMembers(body) : [];

  ctx.definitions.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });

  extractInheritance(node, name, ctx);
}

/** Extract member declarations from a contract body node. */
function extractContractMembers(body: TreeSitterNode): SubDeclaration[] {
  const members: SubDeclaration[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    const member = extractContractMember(child);
    if (member) members.push(member);
  }
  return members;
}

/** Map a single contract body child to a SubDeclaration, or null if not a recognized member. */
function extractContractMember(child: TreeSitterNode): SubDeclaration | null {
  const line = child.startPosition.row + 1;
  switch (child.type) {
    case 'function_definition': {
      const fnName = child.childForFieldName('name');
      return fnName ? { name: fnName.text, kind: 'method', line } : null;
    }
    case 'state_variable_declaration': {
      const varName = child.childForFieldName('name');
      return varName
        ? { name: varName.text, kind: 'property', line, visibility: extractSolVisibility(child) }
        : null;
    }
    case 'event_definition': {
      const evName = child.childForFieldName('name');
      return evName ? { name: evName.text, kind: 'property', decorators: ['event'], line } : null;
    }
    case 'error_declaration': {
      const errName = child.childForFieldName('name');
      return errName ? { name: errName.text, kind: 'property', decorators: ['error'], line } : null;
    }
    case 'modifier_definition': {
      const modName = child.childForFieldName('name');
      return modName
        ? { name: modName.text, kind: 'method', decorators: ['modifier'], line }
        : null;
    }
    default:
      return null;
  }
}

/** Extract inheritance (extends) relationships from a contract node. */
function extractInheritance(node: TreeSitterNode, name: string, ctx: ExtractorOutput): void {
  const inheritance = findChild(node, 'inheritance_specifier');
  if (!inheritance) return;
  for (let i = 0; i < inheritance.childCount; i++) {
    const child = inheritance.child(i);
    if (!child) continue;
    if (child.type === 'user_defined_type' || child.type === 'identifier') {
      ctx.classes.push({ name, extends: child.text, line: node.startPosition.row + 1 });
    }
  }
}

function handleStructDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const members: SubDeclaration[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'struct_member') {
      const memberName = child.childForFieldName('name');
      if (memberName) {
        members.push({
          name: memberName.text,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });
}

function handleEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const members: SubDeclaration[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'enum_value') {
      members.push({ name: child.text, kind: 'constant', line: child.startPosition.row + 1 });
    }
  }

  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });
}

function handleFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;
  const kind = parent ? 'method' : 'function';

  const params = extractSolParams(node);
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractSolVisibility(node),
  });
}

function handleModifierDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    decorators: ['modifier'],
  });
}

function handleEventDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    decorators: ['event'],
  });
}

function handleErrorDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    decorators: ['error'],
  });
}

function handleStateVarDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parent = findParentNode(node, SOL_PARENT_TYPES);
  const fullName = parent ? `${parent}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: extractSolVisibility(node),
  });
}

function handleImportDirective(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // import "path"; or import { X } from "path"; or import "path" as Alias;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'string' || child.type === 'string_literal') {
      const source = stripQuotes(child.text);
      const names: string[] = [];
      // Look for imported symbols
      for (let j = 0; j < node.childCount; j++) {
        const sibling = node.child(j);
        if (sibling && sibling.type === 'identifier') names.push(sibling.text);
        if (sibling && sibling.type === 'import_declaration') {
          const id = findChild(sibling, 'identifier');
          if (id) names.push(id.text);
        }
      }
      ctx.imports.push({
        source,
        names: names.length > 0 ? names : ['*'],
        line: node.startPosition.row + 1,
      });
      return;
    }
    // source_import: handles `import * as X from "path"`
    if (child.type === 'source_import' || child.type === 'import_clause') {
      const strNode = findChild(child, 'string') || findChild(child, 'string_literal');
      if (strNode) {
        ctx.imports.push({
          source: stripQuotes(strNode.text),
          names: ['*'],
          line: node.startPosition.row + 1,
        });
        return;
      }
    }
  }
}

function handleCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function') || node.childForFieldName('callee');
  if (!funcNode) return;

  const call: Call = { name: '', line: node.startPosition.row + 1 };
  if (funcNode.type === 'member_expression' || funcNode.type === 'member_access') {
    const prop = funcNode.childForFieldName('property') || funcNode.childForFieldName('member');
    const obj = funcNode.childForFieldName('object') || funcNode.childForFieldName('expression');
    if (prop) call.name = prop.text;
    if (obj) call.receiver = obj.text;
  } else {
    call.name = funcNode.text;
  }
  if (call.name) ctx.calls.push(call);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractSolParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList =
    funcNode.childForFieldName('parameters') || findChild(funcNode, 'parameter_list');
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = param.childForFieldName('name');
    if (nameNode) {
      params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function extractSolVisibility(
  node: TreeSitterNode,
): 'public' | 'private' | 'protected' | undefined {
  // Solidity visibility is embedded as child keywords or visibility nodes
  const vis = extractModifierVisibility(node);
  if (vis) return vis;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const t = child.text;
    if (t === 'public' || t === 'external') return 'public';
    if (t === 'private') return 'private';
    if (t === 'internal') return 'protected';
  }
  return undefined;
}
