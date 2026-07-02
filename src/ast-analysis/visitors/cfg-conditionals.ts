import type { TreeSitterNode } from '../../types.js';
import type {
  AnyRules,
  CfgBlockInternal,
  FuncState,
  LoopCtx,
  ProcessStatementsFn,
} from './cfg-shared.js';
import { getBodyStatements, isCaseNode, isIfNode, nn } from './cfg-shared.js';

/**
 * Create a branch block off `condBlock`, wire the `branchKind` edge into it,
 * run `runBranchBody` to populate the branch and get its exit block, then —
 * if the branch falls through (exit block is non-null) — wire a
 * `fallthrough` edge from that exit into `joinBlock`.
 *
 * Shared by `processIf`, `processAlternative`, and `processElifSiblings` for
 * the true-branch / else-branch / else-if-branch shapes, which all follow
 * the same make-block -> add-edge -> run-body -> fallthrough-edge sequence
 * (previously hand-inlined 6+ times across those three functions).
 */
function processBranch(
  condBlock: CfgBlockInternal,
  joinBlock: CfgBlockInternal,
  S: FuncState,
  branchKind: 'branch_true' | 'branch_false',
  label: string,
  runBranchBody: (branchBlock: CfgBlockInternal) => CfgBlockInternal | null,
): void {
  const branchBlock = S.makeBlock(branchKind, null, null, label);
  S.addEdge(condBlock, branchBlock, branchKind);
  const branchEnd = runBranchBody(branchBlock);
  if (branchEnd) S.addEdge(branchEnd, joinBlock, 'fallthrough');
}

export function processIf(
  ifStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  currentBlock.endLine = ifStmt.startPosition.row + 1;

  const condBlock = S.makeBlock(
    'condition',
    ifStmt.startPosition.row + 1,
    ifStmt.startPosition.row + 1,
    'if',
  );
  S.addEdge(currentBlock, condBlock, 'fallthrough');

  const joinBlock = S.makeBlock('body');

  const consequentField = cfgRules.ifConsequentField || 'consequence';
  const consequent = ifStmt.childForFieldName(consequentField);
  processBranch(condBlock, joinBlock, S, 'branch_true', 'then', (trueBlock) => {
    const trueStmts = getBodyStatements(consequent, cfgRules);
    return processStatements(trueStmts, trueBlock, S, cfgRules);
  });

  if (cfgRules.elifNode) {
    processElifSiblings(ifStmt, condBlock, joinBlock, S, cfgRules, processStatements);
  } else {
    processAlternative(ifStmt, condBlock, joinBlock, S, cfgRules, processStatements);
  }

  return joinBlock;
}

function processAlternative(
  ifStmt: TreeSitterNode,
  condBlock: CfgBlockInternal,
  joinBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): void {
  const alternative = ifStmt.childForFieldName('alternative');
  if (!alternative) {
    S.addEdge(condBlock, joinBlock, 'branch_false');
    return;
  }

  if (cfgRules.elseViaAlternative && alternative.type !== cfgRules.elseClause) {
    if (isIfNode(alternative.type, cfgRules)) {
      processBranch(condBlock, joinBlock, S, 'branch_false', 'else-if', (falseBlock) =>
        processIf(alternative, falseBlock, S, cfgRules, processStatements),
      );
    } else {
      processBranch(condBlock, joinBlock, S, 'branch_false', 'else', (falseBlock) => {
        const falseStmts = getBodyStatements(alternative, cfgRules);
        return processStatements(falseStmts, falseBlock, S, cfgRules);
      });
    }
  } else if (alternative.type === cfgRules.elseClause) {
    const elseChildren: TreeSitterNode[] = [];
    for (let i = 0; i < alternative.namedChildCount; i++) {
      elseChildren.push(nn(alternative.namedChild(i)));
    }
    const firstChild = elseChildren[0];
    if (elseChildren.length === 1 && firstChild && isIfNode(firstChild.type, cfgRules)) {
      processBranch(condBlock, joinBlock, S, 'branch_false', 'else-if', (falseBlock) =>
        processIf(firstChild, falseBlock, S, cfgRules, processStatements),
      );
    } else {
      processBranch(condBlock, joinBlock, S, 'branch_false', 'else', (falseBlock) =>
        processStatements(elseChildren, falseBlock, S, cfgRules),
      );
    }
  }
}

