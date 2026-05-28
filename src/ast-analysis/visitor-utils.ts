/**
 * Shared AST helper functions used by multiple visitors (dataflow, etc.).
 *
 * Extracted from dataflow.js to be reusable across the visitor framework.
 */

import type { TreeSitterNode } from '../types.js';

interface ParamInfo {
  name: string;
  index: number;
}

interface LanguageRules {
  nameField: string;
  varAssignedFnParent?: string;
  pairFnParent?: string;
  assignmentFnParent?: string;
  assignLeftField?: string;
  paramIdentifier: string;
  paramWrapperTypes: Set<string>;
  defaultParamType?: string;
  restParamType?: string;
  objectDestructType?: string;
  shorthandPropPattern?: string;
  pairPatternType?: string;
  arrayDestructType?: string;
  extraIdentifierTypes?: Set<string>;
  callFunctionField: string;
  memberNode: string;
  memberPropertyField: string;
  memberObjectField: string;
  optionalChainNode?: string;
  extractParamName?(node: TreeSitterNode): string[] | null;
}

/**
 * Truncate a string to a maximum length.
 */
export function truncate(str: string, max = 120): string {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Get the name of a function node from the AST using rules.
 */
export function functionName(fnNode: TreeSitterNode | null, rules: LanguageRules): string | null {
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
      const left = parent.childForFieldName(rules.assignLeftField!);
      return left ? left.text : null;
    }
  }
  return null;
}

/**
 * Extract parameter names and indices from a formal_parameters node.
 */
export function extractParams(
  paramsNode: TreeSitterNode | null,
  rules: LanguageRules,
): ParamInfo[] {
  if (!paramsNode) return [];
  const result: ParamInfo[] = [];
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
 * Resolve a single parameter node to either a direct list of names (base case)
 * or a list of child nodes that still need processing. Returns `null` if the
 * node yields nothing.
 *
 * This base case keeps destructuring helpers from recursing back into
 * `extractParamNames`, breaking the 3-node mutual recursion cycle between
 * `extractParamNames`, `extractObjectDestructNames`, and `extractArrayDestructNames`.
 */
function resolveParamNode(
  node: TreeSitterNode,
  rules: LanguageRules,
): { names?: string[]; next?: TreeSitterNode[] } | null {
  const t = node.type;

  if (rules.extractParamName) {
    const result = rules.extractParamName(node);
    if (result) return { names: result };
  }

  if (t === rules.paramIdentifier) return { names: [node.text] };

  if (rules.paramWrapperTypes.has(t)) {
    const pattern = node.childForFieldName('pattern') || node.childForFieldName('name');
    return pattern ? { next: [pattern] } : null;
  }

  if (rules.defaultParamType && t === rules.defaultParamType) {
    const left = node.childForFieldName('left') || node.childForFieldName('name');
    return left ? { next: [left] } : null;
  }

  if (rules.restParamType && t === rules.restParamType) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return { names: [nameNode.text] };
    for (const child of node.namedChildren) {
      if (child.type === rules.paramIdentifier) return { names: [child.text] };
    }
    return null;
  }

  if (rules.objectDestructType && t === rules.objectDestructType) {
    return { next: collectObjectDestructChildren(node, rules) };
  }

  if (rules.arrayDestructType && t === rules.arrayDestructType) {
    return { next: [...node.namedChildren] };
  }

  return null;
}

/**
 * Collect child nodes from an object destructuring pattern that should be
 * processed for further name extraction. Returns nodes (not names) so the
 * caller drives traversal via a worklist instead of recursion.
 */
function collectObjectDestructChildren(
  node: TreeSitterNode,
  rules: LanguageRules,
): TreeSitterNode[] {
  const next: TreeSitterNode[] = [];
  for (const child of node.namedChildren) {
    if (rules.shorthandPropPattern && child.type === rules.shorthandPropPattern) {
      // Shorthand prop is a direct identifier — handled by the shorthand
      // guard in the `extractParamNames` worklist loop (before `resolveParamNode`).
      next.push(child);
    } else if (rules.pairPatternType && child.type === rules.pairPatternType) {
      const value = child.childForFieldName('value');
      if (value) next.push(value);
    } else if (rules.restParamType && child.type === rules.restParamType) {
      next.push(child);
    }
  }
  return next;
}

/**
 * Extract parameter names from a single parameter node.
 *
 * Uses an iterative worklist to handle nested destructuring (objects, arrays,
 * defaults, rest, wrappers) without mutual recursion through helper functions.
 */
export function extractParamNames(node: TreeSitterNode | null, rules: LanguageRules): string[] {
  if (!node) return [];

  const names: string[] = [];
  const stack: TreeSitterNode[] = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    // Shorthand identifier inside an object destructuring is just the node's text.
    if (rules.shorthandPropPattern && current.type === rules.shorthandPropPattern) {
      names.push(current.text);
      continue;
    }

    const resolved = resolveParamNode(current, rules);
    if (!resolved) continue;
    if (resolved.names) names.push(...resolved.names);
    if (resolved.next) {
      // Push in reverse so traversal order matches the previous recursive order.
      for (let i = resolved.next.length - 1; i >= 0; i--) {
        const child = resolved.next[i];
        if (child) stack.push(child);
      }
    }
  }

  return names;
}

/**
 * Check if a node type is identifier-like for this language.
 */
export function isIdent(nodeType: string, rules: LanguageRules): boolean {
  if (nodeType === 'identifier' || nodeType === rules.paramIdentifier) return true;
  return rules.extraIdentifierTypes ? rules.extraIdentifierTypes.has(nodeType) : false;
}

/** Resolve callee name from an optional chain node (e.g. `obj?.method()`). */
function resolveOptionalChainCallee(fn: TreeSitterNode, rules: LanguageRules): string | null {
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

/**
 * Resolve the name a call expression is calling using rules.
 */
export function resolveCalleeName(callNode: TreeSitterNode, rules: LanguageRules): string | null {
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
    return resolveOptionalChainCallee(fn, rules);
  }
  return null;
}

/**
 * Get the receiver (object) of a member expression using rules.
 */
export function memberReceiver(memberExpr: TreeSitterNode, rules: LanguageRules): string | null {
  const obj = memberExpr.childForFieldName(rules.memberObjectField);
  if (!obj) return null;
  if (isIdent(obj.type, rules)) return obj.text;
  if (obj.type === rules.memberNode) return memberReceiver(obj, rules);
  return null;
}

/**
 * Collect all identifier names referenced within a node.
 */
export function collectIdentifiers(
  node: TreeSitterNode | null,
  out: string[],
  rules: LanguageRules,
): void {
  if (!node) return;
  if (isIdent(node.type, rules)) {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out, rules);
  }
}
