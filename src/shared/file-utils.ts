import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGE_REGISTRY } from '../domain/parser.js';
import { debug } from '../infrastructure/logger.js';

/**
 * Resolve a file path relative to repoRoot, rejecting traversal outside the repo.
 * Returns null if the resolved path escapes repoRoot.
 */
export function safePath(repoRoot: string, file: string): string | null {
  const resolved = path.resolve(repoRoot, file);
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) return null;
  return resolved;
}

interface ReadSourceRangeOpts {
  excerptLines?: number;
}

export function readSourceRange(
  repoRoot: string,
  file: string,
  startLine: number | undefined,
  endLine: number | undefined,
  opts: ReadSourceRangeOpts = {},
): string | null {
  try {
    const absPath = safePath(repoRoot, file);
    if (!absPath) return null;
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const excerptLines = opts.excerptLines ?? 50;
    const start = Math.max(0, (startLine || 1) - 1);
    const end = Math.min(lines.length, endLine || (startLine || 1) + excerptLines);
    return lines.slice(start, end).join('\n');
  } catch (e: unknown) {
    debug(`readSourceRange failed for ${file}: ${(e as Error).message}`);
    return null;
  }
}

interface ExtractSummaryOpts {
  jsdocEndScanLines?: number;
  jsdocOpenScanLines?: number;
  summaryMaxChars?: number;
}

export function extractSummary(
  fileLines: string[] | null,
  line: number | undefined,
  opts: ExtractSummaryOpts = {},
): string | null {
  if (!fileLines || !line || line <= 1) return null;
  const idx = line - 2; // line above the definition (0-indexed)
  const jsdocEndScanLines = opts.jsdocEndScanLines ?? 10;
  const jsdocOpenScanLines = opts.jsdocOpenScanLines ?? 20;
  const summaryMaxChars = opts.summaryMaxChars ?? 100;
  // Scan up for JSDoc or comment
  let jsdocEnd = -1;
  for (let i = idx; i >= Math.max(0, idx - jsdocEndScanLines); i--) {
    const trimmed = fileLines[i]!.trim();
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
      return text.length > summaryMaxChars ? `${text.slice(0, summaryMaxChars)}...` : text;
    }
    if (trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break;
  }
  if (jsdocEnd >= 0) {
    // Find opening /**
    for (let i = jsdocEnd; i >= Math.max(0, jsdocEnd - jsdocOpenScanLines); i--) {
      if (fileLines[i]!.trim().startsWith('/**')) {
        // Extract first non-tag, non-empty line
        for (let j = i + 1; j <= jsdocEnd; j++) {
          const docLine = fileLines[j]!.trim()
            .replace(/^\*\s?/, '')
            .trim();
          if (docLine && !docLine.startsWith('@') && docLine !== '/' && docLine !== '*/') {
            return docLine.length > summaryMaxChars
              ? `${docLine.slice(0, summaryMaxChars)}...`
              : docLine;
          }
        }
        break;
      }
    }
  }
  return null;
}

interface ExtractSignatureOpts {
  signatureGatherLines?: number;
}

interface Signature {
  params: string | null;
  returnType: string | null;
}

export function extractSignature(
  fileLines: string[] | null,
  line: number | undefined,
  opts: ExtractSignatureOpts = {},
): Signature | null {
  if (!fileLines || !line) return null;
  const idx = line - 1;
  const signatureGatherLines = opts.signatureGatherLines ?? 5;
  // Gather lines to handle multi-line params
  const chunk = fileLines
    .slice(idx, Math.min(fileLines.length, idx + signatureGatherLines))
    .join('\n');

  // JS/TS: function name(params) or (params) => or async function
  let m = chunk.match(
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w*\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?/,
  );
  if (m) {
    return {
      params: m[1]!.trim() || null,
      returnType: m[2] ? m[2].trim().replace(/\s*\{$/, '') : null,
    };
  }
  // Arrow: const name = (params) => or (params):ReturnType =>
  m = chunk.match(/=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>\n{]+))?\s*=>/);
  if (m) {
    return {
      params: m[1]!.trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Python: def name(params) -> return:
  m = chunk.match(/def\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^:\n]+))?/);
  if (m) {
    return {
      params: m[1]!.trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Go: func (recv) name(params) (returns)
  m = chunk.match(/func\s+(?:\([^)]*\)\s+)?\w+\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|(\w[^\n{]*))?/);
  if (m) {
    return {
      params: m[1]!.trim() || null,
      returnType: (m[2] || m[3] || '').trim() || null,
    };
  }
  // Rust: fn name(params) -> ReturnType
  m = chunk.match(/fn\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^\n{]+))?/);
  if (m) {
    return {
      params: m[1]!.trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  return null;
}

export function createFileLinesReader(repoRoot: string): (file: string) => string[] | null {
  const cache = new Map<string, string[] | null>();
  return function getFileLines(file: string): string[] | null {
    if (cache.has(file)) return cache.get(file)!;
    try {
      const absPath = safePath(repoRoot, file);
      if (!absPath) {
        cache.set(file, null);
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      cache.set(file, lines);
      return lines;
    } catch (e: unknown) {
      debug(`getFileLines failed for ${file}: ${(e as Error).message}`);
      cache.set(file, null);
      return null;
    }
  };
}

export function isFileLikeTarget(target: string): boolean {
  if (target.includes('/') || target.includes('\\')) return true;
  const ext = path.extname(target).toLowerCase();
  if (!ext) return false;
  for (const entry of LANGUAGE_REGISTRY) {
    if (entry.extensions.includes(ext)) return true;
  }
  return false;
}
