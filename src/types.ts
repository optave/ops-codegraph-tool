/**
 * Core type definitions for codegraph.
 *
 * These interfaces serve as the migration contract — each module is migrated
 * to satisfy its interface. They capture every abstraction in the codebase:
 * symbol/edge kinds, database shapes, repository contracts, extractors,
 * parsers, builders, visitors, features, config, and the graph model.
 */

// ════════════════════════════════════════════════════════════════════════
// §1  Symbol & Edge Kind Enumerations
// ════════════════════════════════════════════════════════════════════════

/** The original 10 symbol kinds — default query scope. */
export type CoreSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'record'
  | 'module';

/** Sub-declaration kinds (Phase 1). Includes 'method' for class child nodes. */
export type ExtendedSymbolKind = 'parameter' | 'property' | 'constant' | 'method';

/** All queryable symbol kinds. */
export type SymbolKind = CoreSymbolKind | ExtendedSymbolKind;

/** Special kind used for file-level nodes in the graph. */
export type FileNodeKind = 'file';

/** Union of every kind that can appear in a node row. */
export type AnyNodeKind = SymbolKind | FileNodeKind;

/** Coupling and dependency edge kinds. */
export type CoreEdgeKind =
  | 'imports'
  | 'imports-type'
  | 'dynamic-imports'
  | 'reexports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'contains';

/** Parent/child and type relationship edges. */
export type StructuralEdgeKind = 'parameter_of' | 'receiver';

/** Dataflow-specific edge kinds. */
export type DataflowEdgeKind = 'flows_to' | 'returns' | 'mutates';

/** All edge kinds that can appear in the graph. */
export type EdgeKind = CoreEdgeKind | StructuralEdgeKind;

/** Extended edge kinds including dataflow. */
export type AnyEdgeKind = EdgeKind | DataflowEdgeKind;

/** AST node kinds extracted during analysis. */
export type ASTNodeKind = 'call' | 'new' | 'string' | 'regex' | 'throw' | 'await';

/** Coarse role classifications for symbols based on connectivity. */
export type CoreRole = 'entry' | 'core' | 'utility' | 'adapter' | 'dead' | 'test-only' | 'leaf';

/** Dead sub-roles — refine the coarse "dead" bucket. */
export type DeadSubRole = 'dead-leaf' | 'dead-entry' | 'dead-ffi' | 'dead-unresolved';

/** Every valid role. */
export type Role = CoreRole | DeadSubRole;

/** Supported language identifiers (from LANGUAGE_REGISTRY). */
export type LanguageId =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'hcl';

/** Engine mode selector. */
export type EngineMode = 'native' | 'wasm' | 'auto';

/** Graph export formats. */
export type ExportFormat = 'dot' | 'mermaid' | 'json' | 'graphml' | 'graphson' | 'neo4j-csv';

// ════════════════════════════════════════════════════════════════════════
// §2  Database Row Shapes
// ════════════════════════════════════════════════════════════════════════

/** A node row as stored in (and returned from) SQLite. */
export interface NodeRow {
  id: number;
  name: string;
  kind: AnyNodeKind;
  file: string;
  line: number;
  end_line: number | null;
  parent_id: number | null;
  exported: 0 | 1 | null;
  qualified_name: string | null;
  scope: string | null;
  visibility: 'public' | 'private' | 'protected' | null;
  role: Role | null;
}

/** A node row augmented with fan-in count (from findNodesWithFanIn). */
export interface NodeRowWithFanIn extends NodeRow {
  fan_in: number;
}

/** A node row augmented with triage signals (from findNodesForTriage). */
export interface TriageNodeRow extends NodeRow {
  fan_in: number;
  cognitive: number;
  mi: number;
  cyclomatic: number;
  max_nesting: number;
  churn: number;
}

/** Compact node ID row (from bulkNodeIdsByFile). */
export interface NodeIdRow {
  id: number;
  name: string;
  kind: string;
  line: number;
}

/** A child node row (from findNodeChildren). */
export interface ChildNodeRow {
  name: string;
  kind: SymbolKind;
  line: number;
  end_line: number | null;
  qualified_name: string | null;
  scope: string | null;
  visibility: 'public' | 'private' | 'protected' | null;
  file?: string;
}

/** An edge row as stored in SQLite. */
export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  kind: EdgeKind;
  confidence: number | null;
  dynamic: 0 | 1;
}

/** Callee/caller node shape (from findCallees / findCallers). */
export interface RelatedNodeRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line?: number | null;
}

/** An incoming/outgoing edge with the related node info. */
export interface AdjacentEdgeRow {
  name: string;
  kind: string;
  file: string;
  line: number;
  edge_kind: EdgeKind;
}

/** Import target/source row. */
export interface ImportEdgeRow {
  file: string;
  edge_kind: EdgeKind;
}

/** Intra-file call edge (from findIntraFileCallEdges). */
export interface IntraFileCallEdge {
  caller_name: string;
  callee_name: string;
}

/** Callable node row (for graph-read queries). */
export interface CallableNodeRow {
  id: number;
  name: string;
  kind: string;
  file: string;
}

/** Call edge row (for graph-read queries). */
export interface CallEdgeRow {
  source_id: number;
  target_id: number;
  confidence: number | null;
}

/** File node row (for graph-read queries). */
export interface FileNodeRow {
  id: number;
  name: string;
  file: string;
}

/** Import edge row (for graph-read queries). */
export interface ImportGraphEdgeRow {
  source_id: number;
  target_id: number;
}

/** Complexity metrics (from getComplexityForNode). */
export interface ComplexityMetrics {
  cognitive: number;
  cyclomatic: number;
  max_nesting: number;
  maintainability_index: number | null;
  halstead_volume: number | null;
}

// ════════════════════════════════════════════════════════════════════════
// §3  Repository Interface
// ════════════════════════════════════════════════════════════════════════

/** Query options common across many repository methods. */
export interface QueryOpts {
  kind?: SymbolKind;
  kinds?: SymbolKind[];
  file?: string;
  noTests?: boolean;
}

/** Options for listFunctionNodes / iterateFunctionNodes. */
export interface ListFunctionOpts {
  file?: string;
  pattern?: string;
  noTests?: boolean;
}

