import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import { warn, debug } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function grammarPath(name) {
  return path.join(__dirname, '..', 'grammars', name);
}

let _initialized = false;

export async function createParsers() {
  if (!_initialized) {
    await Parser.init();
    _initialized = true;
  }

  const JavaScript = await Language.load(grammarPath('tree-sitter-javascript.wasm'));
  const TypeScript = await Language.load(grammarPath('tree-sitter-typescript.wasm'));
  const TSX = await Language.load(grammarPath('tree-sitter-tsx.wasm'));

  const jsParser = new Parser();
  jsParser.setLanguage(JavaScript);

  const tsParser = new Parser();
  tsParser.setLanguage(TypeScript);

  const tsxParser = new Parser();
  tsxParser.setLanguage(TSX);

  let hclParser = null;
  try {
    const HCL = await Language.load(grammarPath('tree-sitter-hcl.wasm'));
    hclParser = new Parser();
    hclParser.setLanguage(HCL);
  } catch (e) {
    warn(`HCL parser failed to initialize: ${e.message}. HCL files will be skipped.`);
  }

  let pyParser = null;
  try {
    const Python = await Language.load(grammarPath('tree-sitter-python.wasm'));
    pyParser = new Parser();
    pyParser.setLanguage(Python);
  } catch (e) {
    warn(`Python parser failed to initialize: ${e.message}. Python files will be skipped.`);
  }

  return { jsParser, tsParser, tsxParser, hclParser, pyParser };
}

export function getParser(parsers, filePath) {
  if (filePath.endsWith('.tsx')) return parsers.tsxParser;
  if (filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) return parsers.tsParser;
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs'))
    return parsers.jsParser;
  if (filePath.endsWith('.py') && parsers.pyParser) return parsers.pyParser;
  if ((filePath.endsWith('.tf') || filePath.endsWith('.hcl')) && parsers.hclParser)
    return parsers.hclParser;
  return null;
}

function nodeEndLine(node) {
  return node.endPosition.row + 1;
}

/**
 * Extract symbols from a JS/TS parsed AST.
 */
