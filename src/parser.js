import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import { warn, debug } from './logger.js';
import { loadNative, isNativeAvailable } from './native.js';
import { normalizePath } from './constants.js';

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

  let goParser = null;
  try {
    const Go = await Language.load(grammarPath('tree-sitter-go.wasm'));
    goParser = new Parser();
    goParser.setLanguage(Go);
  } catch (e) {
    warn(`Go parser failed to initialize: ${e.message}. Go files will be skipped.`);
  }

  let rustParser = null;
  try {
    const Rust = await Language.load(grammarPath('tree-sitter-rust.wasm'));
    rustParser = new Parser();
    rustParser.setLanguage(Rust);
  } catch (e) {
    warn(`Rust parser failed to initialize: ${e.message}. Rust files will be skipped.`);
  }

  let javaParser = null;
  try {
    const Java = await Language.load(grammarPath('tree-sitter-java.wasm'));
    javaParser = new Parser();
    javaParser.setLanguage(Java);
  } catch (e) {
    warn(`Java parser failed to initialize: ${e.message}. Java files will be skipped.`);
  }

  let csharpParser = null;
  try {
    const CSharp = await Language.load(grammarPath('tree-sitter-c_sharp.wasm'));
    csharpParser = new Parser();
    csharpParser.setLanguage(CSharp);
  } catch (e) {
    warn(`C# parser failed to initialize: ${e.message}. C# files will be skipped.`);
  }

  let rubyParser = null;
  try {
    const Ruby = await Language.load(grammarPath('tree-sitter-ruby.wasm'));
    rubyParser = new Parser();
    rubyParser.setLanguage(Ruby);
  } catch (e) {
    warn(`Ruby parser failed to initialize: ${e.message}. Ruby files will be skipped.`);
  }

  let phpParser = null;
  try {
    const PHP = await Language.load(grammarPath('tree-sitter-php.wasm'));
    phpParser = new Parser();
    phpParser.setLanguage(PHP);
  } catch (e) {
    warn(`PHP parser failed to initialize: ${e.message}. PHP files will be skipped.`);
  }

  return { jsParser, tsParser, tsxParser, hclParser, pyParser, goParser, rustParser, javaParser, csharpParser, rubyParser, phpParser };
}

