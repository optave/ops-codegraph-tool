import { diffImpactData } from '../domain/analysis/diff-impact.js';

interface MermaidNodeRegistry {
  nodeIdMap: Map<string, string>;
  nodeLabels: Map<string, string>;
  counter: number;
}

interface ImpactEdgeSets {
  allEdges: Set<string>;
  edgeFromNodes: Set<string>;
  edgeToNodes: Set<string>;
  changedKeys: Set<string>;
}

function createNodeRegistry(): MermaidNodeRegistry {
  return { nodeIdMap: new Map(), nodeLabels: new Map(), counter: 0 };
}

function registerNode(reg: MermaidNodeRegistry, key: string, label?: string): string {
  if (!reg.nodeIdMap.has(key)) {
    reg.nodeIdMap.set(key, `n${reg.counter++}`);
    if (label) reg.nodeLabels.set(key, label);
  }
  return reg.nodeIdMap.get(key)!;
}

function registerAllNodes(reg: MermaidNodeRegistry, affectedFunctions: any[]): void {
  for (const fn of affectedFunctions) {
    registerNode(reg, `${fn.file}::${fn.name}:${fn.line}`, fn.name);
    for (const callers of Object.values(fn.levels || {})) {
      for (const c of callers as Array<{ name: string; file: string; line: number }>) {
        registerNode(reg, `${c.file}::${c.name}:${c.line}`, c.name);
      }
    }
  }
}

function collectEdges(affectedFunctions: any[]): ImpactEdgeSets {
  const allEdges = new Set<string>();
  const edgeFromNodes = new Set<string>();
  const edgeToNodes = new Set<string>();
  const changedKeys = new Set<string>();

  for (const fn of affectedFunctions) {
    changedKeys.add(`${fn.file}::${fn.name}:${fn.line}`);
    for (const edge of fn.edges || []) {
      const edgeKey = `${edge.from}|${edge.to}`;
      if (!allEdges.has(edgeKey)) {
        allEdges.add(edgeKey);
        edgeFromNodes.add(edge.from);
        edgeToNodes.add(edge.to);
      }
    }
  }

  return { allEdges, edgeFromNodes, edgeToNodes, changedKeys };
}

function classifyCallerNodes(edges: ImpactEdgeSets): {
  blastRadiusKeys: Set<string>;
  intermediateKeys: Set<string>;
} {
  const blastRadiusKeys = new Set<string>();
  for (const key of edges.edgeToNodes) {
    if (!edges.edgeFromNodes.has(key) && !edges.changedKeys.has(key)) {
      blastRadiusKeys.add(key);
    }
  }

  const intermediateKeys = new Set<string>();
  for (const key of edges.edgeToNodes) {
    if (!edges.changedKeys.has(key) && !blastRadiusKeys.has(key)) {
      intermediateKeys.add(key);
    }
  }

  return { blastRadiusKeys, intermediateKeys };
}

function emitFileSubgraphs(
  lines: string[],
  affectedFunctions: any[],
  newFileSet: Set<string>,
  reg: MermaidNodeRegistry,
): number {
  const fileGroups = new Map<string, any[]>();
  for (const fn of affectedFunctions) {
    if (!fileGroups.has(fn.file)) fileGroups.set(fn.file, []);
    fileGroups.get(fn.file)!.push(fn);
  }

  let sgCounter = 0;
  for (const [file, fns] of fileGroups) {
    const isNew = newFileSet.has(file);
    const tag = isNew ? 'new' : 'modified';
    const sgId = `sg${sgCounter++}`;
    lines.push(`    subgraph ${sgId}["${file} **(${tag})**"]`);
    for (const fn of fns) {
      const key = `${fn.file}::${fn.name}:${fn.line}`;
      lines.push(`        ${reg.nodeIdMap.get(key)}["${fn.name}"]`);
    }
    lines.push('    end');
    const style = isNew ? 'fill:#e8f5e9,stroke:#4caf50' : 'fill:#fff3e0,stroke:#ff9800';
    lines.push(`    style ${sgId} ${style}`);
  }

  return sgCounter;
}

function emitBlastRadiusSubgraph(
  lines: string[],
  blastRadiusKeys: Set<string>,
  reg: MermaidNodeRegistry,
  sgCounter: number,
): void {
  if (blastRadiusKeys.size === 0) return;
  const sgId = `sg${sgCounter}`;
  lines.push(`    subgraph ${sgId}["Callers **(blast radius)**"]`);
  for (const key of blastRadiusKeys) {
    lines.push(`        ${reg.nodeIdMap.get(key)}["${reg.nodeLabels.get(key)}"]`);
  }
  lines.push('    end');
  lines.push(`    style ${sgId} fill:#f3e5f5,stroke:#9c27b0`);
}

export function diffImpactMermaid(
  customDbPath: string,
  opts: {
    noTests?: boolean;
    depth?: number;
    staged?: boolean;
    ref?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
    config?: any;
  } = {},
): string {
  const data: any = diffImpactData(customDbPath, opts);
  if ('error' in data) return data.error as string;
  if (data.changedFiles === 0 || data.affectedFunctions.length === 0) {
    return 'flowchart TB\n    none["No impacted functions detected"]';
  }

  const newFileSet = new Set<string>(data.newFiles || []);
  const lines = ['flowchart TB'];

  const reg = createNodeRegistry();
  registerAllNodes(reg, data.affectedFunctions);

  const edges = collectEdges(data.affectedFunctions);
  const { blastRadiusKeys, intermediateKeys } = classifyCallerNodes(edges);

  const sgCounter = emitFileSubgraphs(lines, data.affectedFunctions, newFileSet, reg);

  for (const key of intermediateKeys) {
    lines.push(`    ${reg.nodeIdMap.get(key)}["${reg.nodeLabels.get(key)}"]`);
  }

  emitBlastRadiusSubgraph(lines, blastRadiusKeys, reg, sgCounter);

  for (const edgeKey of edges.allEdges) {
    const [from, to] = edgeKey.split('|') as [string, string];
    lines.push(`    ${reg.nodeIdMap.get(from)} --> ${reg.nodeIdMap.get(to)}`);
  }

  return lines.join('\n');
}
