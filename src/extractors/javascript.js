import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from a JS/TS parsed AST.
 * When a compiled tree-sitter Query is provided (from parser.js),
 * uses the fast query-based path. Falls back to manual tree walk otherwise.
 */
export function extractSymbols(tree, _filePath, query) {
  if (query) return extractSymbolsQuery(tree, query);
  return extractSymbolsWalk(tree);
}

// ── Query-based extraction (fast path) ──────────────────────────────────────

function extractSymbolsQuery(tree, query) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exps = [];

  const matches = query.matches(tree.rootNode);

  for (const match of matches) {
    // Build capture lookup for this match (1-3 captures each, very fast)
    const c = Object.create(null);
    for (const cap of match.captures) c[cap.name] = cap.node;

    if (c.fn_node) {
      // function_declaration
      const fnChildren = extractParameters(c.fn_node);
      definitions.push({
        name: c.fn_name.text,
        kind: 'function',
        line: c.fn_node.startPosition.row + 1,
        endLine: nodeEndLine(c.fn_node),
        children: fnChildren.length > 0 ? fnChildren : undefined,
      });
    } else if (c.varfn_name) {
      // variable_declarator with arrow_function / function_expression
      const declNode = c.varfn_name.parent?.parent;
      const line = declNode ? declNode.startPosition.row + 1 : c.varfn_name.startPosition.row + 1;
      const varFnChildren = extractParameters(c.varfn_value);
      definitions.push({
        name: c.varfn_name.text,
        kind: 'function',
        line,
        endLine: nodeEndLine(c.varfn_value),
        children: varFnChildren.length > 0 ? varFnChildren : undefined,
      });
    } else if (c.cls_node) {
      // class_declaration
      const className = c.cls_name.text;
      const startLine = c.cls_node.startPosition.row + 1;
      const clsChildren = extractClassProperties(c.cls_node);
      definitions.push({
        name: className,
        kind: 'class',
        line: startLine,
        endLine: nodeEndLine(c.cls_node),
        children: clsChildren.length > 0 ? clsChildren : undefined,
      });
      const heritage =
        c.cls_node.childForFieldName('heritage') || findChild(c.cls_node, 'class_heritage');
      if (heritage) {
        const superName = extractSuperclass(heritage);
        if (superName) classes.push({ name: className, extends: superName, line: startLine });
        const implementsList = extractImplements(heritage);
        for (const iface of implementsList) {
          classes.push({ name: className, implements: iface, line: startLine });
        }
      }
    } else if (c.meth_node) {
      // method_definition
      const methName = c.meth_name.text;
      const parentClass = findParentClass(c.meth_node);
      const fullName = parentClass ? `${parentClass}.${methName}` : methName;
      const methChildren = extractParameters(c.meth_node);
      definitions.push({
        name: fullName,
        kind: 'method',
        line: c.meth_node.startPosition.row + 1,
        endLine: nodeEndLine(c.meth_node),
        children: methChildren.length > 0 ? methChildren : undefined,
      });
    } else if (c.iface_node) {
      // interface_declaration (TS/TSX only)
      const ifaceName = c.iface_name.text;
      definitions.push({
        name: ifaceName,
        kind: 'interface',
        line: c.iface_node.startPosition.row + 1,
        endLine: nodeEndLine(c.iface_node),
      });
      const body =
        c.iface_node.childForFieldName('body') ||
        findChild(c.iface_node, 'interface_body') ||
        findChild(c.iface_node, 'object_type');
      if (body) extractInterfaceMethods(body, ifaceName, definitions);
    } else if (c.type_node) {
      // type_alias_declaration (TS/TSX only)
      definitions.push({
        name: c.type_name.text,
        kind: 'type',
        line: c.type_node.startPosition.row + 1,
        endLine: nodeEndLine(c.type_node),
      });
    } else if (c.imp_node) {
      // import_statement
      const isTypeOnly = c.imp_node.text.startsWith('import type');
      const modPath = c.imp_source.text.replace(/['"]/g, '');
      const names = extractImportNames(c.imp_node);
      imports.push({
        source: modPath,
        names,
        line: c.imp_node.startPosition.row + 1,
        typeOnly: isTypeOnly,
      });
    } else if (c.exp_node) {
      // export_statement
      const exportLine = c.exp_node.startPosition.row + 1;
      const decl = c.exp_node.childForFieldName('declaration');
      if (decl) {
        const declType = decl.type;
        const kindMap = {
          function_declaration: 'function',
          class_declaration: 'class',
          interface_declaration: 'interface',
          type_alias_declaration: 'type',
        };
        const kind = kindMap[declType];
        if (kind) {
          const n = decl.childForFieldName('name');
          if (n) exps.push({ name: n.text, kind, line: exportLine });
        }
      }
      const source = c.exp_node.childForFieldName('source') || findChild(c.exp_node, 'string');
      if (source && !decl) {
        const modPath = source.text.replace(/['"]/g, '');
        const reexportNames = extractImportNames(c.exp_node);
        const nodeText = c.exp_node.text;
        const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
        imports.push({
          source: modPath,
          names: reexportNames,
          line: exportLine,
          reexport: true,
          wildcardReexport: isWildcard && reexportNames.length === 0,
        });
      }
    } else if (c.callfn_node) {
      // call_expression with identifier function
      calls.push({
        name: c.callfn_name.text,
        line: c.callfn_node.startPosition.row + 1,
      });
    } else if (c.callmem_node) {
      // call_expression with member_expression function
      const callInfo = extractCallInfo(c.callmem_fn, c.callmem_node);
      if (callInfo) calls.push(callInfo);
      const cbDef = extractCallbackDefinition(c.callmem_node, c.callmem_fn);
      if (cbDef) definitions.push(cbDef);
    } else if (c.callsub_node) {
      // call_expression with subscript_expression function
      const callInfo = extractCallInfo(c.callsub_fn, c.callsub_node);
      if (callInfo) calls.push(callInfo);
    } else if (c.assign_node) {
      // CommonJS: module.exports = require(...) / module.exports = { ...require(...) }
      handleCommonJSAssignment(c.assign_left, c.assign_right, c.assign_node, imports);
    }
  }

  // Extract top-level constants via targeted walk (query patterns don't cover these)
  extractConstantsWalk(tree.rootNode, definitions);

  return { definitions, calls, imports, classes, exports: exps };
}

/**
 * Walk program-level children to extract `const x = <literal>` as constants.
 * The query-based fast path has no pattern for lexical_declaration/variable_declaration,
 * so constants are missed. This targeted walk fills that gap without a full tree traversal.
 */
function extractConstantsWalk(rootNode, definitions) {
  for (let i = 0; i < rootNode.childCount; i++) {
    const node = rootNode.child(i);
    if (!node) continue;

    let declNode = node;
    // Handle `export const …` — unwrap the export_statement to its declaration child
    if (node.type === 'export_statement') {
      const inner = node.childForFieldName('declaration');
      if (!inner) continue;
      declNode = inner;
    }

    const t = declNode.type;
    if (t !== 'lexical_declaration' && t !== 'variable_declaration') continue;
    if (!declNode.text.startsWith('const ')) continue;

    for (let j = 0; j < declNode.childCount; j++) {
      const declarator = declNode.child(j);
      if (!declarator || declarator.type !== 'variable_declarator') continue;
      const nameN = declarator.childForFieldName('name');
      const valueN = declarator.childForFieldName('value');
      if (!nameN || nameN.type !== 'identifier' || !valueN) continue;
      // Skip functions — already captured by query patterns
      const valType = valueN.type;
      if (
        valType === 'arrow_function' ||
        valType === 'function_expression' ||
        valType === 'function'
      )
        continue;
      if (isConstantValue(valueN)) {
        definitions.push({
          name: nameN.text,
          kind: 'constant',
          line: declNode.startPosition.row + 1,
          endLine: nodeEndLine(declNode),
        });
      }
    }
  }
}

function handleCommonJSAssignment(left, right, node, imports) {
  if (!left || !right) return;
  const leftText = left.text;
  if (!leftText.startsWith('module.exports') && leftText !== 'exports') return;

  const rightType = right.type;
  const assignLine = node.startPosition.row + 1;

  if (rightType === 'call_expression') {
    const fn = right.childForFieldName('function');
    const args = right.childForFieldName('arguments') || findChild(right, 'arguments');
    if (fn && fn.text === 'require' && args) {
      const strArg = findChild(args, 'string');
      if (strArg) {
        imports.push({
          source: strArg.text.replace(/['"]/g, ''),
          names: [],
          line: assignLine,
          reexport: true,
          wildcardReexport: true,
        });
      }
    }
  }

  if (rightType === 'object') {
    for (let ci = 0; ci < right.childCount; ci++) {
      const child = right.child(ci);
      if (child && child.type === 'spread_element') {
        const spreadExpr = child.child(1) || child.childForFieldName('value');
        if (spreadExpr && spreadExpr.type === 'call_expression') {
          const fn2 = spreadExpr.childForFieldName('function');
          const args2 =
            spreadExpr.childForFieldName('arguments') || findChild(spreadExpr, 'arguments');
          if (fn2 && fn2.text === 'require' && args2) {
            const strArg2 = findChild(args2, 'string');
            if (strArg2) {
              imports.push({
                source: strArg2.text.replace(/['"]/g, ''),
                names: [],
                line: assignLine,
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

// ── Manual tree walk (fallback when Query not available) ────────────────────

function extractSymbolsWalk(tree) {
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
          const fnChildren = extractParameters(node);
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: fnChildren.length > 0 ? fnChildren : undefined,
          });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const className = nameNode.text;
          const startLine = node.startPosition.row + 1;
          const clsChildren = extractClassProperties(node);
          definitions.push({
            name: className,
            kind: 'class',
            line: startLine,
            endLine: nodeEndLine(node),
            children: clsChildren.length > 0 ? clsChildren : undefined,
          });
          const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
          if (heritage) {
            const superName = extractSuperclass(heritage);
            if (superName) {
              classes.push({ name: className, extends: superName, line: startLine });
            }
            const implementsList = extractImplements(heritage);
            for (const iface of implementsList) {
              classes.push({ name: className, implements: iface, line: startLine });
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
          const methChildren = extractParameters(node);
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: methChildren.length > 0 ? methChildren : undefined,
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
        const isConst = node.text.startsWith('const ');
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (declarator && declarator.type === 'variable_declarator') {
            const nameN = declarator.childForFieldName('name');
            const valueN = declarator.childForFieldName('value');
            if (nameN && valueN) {
              const valType = valueN.type;
              if (
                valType === 'arrow_function' ||
                valType === 'function_expression' ||
                valType === 'function'
              ) {
                const varFnChildren = extractParameters(valueN);
                definitions.push({
                  name: nameN.text,
                  kind: 'function',
                  line: node.startPosition.row + 1,
                  endLine: nodeEndLine(valueN),
                  children: varFnChildren.length > 0 ? varFnChildren : undefined,
                });
              } else if (isConst && nameN.type === 'identifier' && isConstantValue(valueN)) {
                definitions.push({
                  name: nameN.text,
                  kind: 'constant',
                  line: node.startPosition.row + 1,
                  endLine: nodeEndLine(node),
                });
              }
            } else if (isConst && nameN && nameN.type === 'identifier' && !valueN) {
              // const with no value (shouldn't happen but be safe)
            }
          }
        }
        break;
      }

      case 'enum_declaration': {
        // TypeScript enum
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const enumChildren = [];
          const body = node.childForFieldName('body') || findChild(node, 'enum_body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const member = body.child(i);
              if (!member) continue;
              if (member.type === 'enum_assignment' || member.type === 'property_identifier') {
                const mName = member.childForFieldName('name') || member.child(0);
                if (mName) {
                  enumChildren.push({
                    name: mName.text,
                    kind: 'constant',
                    line: member.startPosition.row + 1,
                  });
                }
              }
            }
          }
          definitions.push({
            name: nameNode.text,
            kind: 'enum',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: enumChildren.length > 0 ? enumChildren : undefined,
          });
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          const callInfo = extractCallInfo(fn, node);
          if (callInfo) calls.push(callInfo);
          if (fn.type === 'member_expression') {
            const cbDef = extractCallbackDefinition(node, fn);
            if (cbDef) definitions.push(cbDef);
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
        const exportLine = node.startPosition.row + 1;
        const decl = node.childForFieldName('declaration');
        if (decl) {
          const declType = decl.type;
          const kindMap = {
            function_declaration: 'function',
            class_declaration: 'class',
            interface_declaration: 'interface',
            type_alias_declaration: 'type',
          };
          const kind = kindMap[declType];
          if (kind) {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind, line: exportLine });
          }
        }
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source && !decl) {
          const modPath = source.text.replace(/['"]/g, '');
          const reexportNames = extractImportNames(node);
          const nodeText = node.text;
          const isWildcard = nodeText.includes('export *') || nodeText.includes('export*');
          imports.push({
            source: modPath,
            names: reexportNames,
            line: exportLine,
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
                    imports.push({
                      source: strArg.text.replace(/['"]/g, ''),
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
                          imports.push({
                            source: strArg2.text.replace(/['"]/g, ''),
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

// ── Child extraction helpers ────────────────────────────────────────────────

function extractParameters(node) {
  const params = [];
  const paramsNode = node.childForFieldName('parameters') || findChild(node, 'formal_parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === 'identifier') {
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
    } else if (
      t === 'required_parameter' ||
      t === 'optional_parameter' ||
      t === 'assignment_pattern'
    ) {
      const nameNode =
        child.childForFieldName('pattern') || child.childForFieldName('left') || child.child(0);
      if (
        nameNode &&
        (nameNode.type === 'identifier' ||
          nameNode.type === 'shorthand_property_identifier_pattern')
      ) {
        params.push({ name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    } else if (t === 'rest_pattern' || t === 'rest_element') {
      const nameNode = child.child(1) || child.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier') {
        params.push({ name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractClassProperties(classNode) {
  const props = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'class_body');
  if (!body) return props;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    if (
      child.type === 'field_definition' ||
      child.type === 'public_field_definition' ||
      child.type === 'property_definition'
    ) {
      const nameNode =
        child.childForFieldName('name') || child.childForFieldName('property') || child.child(0);
      if (
        nameNode &&
        (nameNode.type === 'property_identifier' ||
          nameNode.type === 'identifier' ||
          nameNode.type === 'private_property_identifier')
      ) {
        props.push({ name: nameNode.text, kind: 'property', line: child.startPosition.row + 1 });
      }
    }
  }
  return props;
}

function isConstantValue(valueNode) {
  if (!valueNode) return false;
  const t = valueNode.type;
  return (
    t === 'number' ||
    t === 'string' ||
    t === 'template_string' ||
    t === 'true' ||
    t === 'false' ||
    t === 'null' ||
    t === 'undefined' ||
    t === 'array' ||
    t === 'object' ||
    t === 'regex' ||
    t === 'unary_expression' ||
    t === 'binary_expression' ||
    t === 'new_expression'
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

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
  const t = objNode.type;
  if (t === 'identifier' || t === 'this' || t === 'super') return objNode.text;
  return objNode.text;
}

function extractCallInfo(fn, callNode) {
  const fnType = fn.type;
  if (fnType === 'identifier') {
    return { name: fn.text, line: callNode.startPosition.row + 1 };
  }

  if (fnType === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!prop) return null;

    const callLine = callNode.startPosition.row + 1;
    const propText = prop.text;

    if (propText === 'call' || propText === 'apply' || propText === 'bind') {
      if (obj && obj.type === 'identifier')
        return { name: obj.text, line: callLine, dynamic: true };
      if (obj && obj.type === 'member_expression') {
        const innerProp = obj.childForFieldName('property');
        if (innerProp) return { name: innerProp.text, line: callLine, dynamic: true };
      }
    }

    const propType = prop.type;
    if (propType === 'string' || propType === 'string_fragment') {
      const methodName = propText.replace(/['"]/g, '');
      if (methodName) {
        const receiver = extractReceiverName(obj);
        return { name: methodName, line: callLine, dynamic: true, receiver };
      }
    }

    const receiver = extractReceiverName(obj);
    return { name: propText, line: callLine, receiver };
  }

  if (fnType === 'subscript_expression') {
    const obj = fn.childForFieldName('object');
    const index = fn.childForFieldName('index');
    if (index) {
      const indexType = index.type;
      if (indexType === 'string' || indexType === 'template_string') {
        const methodName = index.text.replace(/['"`]/g, '');
        if (methodName && !methodName.includes('$')) {
          const receiver = extractReceiverName(obj);
          return {
            name: methodName,
            line: callNode.startPosition.row + 1,
            dynamic: true,
            receiver,
          };
        }
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
    const curType = current.type;
    if (curType === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn && fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop && prop.text === methodName) {
          return current;
        }
      }
      current = fn;
    } else if (curType === 'member_expression') {
      current = current.childForFieldName('object');
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

function extractCallbackDefinition(callNode, fn) {
  if (!fn) fn = callNode.childForFieldName('function');
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
    const t = current.type;
    if (t === 'class_declaration' || t === 'class') {
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
