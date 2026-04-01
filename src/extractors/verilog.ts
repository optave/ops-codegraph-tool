import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Verilog/SystemVerilog files.
 *
 * The tree-sitter-verilog grammar covers modules, interfaces, packages,
 * tasks, functions, classes, always blocks, and instantiations.
 */
export function extractVerilogSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkVerilogNode(tree.rootNode, ctx);
  return ctx;
}

function walkVerilogNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'module_declaration':
      handleModuleDecl(node, ctx);
      break;
    case 'interface_declaration':
      handleInterfaceDecl(node, ctx);
      break;
    case 'package_declaration':
      handlePackageDecl(node, ctx);
      break;
    case 'class_declaration':
      handleClassDecl(node, ctx);
      break;
    case 'function_declaration':
      handleFunctionDecl(node, ctx);
      break;
    case 'task_declaration':
      handleTaskDecl(node, ctx);
      break;
    case 'module_instantiation':
      handleModuleInstantiation(node, ctx);
      break;
    case 'package_import_declaration':
      handlePackageImport(node, ctx);
      break;
    case 'include_compiler_directive':
      handleIncludeDirective(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkVerilogNode(child, ctx);
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

function handleModuleDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findModuleName(node);
  if (!nameNode) return;

  const ports = extractPorts(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: ports.length > 0 ? ports : undefined,
  });
}

function handleInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findDeclName(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handlePackageDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findDeclName(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  // Superclass via extends
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    ctx.classes.push({
      name: nameNode.text,
      extends: superclass.text,
      line: node.startPosition.row + 1,
    });
  }
}

function handleFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findFunctionOrTaskName(node, 'function_identifier');
  if (!nameNode) return;

  const parentModule = findVerilogParent(node);
  const fullName = parentModule ? `${parentModule}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleTaskDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findFunctionOrTaskName(node, 'task_identifier');
  if (!nameNode) return;

  const parentModule = findVerilogParent(node);
  const fullName = parentModule ? `${parentModule}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleModuleInstantiation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Module instantiations are like function calls: `ModuleName instance_name(...);`
  const moduleType = node.childForFieldName('type') || node.child(0);
  if (!moduleType) return;

  ctx.calls.push({
    name: moduleType.text,
    line: node.startPosition.row + 1,
  });
}

function handlePackageImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // import pkg::item; or import pkg::*;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'package_import_item') {
      const text = child.text;
      const parts = text.split('::');
      const pkg = parts[0] ?? text;
      const item = parts[1] ?? '*';
      ctx.imports.push({
        source: pkg,
        names: [item],
        line: node.startPosition.row + 1,
      });
    }
  }
}

function handleIncludeDirective(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // `include "file.vh"
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'string_literal' || child.type === 'quoted_string')) {
      const source = child.text.replace(/^["']|["']$/g, '');
      ctx.imports.push({
        source,
        names: [source.split('/').pop() ?? source],
        line: node.startPosition.row + 1,
        cInclude: true,
      });
      return;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function findModuleName(node: TreeSitterNode): TreeSitterNode | null {
  // Try field name first, then look for module_header > identifier
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode;

  const header = findChild(node, 'module_header');
  if (header) {
    const id = findChild(header, 'simple_identifier') || findChild(header, 'identifier');
    if (id) return id;
  }

  // Direct child identifier after `module` keyword
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'simple_identifier' || child.type === 'identifier')) return child;
  }
  return null;
}

function findDeclName(node: TreeSitterNode): TreeSitterNode | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'simple_identifier' || child.type === 'identifier')) return child;
  }
  return null;
}

/**
 * Find a function or task name by searching for the dedicated identifier node
 * type (e.g. `function_identifier`, `task_identifier`) recursively through
 * body declarations.  Falls back to `findDeclName` for grammars that use
 * plain identifiers.
 */
function findFunctionOrTaskName(
  node: TreeSitterNode,
  identifierType: string,
): TreeSitterNode | null {
  // Try the standard approach first
  const simple = findDeclName(node);
  if (simple) return simple;

  // Search children (including body declarations) for the dedicated identifier node
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === identifierType) return child;
    // Look one level deeper into body declarations
    for (let j = 0; j < child.childCount; j++) {
      const grandchild = child.child(j);
      if (grandchild && grandchild.type === identifierType) return grandchild;
    }
  }
  return null;
}

function findVerilogParent(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'module_declaration' ||
      current.type === 'interface_declaration' ||
      current.type === 'package_declaration' ||
      current.type === 'class_declaration'
    ) {
      const name = findDeclName(current) || findModuleName(current);
      return name ? name.text : null;
    }
    current = current.parent;
  }
  return null;
}

function extractPorts(moduleNode: TreeSitterNode): SubDeclaration[] {
  const ports: SubDeclaration[] = [];

  // Look for port declarations in the module header or body
  const collectFromNode = (node: TreeSitterNode): void => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;

      if (
        child.type === 'ansi_port_declaration' ||
        child.type === 'port_declaration' ||
        child.type === 'input_declaration' ||
        child.type === 'output_declaration' ||
        child.type === 'inout_declaration'
      ) {
        const nameNode =
          child.childForFieldName('name') ||
          findChild(child, 'simple_identifier') ||
          findChild(child, 'identifier');
        if (nameNode) {
          ports.push({ name: nameNode.text, kind: 'property', line: child.startPosition.row + 1 });
        }
      }

      // Recurse into port list containers
      if (
        child.type === 'list_of_port_declarations' ||
        child.type === 'module_header' ||
        child.type === 'port_declaration_list'
      ) {
        collectFromNode(child);
      }
    }
  };

  collectFromNode(moduleNode);
  return ports;
}
