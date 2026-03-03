import fs from 'node:fs';
import path from 'node:path';
import { warn } from './logger.js';

export const CHANGE_EVENTS_FILENAME = 'change-events.ndjson';
export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Returns the absolute path to the NDJSON change events file.
 */
export function changeEventsPath(rootDir) {
  return path.join(rootDir, '.codegraph', CHANGE_EVENTS_FILENAME);
}

/**
 * Compare old and new symbol arrays, returning added/removed/modified sets.
 * Symbols are keyed on `name\0kind`. A symbol is "modified" if the same
 * name+kind exists in both but the line changed.
 *
 * @param {Array<{name:string, kind:string, line:number}>} oldSymbols
 * @param {Array<{name:string, kind:string, line:number}>} newSymbols
 * @returns {{ added: Array, removed: Array, modified: Array }}
 */
export function diffSymbols(oldSymbols, newSymbols) {
  const oldMap = new Map();
  for (const s of oldSymbols) {
    oldMap.set(`${s.name}\0${s.kind}`, s);
  }

  const newMap = new Map();
  for (const s of newSymbols) {
    newMap.set(`${s.name}\0${s.kind}`, s);
  }

  const added = [];
  const removed = [];
  const modified = [];

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

/**
 * Assemble a single change event object.
 */
export function buildChangeEvent(file, event, symbolDiff, counts) {
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

/**
 * Append change events as NDJSON lines to the change events file.
 * Creates the .codegraph directory if needed. Non-fatal on failure.
 */
export function appendChangeEvents(rootDir, events) {
  const filePath = changeEventsPath(rootDir);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    fs.appendFileSync(filePath, lines);
  } catch (err) {
    warn(`Failed to append change events: ${err.message}`);
    return;
  }

  try {
    rotateIfNeeded(filePath, DEFAULT_MAX_BYTES);
  } catch {
    /* rotation failure is non-fatal */
  }
}

/**
 * If the file exceeds maxBytes, keep the last ~half by finding
 * the first newline at or after the midpoint and rewriting from there.
 */
export function rotateIfNeeded(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return; // file doesn't exist, nothing to rotate
  }

  if (stat.size <= maxBytes) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const mid = Math.floor(content.length / 2);
    const newlineIdx = content.indexOf('\n', mid);
    if (newlineIdx === -1) return; // single huge line, can't split
    fs.writeFileSync(filePath, content.slice(newlineIdx + 1));
  } catch (err) {
    warn(`Failed to rotate change events: ${err.message}`);
  }
}
