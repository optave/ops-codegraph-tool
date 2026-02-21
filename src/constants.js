import path from 'path';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'coverage', '.codegraph', '__pycache__', '.tox', 'vendor', '.venv', 'venv',
  'env', '.env'
]);

export const EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.tf', '.hcl', '.py',
  '.go', '.rs', '.java',
  '.cs', '.rb', '.php'
]);

export function shouldIgnore(dirName) {
  return IGNORE_DIRS.has(dirName) || dirName.startsWith('.');
}

export function isSupportedFile(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

/**
 * Normalize a file path to always use forward slashes.
 * Ensures cross-platform consistency in the SQLite database.
 */
export function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}
