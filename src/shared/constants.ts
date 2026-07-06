import path from 'node:path';
import { SUPPORTED_EXTENSIONS } from '../domain/parser.js';

/**
 * Set with a `.toArray()` convenience method for consumers migrating from
 * the pre-3.4 Array-based API (where `.includes()` / `.indexOf()` worked).
 */
export interface ArrayCompatSet<T> extends Set<T> {
  toArray(): T[];
}

function withArrayCompat<T>(s: Set<T>): ArrayCompatSet<T> {
  return Object.assign(s, { toArray: () => [...s] });
}

export const IGNORE_DIRS: ArrayCompatSet<string> = withArrayCompat(
  new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    '.codegraph',
    '__pycache__',
    '.tox',
    'vendor',
    '.venv',
    'venv',
    'env',
    '.env',
  ]),
);

/**
 * Merge the global IGNORE_DIRS set with a per-repo additional list from config.
 * Returns a new Set — does not mutate IGNORE_DIRS.
 */
export function buildIgnoreSet(additionalDirs?: string[]): ReadonlySet<string> {
  if (!additionalDirs || additionalDirs.length === 0) return IGNORE_DIRS;
  return new Set([...IGNORE_DIRS, ...additionalDirs]);
}

export const EXTENSIONS: ArrayCompatSet<string> = withArrayCompat(new Set(SUPPORTED_EXTENSIONS));

/**
 * Minimum confidence assigned to resolved `ts-native` call edges.
 *
 * The native engine's proximity heuristic returns 0.3 for cross-module calls
 * where no import-path evidence is available.  For ts-native edges the engine
 * performed actual name-based symbol lookup, which is stronger evidence than
 * pure file-proximity.  Clamping to 0.5 (same-parent-directory level) avoids
 * unfairly dragging down the call-confidence metric.  Sink edges
 * (confidence = 0.0) are intentionally excluded and must remain at 0.0 so
 * they stay below DEFAULT_MIN_CONFIDENCE and never surface in normal queries.
 *
 * Used in `build-edges.ts` (in-memory + `applyEdgeTechniquesAfterNativeInsert`)
 * and `native-orchestrator.ts` (`backfillEdgeTechniquesAfterNativeOrchestrator`).
 * Centralised here so all three insertion paths apply the same value.
 */
export const TS_NATIVE_CONFIDENCE_FLOOR = 0.5;

export function shouldIgnore(dirName: string): boolean {
  return IGNORE_DIRS.has(dirName) || dirName.startsWith('.');
}

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Normalize a file path to always use forward slashes.
 * Ensures cross-platform consistency in the SQLite database.
 */
export function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Walk every ancestor directory of each given file path (not just the direct
 * parent) and return the union across all files. Shared by the full
 * directory-structure build (`features/structure.ts`) and the incremental
 * fast path (`domain/graph/builder/stages/build-structure.ts`), which both
 * need to scope work to exactly the directories whose file composition may
 * have changed (#1738).
 */
export function getAncestorDirs(filePaths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const f of filePaths) {
    let d = normalizePath(path.dirname(f));
    while (d && d !== '.') {
      dirs.add(d);
      d = normalizePath(path.dirname(d));
    }
  }
  return dirs;
}
