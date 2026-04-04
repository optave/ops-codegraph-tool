import { LANGUAGE_REGISTRY } from '../domain/parser.js';
import { ConfigError } from '../shared/errors.js';
import type {
  CfgRulesConfig,
  DataflowRulesConfig,
  LanguageRegistryEntry,
  TreeSitterNode,
} from '../types.js';

// ─── Generic Rule Factory ─────────────────────────────────────────────────

export function makeRules(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const validKeys = new Set(Object.keys(defaults));
  for (const key of Object.keys(overrides)) {
    if (!validKeys.has(key)) {
      throw new ConfigError(`${label} rules: unknown key "${key}"`);
    }
  }
  return { ...defaults, ...overrides };
}

// ─── CFG Defaults + Factory ───────────────────────────────────────────────

export const CFG_DEFAULTS: CfgRulesConfig = {
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

export function makeCfgRules(overrides: Partial<CfgRulesConfig>): CfgRulesConfig {
  const rules = makeRules(
    CFG_DEFAULTS as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
    'CFG',
  ) as unknown as CfgRulesConfig;
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new ConfigError('CFG rules: functionNodes must be a non-empty Set');
  }
  if (!(rules.forNodes instanceof Set)) {
    throw new ConfigError('CFG rules: forNodes must be a Set');
  }
  return rules;
}

// ─── Dataflow Defaults + Factory ──────────────────────────────────────────

export const DATAFLOW_DEFAULTS: DataflowRulesConfig = {
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

export function makeDataflowRules(overrides: Partial<DataflowRulesConfig>): DataflowRulesConfig {
  const rules = makeRules(
    DATAFLOW_DEFAULTS as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
    'Dataflow',
  ) as unknown as DataflowRulesConfig;
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new ConfigError('Dataflow rules: functionNodes must be a non-empty Set');
  }
  return rules;
}

// ─── AST Helpers ──────────────────────────────────────────────────────────

/** Compute the span (row count) of a tree-sitter node. */
function nodeSpan(node: TreeSitterNode): number {
  return node.endPosition.row - node.startPosition.row;
}

/**
 * Recursively search for the narrowest function node at the target line.
 */
function searchFunctionNode(
  node: TreeSitterNode,
  targetStart: number,
  functionNodeTypes: Set<string>,
  best: TreeSitterNode | null,
): TreeSitterNode | null {
  const nodeStart = node.startPosition.row;
  const nodeEnd = node.endPosition.row;

  // Prune branches outside range
  if (nodeEnd < targetStart || nodeStart > targetStart + 1) return best;

  if (functionNodeTypes.has(node.type) && nodeStart === targetStart) {
    if (!best || nodeSpan(node) < nodeSpan(best)) {
      best = node;
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    best = searchFunctionNode(node.child(i)!, targetStart, functionNodeTypes, best);
  }
  return best;
}

export function findFunctionNode(
  rootNode: TreeSitterNode,
  startLine: number,
  _endLine: number,
  rules: { functionNodes: Set<string> },
): TreeSitterNode | null {
  // tree-sitter lines are 0-indexed
  const targetStart = startLine - 1;
  return searchFunctionNode(rootNode, targetStart, rules.functionNodes, null);
}

// ─── Extension / Language Mapping ─────────────────────────────────────────

export function buildExtToLangMap(
  registry: LanguageRegistryEntry[] = LANGUAGE_REGISTRY as unknown as LanguageRegistryEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of registry) {
    for (const ext of entry.extensions) {
      map.set(ext, entry.id);
    }
  }
  return map;
}

export function buildExtensionSet(
  rulesMap: Map<string, unknown>,
  registry: LanguageRegistryEntry[] = LANGUAGE_REGISTRY as unknown as LanguageRegistryEntry[],
): Set<string> {
  const extensions = new Set<string>();
  for (const entry of registry) {
    if (rulesMap.has(entry.id)) {
      for (const ext of entry.extensions) extensions.add(ext);
    }
  }
  return extensions;
}
