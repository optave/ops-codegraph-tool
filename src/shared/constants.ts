import path from 'node:path';
import { SUPPORTED_EXTENSIONS } from '../domain/parser.js';

export const IGNORE_DIRS: Set<string> = new Set([
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
]);

export { SUPPORTED_EXTENSIONS as EXTENSIONS };

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
