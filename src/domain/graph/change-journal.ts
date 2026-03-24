import fs from 'node:fs';
import path from 'node:path';
import { debug, warn } from '../../infrastructure/logger.js';

export const CHANGE_EVENTS_FILENAME = 'change-events.ndjson';
export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

export function changeEventsPath(rootDir: string): string {
  return path.join(rootDir, '.codegraph', CHANGE_EVENTS_FILENAME);
}

interface SymbolEntry {
  name: string;
  kind: string;
  line: number;
}

interface SymbolDiff {
  added: Array<{ name: string; kind: string; line: number }>;
  removed: Array<{ name: string; kind: string }>;
  modified: Array<{ name: string; kind: string; line: number }>;
}

export function diffSymbols(oldSymbols: SymbolEntry[], newSymbols: SymbolEntry[]): SymbolDiff {
  const oldMap = new Map<string, SymbolEntry>();
  for (const s of oldSymbols) {
    oldMap.set(`${s.name}\0${s.kind}`, s);
  }

  const newMap = new Map<string, SymbolEntry>();
  for (const s of newSymbols) {
    newMap.set(`${s.name}\0${s.kind}`, s);
  }

  const added: SymbolDiff['added'] = [];
  const removed: SymbolDiff['removed'] = [];
  const modified: SymbolDiff['modified'] = [];

  for (const [key, s] of newMap) {
    const old = oldMap.get(key);
    if (!old) {
      added.push({ name: s.name, kind: s.kind, line: s.line });
    } else if (old.line !== s.line) {
      modified.push({ name: s.name, kind: s.kind, line: s.line });
    }
  }

  for (const [key, s] of oldMap) {
    if (!newMap.has(key)) {
      removed.push({ name: s.name, kind: s.kind });
    }
  }

  return { added, removed, modified };
}

interface ChangeEvent {
  ts: string;
  file: string;
  event: string;
  symbols: unknown;
  counts: {
    nodes: { before: number; after: number };
    edges: { added: number };
  };
}

interface ChangeEventCounts {
  nodesBefore?: number;
  nodesAfter?: number;
  edgesAdded?: number;
}

export function buildChangeEvent(
  file: string,
  event: string,
  symbolDiff: unknown,
  counts: ChangeEventCounts,
): ChangeEvent {
  return {
    ts: new Date().toISOString(),
    file,
    event,
    symbols: symbolDiff,
    counts: {
      nodes: { before: counts.nodesBefore ?? 0, after: counts.nodesAfter ?? 0 },
      edges: { added: counts.edgesAdded ?? 0 },
    },
  };
}

export function appendChangeEvents(rootDir: string, events: ChangeEvent[]): void {
  const filePath = changeEventsPath(rootDir);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    fs.appendFileSync(filePath, lines);
    debug(`Appended ${events.length} change event(s) to ${filePath}`);
  } catch (err) {
    warn(`Failed to append change events: ${(err as Error).message}`);
    return;
  }

  try {
    rotateIfNeeded(filePath, DEFAULT_MAX_BYTES);
  } catch {
    /* rotation failure is non-fatal */
  }
}

export function rotateIfNeeded(filePath: string, maxBytes: number = DEFAULT_MAX_BYTES): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  if (stat.size <= maxBytes) return;

  try {
    const buf = fs.readFileSync(filePath);
    const mid = Math.floor(buf.length / 2);
    const newlineIdx = buf.indexOf(0x0a, mid);
    if (newlineIdx === -1) {
      warn(
        `Change events file exceeds ${maxBytes} bytes but contains no line breaks; skipping rotation`,
      );
      return;
    }
    const kept = buf.slice(newlineIdx + 1);
    fs.writeFileSync(filePath, kept);
    debug(`Rotated change events: ${stat.size} → ${kept.length} bytes`);
  } catch (err) {
    warn(`Failed to rotate change events: ${(err as Error).message}`);
  }
}
