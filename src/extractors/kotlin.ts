import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { extractModifierVisibility, findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Kotlin files.
 */
export function extractKotlinSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkKotlinNode(tree.rootNode, ctx);
  return ctx;
}

function walkKotlinNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_declaration':
      handleKotlinClassDecl(node, ctx);
      break;
    case 'object_declaration':
      handleKotlinObjectDecl(node, ctx);
      break;
    case 'function_declaration':
      handleKotlinFunctionDecl(node, ctx);
      break;
    case 'import_header':
      handleKotlinImport(node, ctx);
      break;
    case 'call_expression':
      handleKotlinCallExpression(node, ctx);
      break;
    case 'navigation_expression':
      handleKotlinNavExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkKotlinNode(child, ctx);
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

function hasModifier(node: TreeSitterNode, keyword: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'modifiers' && child.text.includes(keyword)) return true;
  }
  return false;
}

function handleKotlinClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const isInterface = hasKeywordChild(node, 'interface');
  const isEnum = hasModifier(node, 'enum');

  const nameNode = findChild(node, 'type_identifier');
  if (!nameNode) return;
  const name = nameNode.text;

  const kind = isInterface ? 'interface' : isEnum ? 'enum' : 'class';

  const children = isEnum ? collectKotlinEnumEntries(node) : collectKotlinProperties(node);

  ctx.definitions.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  collectKotlinMethods(node, name, ctx);
  collectKotlinInheritance(node, name, ctx);
}

/** Collect enum constant entries from a class_body. */
function collectKotlinEnumEntries(node: TreeSitterNode): SubDeclaration[] {
  const entries: SubDeclaration[] = [];
  const body = findChild(node, 'class_body');
  if (!body) return entries;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child || child.type !== 'enum_entry') continue;
    const entryName = findChild(child, 'simple_identifier');
    if (entryName) {
      entries.push({
        name: entryName.text,
        kind: 'constant',
        line: child.startPosition.row + 1,
      });
    }
  }
  return entries;
}

/** Collect property declarations from a class_body. */
function collectKotlinProperties(node: TreeSitterNode): SubDeclaration[] {
  const props: SubDeclaration[] = [];
  const body = findChild(node, 'class_body');
  if (!body) return props;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child || child.type !== 'property_declaration') continue;
    const varDecl = findChild(child, 'variable_declaration');
    if (!varDecl) continue;
    const id = findChild(varDecl, 'simple_identifier');
    if (id) {
      props.push({
        name: id.text,
        kind: 'property',
        line: child.startPosition.row + 1,
        visibility: extractModifierVisibility(child),
      });
    }
  }
  return props;
}

/** Collect method declarations from a class_body. */
function collectKotlinMethods(node: TreeSitterNode, className: string, ctx: ExtractorOutput): void {
  const body = findChild(node, 'class_body');
  if (!body) return;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child || child.type !== 'function_declaration') continue;
    const methName = findChild(child, 'simple_identifier');
    if (methName) {
      ctx.definitions.push({
        name: `${className}.${methName.text}`,
        kind: 'method',
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        visibility: extractModifierVisibility(child),
      });
    }
  }
}

/** Collect inheritance relationships from delegation_specifier children. */
function collectKotlinInheritance(
  node: TreeSitterNode,
  className: string,
  ctx: ExtractorOutput,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'delegation_specifier') continue;

    // constructor_invocation > user_type > type_identifier (extends)
    const ctorInvocation = findChild(child, 'constructor_invocation');
    if (ctorInvocation) {
      const userType = findChild(ctorInvocation, 'user_type');
      const typeId = userType ? findChild(userType, 'type_identifier') : null;
      if (typeId) {
        ctx.classes.push({
          name: className,
          extends: typeId.text,
          line: node.startPosition.row + 1,
        });
      }
      continue;
    }

    // user_type > type_identifier (implements)
    const userType = findChild(child, 'user_type');
    const typeId = userType ? findChild(userType, 'type_identifier') : null;
    if (typeId) {
      ctx.classes.push({
        name: className,
        implements: typeId.text,
        line: node.startPosition.row + 1,
      });
    }
  }
}

function handleKotlinObjectDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'type_identifier');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  // Methods inside object body
  const body = findChild(node, 'class_body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && child.type === 'function_declaration') {
        const methName = findChild(child, 'simple_identifier');
        if (methName) {
          ctx.definitions.push({
            name: `${nameNode.text}.${methName.text}`,
            kind: 'method',
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
            visibility: extractModifierVisibility(child),
          });
        }
      }
    }
  }
}

function handleKotlinFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip methods already emitted by class/object handlers
  if (
    node.parent?.type === 'class_body' &&
    (node.parent.parent?.type === 'class_declaration' ||
      node.parent.parent?.type === 'object_declaration')
  ) {
    return;
  }
  const nameNode = findChild(node, 'simple_identifier');
  if (!nameNode) return;
  const params = extractKotlinParameters(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleKotlinImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const identNode = findChild(node, 'identifier');
  if (!identNode) return;
  const fullPath = identNode.text;
  const lastName = fullPath.split('.').pop() ?? fullPath;
  ctx.imports.push({
    source: fullPath,
    names: [lastName],
    line: node.startPosition.row + 1,
    kotlinImport: true,
  });
}

function handleKotlinCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.child(0);
  if (!funcNode) return;
  if (funcNode.type === 'simple_identifier') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  }
}

function handleKotlinNavExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // navigation_expression: expr . identifier — only emit if parent is call_expression
  if (node.parent?.type !== 'call_expression') return;
  const lastChild = node.child(node.childCount - 1);
  const firstChild = node.child(0);
  if (lastChild && lastChild.type === 'simple_identifier' && firstChild) {
    const call: Call = { name: lastChild.text, line: node.startPosition.row + 1 };
    call.receiver = firstChild.text;
    ctx.calls.push(call);
  }
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractKotlinParameters(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList = findChild(funcNode, 'function_value_parameters');
  if (!paramList) return params;
  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = findChild(param, 'simple_identifier');
    if (nameNode) {
      params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}
