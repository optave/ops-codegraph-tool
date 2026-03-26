import type { EnterNodeResult, TreeSitterNode, Visitor, VisitorContext } from '../../types.js';
import {
  collectIdentifiers,
  extractParamNames,
  extractParams,
  functionName,
  isIdent,
  memberReceiver,
  resolveCalleeName,
  truncate,
} from '../visitor-utils.js';

type AnyRules = any;

interface ScopeEntry {
  funcName: string | null;
  funcNode: TreeSitterNode;
  params: Map<string, number>;
  locals: Map<string, { type: string; callee?: string }>;
}

interface Binding {
  type: string;
  index?: number;
  source?: { type: string; callee?: string } | null;
  funcName: string | null;
}

interface DataflowParam {
  funcName: string;
  paramName: string;
  paramIndex: number;
  line: number;
}

interface DataflowReturnEntry {
  funcName: string;
  expression: string;
  referencedNames: string[];
  line: number;
}

interface DataflowAssignment {
  varName: string;
  callerFunc: string;
  sourceCallName: string;
  expression: string;
  line: number;
}

interface DataflowArgFlow {
  callerFunc: string;
  calleeName: string;
  argIndex: number;
  argName: string;
  binding: Binding;
  confidence: number;
  expression: string;
  line: number;
}

interface DataflowMutation {
  funcName: string;
  receiverName: string;
  binding: Binding;
  mutatingExpr: string;
  line: number;
}

interface DataflowResultInternal {
  parameters: DataflowParam[];
  returns: DataflowReturnEntry[];
  assignments: DataflowAssignment[];
  argFlows: DataflowArgFlow[];
  mutations: DataflowMutation[];
}

function currentScope(scopeStack: ScopeEntry[]): ScopeEntry | undefined {
  return scopeStack[scopeStack.length - 1];
}

function findBinding(name: string, scopeStack: ScopeEntry[]): Binding | null {
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    const scope = scopeStack[i]!;
    if (scope.params.has(name))
      return { type: 'param', index: scope.params.get(name) as number, funcName: scope.funcName };
    if (scope.locals.has(name))
      return {
        type: 'local',
        source: scope.locals.get(name) as { type: string; callee?: string },
        funcName: scope.funcName,
      };
  }
  return null;
}

function bindingConfidence(binding: Binding | null): number {
  if (!binding) return 0.5;
  if (binding.type === 'param') return 1.0;
  if (binding.type === 'local') {
    if (binding.source?.type === 'call_return') return 0.9;
    if (binding.source?.type === 'destructured') return 0.8;
    return 0.9;
  }
  return 0.5;
}

function unwrapAwait(node: TreeSitterNode, rules: AnyRules): TreeSitterNode {
  if (rules.awaitNode && node.type === rules.awaitNode) {
    return node.namedChildren[0] || node;
  }
  return node;
}

function isCall(node: TreeSitterNode | null, isCallNode: (t: string) => boolean): boolean {
  return node != null && isCallNode(node.type);
}

function handleVarDeclarator(
  node: TreeSitterNode,
  rules: AnyRules,
  scopeStack: ScopeEntry[],
  assignments: DataflowAssignment[],
  isCallNode: (t: string) => boolean,
): void {
  let nameNode = node.childForFieldName(rules.varNameField);
  let valueNode: TreeSitterNode | null = rules.varValueField
    ? node.childForFieldName(rules.varValueField)
    : null;

  if (!valueNode && rules.equalsClauseType) {
    for (const child of node.namedChildren) {
      if (child.type === rules.equalsClauseType) {
        valueNode = child.childForFieldName('value') || child.namedChildren[0] || null;
        break;
      }
    }
  }

  if (!valueNode) {
    for (const child of node.namedChildren) {
      if (child !== nameNode && isCall(unwrapAwait(child, rules), isCallNode)) {
        valueNode = child;
        break;
      }
    }
  }

  if (rules.expressionListType) {
    if (nameNode && nameNode.type === rules.expressionListType)
      nameNode = nameNode.namedChildren[0] ?? null;
    if (valueNode && valueNode.type === rules.expressionListType)
      valueNode = valueNode.namedChildren[0] ?? null;
  }

  const scope = currentScope(scopeStack);
  if (!nameNode || !valueNode || !scope) return;

  const unwrapped = unwrapAwait(valueNode, rules);
  const callExpr = isCall(unwrapped, isCallNode) ? unwrapped : null;

  if (callExpr) {
    const callee = resolveCalleeName(callExpr, rules);
    if (callee && scope.funcName) {
      if (
        (rules.objectDestructType && nameNode.type === rules.objectDestructType) ||
        (rules.arrayDestructType && nameNode.type === rules.arrayDestructType)
      ) {
        const names = extractParamNames(nameNode, rules);
        for (const n of names) {
          assignments.push({
            varName: n,
            callerFunc: scope.funcName,
            sourceCallName: callee,
            expression: truncate(node.text),
            line: node.startPosition.row + 1,
          });
          scope.locals.set(n, { type: 'destructured', callee });
        }
      } else {
        const varName =
          nameNode.type === 'identifier' || nameNode.type === rules.paramIdentifier
            ? nameNode.text
            : nameNode.text;
        assignments.push({
          varName,
          callerFunc: scope.funcName,
          sourceCallName: callee,
          expression: truncate(node.text),
          line: node.startPosition.row + 1,
        });
        scope.locals.set(varName, { type: 'call_return', callee });
      }
    }
  }
}

