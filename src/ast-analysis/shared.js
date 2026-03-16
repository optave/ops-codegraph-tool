/**
 * Shared utilities for AST analysis modules (complexity, CFG, dataflow, AST nodes).
 */

import { LANGUAGE_REGISTRY } from '../domain/parser.js';
import { ConfigError } from '../shared/errors.js';

// ─── Generic Rule Factory ─────────────────────────────────────────────────

/**
 * Merge defaults with overrides, validating that all keys are known.
 *
 * @param {object} defaults - Default rule values (defines the valid key set)
 * @param {object} overrides - Language-specific overrides
 * @param {string} label - Label for error messages (e.g. "CFG", "Dataflow")
 * @returns {object} Merged rules
 */
export function makeRules(defaults, overrides, label) {
  const validKeys = new Set(Object.keys(defaults));
  for (const key of Object.keys(overrides)) {
    if (!validKeys.has(key)) {
      throw new ConfigError(`${label} rules: unknown key "${key}"`);
    }
  }
  return { ...defaults, ...overrides };
}

// ─── CFG Defaults + Factory ───────────────────────────────────────────────

export const CFG_DEFAULTS = {
  ifNode: null,
  ifNodes: null,
  elifNode: null,
  elseClause: null,
  elseViaAlternative: false,
  ifConsequentField: null,
  forNodes: new Set(),
  whileNode: null,
  whileNodes: null,
  doNode: null,
  infiniteLoopNode: null,
  unlessNode: null,
  untilNode: null,
  switchNode: null,
  switchNodes: null,
  caseNode: null,
  caseNodes: null,
  defaultNode: null,
  tryNode: null,
  catchNode: null,
  finallyNode: null,
  returnNode: null,
  throwNode: null,
  breakNode: null,
  continueNode: null,
  blockNode: null,
  blockNodes: null,
  labeledNode: null,
  functionNodes: new Set(),
};

export function makeCfgRules(overrides) {
  const rules = makeRules(CFG_DEFAULTS, overrides, 'CFG');
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new ConfigError('CFG rules: functionNodes must be a non-empty Set');
  }
  if (!(rules.forNodes instanceof Set)) {
    throw new ConfigError('CFG rules: forNodes must be a Set');
  }
  return rules;
}

// ─── Dataflow Defaults + Factory ──────────────────────────────────────────

export const DATAFLOW_DEFAULTS = {
  // Scope entry
  functionNodes: new Set(), // REQUIRED: non-empty

  // Function name extraction
  nameField: 'name',
  varAssignedFnParent: null, // parent type for `const fn = ...` (JS only)
  assignmentFnParent: null, // parent type for `x = function...` (JS only)
  pairFnParent: null, // parent type for `{ key: function }` (JS only)

  // Parameters
  paramListField: 'parameters',
  paramIdentifier: 'identifier',
  paramWrapperTypes: new Set(),
  defaultParamType: null,
  restParamType: null,
  objectDestructType: null,
  arrayDestructType: null,
  shorthandPropPattern: null,
  pairPatternType: null,
  extractParamName: null, // override: (node) => string[]

  // Return
  returnNode: null,

  // Variable declarations
  varDeclaratorNode: null,
  varDeclaratorNodes: null,
  varNameField: 'name',
  varValueField: 'value',
  assignmentNode: null,
  assignLeftField: 'left',
  assignRightField: 'right',

  // Calls
  callNode: null,
  callNodes: null,
  callFunctionField: 'function',
  callArgsField: 'arguments',
  spreadType: null,

  // Member access
  memberNode: null,
  memberObjectField: 'object',
  memberPropertyField: 'property',
  optionalChainNode: null,

  // Await
  awaitNode: null,

  // Mutation
  mutatingMethods: new Set(),
  expressionStmtNode: 'expression_statement',
  callObjectField: null, // Java: combined call+member has [object] field on call node

  // Structural wrappers
  expressionListType: null, // Go: expression_list wraps LHS/RHS of short_var_declaration
  equalsClauseType: null, // C#: equals_value_clause wraps variable initializer
  argumentWrapperType: null, // PHP: individual args wrapped in 'argument' nodes
  extraIdentifierTypes: null, // Set of additional identifier-like types (PHP: variable_name, name)
};

export function makeDataflowRules(overrides) {
  const rules = makeRules(DATAFLOW_DEFAULTS, overrides, 'Dataflow');
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new ConfigError('Dataflow rules: functionNodes must be a non-empty Set');
  }
  return rules;
}

// ─── AST Helpers ──────────────────────────────────────────────────────────

/**
 * Find the function body node in a parse tree that matches a given line range.
 */
export function findFunctionNode(rootNode, startLine, _endLine, rules) {
  // tree-sitter lines are 0-indexed
  const targetStart = startLine - 1;

  let best = null;

  function search(node) {
    const nodeStart = node.startPosition.row;
    const nodeEnd = node.endPosition.row;

    // Prune branches outside range
    if (nodeEnd < targetStart || nodeStart > targetStart + 1) return;

    if (rules.functionNodes.has(node.type) && nodeStart === targetStart) {
      // Found a function node at the right position — pick it
      if (!best || nodeEnd - nodeStart < best.endPosition.row - best.startPosition.row) {
        best = node;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      search(node.child(i));
    }
  }

  search(rootNode);
  return best;
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 *
 * @param {string} str - Input string
 * @param {number} [max=200] - Maximum length
 * @returns {string}
 */
export function truncate(str, max = 200) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// ─── Extension / Language Mapping ─────────────────────────────────────────

/**
 * Build a Map from file extension → language ID using the parser registry.
 *
 * @param {Iterable} [registry=LANGUAGE_REGISTRY] - Language registry entries
 * @returns {Map<string, string>}
 */
export function buildExtToLangMap(registry = LANGUAGE_REGISTRY) {
  const map = new Map();
  for (const entry of registry) {
    for (const ext of entry.extensions) {
      map.set(ext, entry.id);
    }
  }
  return map;
}

/**
 * Build a Set of file extensions for languages that have entries in the given rules Map.
 *
 * @param {Map<string, any>} rulesMap - e.g. COMPLEXITY_RULES, CFG_RULES
 * @param {Iterable} [registry=LANGUAGE_REGISTRY] - Language registry entries
 * @returns {Set<string>}
 */
export function buildExtensionSet(rulesMap, registry = LANGUAGE_REGISTRY) {
  const extensions = new Set();
  for (const entry of registry) {
    if (rulesMap.has(entry.id)) {
      for (const ext of entry.extensions) extensions.add(ext);
    }
  }
  return extensions;
}
