import type { TreeSitterNode } from '../../types.js';
import type {
  AnyRules,
  CfgBlockInternal,
  FuncState,
  LoopCtx,
  ProcessStatementsFn,
} from './cfg-shared.js';
import { getBodyStatements, isCaseNode, isIfNode, nn } from './cfg-shared.js';

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
  const trueBlock = S.makeBlock('branch_true', null, null, 'then');
  S.addEdge(condBlock, trueBlock, 'branch_true');
  const trueStmts = getBodyStatements(consequent, cfgRules);
  const trueEnd = processStatements(trueStmts, trueBlock, S, cfgRules);
  if (trueEnd) {
    S.addEdge(trueEnd, joinBlock, 'fallthrough');
  }

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
      const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const elseIfEnd = processIf(alternative, falseBlock, S, cfgRules, processStatements);
      if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
    } else {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const falseStmts = getBodyStatements(alternative, cfgRules);
      const falseEnd = processStatements(falseStmts, falseBlock, S, cfgRules);
      if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
    }
  } else if (alternative.type === cfgRules.elseClause) {
    const elseChildren: TreeSitterNode[] = [];
    for (let i = 0; i < alternative.namedChildCount; i++) {
      elseChildren.push(nn(alternative.namedChild(i)));
    }
    const firstChild = elseChildren[0];
    if (elseChildren.length === 1 && firstChild && isIfNode(firstChild.type, cfgRules)) {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const elseIfEnd = processIf(firstChild, falseBlock, S, cfgRules, processStatements);
      if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
    } else {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const falseEnd = processStatements(elseChildren, falseBlock, S, cfgRules);
      if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
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
      const elifTrueBlock = S.makeBlock('branch_true', null, null, 'then');
      S.addEdge(elifCondBlock, elifTrueBlock, 'branch_true');
      const elifTrueStmts = getBodyStatements(elifConsequent, cfgRules);
      const elifTrueEnd = processStatements(elifTrueStmts, elifTrueBlock, S, cfgRules);
      if (elifTrueEnd) S.addEdge(elifTrueEnd, joinBlock, 'fallthrough');

      lastCondBlock = elifCondBlock;
    } else if (child.type === cfgRules.elseClause) {
      const elseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(lastCondBlock, elseBlock, 'branch_false');

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
      const elseEnd = processStatements(elseStmts, elseBlock, S, cfgRules);
      if (elseEnd) S.addEdge(elseEnd, joinBlock, 'fallthrough');

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
