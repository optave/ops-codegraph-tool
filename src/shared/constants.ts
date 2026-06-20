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

export const EXTENSIONS: ArrayCompatSet<string> = withArrayCompat(new Set(SUPPORTED_EXTENSIONS));

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