/** Options for findNodesForTriage. */
export interface TriageQueryOpts {
  kind?: string;
  role?: Role;
  noTests?: boolean;
  file?: string;
}

/**
 * Abstract Repository contract — defines all graph data access methods.
 * Concrete implementations: SqliteRepository, InMemoryRepository.
 */
export interface Repository {
  // ── Node lookups ──────────────────────────────────────────────────
  findNodeById(id: number): NodeRow | undefined;
  findNodesByFile(file: string): NodeRow[];
  findFileNodes(fileLike: string): NodeRow[];
  findNodesWithFanIn(namePattern: string, opts?: QueryOpts): NodeRowWithFanIn[];
  countNodes(): number;
  countEdges(): number;
  countFiles(): number;
  getNodeId(name: string, kind: string, file: string, line: number): number | undefined;
  getFunctionNodeId(name: string, file: string, line: number): number | undefined;
  bulkNodeIdsByFile(file: string): NodeIdRow[];
  findNodeChildren(parentId: number): ChildNodeRow[];
  findNodesByScope(scopeName: string, opts?: QueryOpts): NodeRow[];
  findNodeByQualifiedName(qualifiedName: string, opts?: { file?: string }): NodeRow[];
  listFunctionNodes(opts?: ListFunctionOpts): NodeRow[];
  iterateFunctionNodes(opts?: ListFunctionOpts): IterableIterator<NodeRow>;
  findNodesForTriage(opts?: TriageQueryOpts): TriageNodeRow[];

  // ── Edge queries ──────────────────────────────────────────────────
  findCallees(nodeId: number): RelatedNodeRow[];
  findCallers(nodeId: number): RelatedNodeRow[];
  findDistinctCallers(nodeId: number): RelatedNodeRow[];
  findAllOutgoingEdges(nodeId: number): AdjacentEdgeRow[];
  findAllIncomingEdges(nodeId: number): AdjacentEdgeRow[];
  findCalleeNames(nodeId: number): string[];
  findCallerNames(nodeId: number): string[];
  findImportTargets(nodeId: number): ImportEdgeRow[];
  findImportSources(nodeId: number): ImportEdgeRow[];
  findImportDependents(nodeId: number): NodeRow[];
  findCrossFileCallTargets(file: string): Set<number>;
  countCrossFileCallers(nodeId: number, file: string): number;
  getClassHierarchy(classNodeId: number): Set<number>;
  findImplementors(nodeId: number): RelatedNodeRow[];
  findInterfaces(nodeId: number): RelatedNodeRow[];
  findIntraFileCallEdges(file: string): IntraFileCallEdge[];

  // ── Graph-read queries ────────────────────────────────────────────
  getCallableNodes(): CallableNodeRow[];
  getCallEdges(): CallEdgeRow[];
  getFileNodesAll(): FileNodeRow[];
  getImportEdges(): ImportGraphEdgeRow[];

  // ── Optional table checks ─────────────────────────────────────────
  hasCfgTables(): boolean;
  hasEmbeddings(): boolean;
  hasDataflowTable(): boolean;
  getComplexityForNode(nodeId: number): ComplexityMetrics | undefined;
}

/**
 * In-memory repository — mutable, used for testing and incremental builds.
 * Extends Repository with mutation methods.
 */
export interface MutableRepository extends Repository {
  addNode(attrs: {
    name: string;
    kind: AnyNodeKind;
    file: string;
    line: number;
    end_line?: number;
    parent_id?: number;
    exported?: 0 | 1;
    qualified_name?: string;
    scope?: string;
    visibility?: 'public' | 'private' | 'protected';
    role?: Role;
  }): number;

  addEdge(attrs: {
    source_id: number;
    target_id: number;
    kind: AnyEdgeKind;
    confidence?: number;
    dynamic?: 0 | 1;
  }): number;

  addComplexity(
    nodeId: number,
    metrics: {
      cognitive: number;
      cyclomatic: number;
      max_nesting: number;
      maintainability_index?: number;
      halstead_volume?: number;
    },
  ): void;
}

// ════════════════════════════════════════════════════════════════════════
// §4  Extractor Types
// ════════════════════════════════════════════════════════════════════════

/** A symbol definition produced by any extractor. */
export interface Definition {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine?: number;
  children?: SubDeclaration[];
  visibility?: 'public' | 'private' | 'protected';
  decorators?: string[];
  /** Populated post-analysis by the complexity visitor. */
  complexity?: DefinitionComplexity;
  /** Populated post-analysis by the CFG visitor. */
  cfg?: { blocks: CfgBlock[]; edges: CfgEdge[] } | null;
}

/** Sub-declaration (child) within a definition. */
export interface SubDeclaration {
  name: string;
  kind: 'parameter' | 'property' | 'constant' | 'method';
  line: number;
  endLine?: number;
  visibility?: 'public' | 'private' | 'protected';
}

/** Complexity metrics attached to a definition post-analysis. */
export interface DefinitionComplexity {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  halstead?: HalsteadMetrics;
  loc?: LOCMetrics;
  maintainabilityIndex?: number;
}

/** Halstead software science metrics. */
export interface HalsteadMetrics {
  volume: number;
  difficulty: number;
  effort: number;
  bugs: number;
}

/** Halstead derived metrics including raw counts. */
export interface HalsteadDerivedMetrics extends HalsteadMetrics {
  n1: number;
  n2: number;
  bigN1: number;
  bigN2: number;
  vocabulary: number;
  length: number;
}

/** Lines-of-code metrics. */
export interface LOCMetrics {
  loc: number;
  sloc: number;
  commentLines: number;
}

/** A function/method call detected by an extractor. */
export interface Call {
  name: string;
  line: number;
  receiver?: string;
  dynamic?: boolean;
}

/** An import statement detected by an extractor. */
export interface Import {
  source: string;
  names: string[];
  line: number;
  // Standard flags
  typeOnly?: boolean;
  reexport?: boolean;
  wildcardReexport?: boolean;
  dynamicImport?: boolean;
  // Language-specific flags (mutually exclusive at runtime)
  pythonImport?: boolean;
  goImport?: boolean;
  rustUse?: boolean;
  javaImport?: boolean;
  csharpUsing?: boolean;
  rubyRequire?: boolean;
  phpUse?: boolean;
}