function handleAssignment(
  node: TreeSitterNode,
  rules: AnyRules,
  scopeStack: ScopeEntry[],
  assignments: DataflowAssignment[],
  mutations: DataflowMutation[],
  isCallNode: (t: string) => boolean,
): void {
  const left = node.childForFieldName(rules.assignLeftField);
  const right = node.childForFieldName(rules.assignRightField);
  const scope = currentScope(scopeStack);
  if (!scope?.funcName) return;

  if (left && rules.memberNode && left.type === rules.memberNode) {
    const receiver = memberReceiver(left, rules);
    if (receiver) {
      const binding = findBinding(receiver, scopeStack);
      if (binding) {
        mutations.push({
          funcName: scope.funcName,
          receiverName: receiver,
          binding,
          mutatingExpr: truncate(node.text),
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  if (left && isIdent(left.type, rules) && right) {
    const unwrapped = unwrapAwait(right, rules);
    const callExpr = isCall(unwrapped, isCallNode) ? unwrapped : null;
    if (callExpr) {
      const callee = resolveCalleeName(callExpr, rules);
      if (callee) {
        assignments.push({
          varName: left.text,
          callerFunc: scope.funcName,
          sourceCallName: callee,
          expression: truncate(node.text),
          line: node.startPosition.row + 1,
        });
        scope.locals.set(left.text, { type: 'call_return', callee });
      }
    }
  }
}

function handleCallExpr(
  node: TreeSitterNode,
  rules: AnyRules,
  scopeStack: ScopeEntry[],
  argFlows: DataflowArgFlow[],
): void {
  const callee = resolveCalleeName(node, rules);
  const argsNode = node.childForFieldName(rules.callArgsField);
  const scope = currentScope(scopeStack);
  if (!callee || !argsNode || !scope?.funcName) return;

  let argIndex = 0;
  for (let arg of argsNode.namedChildren) {
    if (rules.argumentWrapperType && arg.type === rules.argumentWrapperType) {
      arg = arg.namedChildren[0] || arg;
    }
    const unwrapped =
      rules.spreadType && arg.type === rules.spreadType ? arg.namedChildren[0] || arg : arg;
    if (!unwrapped) {
      argIndex++;
      continue;
    }

    const argName = isIdent(unwrapped.type, rules) ? unwrapped.text : null;
    const argMember =
      rules.memberNode && unwrapped.type === rules.memberNode
        ? memberReceiver(unwrapped, rules)
        : null;
    const trackedName = argName || argMember;

    if (trackedName) {
      const binding = findBinding(trackedName, scopeStack);
      if (binding) {
        argFlows.push({
          callerFunc: scope.funcName,
          calleeName: callee,
          argIndex,
          argName: trackedName,
          binding,
          confidence: bindingConfidence(binding),
          expression: truncate(arg.text),
          line: node.startPosition.row + 1,
        });
      }
    }
    argIndex++;
  }
}

function handleExprStmtMutation(
  node: TreeSitterNode,
  rules: AnyRules,
  scopeStack: ScopeEntry[],
  mutations: DataflowMutation[],
  isCallNode: (t: string) => boolean,
): void {
  if (rules.mutatingMethods.size === 0) return;
  const expr = node.namedChildren[0];
  if (!expr || !isCall(expr, isCallNode)) return;

  let methodName: string | null = null;
  let receiver: string | null = null;

  const fn = expr.childForFieldName(rules.callFunctionField);
  if (fn && fn.type === rules.memberNode) {
    const prop = fn.childForFieldName(rules.memberPropertyField);
    methodName = prop ? prop.text : null;
    receiver = memberReceiver(fn, rules);
  }

  if (!receiver && rules.callObjectField) {
    const obj = expr.childForFieldName(rules.callObjectField);
    const name = expr.childForFieldName(rules.callFunctionField);
    if (obj && name) {
      methodName = name.text;
      receiver = isIdent(obj.type, rules) ? obj.text : null;
    }
  }

  if (!methodName || !rules.mutatingMethods.has(methodName)) return;

  const scope = currentScope(scopeStack);
  if (!receiver || !scope?.funcName) return;

  const binding = findBinding(receiver, scopeStack);
  if (binding) {
    mutations.push({
      funcName: scope.funcName,
      receiverName: receiver,
      binding,
      mutatingExpr: truncate(expr.text),
      line: node.startPosition.row + 1,
    });
  }
}

function handleReturn(
  node: TreeSitterNode,
  rules: AnyRules,
  scopeStack: ScopeEntry[],
  returns: DataflowReturnEntry[],
): void {
  if (node.parent?.type === rules.returnNode) return;

  const scope = currentScope(scopeStack);
  if (scope?.funcName) {
    const expr = node.namedChildren[0];
    const referencedNames: string[] = [];
    if (expr) collectIdentifiers(expr, referencedNames, rules);
    returns.push({
      funcName: scope.funcName,
      expression: truncate(expr ? expr.text : ''),
      referencedNames,
      line: node.startPosition.row + 1,
    });
  }
}

export function createDataflowVisitor(rules: AnyRules): Visitor {
  const isCallNode: (t: string) => boolean = rules.callNodes
    ? (t: string) => rules.callNodes.has(t)
    : (t: string) => t === rules.callNode;

  const parameters: DataflowParam[] = [];
  const returns: DataflowReturnEntry[] = [];
  const assignments: DataflowAssignment[] = [];
  const argFlows: DataflowArgFlow[] = [];
  const mutations: DataflowMutation[] = [];
  const scopeStack: ScopeEntry[] = [];

  return {
    name: 'dataflow',
    functionNodeTypes: rules.functionNodes,

    enterFunction(
      funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      const name = functionName(funcNode, rules);
      const paramsNode = funcNode.childForFieldName(rules.paramListField);
      const paramList = extractParams(paramsNode, rules);
      const paramMap = new Map<string, number>();
      for (const p of paramList) {
        paramMap.set(p.name, p.index);
        if (name) {
          parameters.push({
            funcName: name,
            paramName: p.name,
            paramIndex: p.index,
            line: (paramsNode?.startPosition?.row ?? funcNode.startPosition.row) + 1,
          });
        }
      }
      scopeStack.push({ funcName: name, funcNode, params: paramMap, locals: new Map() });
    },

    exitFunction(
      _funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      scopeStack.pop();
    },

    enterNode(node: TreeSitterNode, _context: VisitorContext): EnterNodeResult | undefined {
      const t = node.type;

      if (rules.functionNodes.has(t)) return;

      if (rules.returnNode && t === rules.returnNode) {
        handleReturn(node, rules, scopeStack, returns);
        return;
      }

      if (rules.varDeclaratorNode && t === rules.varDeclaratorNode) {
        handleVarDeclarator(node, rules, scopeStack, assignments, isCallNode);
        return;
      }
      if (rules.varDeclaratorNodes?.has(t)) {
        handleVarDeclarator(node, rules, scopeStack, assignments, isCallNode);
        return;
      }

      if (isCallNode(t)) {
        handleCallExpr(node, rules, scopeStack, argFlows);
        return;
      }

      if (rules.assignmentNode && t === rules.assignmentNode) {
        handleAssignment(node, rules, scopeStack, assignments, mutations, isCallNode);
        return;
      }

      if (rules.expressionStmtNode && t === rules.expressionStmtNode) {
        handleExprStmtMutation(node, rules, scopeStack, mutations, isCallNode);
      }
    },

    finish(): DataflowResultInternal {
      return { parameters, returns, assignments, argFlows, mutations };
    },
  };
}
