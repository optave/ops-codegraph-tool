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
  // tree-sitter-verilog exposes no field names on `class_declaration`. The
  // class name lives under a `class_identifier > simple_identifier` chain, and
  // the superclass appears as a `class_type` child (no `superclass` field).
  // The Rust extractor in `crates/codegraph-core/src/extractors/verilog.rs`
  // uses the same structural lookups so both engines emit identical class
  // definitions and `extends` relations.
  const name = findClassName(node);
  if (!name) return;

  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  const superclass = findClassSuperclass(node);
  if (superclass) {
    ctx.classes.push({
      name,
      extends: superclass,
      line: node.startPosition.row + 1,
    });
  }
}

function findClassName(node: TreeSitterNode): string | null {
  const fieldName = node.childForFieldName('name');
  if (fieldName) return fieldName.text;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'class_identifier') {
      const simple = findChild(child, 'simple_identifier');
      return (simple ?? child).text.trim();
    }
  }
  return null;
}

function findClassSuperclass(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'class_type') {
      const id = findChild(child, 'class_identifier');
      if (id) {
        const simple = findChild(id, 'simple_identifier');
        return (simple ?? id).text.trim();
      }
      return child.text.trim();
    }
  }
  return null;
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
  // Module instantiations are like function calls: `ModuleName instance_name(...);`.
  // The module type identifier is the first *named* child; using
  // `namedChild(0)` (instead of `child(0)`) skips anonymous tokens like a
  // leading `#` parameter-override punctuation so we never capture that as a
  // call name. The Rust extractor uses the same lookup for parity.
  const moduleType = node.childForFieldName('type') ?? node.namedChild(0);
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
      // `String.split('::')` always yields at least one element — when the
      // delimiter is absent the whole string is the sole item, so the
      // empty-string fallback is unreachable in practice.
      const pkg = parts[0] ?? '';
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
  // Mirrors the Rust `handle_include_directive` which checks all three node
  // kinds — tree-sitter-verilog has emitted `double_quoted_string` in some
  // grammar revisions, and missing it would silently drop the import in WASM
  // while the native engine still records it.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (
      child &&
      (child.type === 'string_literal' ||
        child.type === 'quoted_string' ||
        child.type === 'double_quoted_string')
    ) {
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
      // `class_declaration` wraps its name in `class_identifier >
      // simple_identifier`; `findDeclName` / `findModuleName` only look at
      // bare `simple_identifier`/`identifier` children, so they miss it.
      // `findClassName` already handles the wrapper, so consult it last to
      // qualify tasks/functions nested inside a SystemVerilog class.
      const nameNode = findDeclName(current) || findModuleName(current);
      if (nameNode) return nameNode.text;
      return findClassName(current);
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
          findChild(child, 'port_identifier') ||
          findChild(child, 'simple_identifier') ||
          findChild(child, 'identifier');
        if (nameNode) {
          // `port_identifier` wraps a `simple_identifier`; descend to the
          // innermost identifier for a clean, whitespace-free name.
          const inner =
            findChild(nameNode, 'simple_identifier') ||
            findChild(nameNode, 'identifier') ||
            nameNode;
          ports.push({ name: inner.text, kind: 'property', line: child.startPosition.row + 1 });
        }
      }

      // Recurse into port list containers. `module_ansi_header` wraps the
      // ANSI-style declarations emitted by tree-sitter-verilog (e.g.
      // `module top(input clk, output reg q);`) — without this branch the
      // WASM engine returns an empty children array while the native engine
      // (which includes the same kind in its CONTAINER_KINDS list) returns
      // the correct ports, breaking engine parity.
      if (
        child.type === 'list_of_port_declarations' ||
        child.type === 'module_header' ||
        child.type === 'module_ansi_header' ||
        child.type === 'port_declaration_list'
      ) {
        collectFromNode(child);
      }
    }
  };

  collectFromNode(moduleNode);
  return ports;
}