/** A class/struct/trait relationship (extends or implements). */
export interface ClassRelation {
  name: string;
  extends?: string;
  implements?: string;
  line: number;
}

/** A named export from a module. */
export interface Export {
  name: string;
  kind: SymbolKind;
  line: number;
}

/** A type-map entry for call resolution confidence scoring. */
export interface TypeMapEntry {
  type: string;
  confidence: number;
}

/** The normalized output shape returned by every language extractor. */
export interface ExtractorOutput {
  definitions: Definition[];
  calls: Call[];
  imports: Import[];
  classes: ClassRelation[];
  exports: Export[];
  typeMap: Map<string, TypeMapEntry>;
  /** WASM tree retained for downstream analysis (complexity, CFG, dataflow). */
  _tree?: TreeSitterTree;
  /** Language identifier. */
  _langId?: LanguageId;
  /** Line count for metrics. */
  _lineCount?: number;
  /** Dataflow results, populated post-analysis. */
  dataflow?: DataflowResult;
  /** AST node rows, populated post-analysis. */
  astNodes?: ASTNodeRow[];
  /** Set when typeMap was backfilled from WASM for a native parse result. */
  _typeMapBackfilled?: boolean;
}

/** Extractor function signature. */
export type ExtractorFn = (
  tree: TreeSitterTree,
  filePath: string,
  query?: TreeSitterQuery,
) => ExtractorOutput;

// ════════════════════════════════════════════════════════════════════════
// §5  Parser & Language Registry
// ════════════════════════════════════════════════════════════════════════

/** A single entry in the LANGUAGE_REGISTRY. */
export interface LanguageRegistryEntry {
  id: LanguageId;
  extensions: string[];
  grammarFile: string;
  extractor: ExtractorFn;
  required: boolean;
}

/** tree-sitter opaque types (thin wrappers — real impl is WASM). */
export interface TreeSitterNode {
  id: number;
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  child(index: number): TreeSitterNode | null;
  namedChild(index: number): TreeSitterNode | null;
  childForFieldName(name: string): TreeSitterNode | null;
  parent: TreeSitterNode | null;
  previousSibling: TreeSitterNode | null;
  nextSibling: TreeSitterNode | null;
  children: TreeSitterNode[];
  namedChildren: TreeSitterNode[];
}

export interface TreeSitterTree {
  rootNode: TreeSitterNode;
}

export interface TreeSitterQuery {
  matches(node: TreeSitterNode): TreeSitterQueryMatch[];
  captures(node: TreeSitterNode): TreeSitterQueryCapture[];
}

export interface TreeSitterQueryMatch {
  pattern: number;
  captures: TreeSitterQueryCapture[];
}

export interface TreeSitterQueryCapture {
  name: string;
  node: TreeSitterNode;
}

// ════════════════════════════════════════════════════════════════════════
// §6  Import Resolution
// ════════════════════════════════════════════════════════════════════════

/** A single import to resolve. */
export interface ImportBatchItem {
  fromFile: string;
  importSource: string;
}

/** Batch of imports to resolve. */
export type ImportBatch = ImportBatchItem[];

/** Result of resolveImportsBatch: Map<"fromFile|importSource", resolvedPath>. */
export type BatchResolvedMap = Map<string, string>;

