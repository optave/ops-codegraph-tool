import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { extractModifierVisibility, findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Scala files.
 */
export function extractScalaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkScalaNode(tree.rootNode, ctx);
  return ctx;
}

function walkScalaNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_definition':
      handleScalaClassDef(node, ctx);
      break;
    case 'trait_definition':
      handleScalaTraitDef(node, ctx);
      break;
    case 'object_definition':
      handleScalaObjectDef(node, ctx);
      break;
    case 'function_definition':
      handleScalaFunctionDef(node, ctx);
      break;
    case 'import_declaration':
      handleScalaImportDecl(node, ctx);
      break;
    case 'call_expression':
      handleScalaCallExpression(node, ctx);
      break;
    case 'val_definition':
    case 'var_definition':
      handleScalaValVarDef(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkScalaNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleScalaClassDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const children = extractScalaBodyMembers(node, name, ctx);

  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  extractScalaInheritance(node, name, ctx);
}

function handleScalaTraitDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const children = extractScalaBodyMembers(node, name, ctx);

  ctx.definitions.push({
    name,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  extractScalaInheritance(node, name, ctx);
}

function handleScalaObjectDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const children = extractScalaBodyMembers(node, name, ctx);

  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  extractScalaInheritance(node, name, ctx);
}

function handleScalaFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip methods already emitted by class/trait/object handlers
  if (node.parent?.type === 'template_body') {
    const grandparent = node.parent.parent;
    if (
      grandparent &&
      (grandparent.type === 'class_definition' ||
        grandparent.type === 'trait_definition' ||
        grandparent.type === 'object_definition')
    ) {
      return;
    }
  }
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const params = extractScalaParameters(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleScalaImportDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // import_declaration has alternating `identifier` and `.` children directly (NO import_expression wrapper)
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      parts.push(child.text);
    }
  }
  if (parts.length === 0) return;
  const fullPath = parts.join('.');
  const lastName = parts[parts.length - 1] ?? fullPath;
  ctx.imports.push({
    source: fullPath,
    names: [lastName],
    line: node.startPosition.row + 1,
    scalaImport: true,
  });
}

function handleScalaCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return;
  const call: Call = { name: '', line: node.startPosition.row + 1 };
  if (funcNode.type === 'field_expression') {
    const field = funcNode.childForFieldName('field');
    const value = funcNode.childForFieldName('value');
    if (field) call.name = field.text;
    if (value) call.receiver = value.text;
  } else {
    call.name = funcNode.text;
  }
  if (call.name) ctx.calls.push(call);
}

function handleScalaValVarDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Only handle top-level vals/vars — skip class members and function-local bindings
  if (node.parent?.type === 'template_body') return;
  if (node.parent?.type === 'block' || node.parent?.type === 'indented_block') return;
  const pattern = node.childForFieldName('pattern');
  if (!pattern) return;
  const nameNode = pattern.type === 'identifier' ? pattern : findChild(pattern, 'identifier');
  if (!nameNode) return;
  const kind = node.type === 'val_definition' ? 'constant' : 'variable';
  ctx.definitions.push({
    name: nameNode.text,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

// ── Inheritance helpers ─────────────────────────────────────────────────────

function extractScalaInheritance(node: TreeSitterNode, name: string, ctx: ExtractorOutput): void {
  const extendsClause = findChild(node, 'extends_clause');
  if (!extendsClause) return;
  let foundExtends = false;
  for (let i = 0; i < extendsClause.childCount; i++) {
    const child = extendsClause.child(i);
    if (!child) continue;
    if (
      child.type === 'type_identifier' ||
      child.type === 'generic_type' ||
      child.type === 'identifier'
    ) {
      const typeName = child.type === 'generic_type' ? child.child(0)?.text : child.text;
      if (!typeName) continue;
      if (!foundExtends) {
        ctx.classes.push({
          name,
          extends: typeName,
          line: node.startPosition.row + 1,
        });
        foundExtends = true;
      } else {
        ctx.classes.push({
          name,
          implements: typeName,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

// ── Body member extraction ──────────────────────────────────────────────────

function extractScalaBodyMembers(
  parentNode: TreeSitterNode,
  parentName: string,
  ctx: ExtractorOutput,
): SubDeclaration[] {
  const children: SubDeclaration[] = [];
  const body = findChild(parentNode, 'template_body');
  if (!body) return children;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;

    if (member.type === 'function_definition') {
      const methName = member.childForFieldName('name');
      if (methName) {
        ctx.definitions.push({
          name: `${parentName}.${methName.text}`,
          kind: 'method',
          line: member.startPosition.row + 1,
          endLine: member.endPosition.row + 1,
          visibility: extractModifierVisibility(member),
        });
      }
    } else if (member.type === 'val_definition' || member.type === 'var_definition') {
      const pattern = member.childForFieldName('pattern');
      if (pattern) {
        const nameNode = pattern.type === 'identifier' ? pattern : findChild(pattern, 'identifier');
        if (nameNode) {
          children.push({
            name: nameNode.text,
            kind: 'property',
            line: member.startPosition.row + 1,
            visibility: extractModifierVisibility(member),
          });
        }
      }
    }
  }

  return children;
}

// ── Parameter extraction ────────────────────────────────────────────────────

function extractScalaParameters(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList = findChild(funcNode, 'parameters');
  if (!paramList) return params;
  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = findChild(param, 'identifier');
    if (nameNode) {
      params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}
