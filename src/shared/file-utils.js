import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGE_REGISTRY } from '../domain/parser.js';
import { debug } from '../infrastructure/logger.js';

/**
 * Resolve a file path relative to repoRoot, rejecting traversal outside the repo.
 * Returns null if the resolved path escapes repoRoot.
 */
export function safePath(repoRoot, file) {
  const resolved = path.resolve(repoRoot, file);
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) return null;
  return resolved;
}

export function readSourceRange(repoRoot, file, startLine, endLine) {
  try {
    const absPath = safePath(repoRoot, file);
    if (!absPath) return null;
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (startLine || 1) - 1);
    const end = Math.min(lines.length, endLine || startLine + 50);
    return lines.slice(start, end).join('\n');
  } catch (e) {
    debug(`readSourceRange failed for ${file}: ${e.message}`);
    return null;
  }
}

export function extractSummary(fileLines, line) {
  if (!fileLines || !line || line <= 1) return null;
  const idx = line - 2; // line above the definition (0-indexed)
  // Scan up to 10 lines above for JSDoc or comment
  let jsdocEnd = -1;
  for (let i = idx; i >= Math.max(0, idx - 10); i--) {
    const trimmed = fileLines[i].trim();
    if (trimmed.endsWith('*/')) {
      jsdocEnd = i;
      break;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      // Single-line comment immediately above
      const text = trimmed
        .replace(/^\/\/\s*/, '')
        .replace(/^#\s*/, '')
        .trim();
      return text.length > 100 ? `${text.slice(0, 100)}...` : text;
    }
    if (trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break;
  }
  if (jsdocEnd >= 0) {
    // Find opening /**
    for (let i = jsdocEnd; i >= Math.max(0, jsdocEnd - 20); i--) {
      if (fileLines[i].trim().startsWith('/**')) {
        // Extract first non-tag, non-empty line
        for (let j = i + 1; j <= jsdocEnd; j++) {
          const docLine = fileLines[j]
            .trim()
            .replace(/^\*\s?/, '')
            .trim();
          if (docLine && !docLine.startsWith('@') && docLine !== '/' && docLine !== '*/') {
            return docLine.length > 100 ? `${docLine.slice(0, 100)}...` : docLine;
          }
        }
        break;
      }
    }
  }
  return null;
}

export function extractSignature(fileLines, line) {
  if (!fileLines || !line) return null;
  const idx = line - 1;
  // Gather up to 5 lines to handle multi-line params
  const chunk = fileLines.slice(idx, Math.min(fileLines.length, idx + 5)).join('\n');

  // JS/TS: function name(params) or (params) => or async function
  let m = chunk.match(
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w*\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?/,
  );
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim().replace(/\s*\{$/, '') : null,
    };
  }
  // Arrow: const name = (params) => or (params):ReturnType =>
  m = chunk.match(/=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>\n{]+))?\s*=>/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Python: def name(params) -> return:
  m = chunk.match(/def\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^:\n]+))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Go: func (recv) name(params) (returns)
  m = chunk.match(/func\s+(?:\([^)]*\)\s+)?\w+\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|(\w[^\n{]*))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: (m[2] || m[3] || '').trim() || null,
    };
  }
  // Rust: fn name(params) -> ReturnType
  m = chunk.match(/fn\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^\n{]+))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  return null;
}

export function createFileLinesReader(repoRoot) {
  const cache = new Map();
  return function getFileLines(file) {
    if (cache.has(file)) return cache.get(file);
    try {
      const absPath = safePath(repoRoot, file);
      if (!absPath) {
        cache.set(file, null);
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      cache.set(file, lines);
      return lines;
    } catch (e) {
      debug(`getFileLines failed for ${file}: ${e.message}`);
      cache.set(file, null);
      return null;
    }
  };
}

export function isFileLikeTarget(target) {
  if (target.includes('/') || target.includes('\\')) return true;
  const ext = path.extname(target).toLowerCase();
  if (!ext) return false;
  for (const entry of LANGUAGE_REGISTRY) {
    if (entry.extensions.includes(ext)) return true;
  }
  return false;
}