/** Path aliases from tsconfig/jsconfig. */
export interface PathAliases {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

/** Parsed bare specifier. */
export interface BareSpecifier {
  packageName: string;
  subpath: string;
}

// ════════════════════════════════════════════════════════════════════════
// §7  AST Visitor System
// ════════════════════════════════════════════════════════════════════════

/** Shared context mutated during the DFS walk. */
export interface VisitorContext {
  nestingLevel: number;
  currentFunction: TreeSitterNode | null;
  langId: string;
  scopeStack: ScopeEntry[];
}

/** An entry on the scope stack. */
export interface ScopeEntry {
  funcName: string | null;
  funcNode: TreeSitterNode;
  params: Map<string, unknown>;
  locals: Map<string, unknown>;
}

/** Return value from enterNode — request skip of descendants. */
export interface EnterNodeResult {
  skipChildren?: boolean;
}

/** A pluggable analysis visitor for the unified DFS walker. */
export interface Visitor {
  name: string;
  init?(langId: string): void;
  enterNode?(node: TreeSitterNode, context: VisitorContext): EnterNodeResult | undefined;
  exitNode?(node: TreeSitterNode, context: VisitorContext): void;
  enterFunction?(funcNode: TreeSitterNode, funcName: string | null, context: VisitorContext): void;
  exitFunction?(funcNode: TreeSitterNode, funcName: string | null, context: VisitorContext): void;
  finish?(): unknown;
  functionNodeTypes?: Set<string>;
}

/** Options for walkWithVisitors. */
export interface WalkOptions {
  functionNodeTypes?: Set<string>;
  nestingNodeTypes?: Set<string>;
  getFunctionName?: (node: TreeSitterNode) => string | null;
}

/** Result of walkWithVisitors: Map of visitor.name → finish() result. */
export type WalkResults = Record<string, unknown>;

// ════════════════════════════════════════════════════════════════════════
// §8  AST Analysis Engine
// ════════════════════════════════════════════════════════════════════════

/** Toggles for runAnalyses. */
export interface AnalysisOpts {
  ast?: boolean;
  complexity?: boolean;
  cfg?: boolean;
  dataflow?: boolean;
}

/** Timing output from runAnalyses. */
export interface AnalysisTiming {
  astMs: number;
  complexityMs: number;
  cfgMs: number;
  dataflowMs: number;
  _unifiedWalkMs?: number;
}

/** An AST node row stored in the database. */
export interface ASTNodeRow {
  node_id: number;
  kind: ASTNodeKind;
  line: number;
  text: string;
}

/** AST type mapping: tree-sitter node type → analysis kind. */
export type ASTTypeMap = Map<string, ASTNodeKind>;

/** Complexity rules for a language. */
export interface ComplexityRules {
  branchNodes: Set<string>;
  caseNodes: Set<string>;
  logicalOperators: Set<string>;
  logicalNodeType: string | null;
  optionalChainType: string | null;
  nestingNodes: Set<string>;
  functionNodes: Set<string>;
  ifNodeType: string | null;
  elseNodeType: string | null;
  elifNodeType: string | null;
  elseViaAlternative: boolean;
  switchLikeNodes: Set<string>;
}

/** Halstead rules for a language. */
export interface HalsteadRules {
  operatorLeafTypes: Set<string>;
  operandLeafTypes: Set<string>;
  compoundOperators: Set<string>;
  skipTypes: Set<string>;
}

/** CFG rules for a language (merged result of CFG_DEFAULTS + overrides). */
export interface CfgRulesConfig {
  ifNode: string | null;
  ifNodes: Set<string> | null;
  elifNode: string | null;
  elseClause: string | null;
  elseViaAlternative: boolean;
  ifConsequentField: string | null;
  forNodes: Set<string>;
  whileNode: string | null;
  whileNodes: Set<string> | null;
  doNode: string | null;
  infiniteLoopNode: string | null;
  unlessNode: string | null;
  untilNode: string | null;
  switchNode: string | null;
  switchNodes: Set<string> | null;
  caseNode: string | null;
  caseNodes: Set<string> | null;
  defaultNode: string | null;
  tryNode: string | null;
  catchNode: string | null;
  finallyNode: string | null;
  returnNode: string | null;
  throwNode: string | null;
  breakNode: string | null;
  continueNode: string | null;
  blockNode: string | null;
  blockNodes: Set<string> | null;
  labeledNode: string | null;
  functionNodes: Set<string>;
}

/** Dataflow rules for a language (merged result of DATAFLOW_DEFAULTS + overrides). */
export interface DataflowRulesConfig {
  functionNodes: Set<string>;
  nameField: string;
  varAssignedFnParent: string | null;
  assignmentFnParent: string | null;
  pairFnParent: string | null;
  paramListField: string;
  paramIdentifier: string;
  paramWrapperTypes: Set<string>;
  defaultParamType: string | null;
  restParamType: string | null;
  objectDestructType: string | null;
  arrayDestructType: string | null;
  shorthandPropPattern: string | null;
  pairPatternType: string | null;
  extractParamName: ((node: TreeSitterNode) => string[] | null) | null;
  returnNode: string | null;
  varDeclaratorNode: string | null;
  varDeclaratorNodes: Set<string> | null;
  varNameField: string;
  varValueField: string;
  assignmentNode: string | null;
  assignLeftField: string;
  assignRightField: string;
  callNode: string | null;
  callNodes: Set<string> | null;
  callFunctionField: string;
  callArgsField: string;
  spreadType: string | null;
  memberNode: string | null;
  memberObjectField: string;
  memberPropertyField: string;
  optionalChainNode: string | null;
  awaitNode: string | null;
  mutatingMethods: Set<string>;
  expressionStmtNode: string;
  callObjectField: string | null;
  expressionListType: string | null;
  equalsClauseType: string | null;
  argumentWrapperType: string | null;
  extraIdentifierTypes: Set<string> | null;
}

/** Language rule module: exports from each language rule file. */
export interface LanguageRuleModule {
  complexity: ComplexityRules;
  halstead: HalsteadRules;
  cfg: CfgRulesConfig;
  dataflow: DataflowRulesConfig;
  astTypes: Record<string, string> | null;
}

/** A basic block in a control flow graph. */
export interface CfgBlock {
  id: number;
  label: string;
  startLine: number;
  endLine: number;
}

/** An edge in a control flow graph. */
export interface CfgEdge {
  from: number;
  to: number;
  label?: string;
}

/** Dataflow extraction result. */
export interface DataflowResult {
  parameters: DataflowParam[];
  returns: DataflowReturn[];
  assignments: DataflowAssignment[];
  argFlows: DataflowArgFlow[];
  mutations: DataflowMutation[];
}

export interface DataflowParam {
  name: string;
  funcName: string;
  line: number;
  typeHint?: string;
}

export interface DataflowReturn {
  funcName: string;
  line: number;
  expression: string;
}

export interface DataflowAssignment {
  name: string;
  line: number;
  expression: string;
}

export interface DataflowArgFlow {
  callerFunc: string;
  callee: string;
  argIndex: number;
  binding: { name: string; type: 'param' | 'local' | 'unknown' };
  line: number;
}

export interface DataflowMutation {
  binding: { name: string; type: 'param' | 'local' | 'unknown' };
  mutatingExpr: string;
  line: number;
}

// ════════════════════════════════════════════════════════════════════════
// §9  Graph Model (CodeGraph)
// ════════════════════════════════════════════════════════════════════════

/** Node attributes stored in the in-memory graph. */
export interface GraphNodeAttrs {
  label?: string;
  kind?: string;
  file?: string;
  name?: string;
  line?: number;
  dbId?: number;
  [key: string]: unknown;
}

/** Edge attributes stored in the in-memory graph. */
export interface GraphEdgeAttrs {
  kind?: string;
  confidence?: number;
  weight?: number;
  [key: string]: unknown;
}

/** The unified in-memory graph model. */
export interface CodeGraph {
  readonly directed: boolean;
  readonly nodeCount: number;
  readonly edgeCount: number;

  // Node operations
  addNode(id: string, attrs?: GraphNodeAttrs): CodeGraph;
  hasNode(id: string): boolean;
  getNodeAttrs(id: string): GraphNodeAttrs | undefined;
  nodes(): IterableIterator<[string, GraphNodeAttrs]>;
  nodeIds(): string[];

  // Edge operations
  addEdge(source: string, target: string, attrs?: GraphEdgeAttrs): CodeGraph;
  hasEdge(source: string, target: string): boolean;
  getEdgeAttrs(source: string, target: string): GraphEdgeAttrs | undefined;
  edges(): Generator<[string, string, GraphEdgeAttrs]>;

  // Adjacency
  successors(id: string): string[];
  predecessors(id: string): string[];
  neighbors(id: string): string[];
  outDegree(id: string): number;
  inDegree(id: string): number;

