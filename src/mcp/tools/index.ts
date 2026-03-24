/**
 * Barrel module — registers all MCP tool handlers.
 */

import type { McpToolContext } from '../server.js';

export interface McpToolHandler {
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: tool arg types vary per handler
  handler(args: any, ctx: McpToolContext): Promise<unknown>;
}

import * as astQuery from './ast-query.js';
import * as audit from './audit.js';
import * as batchQuery from './batch-query.js';
import * as branchCompare from './branch-compare.js';
import * as brief from './brief.js';
import * as cfg from './cfg.js';
import * as check from './check.js';
import * as coChanges from './co-changes.js';
import * as codeOwners from './code-owners.js';
import * as communities from './communities.js';
import * as complexity from './complexity.js';
import * as context from './context.js';
import * as dataflow from './dataflow.js';
import * as diffImpact from './diff-impact.js';
import * as executionFlow from './execution-flow.js';
import * as exportGraph from './export-graph.js';
import * as fileDeps from './file-deps.js';
import * as fileExports from './file-exports.js';
import * as findCycles from './find-cycles.js';
import * as fnImpact from './fn-impact.js';
import * as impactAnalysis from './impact-analysis.js';
import * as implementations from './implementations.js';
import * as interfaces from './interfaces.js';
import * as listFunctions from './list-functions.js';
import * as listRepos from './list-repos.js';
import * as moduleMap from './module-map.js';
import * as nodeRoles from './node-roles.js';
import * as pathTool from './path.js';
import * as query from './query.js';
import * as semanticSearch from './semantic-search.js';
import * as sequence from './sequence.js';
import * as structure from './structure.js';
import * as symbolChildren from './symbol-children.js';
import * as triage from './triage.js';
import * as where from './where.js';

export const TOOL_HANDLERS = new Map<string, McpToolHandler>([
  [query.name, query],
  [pathTool.name, pathTool],
  [fileDeps.name, fileDeps],
  [fileExports.name, fileExports],
  [impactAnalysis.name, impactAnalysis],
  [findCycles.name, findCycles],
  [moduleMap.name, moduleMap],
  [fnImpact.name, fnImpact],
  [context.name, context],
  [symbolChildren.name, symbolChildren],
  [where.name, where],
  [diffImpact.name, diffImpact],
  [semanticSearch.name, semanticSearch],
  [exportGraph.name, exportGraph],
  [listFunctions.name, listFunctions],
  [structure.name, structure],
  [nodeRoles.name, nodeRoles],
  [coChanges.name, coChanges],
  [executionFlow.name, executionFlow],
  [sequence.name, sequence],
  [complexity.name, complexity],
  [communities.name, communities],
  [codeOwners.name, codeOwners],
  [audit.name, audit],
  [batchQuery.name, batchQuery],
  [triage.name, triage],
  [branchCompare.name, branchCompare],
  [cfg.name, cfg],
  [dataflow.name, dataflow],
  [check.name, check],
  [astQuery.name, astQuery],
  [brief.name, brief],
  [implementations.name, implementations],
  [interfaces.name, interfaces],
  [listRepos.name, listRepos],
]);
