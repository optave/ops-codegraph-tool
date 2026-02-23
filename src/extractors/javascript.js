import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from a JS/TS parsed AST.
 */
export function extractSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walkJavaScriptNode(node) {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const cls = {
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          };
          definitions.push(cls);
          const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
          if (heritage) {
            const superName = extractSuperclass(heritage);
            if (superName) {
              classes.push({
                name: nameNode.text,
                extends: superName,
                line: node.startPosition.row + 1,
              });
            }
            const implementsList = extractImplements(heritage);
            for (const iface of implementsList) {
              classes.push({
                name: nameNode.text,
                implements: iface,
                line: node.startPosition.row + 1,
              });
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'interface',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          const body =
            node.childForFieldName('body') ||
            findChild(node, 'interface_body') ||
            findChild(node, 'object_type');
          if (body) {
            extractInterfaceMethods(body, nameNode.text, definitions);
          }
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'type',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
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
            if (
              nameN &&
              valueN &&
              (valueN.type === 'arrow_function' ||
                valueN.type === 'function_expression' ||
                valueN.type === 'function')
            ) {
              definitions.push({
                name: nameN.text,
                kind: 'function',
                line: node.startPosition.row + 1,
                endLine: nodeEndLine(valueN),
              });
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
        const cbDef = extractCallbackDefinition(node);
        if (cbDef) definitions.push(cbDef);
        break;
      }

      case 'import_statement': {
        const isTypeOnly = node.text.startsWith('import type');
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source) {
          const modPath = source.text.replace(/['"]/g, '');
          const names = extractImportNames(node);
          imports.push({
            source: modPath,
            names,
            line: node.startPosition.row + 1,
            typeOnly: isTypeOnly,
          });
        }
        break;
      }

      case 'export_statement': {
        const decl = node.childForFieldName('declaration');
        if (decl) {
          if (decl.type === 'function_declaration') {
            const n = decl.childForFieldName('name');
            if (n)
              exports.push({ name: n.text, kind: 'function', line: node.startPosition.row + 1 });
          } else if (decl.type === 'class_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'class', line: node.startPosition.row + 1 });
          } else if (decl.type === 'interface_declaration') {
            const n = decl.childForFieldName('name');
            if (n)
              exports.push({ name: n.text, kind: 'interface', line: node.startPosition.row + 1 });
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
          imports.push({
            source: modPath,
            names: reexportNames,
            line: node.startPosition.row + 1,
            reexport: true,
            wildcardReexport: isWildcard && reexportNames.length === 0,
          });
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
                    imports.push({
                      source: modPath,
                      names: [],
                      line: node.startPosition.row + 1,
                      reexport: true,
                      wildcardReexport: true,
                    });
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
                      const args2 =
                        spreadExpr.childForFieldName('arguments') ||
                        findChild(spreadExpr, 'arguments');
                      if (fn2 && fn2.text === 'require' && args2) {
                        const strArg2 = findChild(args2, 'string');
                        if (strArg2) {
                          const modPath2 = strArg2.text.replace(/['"]/g, '');
                          imports.push({
                            source: modPath2,
                            names: [],
                            line: node.startPosition.row + 1,
                            reexport: true,
                            wildcardReexport: true,
                          });
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
      walkJavaScriptNode(node.child(i));
    }
  }

  walkJavaScriptNode(tree.rootNode);
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
          endLine: child.endPosition.row + 1,
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

function extractReceiverName(objNode) {
  if (!objNode) return undefined;
  if (objNode.type === 'identifier') return objNode.text;
  if (objNode.type === 'this') return 'this';
  if (objNode.type === 'super') return 'super';
  if (objNode.type === 'member_expression') {
    const prop = objNode.childForFieldName('property');
    if (prop) return objNode.text;
  }
  return objNode.text;
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
      if (obj && obj.type === 'identifier')
        return { name: obj.text, line: callNode.startPosition.row + 1, dynamic: true };
      if (obj && obj.type === 'member_expression') {
        const innerProp = obj.childForFieldName('property');
        if (innerProp)
          return { name: innerProp.text, line: callNode.startPosition.row + 1, dynamic: true };
      }
    }

    if (prop.type === 'string' || prop.type === 'string_fragment') {
      const methodName = prop.text.replace(/['"]/g, '');
      if (methodName) {
        const receiver = extractReceiverName(obj);
        return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true, receiver };
      }
    }

    const receiver = extractReceiverName(obj);
    return { name: prop.text, line: callNode.startPosition.row + 1, receiver };
  }

  if (fn.type === 'subscript_expression') {
    const obj = fn.childForFieldName('object');
    const index = fn.childForFieldName('index');
    if (index && (index.type === 'string' || index.type === 'template_string')) {
      const methodName = index.text.replace(/['"`]/g, '');
      if (methodName && !methodName.includes('$')) {
        const receiver = extractReceiverName(obj);
        return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true, receiver };
      }
    }
  }

  return null;
}

function findAnonymousCallback(argsNode) {
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child && (child.type === 'arrow_function' || child.type === 'function_expression')) {
      return child;
    }
  }
  return null;
}

function findFirstStringArg(argsNode) {
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child && child.type === 'string') {
      return child.text.replace(/['"]/g, '');
    }
  }
  return null;
}

function walkCallChain(startNode, methodName) {
  let current = startNode;
  while (current) {
    if (current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop && prop.text === methodName) {
          return current;
        }
      }
    }
    if (current.type === 'member_expression') {
      const obj = current.childForFieldName('object');
      current = obj;
    } else if (current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      current = fn;
    } else {
      break;
    }
  }
  return null;
}

const EXPRESS_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
  'use',
]);
const EVENT_METHODS = new Set(['on', 'once', 'addEventListener', 'addListener']);

function extractCallbackDefinition(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return null;

  const prop = fn.childForFieldName('property');
  if (!prop) return null;
  const method = prop.text;

  const args = callNode.childForFieldName('arguments') || findChild(callNode, 'arguments');
  if (!args) return null;

  // Commander: .action(callback) with .command('name') in chain
  if (method === 'action') {
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    const commandCall = walkCallChain(fn.childForFieldName('object'), 'command');
    if (!commandCall) return null;
    const cmdArgs =
      commandCall.childForFieldName('arguments') || findChild(commandCall, 'arguments');
    if (!cmdArgs) return null;
    const cmdName = findFirstStringArg(cmdArgs);
    if (!cmdName) return null;
    const firstWord = cmdName.split(/\s/)[0];
    return {
      name: `command:${firstWord}`,
      kind: 'function',
      line: cb.startPosition.row + 1,
      endLine: nodeEndLine(cb),
    };
  }

  // Express: app.get('/path', callback)
  if (EXPRESS_METHODS.has(method)) {
    const strArg = findFirstStringArg(args);
    if (!strArg || !strArg.startsWith('/')) return null;
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    return {
      name: `route:${method.toUpperCase()} ${strArg}`,
      kind: 'function',
      line: cb.startPosition.row + 1,
      endLine: nodeEndLine(cb),
    };
  }

  // Events: emitter.on('event', callback)
  if (EVENT_METHODS.has(method)) {
    const eventName = findFirstStringArg(args);
    if (!eventName) return null;
    const cb = findAnonymousCallback(args);
    if (!cb) return null;
    return {
      name: `event:${eventName}`,
      kind: 'function',
      line: cb.startPosition.row + 1,
      endLine: nodeEndLine(cb),
    };
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
