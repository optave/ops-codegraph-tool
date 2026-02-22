import path from 'node:path';
import { SUPPORTED_EXTENSIONS } from './parser.js';

export const IGNORE_DIRS = new Set([
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

// Re-export as an indirect binding to avoid TDZ in the circular
// parser.js ↔ constants.js import (no value read at evaluation time).
export { SUPPORTED_EXTENSIONS as EXTENSIONS };

export function shouldIgnore(dirName) {
  return IGNORE_DIRS.has(dirName) || dirName.startsWith('.');
}

export function isSupportedFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath));
}

/**
 * Normalize a file path to always use forward slashes.
 * Ensures cross-platform consistency in the SQLite database.
 */
export function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}
