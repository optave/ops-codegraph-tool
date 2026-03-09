/**
 * Shared AST helper functions used by multiple visitors (dataflow, etc.).
 *
 * Extracted from dataflow.js to be reusable across the visitor framework.
 */

/**
 * Truncate a string to a maximum length.
 */
export function truncate(str, max = 120) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Get the name of a function node from the AST using rules.
 */
export function functionName(fnNode, rules) {
  if (!fnNode) return null;
  const nameNode = fnNode.childForFieldName(rules.nameField);
  if (nameNode) return nameNode.text;

  const parent = fnNode.parent;
  if (parent) {
    if (rules.varAssignedFnParent && parent.type === rules.varAssignedFnParent) {
      const n = parent.childForFieldName('name');
      return n ? n.text : null;
    }
    if (rules.pairFnParent && parent.type === rules.pairFnParent) {
      const keyNode = parent.childForFieldName('key');
      return keyNode ? keyNode.text : null;
    }
    if (rules.assignmentFnParent && parent.type === rules.assignmentFnParent) {
      const left = parent.childForFieldName(rules.assignLeftField);
      return left ? left.text : null;
    }
  }
  return null;
}

/**
 * Extract parameter names and indices from a formal_parameters node.
 */
export function extractParams(paramsNode, rules) {
  if (!paramsNode) return [];
  const result = [];
  let index = 0;
  for (const child of paramsNode.namedChildren) {
    const names = extractParamNames(child, rules);
    for (const name of names) {
      result.push({ name, index });
    }
    index++;
  }
  return result;
}

/**
 * Extract parameter names from a single parameter node.
 */
export function extractParamNames(node, rules) {
  if (!node) return [];
  const t = node.type;

  if (rules.extractParamName) {
    const result = rules.extractParamName(node);
    if (result) return result;
  }

  if (t === rules.paramIdentifier) return [node.text];

  if (rules.paramWrapperTypes.has(t)) {
    const pattern = node.childForFieldName('pattern') || node.childForFieldName('name');
    return pattern ? extractParamNames(pattern, rules) : [];
  }

  if (rules.defaultParamType && t === rules.defaultParamType) {
    const left = node.childForFieldName('left') || node.childForFieldName('name');
    return left ? extractParamNames(left, rules) : [];
  }

  if (rules.restParamType && t === rules.restParamType) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return [nameNode.text];
    for (const child of node.namedChildren) {
      if (child.type === rules.paramIdentifier) return [child.text];
    }
    return [];
  }

  if (rules.objectDestructType && t === rules.objectDestructType) {
    const names = [];
    for (const child of node.namedChildren) {
      if (rules.shorthandPropPattern && child.type === rules.shorthandPropPattern) {
        names.push(child.text);
      } else if (rules.pairPatternType && child.type === rules.pairPatternType) {
        const value = child.childForFieldName('value');
        if (value) names.push(...extractParamNames(value, rules));
      } else if (rules.restParamType && child.type === rules.restParamType) {
        names.push(...extractParamNames(child, rules));
      }
    }
    return names;
  }

  if (rules.arrayDestructType && t === rules.arrayDestructType) {
    const names = [];
    for (const child of node.namedChildren) {
      names.push(...extractParamNames(child, rules));
    }
    return names;
  }

  return [];
}

/**
 * Check if a node type is identifier-like for this language.
 */
export function isIdent(nodeType, rules) {
  if (nodeType === 'identifier' || nodeType === rules.paramIdentifier) return true;
  return rules.extraIdentifierTypes ? rules.extraIdentifierTypes.has(nodeType) : false;
}

/**
 * Resolve the name a call expression is calling using rules.
 */
export function resolveCalleeName(callNode, rules) {
  const fn = callNode.childForFieldName(rules.callFunctionField);
  if (!fn) {
    const nameNode = callNode.childForFieldName('name') || callNode.childForFieldName('method');
    return nameNode ? nameNode.text : null;
  }
  if (isIdent(fn.type, rules)) return fn.text;
  if (fn.type === rules.memberNode) {
    const prop = fn.childForFieldName(rules.memberPropertyField);
    return prop ? prop.text : null;
  }
  if (rules.optionalChainNode && fn.type === rules.optionalChainNode) {
    const target = fn.namedChildren[0];
    if (!target) return null;
    if (target.type === rules.memberNode) {
      const prop = target.childForFieldName(rules.memberPropertyField);
      return prop ? prop.text : null;
    }
    if (target.type === 'identifier') return target.text;
    const prop = fn.childForFieldName(rules.memberPropertyField);
    return prop ? prop.text : null;
  }
  return null;
}

/**
 * Get the receiver (object) of a member expression using rules.
 */
export function memberReceiver(memberExpr, rules) {
  const obj = memberExpr.childForFieldName(rules.memberObjectField);
  if (!obj) return null;
  if (isIdent(obj.type, rules)) return obj.text;
  if (obj.type === rules.memberNode) return memberReceiver(obj, rules);
  return null;
}

/**
 * Collect all identifier names referenced within a node.
 */
export function collectIdentifiers(node, out, rules) {
  if (!node) return;
  if (isIdent(node.type, rules)) {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out, rules);
  }
}