  // Filtering
  subgraph(predicate: (id: string, attrs: GraphNodeAttrs) => boolean): CodeGraph;
  filterEdges(predicate: (src: string, tgt: string, attrs: GraphEdgeAttrs) => boolean): CodeGraph;

  // Conversion
  toEdgeArray(): Array<{ source: string; target: string }>;
  toGraphology(opts?: { type?: string }): unknown;

  // Utilities
  clone(): CodeGraph;
  merge(other: CodeGraph): CodeGraph;
}

// ════════════════════════════════════════════════════════════════════════
// §10  Build Pipeline
// ════════════════════════════════════════════════════════════════════════

/** Engine options for the build pipeline. */
export interface EngineOpts {
  engine: EngineMode;
  dataflow: boolean;
  ast: boolean;
}

/** A file change detected during incremental builds. */
export interface ParseChange {
  file: string;
  relPath?: string;
  content?: string;
  hash?: string;
  stat?: { mtime: number; size: number };
  _reverseDepOnly?: boolean;
}

/** Metadata-only self-heal update. */
export interface MetadataUpdate {
  relPath: string;
  hash: string;
  stat: { mtime: number; size: number };
}

/** A file queued for parsing. */
export interface FileToParse {
  file: string;
  relPath?: string;
}

/** Shared mutable state threaded through all build stages. */
export interface PipelineContext {
  // Inputs (set during setup)
  rootDir: string;
  db: unknown; // better-sqlite3.Database
  dbPath: string;
  config: CodegraphConfig;
  opts: BuildGraphOpts;
  engineOpts: EngineOpts;
  engineName: 'native' | 'wasm';
  engineVersion: string | null;
  aliases: PathAliases;
  incremental: boolean;
  forceFullRebuild: boolean;
  schemaVersion: number;

  // File collection
  allFiles: string[];
  discoveredDirs: Set<string>;

  // Change detection
  isFullBuild: boolean;
  parseChanges: ParseChange[];
  metadataUpdates: MetadataUpdate[];
  removed: string[];
  earlyExit: boolean;

  // Parsing
  allSymbols: Map<string, ExtractorOutput>;
  fileSymbols: Map<string, ExtractorOutput>;
  filesToParse: FileToParse[];

  // Import resolution
  batchResolved: BatchResolvedMap | null;
  reexportMap: Map<string, unknown[]>;
  barrelOnlyFiles: Set<string>;

  // Node lookup
  nodesByName: Map<string, NodeRow[]>;
  nodesByNameAndFile: Map<string, NodeRow[]>;

  // Misc state
  hasEmbeddings: boolean;
  lineCountMap: Map<string, number>;

  // Phase timing
  timing: Record<string, number>;
  buildStart: number;
}

/** Options for buildGraph. */
export interface BuildGraphOpts {
  incremental?: boolean;
  engine?: EngineMode;
  dataflow?: boolean;
  ast?: boolean;
  complexity?: boolean;
  cfg?: boolean;
  scope?: string[];
  skipRegistry?: boolean;
}

/** Build timing result from buildGraph. */
export interface BuildResult {
  phases: {
    setupMs: number;
    parseMs: number;
    insertMs: number;
    resolveMs: number;
    edgesMs: number;
    structureMs: number;
    rolesMs: number;
    astMs: number;
    complexityMs: number;
    cfgMs: number;
    dataflowMs: number;
    finalizeMs: number;
  };
}

/** A pipeline stage function. */
export type PipelineStage = (ctx: PipelineContext) => Promise<void>;

// ════════════════════════════════════════════════════════════════════════
// §11  Configuration
// ════════════════════════════════════════════════════════════════════════

export interface CodegraphConfig {
  include: string[];
  exclude: string[];
  ignoreDirs: string[];
  extensions: string[];
  aliases: Record<string, unknown>;

  build: {
    incremental: boolean;
    dbPath: string;
    driftThreshold: number;
  };

  query: {
    defaultDepth: number;
    defaultLimit: number;
    excludeTests: boolean;
  };

  embeddings: {
    model: string;
    llmProvider: string | null;
  };

  llm: {
    provider: string | null;
    model: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    apiKeyCommand: string | null;
  };

  search: {
    defaultMinScore: number;
    rrfK: number;
    topK: number;
    similarityWarnThreshold: number;
  };

  ci: {
    failOnCycles: boolean;
    impactThreshold: number | null;
  };

  manifesto: {
    rules: ManifestoRules;
    boundaries: unknown | null;
  };

  check: {
    cycles: boolean;
    blastRadius: number | null;
    signatures: boolean;
    boundaries: boolean;
    depth: number;
  };

  coChange: {
    since: string;
    minSupport: number;
    minJaccard: number;
    maxFilesPerCommit: number;
  };

  analysis: {
    impactDepth: number;
    fnImpactDepth: number;
    auditDepth: number;
    sequenceDepth: number;
    falsePositiveCallers: number;
    briefCallerDepth: number;
    briefImporterDepth: number;
    briefHighRiskCallers: number;
    briefMediumRiskCallers: number;
  };

  community: {
    resolution: number;
    maxLevels: number;
    maxLocalPasses: number;
    refinementTheta: number;
  };
  structure: { cohesionThreshold: number };

  risk: {
    weights: RiskWeights;
    roleWeights: Record<Role, number>;
    defaultRoleWeight: number;
  };

  display: {
    maxColWidth: number;
    excerptLines: number;
    summaryMaxChars: number;
    jsdocEndScanLines: number;
    jsdocOpenScanLines: number;
    signatureGatherLines: number;
  };

