/**
 * Visitor: Extract dataflow information (define-use chains, arg flows, mutations).
 *
 * Replaces the standalone extractDataflow() visit logic in dataflow.js with a
 * visitor that plugs into the unified walkWithVisitors framework.
 *
 * NOTE: The original dataflow walk uses `node.namedChildren` while the visitor
 * framework uses `node.child(i)` (all children). This visitor handles both
 * named and unnamed children correctly since the classification logic only
 * cares about specific node types/fields, not about traversal order.
 */

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

/**
 * Create a dataflow visitor for use with walkWithVisitors.
 *
 * @param {object} rules - DATAFLOW_RULES for the language
 * @returns {Visitor}
 */
export function createDataflowVisitor(rules) {
  const isCallNode = rules.callNodes ? (t) => rules.callNodes.has(t) : (t) => t === rules.callNode;

  const parameters = [];
  const returns = [];
  const assignments = [];
  const argFlows = [];
  const mutations = [];

  const scopeStack = [];

  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
  }

  function findBinding(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const scope = scopeStack[i];
      if (scope.params.has(name))
        return { type: 'param', index: scope.params.get(name), funcName: scope.funcName };
      if (scope.locals.has(name))
        return { type: 'local', source: scope.locals.get(name), funcName: scope.funcName };
    }
    return null;
  }

  function bindingConfidence(binding) {
    if (!binding) return 0.5;
    if (binding.type === 'param') return 1.0;
    if (binding.type === 'local') {
      if (binding.source?.type === 'call_return') return 0.9;
      if (binding.source?.type === 'destructured') return 0.8;
      return 0.9;
    }
    return 0.5;
  }

  function unwrapAwait(node) {
    if (rules.awaitNode && node.type === rules.awaitNode) {
      return node.namedChildren[0] || node;
    }
    return node;
  }

  function isCall(node) {
    return node && isCallNode(node.type);
  }

  function handleVarDeclarator(node) {
    let nameNode = node.childForFieldName(rules.varNameField);
    let valueNode = rules.varValueField ? node.childForFieldName(rules.varValueField) : null;

    if (!valueNode && rules.equalsClauseType) {
      for (const child of node.namedChildren) {
        if (child.type === rules.equalsClauseType) {
          valueNode = child.childForFieldName('value') || child.namedChildren[0];
          break;
        }
      }
    }

    if (!valueNode) {
      for (const child of node.namedChildren) {
        if (child !== nameNode && isCall(unwrapAwait(child))) {
          valueNode = child;
          break;
        }
      }
    }

    if (rules.expressionListType) {
      if (nameNode?.type === rules.expressionListType) nameNode = nameNode.namedChildren[0];
      if (valueNode?.type === rules.expressionListType) valueNode = valueNode.namedChildren[0];
    }

    const scope = currentScope();
    if (!nameNode || !valueNode || !scope) return;

    const unwrapped = unwrapAwait(valueNode);
    const callExpr = isCall(unwrapped) ? unwrapped : null;

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

  function handleAssignment(node) {
    const left = node.childForFieldName(rules.assignLeftField);
    const right = node.childForFieldName(rules.assignRightField);
    const scope = currentScope();
    if (!scope?.funcName) return;

    if (left && rules.memberNode && left.type === rules.memberNode) {
      const receiver = memberReceiver(left, rules);
      if (receiver) {
        const binding = findBinding(receiver);
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
      const unwrapped = unwrapAwait(right);
      const callExpr = isCall(unwrapped) ? unwrapped : null;
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

  function handleCallExpr(node) {
    const callee = resolveCalleeName(node, rules);
    const argsNode = node.childForFieldName(rules.callArgsField);
    const scope = currentScope();
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
        const binding = findBinding(trackedName);
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

  function handleExprStmtMutation(node) {
    if (rules.mutatingMethods.size === 0) return;
    const expr = node.namedChildren[0];
    if (!expr || !isCall(expr)) return;

    let methodName = null;
    let receiver = null;

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

    const scope = currentScope();
    if (!receiver || !scope?.funcName) return;

    const binding = findBinding(receiver);
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

  return {
    name: 'dataflow',
    functionNodeTypes: rules.functionNodes,

    enterFunction(funcNode, _funcName, _context) {
      const name = functionName(funcNode, rules);
      const paramsNode = funcNode.childForFieldName(rules.paramListField);
      const paramList = extractParams(paramsNode, rules);
      const paramMap = new Map();
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

    exitFunction(_funcNode, _funcName, _context) {
      scopeStack.pop();
    },

    enterNode(node, _context) {
      const t = node.type;

      // Skip function nodes — handled by enterFunction/exitFunction
      if (rules.functionNodes.has(t)) return;

      // Return statements (skip keyword tokens inside return statements, e.g. Ruby's
      // `return` node nests a `return` keyword child with the same type string)
      if (rules.returnNode && t === rules.returnNode) {
        if (node.parent?.type === rules.returnNode) return; // keyword token, not statement

        const scope = currentScope();
        if (scope?.funcName) {
          const expr = node.namedChildren[0];
          const referencedNames = [];
          if (expr) collectIdentifiers(expr, referencedNames, rules);
          returns.push({
            funcName: scope.funcName,
            expression: truncate(expr ? expr.text : ''),
            referencedNames,
            line: node.startPosition.row + 1,
          });
        }
        return;
      }

      // Variable declarations
      if (rules.varDeclaratorNode && t === rules.varDeclaratorNode) {
        handleVarDeclarator(node);
        return;
      }
      if (rules.varDeclaratorNodes?.has(t)) {
        handleVarDeclarator(node);
        return;
      }

      // Call expressions
      if (isCallNode(t)) {
        handleCallExpr(node);
        return;
      }

      // Assignment expressions
      if (rules.assignmentNode && t === rules.assignmentNode) {
        handleAssignment(node);
        return;
      }

      // Mutation detection via expression_statement
      if (rules.expressionStmtNode && t === rules.expressionStmtNode) {
        handleExprStmtMutation(node);
      }
    },

    finish() {
      return { parameters, returns, assignments, argFlows, mutations };
    },
  };
}
