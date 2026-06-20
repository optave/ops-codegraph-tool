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
    // Rust workspace convention — contains only Rust source and NAPI-RS generated
    // binding artifacts (index.js / index.d.ts) that produce false complexity readings.
    'crates',
  ]),
);

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