  mcp: {
    defaults: McpDefaults;
  };
}

export interface ManifestoRules {
  cognitive: ThresholdRule;
  cyclomatic: ThresholdRule;
  maxNesting: ThresholdRule;
  maintainabilityIndex: ThresholdRule;
  importCount: ThresholdRule;
  exportCount: ThresholdRule;
  lineCount: ThresholdRule;
  fanIn: ThresholdRule;
  fanOut: ThresholdRule;
  noCycles: ThresholdRule;
  boundaries: ThresholdRule;
}

export interface ThresholdRule {
  warn: number | null;
  fail?: number | null;
}

export interface RiskWeights {
  fanIn: number;
  complexity: number;
  churn: number;
  role: number;
  mi: number;
}

export interface McpDefaults {
  [key: string]: number;
  list_functions: number;
  query: number;
  where: number;
  node_roles: number;
  export_graph: number;
  fn_impact: number;
  context: number;
  explain: number;
  file_deps: number;
  file_exports: number;
  diff_impact: number;
  impact_analysis: number;
  semantic_search: number;
  execution_flow: number;
  hotspots: number;
  co_changes: number;
  complexity: number;
  manifesto: number;
  communities: number;
  structure: number;
  triage: number;
  ast_query: number;
  implementations: number;
  interfaces: number;
}

// ════════════════════════════════════════════════════════════════════════
// §12  Pagination
// ════════════════════════════════════════════════════════════════════════

export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

export interface PaginationMeta {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  returned: number;
}

export interface PaginatedItems<T> {
  items: T[];
  pagination?: PaginationMeta;
}

/** A result object with optional _pagination metadata. */
export type Paginated<T> = T & { _pagination?: PaginationMeta };

// ════════════════════════════════════════════════════════════════════════
// §13  Error Hierarchy
// ════════════════════════════════════════════════════════════════════════

export type ErrorCode =
  | 'CODEGRAPH_ERROR'
  | 'PARSE_FAILED'
  | 'DB_ERROR'
  | 'CONFIG_INVALID'
  | 'RESOLUTION_FAILED'
  | 'ENGINE_UNAVAILABLE'
  | 'ANALYSIS_FAILED'
  | 'BOUNDARY_VIOLATION';

export interface CodegraphErrorOpts {
  code?: ErrorCode;
  file?: string;
  cause?: Error;
}

// ════════════════════════════════════════════════════════════════════════
// §14  Feature Module Result Shapes
// ════════════════════════════════════════════════════════════════════════

// ── Audit ────────────────────────────────────────────────────────────

export interface AuditResult {
  target: string;
  kind: 'function' | 'file';
  functions: AuditFunctionEntry[];
}

export interface AuditFunctionEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  endLine: number | null;
  role: Role | null;
  lineCount: number;
  summary: string | null;
  signature: string | null;
  callees: string[];
  callers: string[];
  relatedTests: string[];
  impact: {
    totalDependents: number;
    levels: Record<number, ImpactLevelEntry[]>;
  };
  health: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    maintainabilityIndex: number | null;
    halstead: HalsteadMetrics | null;
    loc: number;
    sloc: number;
    commentLines: number;
    thresholdBreaches: string[];
  };
  riskScore: number;
  complexityNotes: string[];
  sideEffects: string[];
}

export interface ImpactLevelEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  viaImplements?: boolean;
}

// ── Complexity ───────────────────────────────────────────────────────

export interface ComplexityResult {
  functions: ComplexityEntry[];
  summary: {
    analyzed: number;
    avgCognitive: number;
    maxCognitive: number;
    avgCyclomatic: number;
    maxCyclomatic: number;
    avgMI: number;
    minMI: number;
    aboveWarn: number;
  };
  thresholds: ManifestoRules;
  hasGraph: boolean;
}

export interface ComplexityEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  endLine: number | null;
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  loc: number;
  sloc: number;
  maintainabilityIndex: number;
  halstead: HalsteadMetrics;
  exceeds?: Array<'cognitive' | 'cyclomatic' | 'maxNesting' | 'maintainabilityIndex'>;
}

// ── Diff Impact ──────────────────────────────────────────────────────

export interface DiffImpactResult {
  error?: string;
  changedFiles: number;
  newFiles: string[];
  affectedFunctions: AffectedFunction[];
  affectedFiles: string[];
  historicallyCoupled?: CoChangeEntry[];
  ownership?: Record<string, string>;
  boundaryViolations?: BoundaryViolation[];
  boundaryViolationCount: number;
  summary?: DiffImpactSummary;
}

export interface AffectedFunction {
  name: string;
  kind: string;
  file: string;
  line: number;
  totalDependents: number;
  levels: Record<number, ImpactLevelEntry[]>;
}

export interface CoChangeEntry {
  file: string;
  support: number;
  jaccard: number;
}

export interface BoundaryViolation {
  from: string;
  to: string;
  rule: string;
}

export interface DiffImpactSummary {
  changedFiles: number;
  newFiles: number;
  affectedFunctions: number;
  totalDependents: number;
  boundaryViolations: number;
}

// ── Triage ───────────────────────────────────────────────────────────

export interface TriageResult {
  items: TriageEntry[];
  summary: {
    total: number;
    analyzed: number;
    avgScore: number;
    maxScore: number;
    weights: RiskWeights;
    signalCoverage: {
      complexity: number;
      churn: number;
      fanIn: number;
      mi: number;
    };
  };
  _pagination?: PaginationMeta;
}

export interface TriageEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  role: Role | null;
  fanIn: number;
  cognitive: number;
  churn: number;
  maintainabilityIndex: number;
  normFanIn: number;
  normComplexity: number;
  normChurn: number;
  normMI: number;
  roleWeight: number;
  riskScore: number;
}

// ── Communities ───────────────────────────────────────────────────────

export interface CommunitiesResult {
  communities: CommunityEntry[];
  modularity: number;
  drift: {
    splitCandidates: Array<{ directory: string; communityCount: number }>;
    mergeCandidates: Array<{
      communityId: number;
      size: number;
      directoryCount: number;
      directories: string[];
    }>;
  };
  summary: {
    communityCount: number;
    modularity: number;
    nodeCount: number;
    driftScore: number;
  };
  _pagination?: PaginationMeta;
}

export interface CommunityEntry {
  id: number;
  size: number;
  directories: Record<string, number>;
  members?: Array<{ name: string; file: string; kind?: string }>;
}

// ── Check ────────────────────────────────────────────────────────────

export interface CheckResult {
  predicates: CheckPredicate[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    changedFiles: number;
    newFiles: number;
  };
  passed: boolean;
  error?: string;
}

export interface CheckPredicate {
  name: string;
  passed: boolean;
  violations: unknown[];
  maxFound?: number;
  threshold?: number;
  note?: string;
}

