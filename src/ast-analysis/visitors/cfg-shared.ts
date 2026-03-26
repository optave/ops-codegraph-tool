import type { TreeSitterNode } from '../../types.js';

// biome-ignore lint/suspicious/noExplicitAny: CFG rules are opaque language-specific objects
export type AnyRules = any;

export function nn(node: TreeSitterNode | null, context?: string): TreeSitterNode {
  if (node === null) {
    throw new Error(`Unexpected null tree-sitter node${context ? ` (${context})` : ''}`);
  }
  return node;
}

export interface CfgBlockInternal {
  index: number;
  type: string;
  startLine: number | null;
  endLine: number | null;
  label: string | null;
}

export interface CfgEdgeInternal {
  sourceIndex: number;
  targetIndex: number;
  kind: string;
}

export interface LabelCtx {
  headerBlock: CfgBlockInternal | null;
  exitBlock: CfgBlockInternal | null;
}

export interface LoopCtx {
  headerBlock: CfgBlockInternal;
  exitBlock: CfgBlockInternal;
}

export interface FuncState {
  blocks: CfgBlockInternal[];
  edges: CfgEdgeInternal[];
  makeBlock(
    type: string,
    startLine?: number | null,
    endLine?: number | null,
    label?: string | null,
  ): CfgBlockInternal;
  addEdge(source: CfgBlockInternal, target: CfgBlockInternal, kind: string): void;
  entryBlock: CfgBlockInternal;
  exitBlock: CfgBlockInternal;
  currentBlock: CfgBlockInternal | null;
  loopStack: LoopCtx[];
  labelMap: Map<string, LabelCtx>;
  cfgStack: FuncState[];
  funcNode: TreeSitterNode | null;
}

export interface CFGResultInternal {
  funcNode: TreeSitterNode;
  blocks: CfgBlockInternal[];
  edges: CfgEdgeInternal[];
  cyclomatic: number;
}

export function isIfNode(type: string, cfgRules: AnyRules): boolean {
  return type === cfgRules.ifNode || cfgRules.ifNodes?.has(type);
}

export function isForNode(type: string, cfgRules: AnyRules): boolean {
  return cfgRules.forNodes.has(type);
}

export function isWhileNode(type: string, cfgRules: AnyRules): boolean {
  return type === cfgRules.whileNode || cfgRules.whileNodes?.has(type);
}

export function isSwitchNode(type: string, cfgRules: AnyRules): boolean {
  return type === cfgRules.switchNode || cfgRules.switchNodes?.has(type);
}

export function isCaseNode(type: string, cfgRules: AnyRules): boolean {
  return (
    type === cfgRules.caseNode || type === cfgRules.defaultNode || cfgRules.caseNodes?.has(type)
  );
}

export function isBlockNode(type: string, cfgRules: AnyRules): boolean {
  return type === 'statement_list' || type === cfgRules.blockNode || cfgRules.blockNodes?.has(type);
}

export function isControlFlow(type: string, cfgRules: AnyRules): boolean {
  return (
    isIfNode(type, cfgRules) ||
    (cfgRules.unlessNode && type === cfgRules.unlessNode) ||
    isForNode(type, cfgRules) ||
    isWhileNode(type, cfgRules) ||
    (cfgRules.untilNode && type === cfgRules.untilNode) ||
    (cfgRules.doNode && type === cfgRules.doNode) ||
    (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) ||
    isSwitchNode(type, cfgRules) ||
    (cfgRules.tryNode && type === cfgRules.tryNode) ||
    type === cfgRules.returnNode ||
    type === cfgRules.throwNode ||
    type === cfgRules.breakNode ||
    type === cfgRules.continueNode ||
    type === cfgRules.labeledNode
  );
}

export function effectiveNode(node: TreeSitterNode, cfgRules: AnyRules): TreeSitterNode {
  if (node.type === 'expression_statement' && node.namedChildCount === 1) {
    const inner = nn(node.namedChild(0));
    if (isControlFlow(inner.type, cfgRules)) return inner;
  }
  return node;
}

export function registerLabelCtx(
  S: FuncState,
  headerBlock: CfgBlockInternal,
  exitBlock: CfgBlockInternal,
): void {
  for (const [, ctx] of Array.from(S.labelMap)) {
    if (!ctx.headerBlock) {
      ctx.headerBlock = headerBlock;
      ctx.exitBlock = exitBlock;
    }
  }
}

export function getBodyStatements(
  bodyNode: TreeSitterNode | null,
  cfgRules: AnyRules,
): TreeSitterNode[] {
  if (!bodyNode) return [];
  if (isBlockNode(bodyNode.type, cfgRules)) {
    const stmts: TreeSitterNode[] = [];
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = nn(bodyNode.namedChild(i));
      if (child.type === 'statement_list') {
        for (let j = 0; j < child.namedChildCount; j++) {
          stmts.push(nn(child.namedChild(j)));
        }
      } else {
        stmts.push(child);
      }
    }
    return stmts;
  }
  return [bodyNode];
}

export function makeFuncState(): FuncState {
  const blocks: CfgBlockInternal[] = [];
  const edges: CfgEdgeInternal[] = [];
  let nextIndex = 0;

  function makeBlock(
    type: string,
    startLine: number | null = null,
    endLine: number | null = null,
    label: string | null = null,
  ): CfgBlockInternal {
    const block: CfgBlockInternal = { index: nextIndex++, type, startLine, endLine, label };
    blocks.push(block);
    return block;
  }

  function addEdge(source: CfgBlockInternal, target: CfgBlockInternal, kind: string): void {
    edges.push({ sourceIndex: source.index, targetIndex: target.index, kind });
  }

  const entry = makeBlock('entry');
  const exit = makeBlock('exit');
  const firstBody = makeBlock('body');
  addEdge(entry, firstBody, 'fallthrough');

  return {
    blocks,
    edges,
    makeBlock,
    addEdge,
    entryBlock: entry,
    exitBlock: exit,
    currentBlock: firstBody,
    loopStack: [],
    labelMap: new Map(),
    cfgStack: [],
    funcNode: null,
  };
}