function processElifSiblings(
  ifStmt: TreeSitterNode,
  firstCondBlock: CfgBlockInternal,
  joinBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): void {
  let lastCondBlock = firstCondBlock;
  let foundElse = false;

  for (let i = 0; i < ifStmt.namedChildCount; i++) {
    const child = nn(ifStmt.namedChild(i));

    if (child.type === cfgRules.elifNode) {
      const elifCondBlock = S.makeBlock(
        'condition',
        child.startPosition.row + 1,
        child.startPosition.row + 1,
        'else-if',
      );
      S.addEdge(lastCondBlock, elifCondBlock, 'branch_false');

      const elifConsequentField = cfgRules.ifConsequentField || 'consequence';
      const elifConsequent = child.childForFieldName(elifConsequentField);
      processBranch(elifCondBlock, joinBlock, S, 'branch_true', 'then', (elifTrueBlock) => {
        const elifTrueStmts = getBodyStatements(elifConsequent, cfgRules);
        return processStatements(elifTrueStmts, elifTrueBlock, S, cfgRules);
      });

      lastCondBlock = elifCondBlock;
    } else if (child.type === cfgRules.elseClause) {
      const elseBody = child.childForFieldName('body');
      let elseStmts: TreeSitterNode[];
      if (elseBody) {
        elseStmts = getBodyStatements(elseBody, cfgRules);
      } else {
        elseStmts = [];
        for (let j = 0; j < child.namedChildCount; j++) {
          elseStmts.push(nn(child.namedChild(j)));
        }
      }
      processBranch(lastCondBlock, joinBlock, S, 'branch_false', 'else', (elseBlock) =>
        processStatements(elseStmts, elseBlock, S, cfgRules),
      );

      foundElse = true;
    }
  }

  if (!foundElse) {
    S.addEdge(lastCondBlock, joinBlock, 'branch_false');
  }
}

export function processSwitch(
  switchStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  currentBlock.endLine = switchStmt.startPosition.row + 1;

  const switchHeader = S.makeBlock(
    'condition',
    switchStmt.startPosition.row + 1,
    switchStmt.startPosition.row + 1,
    'switch',
  );
  S.addEdge(currentBlock, switchHeader, 'fallthrough');

  const joinBlock = S.makeBlock('body');
  const switchCtx: LoopCtx = { headerBlock: switchHeader, exitBlock: joinBlock };
  S.loopStack.push(switchCtx);

  const switchBody = switchStmt.childForFieldName('body');
  const container = switchBody || switchStmt;

  let hasDefault = false;
  for (let i = 0; i < container.namedChildCount; i++) {
    const caseClause = nn(container.namedChild(i));

    const isDefault = caseClause.type === cfgRules.defaultNode;
    const isCase = isDefault || isCaseNode(caseClause.type, cfgRules);
    if (!isCase) continue;

    const caseLabel = isDefault ? 'default' : 'case';
    const caseBlock = S.makeBlock('case', caseClause.startPosition.row + 1, null, caseLabel);
    S.addEdge(switchHeader, caseBlock, isDefault ? 'branch_false' : 'branch_true');
    if (isDefault) hasDefault = true;

    const caseStmts = extractCaseBody(caseClause, cfgRules);
    const caseEnd = processStatements(caseStmts, caseBlock, S, cfgRules);
    if (caseEnd) S.addEdge(caseEnd, joinBlock, 'fallthrough');
  }

  if (!hasDefault) {
    S.addEdge(switchHeader, joinBlock, 'branch_false');
  }

  S.loopStack.pop();
  return joinBlock;
}

function extractCaseBody(caseClause: TreeSitterNode, cfgRules: AnyRules): TreeSitterNode[] {
  const caseBodyNode =
    caseClause.childForFieldName('body') || caseClause.childForFieldName('consequence');
  if (caseBodyNode) {
    return getBodyStatements(caseBodyNode, cfgRules);
  }

  const stmts: TreeSitterNode[] = [];
  const valueNode = caseClause.childForFieldName('value');
  const patternNode = caseClause.childForFieldName('pattern');
  for (let j = 0; j < caseClause.namedChildCount; j++) {
    const child = nn(caseClause.namedChild(j));
    if (child !== valueNode && child !== patternNode && child.type !== 'switch_label') {
      if (child.type === 'statement_list') {
        for (let k = 0; k < child.namedChildCount; k++) {
          stmts.push(nn(child.namedChild(k)));
        }
      } else {
        stmts.push(child);
      }
    }
  }
  return stmts;
}