// ── Batch ────────────────────────────────────────────────────────────

export type BatchCommand =
  | 'fn-impact'
  | 'context'
  | 'explain'
  | 'where'
  | 'query'
  | 'impact'
  | 'deps'
  | 'exports'
  | 'flow'
  | 'dataflow'
  | 'complexity';

export interface BatchResult {
  command: BatchCommand;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchResultEntry[];
}

export interface BatchResultEntry {
  target: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface MultiBatchItem {
  command: BatchCommand;
  target: string;
  opts?: Record<string, unknown>;
}

export interface MultiBatchResult {
  mode: 'multi';
  total: number;
  succeeded: number;
  failed: number;
  results: BatchResultEntry[];
}

// ── Flow ─────────────────────────────────────────────────────────────

export interface FlowResult {
  entry: FlowEntry | null;
  depth: number;
  steps: Array<{
    depth: number;
    nodes: Array<{ name: string; kind: string; file: string; line: number }>;
  }>;
  leaves: Array<{ name: string; kind: string; file: string; line: number; depth: number }>;
  cycles: Array<{ from: string; to: string; depth: number }>;
  totalReached: number;
  truncated: boolean;
  _pagination?: PaginationMeta;
}

export interface FlowEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  type: string;
  role: Role | null;
}

// ── Manifesto ────────────────────────────────────────────────────────

export type ManifestoRuleLevel = 'function' | 'file' | 'graph';

export interface ManifestoRuleDef {
  name: string;
  level: ManifestoRuleLevel;
  metric: string;
  defaults: ThresholdRule;
  reportOnly?: boolean;
}

export interface ManifestoResult {
  rules: ManifestoRuleStatus[];
  violations: ManifestoViolation[];
  summary: { total: number; passed: number; warned: number; failed: number };
  _pagination?: PaginationMeta;
}

export interface ManifestoRuleStatus {
  name: string;
  level: ManifestoRuleLevel;
  status: 'pass' | 'warn' | 'fail';
  thresholds: ThresholdRule;
  violationCount: number;
}

export interface ManifestoViolation {
  rule: string;
  level: ManifestoRuleLevel;
  value: number;
  threshold: number;
  name?: string;
  kind?: string;
  file?: string;
  line?: number;
}

// ── Exports (file) ───────────────────────────────────────────────────

export interface FileExportsResult {
  file: string;
  results: FileExportEntry[];
  reexports: Array<{ file: string }>;
  totalExported: number;
  totalInternal: number;
  totalUnused: number;
}

export interface FileExportEntry {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number | null;
  role: Role | null;
  signature: string | null;
  summary: string | null;
  consumers: Array<{ name: string; file: string; line: number }>;
  consumerCount: number;
}

// ── Path ─────────────────────────────────────────────────────────────

export interface PathResult {
  from: string;
  to: string;
  fromCandidates: NodeRow[];
  toCandidates: NodeRow[];
  found: boolean;
  hops: number | null;
  path: PathStep[];
  alternateCount: number;
  edgeKinds: string[];
  reverse: boolean;
  maxDepth: number;
}

export interface PathStep {
  name: string;
  kind: string;
  file: string;
  line: number;
  edgeKind: AnyEdgeKind | null;
}

// ── Stats ────────────────────────────────────────────────────────────

export interface StatsResult {
  nodes: { total: number; byKind: Record<string, number> };
  edges: { total: number; byKind: Record<string, number> };
  files: Record<string, unknown>;
  cycles: { fileLevel: number; functionLevel: number };
  hotspots: unknown[];
  embeddings?: unknown;
  quality?: unknown;
  roles: Record<Role, number>;
  complexity?: unknown;
}

// ── Module Map ───────────────────────────────────────────────────────

export interface ModuleMapResult {
  limit: number;
  topNodes: ModuleMapEntry[];
  stats: { totalFiles: number; totalNodes: number; totalEdges: number };
}

export interface ModuleMapEntry {
  file: string;
  dir: string;
  inEdges: number;
  outEdges: number;
  coupling: number;
}

// ── Roles ────────────────────────────────────────────────────────────

export interface RolesResult {
  count: number;
  summary: Record<Role, number>;
  symbols: NodeRow[];
}

// ── Implementations / Interfaces ─────────────────────────────────

export interface ImplementationsResult {
  name: string;
  results: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    implementors: Array<{ name: string; kind: string; file: string; line: number }>;
  }>;
  _pagination?: PaginationMeta;
}

export interface InterfacesResult {
  name: string;
  results: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    interfaces: Array<{ name: string; kind: string; file: string; line: number }>;
  }>;
  _pagination?: PaginationMeta;
}

// ════════════════════════════════════════════════════════════════════════
// §15  Registry (Multi-repo)
// ════════════════════════════════════════════════════════════════════════

export interface RegistryEntry {
  path: string;
  dbPath: string;
  addedAt: string;
  lastAccessedAt: string;
}

export interface Registry {
  repos: Record<string, RegistryEntry>;
}

export interface RegistryListItem {
  name: string;
  path: string;
  dbPath: string;
  addedAt: string;
  lastAccessedAt: string;
}

// ════════════════════════════════════════════════════════════════════════
// §16  MCP Server
// ════════════════════════════════════════════════════════════════════════

export interface MCPServerOptions {
  multiRepo?: boolean;
  allowedRepos?: string[];
}

// ════════════════════════════════════════════════════════════════════════
// §17  Command Interface (CLI)
// ════════════════════════════════════════════════════════════════════════

export interface OptionDef {
  flags: string;
  description: string;
  default?: unknown;
}

export interface Command {
  name: string;
  description: string;
  options: OptionDef[];
  validate?(args: unknown, opts: unknown): void;
  execute(args: unknown, opts: unknown): Promise<void>;
}

// ════════════════════════════════════════════════════════════════════════
// §18  Risk Scoring
// ════════════════════════════════════════════════════════════════════════

export interface RiskInput {
  fan_in: number;
  cognitive: number;
  churn: number;
  mi: number;
  role?: Role;
}

export interface RiskScored {
  normFanIn: number;
  normComplexity: number;
  normChurn: number;
  normMI: number;
  roleWeight: number;
  riskScore: number;
}