export function extractSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walk(node) {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const cls = { name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) };
          definitions.push(cls);
          const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
          if (heritage) {
            const superName = extractSuperclass(heritage);
            if (superName) {
              classes.push({ name: nameNode.text, extends: superName, line: node.startPosition.row + 1 });
            }
            const implementsList = extractImplements(heritage);
            for (const iface of implementsList) {
              classes.push({ name: nameNode.text, implements: iface, line: node.startPosition.row + 1 });
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          let parentClass = findParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const body = node.childForFieldName('body') || findChild(node, 'interface_body') || findChild(node, 'object_type');
          if (body) {
            extractInterfaceMethods(body, nameNode.text, definitions);
          }
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'type', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (declarator && declarator.type === 'variable_declarator') {
            const nameN = declarator.childForFieldName('name');
            const valueN = declarator.childForFieldName('value');
            if (nameN && valueN && (valueN.type === 'arrow_function' || valueN.type === 'function_expression' || valueN.type === 'function')) {
              definitions.push({ name: nameN.text, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(valueN) });
            }
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          const callInfo = extractCallInfo(fn, node);
          if (callInfo) {
            calls.push(callInfo);
          }
        }
        break;
      }

      case 'import_statement': {
        const isTypeOnly = node.text.startsWith('import type');
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source) {
          const modPath = source.text.replace(/['"]/g, '');
          const names = extractImportNames(node);
          imports.push({ source: modPath, names, line: node.startPosition.row + 1, typeOnly: isTypeOnly });
        }
        break;
      }

      case 'export_statement': {
        const decl = node.childForFieldName('declaration');
        if (decl) {
          if (decl.type === 'function_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'function', line: node.startPosition.row + 1 });
          } else if (decl.type === 'class_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'class', line: node.startPosition.row + 1 });
          } else if (decl.type === 'interface_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'interface', line: node.startPosition.row + 1 });
          } else if (decl.type === 'type_alias_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'type', line: node.startPosition.row + 1 });
          }
        }
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source && !decl) {
          const modPath = source.text.replace(/['"]/g, '');
          const reexportNames = extractImportNames(node);
          const isWildcard = node.text.includes('export *') || node.text.includes('export*');
          imports.push({ source: modPath, names: reexportNames, line: node.startPosition.row + 1, reexport: true, wildcardReexport: isWildcard && reexportNames.length === 0 });
        }
        break;
      }

      case 'expression_statement': {
        const expr = node.child(0);
        if (expr && expr.type === 'assignment_expression') {
          const left = expr.childForFieldName('left');
          const right = expr.childForFieldName('right');
          if (left && right) {
            const leftText = left.text;
            if (leftText.startsWith('module.exports') || leftText === 'exports') {
              if (right.type === 'call_expression') {
                const fn = right.childForFieldName('function');
                const args = right.childForFieldName('arguments') || findChild(right, 'arguments');
                if (fn && fn.text === 'require' && args) {
                  const strArg = findChild(args, 'string');
                  if (strArg) {
                    const modPath = strArg.text.replace(/['"]/g, '');
                    imports.push({ source: modPath, names: [], line: node.startPosition.row + 1, reexport: true, wildcardReexport: true });
                  }
                }
              }
              if (right.type === 'object') {
                for (let ci = 0; ci < right.childCount; ci++) {
                  const child = right.child(ci);
                  if (child && child.type === 'spread_element') {
                    const spreadExpr = child.child(1) || child.childForFieldName('value');
                    if (spreadExpr && spreadExpr.type === 'call_expression') {
                      const fn2 = spreadExpr.childForFieldName('function');
                      const args2 = spreadExpr.childForFieldName('arguments') || findChild(spreadExpr, 'arguments');
                      if (fn2 && fn2.text === 'require' && args2) {
                        const strArg2 = findChild(args2, 'string');
                        if (strArg2) {
                          const modPath2 = strArg2.text.replace(/['"]/g, '');
                          imports.push({ source: modPath2, names: [], line: node.startPosition.row + 1, reexport: true, wildcardReexport: true });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

function extractInterfaceMethods(bodyNode, interfaceName, definitions) {
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
          endLine: child.endPosition.row + 1
        });
      }
    }
  }
}

function extractImplements(heritage) {
  const interfaces = [];
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

function extractImplementsFromNode(node) {
  const result = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'type_identifier') result.push(child.text);
    if (child.childCount > 0) result.push(...extractImplementsFromNode(child));
  }
  return result;
}

function extractCallInfo(fn, callNode) {
  if (fn.type === 'identifier') {
    return { name: fn.text, line: callNode.startPosition.row + 1 };
  }

  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!prop) return null;

    if (prop.text === 'call' || prop.text === 'apply' || prop.text === 'bind') {
      if (obj && obj.type === 'identifier') return { name: obj.text, line: callNode.startPosition.row + 1, dynamic: true };
      if (obj && obj.type === 'member_expression') {
        const innerProp = obj.childForFieldName('property');
        if (innerProp) return { name: innerProp.text, line: callNode.startPosition.row + 1, dynamic: true };
      }
    }

    if (prop.type === 'string' || prop.type === 'string_fragment') {
      const methodName = prop.text.replace(/['"]/g, '');
      if (methodName) return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true };
    }

    return { name: prop.text, line: callNode.startPosition.row + 1 };
  }

  if (fn.type === 'subscript_expression') {
    const index = fn.childForFieldName('index');
    if (index && (index.type === 'string' || index.type === 'template_string')) {
      const methodName = index.text.replace(/['"`]/g, '');
      if (methodName && !methodName.includes('$')) return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true };
    }
  }

  return null;
}

function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}

function extractSuperclass(heritage) {
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i);
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
    const found = extractSuperclass(child);
    if (found) return found;
  }
  return null;
}

function findParentClass(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

function extractImportNames(node) {
  const names = [];
  function scan(n) {
    if (n.type === 'import_specifier' || n.type === 'export_specifier') {
      const nameNode = n.childForFieldName('name') || n.childForFieldName('alias');
      if (nameNode) names.push(nameNode.text);
      else names.push(n.text);
    } else if (n.type === 'identifier' && n.parent && n.parent.type === 'import_clause') {
      names.push(n.text);
    } else if (n.type === 'namespace_import') {
      names.push(n.text);
    }
    for (let i = 0; i < n.childCount; i++) scan(n.child(i));
  }
  scan(node);
  return names;
}

/**
 * Extract symbols from HCL (Terraform) files.
 */
export function extractHCLSymbols(tree, filePath) {
  const definitions = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'block') {
      const children = [];
      for (let i = 0; i < node.childCount; i++) children.push(node.child(i));

      const identifiers = children.filter(c => c.type === 'identifier');
      const strings = children.filter(c => c.type === 'string_lit');

      if (identifiers.length > 0) {
        const blockType = identifiers[0].text;
        let name = '';

        if (blockType === 'resource' && strings.length >= 2) {
          name = `${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if (blockType === 'data' && strings.length >= 2) {
          name = `data.${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if ((blockType === 'variable' || blockType === 'output' || blockType === 'module') && strings.length >= 1) {
          name = `${blockType}.${strings[0].text.replace(/"/g, '')}`;
        } else if (blockType === 'locals') {
          name = 'locals';
        } else if (blockType === 'terraform' || blockType === 'provider') {
          name = blockType;
          if (strings.length >= 1) name += `.${strings[0].text.replace(/"/g, '')}`;
        }

        if (name) {
          definitions.push({ name, kind: blockType, line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }

        if (blockType === 'module') {
          const body = children.find(c => c.type === 'body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const attr = body.child(i);
              if (attr && attr.type === 'attribute') {
                const key = attr.childForFieldName('key') || attr.child(0);
                const val = attr.childForFieldName('val') || attr.child(2);
                if (key && key.text === 'source' && val) {
                  const src = val.text.replace(/"/g, '');
                  if (src.startsWith('./') || src.startsWith('../')) {
                    imports.push({ source: src, names: [], line: attr.startPosition.row + 1 });
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls: [], imports, classes: [], exports: [] };
}

/**
 * Extract symbols from Python files.
 */
export function extractPythonSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walk(node) {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          let decorators = [];
          if (node.previousSibling && node.previousSibling.type === 'decorator') {
            decorators.push(node.previousSibling.text);
          }
          const parentClass = findPythonParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          const kind = parentClass ? 'method' : 'function';
          definitions.push({ name: fullName, kind, line: node.startPosition.row + 1, endLine: nodeEndLine(node), decorators });
        }
        break;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const superclasses = node.childForFieldName('superclasses') || findChild(node, 'argument_list');
          if (superclasses) {
            for (let i = 0; i < superclasses.childCount; i++) {
              const child = superclasses.child(i);
              if (child && child.type === 'identifier') {
                classes.push({ name: nameNode.text, extends: child.text, line: node.startPosition.row + 1 });
              }
            }
          }
        }
        break;
      }

      case 'decorated_definition': {
        for (let i = 0; i < node.childCount; i++) walk(node.child(i));
        return;
      }

      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn) {
          let callName = null;
          if (fn.type === 'identifier') callName = fn.text;
          else if (fn.type === 'attribute') {
            const attr = fn.childForFieldName('attribute');
            if (attr) callName = attr.text;
          }
          if (callName) calls.push({ name: callName, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'import_statement': {
        const names = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'dotted_name' || child.type === 'aliased_import')) {
            const name = child.type === 'aliased_import' ?
              (child.childForFieldName('alias') || child.childForFieldName('name'))?.text :
              child.text;
            if (name) names.push(name);
          }
        }
        if (names.length > 0) imports.push({ source: names[0], names, line: node.startPosition.row + 1, pythonImport: true });
        break;
      }

      case 'import_from_statement': {
        let source = '';
        const names = [];
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
        if (source) imports.push({ source, names, line: node.startPosition.row + 1, pythonImport: true });
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  function findPythonParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_definition') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