export function getParser(parsers, filePath) {
  if (filePath.endsWith('.tsx')) return parsers.tsxParser;
  if (filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) return parsers.tsParser;
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs'))
    return parsers.jsParser;
  if (filePath.endsWith('.py') && parsers.pyParser) return parsers.pyParser;
  if ((filePath.endsWith('.tf') || filePath.endsWith('.hcl')) && parsers.hclParser)
    return parsers.hclParser;
  if (filePath.endsWith('.go') && parsers.goParser) return parsers.goParser;
  if (filePath.endsWith('.rs') && parsers.rustParser) return parsers.rustParser;
  if (filePath.endsWith('.java') && parsers.javaParser) return parsers.javaParser;
  if (filePath.endsWith('.cs') && parsers.csharpParser) return parsers.csharpParser;
  if (filePath.endsWith('.rb') && parsers.rubyParser) return parsers.rubyParser;
  if (filePath.endsWith('.php') && parsers.phpParser) return parsers.phpParser;
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

/**
 * Extract symbols from Go files.
 */
export function extractGoSymbols(tree, filePath) {
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

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const receiver = node.childForFieldName('receiver');
        if (nameNode) {
          let receiverType = null;
          if (receiver) {
            // receiver is a parameter_list like (r *Foo) or (r Foo)
            for (let i = 0; i < receiver.childCount; i++) {
              const param = receiver.child(i);
              if (!param) continue;
              const typeNode = param.childForFieldName('type');
              if (typeNode) {
                receiverType = typeNode.type === 'pointer_type'
                  ? typeNode.text.replace(/^\*/, '')
                  : typeNode.text;
                break;
              }
            }
          }
          const fullName = receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'type_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const spec = node.child(i);
          if (!spec || spec.type !== 'type_spec') continue;
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          if (nameNode && typeNode) {
            if (typeNode.type === 'struct_type') {
              definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
            } else if (typeNode.type === 'interface_type') {
              definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
              for (let j = 0; j < typeNode.childCount; j++) {
                const member = typeNode.child(j);
                if (member && member.type === 'method_elem') {
                  const methName = member.childForFieldName('name');
                  if (methName) {
                    definitions.push({ name: `${nameNode.text}.${methName.text}`, kind: 'method', line: member.startPosition.row + 1, endLine: member.endPosition.row + 1 });
                  }
                }
              }
            } else {
              definitions.push({ name: nameNode.text, kind: 'type', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
            }
          }
        }
        break;
      }

      case 'import_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === 'import_spec') {
            const pathNode = child.childForFieldName('path');
            if (pathNode) {
              const importPath = pathNode.text.replace(/"/g, '');
              const nameNode = child.childForFieldName('name');
              const alias = nameNode ? nameNode.text : importPath.split('/').pop();
              imports.push({ source: importPath, names: [alias], line: child.startPosition.row + 1, goImport: true });
            }
          }
          if (child.type === 'import_spec_list') {
            for (let j = 0; j < child.childCount; j++) {
              const spec = child.child(j);
              if (spec && spec.type === 'import_spec') {
                const pathNode = spec.childForFieldName('path');
                if (pathNode) {
                  const importPath = pathNode.text.replace(/"/g, '');
                  const nameNode = spec.childForFieldName('name');
                  const alias = nameNode ? nameNode.text : importPath.split('/').pop();
                  imports.push({ source: importPath, names: [alias], line: spec.startPosition.row + 1, goImport: true });
                }
              }
            }
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'selector_expression') {
            const field = fn.childForFieldName('field');
            if (field) calls.push({ name: field.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

/**
 * Extract symbols from Rust files.
 */
export function extractRustSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findCurrentImpl(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'impl_item') {
        const typeNode = current.childForFieldName('type');
        return typeNode ? typeNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    switch (node.type) {
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const implType = findCurrentImpl(node);
          const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
          const kind = implType ? 'method' : 'function';
          definitions.push({ name: fullName, kind, line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'struct_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'enum_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (child && (child.type === 'function_signature_item' || child.type === 'function_item')) {
                const methName = child.childForFieldName('name');
                if (methName) {
                  definitions.push({ name: `${nameNode.text}.${methName.text}`, kind: 'method', line: child.startPosition.row + 1, endLine: child.endPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }

      case 'impl_item': {
        const typeNode = node.childForFieldName('type');
        const traitNode = node.childForFieldName('trait');
        if (typeNode && traitNode) {
          classes.push({ name: typeNode.text, implements: traitNode.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'use_declaration': {
        const argNode = node.child(1);
        if (argNode) {
          const usePaths = extractRustUsePath(argNode);
          for (const imp of usePaths) {
            imports.push({ source: imp.source, names: imp.names, line: node.startPosition.row + 1, rustUse: true });
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'field_expression') {
            const field = fn.childForFieldName('field');
            if (field) calls.push({ name: field.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'scoped_identifier') {
            const name = fn.childForFieldName('name');
            if (name) calls.push({ name: name.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'macro_invocation': {
        const macroNode = node.child(0);
        if (macroNode) {
          calls.push({ name: macroNode.text + '!', line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

function extractRustUsePath(node) {
  if (!node) return [];

  if (node.type === 'use_list') {
    const results = [];
    for (let i = 0; i < node.childCount; i++) {
      results.push(...extractRustUsePath(node.child(i)));
    }
    return results;
  }

  if (node.type === 'scoped_use_list') {
    const pathNode = node.childForFieldName('path');
    const listNode = node.childForFieldName('list');
    const prefix = pathNode ? pathNode.text : '';
    if (listNode) {
      const names = [];
      for (let i = 0; i < listNode.childCount; i++) {
        const child = listNode.child(i);
        if (child && (child.type === 'identifier' || child.type === 'use_as_clause' || child.type === 'self')) {
          const name = child.type === 'use_as_clause'
            ? (child.childForFieldName('alias') || child.childForFieldName('name'))?.text
            : child.text;
          if (name) names.push(name);
        }
      }
      return [{ source: prefix, names }];
    }
    return [{ source: prefix, names: [] }];
  }

  if (node.type === 'use_as_clause') {
    const name = node.childForFieldName('alias') || node.childForFieldName('name');
    return [{ source: node.text, names: name ? [name.text] : [] }];
  }

  if (node.type === 'use_wildcard') {
    const pathNode = node.childForFieldName('path');
    return [{ source: pathNode ? pathNode.text : '*', names: ['*'] }];
  }

  if (node.type === 'scoped_identifier' || node.type === 'identifier') {
    const text = node.text;
    const lastName = text.split('::').pop();
    return [{ source: text, names: [lastName] }];
  }

  return [];
}

/**
 * Extract symbols from Java files.
 */
export function extractJavaSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findJavaParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_declaration' || current.type === 'enum_declaration' || current.type === 'interface_declaration') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    switch (node.type) {
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });

          const superclass = node.childForFieldName('superclass');
          if (superclass) {
            for (let i = 0; i < superclass.childCount; i++) {
              const child = superclass.child(i);
              if (child && (child.type === 'type_identifier' || child.type === 'identifier' || child.type === 'generic_type')) {
                const superName = child.type === 'generic_type' ? child.child(0)?.text : child.text;
                if (superName) classes.push({ name: nameNode.text, extends: superName, line: node.startPosition.row + 1 });
                break;
              }
            }
          }

          const interfaces = node.childForFieldName('interfaces');
          if (interfaces) {
            for (let i = 0; i < interfaces.childCount; i++) {
              const child = interfaces.child(i);
              if (child && (child.type === 'type_identifier' || child.type === 'identifier' || child.type === 'type_list' || child.type === 'generic_type')) {
                if (child.type === 'type_list') {
                  for (let j = 0; j < child.childCount; j++) {
                    const t = child.child(j);
                    if (t && (t.type === 'type_identifier' || t.type === 'identifier' || t.type === 'generic_type')) {
                      const ifaceName = t.type === 'generic_type' ? t.child(0)?.text : t.text;
                      if (ifaceName) classes.push({ name: nameNode.text, implements: ifaceName, line: node.startPosition.row + 1 });
                    }
                  }
                } else {
                  const ifaceName = child.type === 'generic_type' ? child.child(0)?.text : child.text;
                  if (ifaceName) classes.push({ name: nameNode.text, implements: ifaceName, line: node.startPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (child && child.type === 'method_declaration') {
                const methName = child.childForFieldName('name');
                if (methName) {
                  definitions.push({ name: `${nameNode.text}.${methName.text}`, kind: 'method', line: child.startPosition.row + 1, endLine: child.endPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findJavaParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findJavaParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'import_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'scoped_identifier' || child.type === 'identifier')) {
            const fullPath = child.text;
            const lastName = fullPath.split('.').pop();
            imports.push({ source: fullPath, names: [lastName], line: node.startPosition.row + 1, javaImport: true });
          }
          if (child && child.type === 'asterisk') {
            const lastImport = imports[imports.length - 1];
            if (lastImport) lastImport.names = ['*'];
          }
        }
        break;
      }

      case 'method_invocation': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          calls.push({ name: nameNode.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'object_creation_expression': {
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
          const typeName = typeNode.type === 'generic_type' ? typeNode.child(0)?.text : typeNode.text;
          if (typeName) calls.push({ name: typeName, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

/**
 * Extract symbols from C# files.
 */
export function extractCSharpSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findCSharpParentType(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_declaration' || current.type === 'struct_declaration' ||
          current.type === 'interface_declaration' || current.type === 'enum_declaration' ||
          current.type === 'record_declaration') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    switch (node.type) {
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          extractCSharpBaseTypes(node, nameNode.text, classes);
        }
        break;
      }

      case 'struct_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          extractCSharpBaseTypes(node, nameNode.text, classes);
        }
        break;
      }

      case 'record_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          extractCSharpBaseTypes(node, nameNode.text, classes);
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (child && child.type === 'method_declaration') {
                const methName = child.childForFieldName('name');
                if (methName) {
                  definitions.push({ name: `${nameNode.text}.${methName.text}`, kind: 'method', line: child.startPosition.row + 1, endLine: child.endPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'property_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'using_directive': {
        // using System.Collections.Generic;
        const nameNode = node.childForFieldName('name') || findChild(node, 'qualified_name') || findChild(node, 'identifier');
        if (nameNode) {
          const fullPath = nameNode.text;
          const lastName = fullPath.split('.').pop();
          imports.push({ source: fullPath, names: [lastName], line: node.startPosition.row + 1, csharpUsing: true });
        }
        break;
      }

      case 'invocation_expression': {
        const fn = node.childForFieldName('function') || node.child(0);
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'member_access_expression') {
            const name = fn.childForFieldName('name');
            if (name) calls.push({ name: name.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'generic_name' || fn.type === 'member_binding_expression') {
            const name = fn.childForFieldName('name') || fn.child(0);
            if (name) calls.push({ name: name.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'object_creation_expression': {
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
          const typeName = typeNode.type === 'generic_name' ? typeNode.childForFieldName('name')?.text || typeNode.child(0)?.text : typeNode.text;
          if (typeName) calls.push({ name: typeName, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

function extractCSharpBaseTypes(node, className, classes) {
  const baseList = node.childForFieldName('bases');
  if (!baseList) return;
  for (let i = 0; i < baseList.childCount; i++) {
    const child = baseList.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'qualified_name') {
      classes.push({ name: className, extends: child.text, line: node.startPosition.row + 1 });
    } else if (child.type === 'generic_name') {
      const name = child.childForFieldName('name') || child.child(0);
      if (name) classes.push({ name: className, extends: name.text, line: node.startPosition.row + 1 });
    } else if (child.type === 'base_list') {
      for (let j = 0; j < child.childCount; j++) {
        const base = child.child(j);
        if (base && (base.type === 'identifier' || base.type === 'qualified_name')) {
          classes.push({ name: className, extends: base.text, line: node.startPosition.row + 1 });
        } else if (base && base.type === 'generic_name') {
          const name = base.childForFieldName('name') || base.child(0);
          if (name) classes.push({ name: className, extends: name.text, line: node.startPosition.row + 1 });
        }
      }
    }
  }
}

/**
 * Extract symbols from Ruby files.
 */
export function extractRubySymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findRubyParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      if (current.type === 'module') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    switch (node.type) {
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const superclass = node.childForFieldName('superclass');
          if (superclass) {
            // superclass wraps the < token and class name
            for (let i = 0; i < superclass.childCount; i++) {
              const child = superclass.child(i);
              if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
                classes.push({ name: nameNode.text, extends: child.text, line: node.startPosition.row + 1 });
                break;
              }
            }
            // Direct superclass node may be a constant
            if (superclass.type === 'superclass') {
              for (let i = 0; i < superclass.childCount; i++) {
                const child = superclass.child(i);
                if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
                  classes.push({ name: nameNode.text, extends: child.text, line: node.startPosition.row + 1 });
                  break;
                }
              }
            }
          }
        }
        break;
      }

      case 'module': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findRubyParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findRubyParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'call': {
        const methodNode = node.childForFieldName('method');
        if (methodNode) {
          // Check for require/require_relative
          if (methodNode.text === 'require' || methodNode.text === 'require_relative') {
            const args = node.childForFieldName('arguments');
            if (args) {
              for (let i = 0; i < args.childCount; i++) {
                const arg = args.child(i);
                if (arg && (arg.type === 'string' || arg.type === 'string_content')) {
                  const strContent = arg.text.replace(/^['"]|['"]$/g, '');
                  imports.push({ source: strContent, names: [strContent.split('/').pop()], line: node.startPosition.row + 1, rubyRequire: true });
                  break;
                }
                // Look inside string for string_content
                if (arg && arg.type === 'string') {
                  const content = findChild(arg, 'string_content');
                  if (content) {
                    imports.push({ source: content.text, names: [content.text.split('/').pop()], line: node.startPosition.row + 1, rubyRequire: true });
                    break;
                  }
                }
              }
            }
          } else if (methodNode.text === 'include' || methodNode.text === 'extend' || methodNode.text === 'prepend') {
            // Module inclusion — treated like implements
            const parentClass = findRubyParentClass(node);
            if (parentClass) {
              const args = node.childForFieldName('arguments');
              if (args) {
                for (let i = 0; i < args.childCount; i++) {
                  const arg = args.child(i);
                  if (arg && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
                    classes.push({ name: parentClass, implements: arg.text, line: node.startPosition.row + 1 });
                  }
                }
              }
            }
          } else {
            calls.push({ name: methodNode.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

/**
 * Extract symbols from PHP files.
 */
export function extractPHPSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findPHPParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_declaration' || current.type === 'trait_declaration' || current.type === 'enum_declaration') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walk(node) {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });

          // Check base clause (extends)
          const baseClause = node.childForFieldName('base_clause') || findChild(node, 'base_clause');
          if (baseClause) {
            for (let i = 0; i < baseClause.childCount; i++) {
              const child = baseClause.child(i);
              if (child && (child.type === 'name' || child.type === 'qualified_name')) {
                classes.push({ name: nameNode.text, extends: child.text, line: node.startPosition.row + 1 });
                break;
              }
            }
          }

          // Check class interface clause (implements)
          const interfaceClause = findChild(node, 'class_interface_clause');
          if (interfaceClause) {
            for (let i = 0; i < interfaceClause.childCount; i++) {
              const child = interfaceClause.child(i);
              if (child && (child.type === 'name' || child.type === 'qualified_name')) {
                classes.push({ name: nameNode.text, implements: child.text, line: node.startPosition.row + 1 });
              }
            }
          }
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (child && child.type === 'method_declaration') {
                const methName = child.childForFieldName('name');
                if (methName) {
                  definitions.push({ name: `${nameNode.text}.${methName.text}`, kind: 'method', line: child.startPosition.row + 1, endLine: child.endPosition.row + 1 });
                }
              }
            }
          }
        }
        break;
      }

      case 'trait_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findPHPParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'namespace_use_declaration': {
        // use App\Models\User;
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'namespace_use_clause') {
            const nameNode = findChild(child, 'qualified_name') || findChild(child, 'name');
            if (nameNode) {
              const fullPath = nameNode.text;
              const lastName = fullPath.split('\\').pop();
              const alias = child.childForFieldName('alias');
              imports.push({ source: fullPath, names: [alias ? alias.text : lastName], line: node.startPosition.row + 1, phpUse: true });
            }
          }
          // Single use clause without wrapper
          if (child && (child.type === 'qualified_name' || child.type === 'name')) {
            const fullPath = child.text;
            const lastName = fullPath.split('\\').pop();
            imports.push({ source: fullPath, names: [lastName], line: node.startPosition.row + 1, phpUse: true });
          }
        }
        break;
      }

      case 'function_call_expression': {
        const fn = node.childForFieldName('function') || node.child(0);
        if (fn) {
          if (fn.type === 'name' || fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'qualified_name') {
            const parts = fn.text.split('\\');
            calls.push({ name: parts[parts.length - 1], line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'member_call_expression': {
        const name = node.childForFieldName('name');
        if (name) {
          calls.push({ name: name.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'scoped_call_expression': {
        const name = node.childForFieldName('name');
        if (name) {
          calls.push({ name: name.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'object_creation_expression': {
        const classNode = node.child(1); // skip 'new' keyword
        if (classNode && (classNode.type === 'name' || classNode.type === 'qualified_name')) {
          const parts = classNode.text.split('\\');
          calls.push({ name: parts[parts.length - 1], line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

// ── Unified API ──────────────────────────────────────────────────────────────

function resolveEngine(opts = {}) {
  const pref = opts.engine || 'auto';
  if (pref === 'wasm') return { name: 'wasm', native: null };
  if (pref === 'native' || pref === 'auto') {
    const native = loadNative();
    if (native) return { name: 'native', native };
    if (pref === 'native') {
      warn('Native engine requested but unavailable — falling back to WASM');
    }
  }
  return { name: 'wasm', native: null };
}

/**
 * Normalize native engine output to match the camelCase convention
 * used by the WASM extractors.
 */
function normalizeNativeSymbols(result) {
  return {
    definitions: (result.definitions || []).map(d => ({
      name: d.name, kind: d.kind, line: d.line,
      endLine: d.endLine ?? d.end_line ?? null,
      decorators: d.decorators
    })),
    calls: (result.calls || []).map(c => ({
      name: c.name, line: c.line, dynamic: c.dynamic
    })),
    imports: (result.imports || []).map(i => ({
      source: i.source, names: i.names || [], line: i.line,
      typeOnly: i.typeOnly ?? i.type_only,
      reexport: i.reexport,
      wildcardReexport: i.wildcardReexport ?? i.wildcard_reexport,
      pythonImport: i.pythonImport ?? i.python_import,
      goImport: i.goImport ?? i.go_import,
      rustUse: i.rustUse ?? i.rust_use,
      javaImport: i.javaImport ?? i.java_import,
      csharpUsing: i.csharpUsing ?? i.csharp_using,
      rubyRequire: i.rubyRequire ?? i.ruby_require,
      phpUse: i.phpUse ?? i.php_use
    })),
    classes: (result.classes || []).map(c => ({
      name: c.name, extends: c.extends, implements: c.implements, line: c.line
    })),
    exports: (result.exports || []).map(e => ({
      name: e.name, kind: e.kind, line: e.line
    }))
  };
}

/**
 * WASM extraction helper: picks the right extractor based on file extension.
 */
function wasmExtractSymbols(parsers, filePath, code) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;

  let tree;
  try { tree = parser.parse(code); }
  catch (e) {
    warn(`Parse error in ${filePath}: ${e.message}`);
    return null;
  }

  if (filePath.endsWith('.tf') || filePath.endsWith('.hcl')) return extractHCLSymbols(tree, filePath);
  if (filePath.endsWith('.py')) return extractPythonSymbols(tree, filePath);
  if (filePath.endsWith('.go')) return extractGoSymbols(tree, filePath);
  if (filePath.endsWith('.rs')) return extractRustSymbols(tree, filePath);
  if (filePath.endsWith('.java')) return extractJavaSymbols(tree, filePath);
  if (filePath.endsWith('.cs')) return extractCSharpSymbols(tree, filePath);
  if (filePath.endsWith('.rb')) return extractRubySymbols(tree, filePath);
  if (filePath.endsWith('.php')) return extractPHPSymbols(tree, filePath);
  return extractSymbols(tree, filePath);
}

/**
 * Parse a single file and return normalized symbols.
 *
 * @param {string} filePath  Absolute path to the file.
 * @param {string} source    Source code string.
 * @param {object} [opts]    Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {Promise<{definitions, calls, imports, classes, exports}|null>}
 */
export async function parseFileAuto(filePath, source, opts = {}) {
  const { name, native } = resolveEngine(opts);

  if (native) {
    const result = native.parseFile(filePath, source);
    return result ? normalizeNativeSymbols(result) : null;
  }

  // WASM path
  const parsers = await createParsers();
  return wasmExtractSymbols(parsers, filePath, source);
}

/**
 * Parse multiple files in bulk and return a Map<relPath, symbols>.
 *
 * @param {string[]} filePaths  Absolute paths to files.
 * @param {string}   rootDir    Project root for computing relative paths.
 * @param {object}   [opts]     Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {Promise<Map<string, {definitions, calls, imports, classes, exports}>>}
 */
export async function parseFilesAuto(filePaths, rootDir, opts = {}) {
  const { name, native } = resolveEngine(opts);
  const result = new Map();

  if (native) {
    const nativeResults = native.parseFiles(filePaths, rootDir);
    for (const r of nativeResults) {
      if (!r) continue;
      const relPath = normalizePath(path.relative(rootDir, r.file));
      result.set(relPath, normalizeNativeSymbols(r));
    }
    return result;
  }

  // WASM path
  const parsers = await createParsers();
  for (const filePath of filePaths) {
    let code;
    try { code = fs.readFileSync(filePath, 'utf-8'); }
    catch (err) {
      warn(`Skipping ${path.relative(rootDir, filePath)}: ${err.message}`);
      continue;
    }
    const symbols = wasmExtractSymbols(parsers, filePath, code);
    if (symbols) {
      const relPath = normalizePath(path.relative(rootDir, filePath));
      result.set(relPath, symbols);
    }
  }
  return result;
}

/**
 * Report which engine is active.
 *
 * @param {object} [opts]  Options: { engine: 'native'|'wasm'|'auto' }
 * @returns {{ name: 'native'|'wasm', version: string|null }}
 */
export function getActiveEngine(opts = {}) {
  const { name, native } = resolveEngine(opts);
  const version = native ? (typeof native.engineVersion === 'function' ? native.engineVersion() : null) : null;
  return { name, version };
}