// ════════════════════════════════════════════════════════════════════════
// §19  Sequence Diagrams
// ════════════════════════════════════════════════════════════════════════

export interface SequenceStep {
  caller: string;
  callee: string;
  depth: number;
}

export interface SequenceResult {
  entry: string;
  steps: SequenceStep[];
  participants: string[];
}

// ════════════════════════════════════════════════════════════════════════
// §20  Graph Export
// ════════════════════════════════════════════════════════════════════════

export interface ExportOpts {
  fileLevel?: boolean;
  noTests?: boolean;
  minConfidence?: number;
  limit?: number;
  offset?: number;
  direction?: string;
}

export interface ExportJSONResult {
  nodes: NodeRow[];
  edges: EdgeRow[];
  _pagination?: PaginationMeta;
}

export interface ExportGraphSONResult {
  vertices: unknown[];
  edges: unknown[];
  _pagination?: PaginationMeta;
}

export interface ExportNeo4jCSVResult {
  nodes: string;
  relationships: string;
}

// ════════════════════════════════════════════════════════════════════════
// §21  SQLite Database (better-sqlite3 surface)
// ════════════════════════════════════════════════════════════════════════

/** Minimal prepared-statement interface matching better-sqlite3. */
export interface SqliteStatement<TRow = unknown> {
  get(...params: unknown[]): TRow | undefined;
  all(...params: unknown[]): TRow[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  iterate(...params: unknown[]): IterableIterator<TRow>;
  raw(toggle?: boolean): this;
}

/** Minimal database interface matching the better-sqlite3 surface we use. */
export interface BetterSqlite3Database {
  prepare<TRow = unknown>(sql: string): SqliteStatement<TRow>;
  exec(sql: string): this;
  close(): void;
  pragma(sql: string): unknown;
  transaction<F extends (...args: any[]) => any>(
    fn: F,
  ): (...args: F extends (...a: infer A) => unknown ? A : never) => ReturnType<F>;
  readonly open: boolean;
  readonly name: string;
}

/** WeakMap-based statement cache: one prepared statement per db instance. */
export type StmtCache<TRow = unknown> = WeakMap<BetterSqlite3Database, SqliteStatement<TRow>>;

// ════════════════════════════════════════════════════════════════════════
// §22  Native Addon (napi-rs FFI boundary)
// ════════════════════════════════════════════════════════════════════════

/** The native napi-rs addon interface (crates/codegraph-core). */
export interface NativeAddon {
  parseFile(filePath: string, source: string, dataflow: boolean, ast: boolean): unknown;
  parseFiles(files: string[], rootDir: string, dataflow: boolean, ast: boolean): unknown[];
  resolveImport(fromFile: string, importSource: string, rootDir: string, aliases: unknown): string;
  resolveImports(
    items: Array<{ fromFile: string; importSource: string }>,
    rootDir: string,
    aliases: unknown,
    knownFiles: string[] | null,
  ): Array<{ fromFile: string; importSource: string; resolvedPath: string }>;
  computeConfidence(callerFile: string, targetFile: string, importedFrom: string | null): number;
  detectCycles(edges: Array<{ source: string; target: string }>): string[][];
  buildCallEdges(files: unknown[], nodes: unknown[], builtinReceivers: string[]): unknown[];
  bulkInsertAstNodes(
    dbPath: string,
    batches: Array<{
      file: string;
      nodes: Array<{
        line: number;
        kind: string;
        name: string;
        text?: string | null;
        receiver?: string | null;
      }>;
    }>,
  ): number;
  bulkInsertNodes(
    dbPath: string,
    batches: Array<{
      file: string;
      definitions: Array<{
        name: string;
        kind: string;
        line: number;
        endLine?: number | null;
        visibility?: string | null;
        children: Array<{
          name: string;
          kind: string;
          line: number;
          endLine?: number | null;
          visibility?: string | null;
        }>;
      }>;
      exports: Array<{ name: string; kind: string; line: number }>;
    }>,
    fileHashes: Array<{ file: string; hash: string; mtime: number; size: number }>,
    removedFiles: string[],
  ): boolean;
  bulkInsertCfg(
    dbPath: string,
    batches: Array<{
      name: string;
      file: string;
      line: number;
      blocks: Array<{
        index: number;
        type: string;
        startLine?: number | null;
        endLine?: number | null;
        label?: string | null;
      }>;
      edges: Array<{
        sourceIndex: number;
        targetIndex: number;
        kind: string;
      }>;
    }>,
  ): number;
  bulkInsertDataflow(
    dbPath: string,
    batches: Array<{
      file: string;
      edges: Array<{
        sourceName: string;
        targetName: string;
        kind: string;
        paramIndex?: number | null;
        expression?: string | null;
        line?: number | null;
        confidence: number;
      }>;
    }>,
  ): number;
  engineVersion(): string;
  ParseTreeCache: new () => NativeParseTreeCache;
}

/** Native parse-tree cache instance. */
export interface NativeParseTreeCache {
  get(filePath: string): unknown;
  set(filePath: string, tree: unknown): void;
  delete(filePath: string): void;
  clear(): void;
}

// ════════════════════════════════════════════════════════════════════════
// §14  CLI Command Framework
// ════════════════════════════════════════════════════════════════════════

/** Shared context passed to every CLI command's execute/validate functions. */
export interface CommandContext {
  config: Record<string, any>;
  resolveNoTests: (opts: any) => boolean;
  resolveQueryOpts: (opts: any) => any;
  formatSize: (bytes: number) => string;
  outputResult: (data: any, key: string, opts: any) => boolean;
  program: import('commander').Command;
}

/** Shape of a CLI command definition used by the registerCommand framework. */
export interface CommandDefinition {
  name: string;
  description: string;
  queryOpts?: boolean;
  options?: Array<
    | [string, string]
    | [string, string, string | boolean | number]
    | [string, string, (val: string) => any, string | boolean | number]
  >;
  validate?: (args: any[], opts: any, ctx: CommandContext) => string | undefined;
  execute?: (args: any[], opts: any, ctx: CommandContext) => void | Promise<void>;
  subcommands?: CommandDefinition[];
}
