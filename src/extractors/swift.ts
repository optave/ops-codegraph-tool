import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { extractModifierVisibility, findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Swift files.
 */
export function extractSwiftSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkSwiftNode(tree.rootNode, ctx);
  return ctx;
}

function walkSwiftNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_declaration':
      handleSwiftClassDecl(node, ctx);
      break;
    case 'protocol_declaration':
      handleSwiftProtocolDecl(node, ctx);
      break;
    case 'function_declaration':
      handleSwiftFunctionDecl(node, ctx);
      break;
    case 'import_declaration':
      handleSwiftImportDecl(node, ctx);
      break;
    case 'call_expression':
      handleSwiftCallExpression(node, ctx);
      break;
    case 'property_declaration':
      handleSwiftPropertyDecl(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkSwiftNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function hasKeywordChild(node: TreeSitterNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.text === keyword) return true;
  }
  return false;
}

function handleSwiftClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isStruct = hasKeywordChild(node, 'struct');
  const isEnum = hasKeywordChild(node, 'enum');

  // Name is a type_identifier direct child
  const nameNode = findChild(node, 'type_identifier');
  if (!nameNode) return;
  const name = nameNode.text;

  const kind = isEnum ? 'enum' : isStruct ? 'struct' : 'class';

  const children: SubDeclaration[] = [];

  if (isEnum) {
    // Enum cases: enum_entry > simple_identifier, inside enum_class_body
    const body = findChild(node, 'enum_class_body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child && child.type === 'enum_entry') {
          const entryName = findChild(child, 'simple_identifier');
          if (entryName) {
            children.push({
              name: entryName.text,
              kind: 'constant',
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }
  } else {
    // Extract properties from class_body
    const body = findChild(node, 'class_body');
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i);
        if (child && child.type === 'property_declaration') {
          const pattern = findChild(child, 'pattern');
          if (pattern) {
            const propName = findChild(pattern, 'simple_identifier');
            if (propName) {
              children.push({
                name: propName.text,
                kind: 'property',
                line: child.startPosition.row + 1,
                visibility: extractModifierVisibility(child),
              });
            }
          }
        }
      }
    }
  }

  ctx.definitions.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  // Methods inside class_body or enum_class_body
  const body = findChild(node, 'class_body') || findChild(node, 'enum_class_body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && child.type === 'function_declaration') {
        const methName = findChild(child, 'simple_identifier');
        if (methName) {
          ctx.definitions.push({
            name: `${name}.${methName.text}`,
            kind: 'method',
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            visibility: extractModifierVisibility(child),
          });
        }
      }
    }
  }

  // Inheritance: inheritance_specifier nodes are DIRECT children of class_declaration
  // First specifier is the superclass (extends), rest are protocol conformances (implements)
  let first = true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'inheritance_specifier') continue;
    // inheritance_specifier > user_type > type_identifier
    const userType = findChild(child, 'user_type');
    if (userType) {
      const typeId = findChild(userType, 'type_identifier');
      if (typeId) {
        if (first) {
          ctx.classes.push({
            name,
            extends: typeId.text,
            line: node.startPosition.row + 1,
          });
          first = false;
        } else {
          ctx.classes.push({
            name,
            implements: typeId.text,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function handleSwiftProtocolDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'type_identifier');
  if (!nameNode) return;
  const name = nameNode.text;

  ctx.definitions.push({
    name,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  // Methods inside protocol_body or class_body
  const body = findChild(node, 'protocol_body') || findChild(node, 'class_body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && child.type === 'function_declaration') {
        const methName = findChild(child, 'simple_identifier');
        if (methName) {
          ctx.definitions.push({
            name: `${name}.${methName.text}`,
            kind: 'method',
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          });
        }
      }
    }
  }
}

function handleSwiftFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip methods already emitted by class/protocol handlers
  if (
    node.parent?.type === 'class_body' ||
    node.parent?.type === 'protocol_body' ||
    node.parent?.type === 'enum_class_body'
  ) {
    if (
      node.parent.parent?.type === 'class_declaration' ||
      node.parent.parent?.type === 'protocol_declaration'
    ) {
      return;
    }
  }
  const nameNode = findChild(node, 'simple_identifier');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: extractModifierVisibility(node),
  });
}

function handleSwiftImportDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const identNode = findChild(node, 'identifier');
  if (!identNode) return;
  const source = identNode.text;
  ctx.imports.push({
    source,
    names: [source],
    line: node.startPosition.row + 1,
    swiftImport: true,
  });
}

function handleSwiftCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.child(0);
  if (!funcNode) return;
  const call: Call = { name: '', line: node.startPosition.row + 1 };
  if (funcNode.type === 'navigation_expression') {
    // obj.method(...)
    const lastChild = funcNode.child(funcNode.childCount - 1);
    const firstChild = funcNode.child(0);
    if (lastChild && lastChild.type === 'simple_identifier' && firstChild) {
      call.name = lastChild.text;
      call.receiver = firstChild.text;
    }
  } else if (funcNode.type === 'simple_identifier') {
    call.name = funcNode.text;
  } else {
    call.name = funcNode.text;
  }
  if (call.name) ctx.calls.push(call);
}

function handleSwiftPropertyDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Only handle top-level properties (class properties are handled inline)
  if (
    node.parent?.type === 'class_body' ||
    node.parent?.type === 'protocol_body' ||
    node.parent?.type === 'enum_class_body'
  ) {
    return;
  }
  // Skip function-local let/var bindings
  if (node.parent?.type === 'statements' || node.parent?.type === 'function_body') {
    return;
  }
  const pattern = findChild(node, 'pattern');
  if (!pattern) return;
  const nameNode = findChild(pattern, 'simple_identifier');
  if (!nameNode) return;
  // let → constant, var → variable
  const isLet = hasKeywordChild(node, 'let');
  const kind = isLet ? 'constant' : 'variable';
  ctx.definitions.push({
    name: nameNode.text,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}
