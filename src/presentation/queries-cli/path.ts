import { filePathData, kindIcon, pathData } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

interface PathCandidate {
  name: string;
  file: string;
  line: number;
}

interface PathStep {
  kind: string;
  name: string;
  file: string;
  line: number;
  edgeKind?: string;
}

interface PathDataResult {
  error?: string;
  found?: boolean;
  hops?: number;
  reverse?: boolean;
  maxDepth?: number;
  path: PathStep[];
  fromCandidates: PathCandidate[];
  toCandidates: PathCandidate[];
  alternateCount: number;
}

interface PathOpts {
  json?: boolean;
  ndjson?: boolean;
  csv?: boolean;
  table?: boolean;
  noTests?: boolean;
  reverse?: boolean;
  maxDepth?: number;
  file?: string;
  kind?: string;
  [key: string]: unknown;
}

function printNotFound(from: string, to: string, data: PathDataResult): void {
  const dir = data.reverse ? 'reverse ' : '';
  console.log(`No ${dir}path from "${from}" to "${to}" within ${data.maxDepth} hops.`);
  if (data.fromCandidates.length > 1) {
    console.log(
      `\n  "${from}" matched ${data.fromCandidates.length} symbols — using top match: ${data.fromCandidates[0]!.name} (${data.fromCandidates[0]!.file}:${data.fromCandidates[0]!.line})`,
    );
  }
  if (data.toCandidates.length > 1) {
    console.log(
      `  "${to}" matched ${data.toCandidates.length} symbols — using top match: ${data.toCandidates[0]!.name} (${data.toCandidates[0]!.file}:${data.toCandidates[0]!.line})`,
    );
  }
}

function printPathSteps(data: PathDataResult): void {
  for (let i = 0; i < data.path.length; i++) {
    const n = data.path[i]!;
    const indent = '  '.repeat(i + 1);
    if (i === 0) {
      console.log(`${indent}${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`);
    } else {
      console.log(
        `${indent}--[${n.edgeKind}]--> ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`,
      );
    }
  }
  if (data.alternateCount > 0) {
    console.log(
      `\n  (${data.alternateCount} alternate shortest ${data.alternateCount === 1 ? 'path' : 'paths'} at same depth)`,
    );
  }
}

export function symbolPath(
  from: string,
  to: string,
  customDbPath: string,
  opts: PathOpts = {},
): void {
  if (opts.file) {
    filePath(from, to, customDbPath, opts);
    return;
  }

  const data = pathData(from, to, customDbPath, opts) as PathDataResult;
  if (outputResult(data as unknown as Record<string, unknown>, null, opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }

  if (!data.found) {
    printNotFound(from, to, data);
    return;
  }

  if (data.hops === 0) {
    console.log(`\n"${from}" and "${to}" resolve to the same symbol (0 hops):`);
    const n = data.path[0]!;
    console.log(`  ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}\n`);
    return;
  }

  const dir = data.reverse ? ' (reverse)' : '';
  console.log(
    `\nPath from ${from} to ${to} (${data.hops} ${data.hops === 1 ? 'hop' : 'hops'})${dir}:\n`,
  );
  printPathSteps(data);
  console.log();
}

// ── File-level path ──────────────────────────────────────────────────────

interface FilePathDataResult {
  error?: string;
  found?: boolean;
  hops?: number | null;
  reverse?: boolean;
  maxDepth?: number;
  path: string[];
  fromCandidates: string[];
  toCandidates: string[];
  alternateCount: number;
}

function printFilePathNotFound(from: string, to: string, data: FilePathDataResult): void {
  const dir = data.reverse ? 'reverse ' : '';
  console.log(`No ${dir}file path from "${from}" to "${to}" within ${data.maxDepth} hops.`);
  if (data.fromCandidates.length > 1) {
    console.log(
      `\n  "${from}" matched ${data.fromCandidates.length} files — using: ${data.fromCandidates[0]}`,
    );
  }
  if (data.toCandidates.length > 1) {
    console.log(
      `  "${to}" matched ${data.toCandidates.length} files — using: ${data.toCandidates[0]}`,
    );
  }
}

function printFilePathSteps(data: FilePathDataResult): void {
  for (let i = 0; i < data.path.length; i++) {
    const indent = '  '.repeat(i + 1);
    if (i === 0) {
      console.log(`${indent}${data.path[i]}`);
    } else {
      console.log(`${indent}→ ${data.path[i]}`);
    }
  }
  if (data.alternateCount > 0) {
    console.log(
      `\n  (${data.alternateCount} alternate shortest ${data.alternateCount === 1 ? 'path' : 'paths'} at same depth)`,
    );
  }
}

function filePath(from: string, to: string, customDbPath: string, opts: PathOpts = {}): void {
  const data = filePathData(from, to, customDbPath, opts) as FilePathDataResult;
  if (outputResult(data as unknown as Record<string, unknown>, null, opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }

  if (!data.found) {
    printFilePathNotFound(from, to, data);
    return;
  }

  if (data.hops === 0) {
    console.log(`\n"${from}" and "${to}" resolve to the same file (0 hops):`);
    console.log(`  ${data.path[0]}\n`);
    return;
  }

  const dir = data.reverse ? ' (reverse)' : '';
  console.log(
    `\nFile path from ${from} to ${to} (${data.hops} ${data.hops === 1 ? 'hop' : 'hops'})${dir}:\n`,
  );
  printFilePathSteps(data);
  console.log();
}
