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

/** Truncate text to maxChars, appending "..." if truncated. */
function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

/** Try to extract a single-line comment (// or #) above the definition. */
function extractSingleLineComment(
  fileLines: string[],
  idx: number,
  scanLines: number,
  maxChars: number,
): string | null {
  for (let i = idx; i >= Math.max(0, idx - scanLines); i--) {
    const trimmed = fileLines[i]!.trim();
    if (trimmed.endsWith('*/')) return null; // hit a block comment — defer to JSDoc extractor
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      const text = trimmed
        .replace(/^\/\/\s*/, '')
        .replace(/^#\s*/, '')
        .trim();
      return truncate(text, maxChars);
    }
    if (trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) return null;
  }
  return null;
}

/** Find the line index where a block comment (*​/) ends, scanning upward from idx. */
function findJsdocEndLine(fileLines: string[], idx: number, scanLines: number): number {
  for (let i = idx; i >= Math.max(0, idx - scanLines); i--) {
    const trimmed = fileLines[i]!.trim();
    if (trimmed.endsWith('*/')) return i;
    if (
      trimmed !== '' &&
      !trimmed.startsWith('*') &&
      !trimmed.startsWith('/*') &&
      !trimmed.startsWith('//') &&
      !trimmed.startsWith('#')
    ) {
      break;
    }
  }
  return -1;
}

/** Extract the first description line from a JSDoc block ending at jsdocEnd. */
function extractJsdocDescription(
  fileLines: string[],
  jsdocEnd: number,
  openScanLines: number,
  maxChars: number,
): string | null {
  for (let i = jsdocEnd; i >= Math.max(0, jsdocEnd - openScanLines); i--) {
    if (!fileLines[i]!.trim().startsWith('/**')) continue;
    for (let j = i + 1; j <= jsdocEnd; j++) {
      const docLine = fileLines[j]!.trim()
        .replace(/^\*\s?/, '')
        .trim();
      if (docLine && !docLine.startsWith('@') && docLine !== '/' && docLine !== '*/') {
        return truncate(docLine, maxChars);
      }
    }
    break;
  }
  return null;
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

  // Try single-line comment first
  const singleLine = extractSingleLineComment(fileLines, idx, jsdocEndScanLines, summaryMaxChars);
  if (singleLine) return singleLine;

  // Try JSDoc block comment
  const jsdocEnd = findJsdocEndLine(fileLines, idx, jsdocEndScanLines);
  if (jsdocEnd >= 0) {
    return extractJsdocDescription(fileLines, jsdocEnd, jsdocOpenScanLines, summaryMaxChars);
  }

  return null;
}

interface ExtractSignatureOpts {
  signatureGatherLines?: number;
}

export interface Signature {
  params: string | null;
  returnType: string | null;
}

/** Per-language signature patterns. Each entry has a regex and an extractor for return type. */
const SIGNATURE_PATTERNS: Array<{
  regex: RegExp;
  returnType: (m: RegExpMatchArray) => string | null;
}> = [
  // JS/TS: function name(params) or async function
  {
    regex: /(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w*\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?/,
    returnType: (m) => (m[2] ? m[2].trim().replace(/\s*\{$/, '') : null),
  },
  // Arrow: const name = (params) => or (params):ReturnType =>
  {
    regex: /=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>\n{]+))?\s*=>/,
    returnType: (m) => (m[2] ? m[2].trim() : null),
  },
  // Python: def name(params) -> return:
  {
    regex: /def\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^:\n]+))?/,
    returnType: (m) => (m[2] ? m[2].trim() : null),
  },
  // Go: func (recv) name(params) (returns)
  {
    regex: /func\s+(?:\([^)]*\)\s+)?\w+\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|(\w[^\n{]*))?/,
    returnType: (m) => (m[2] || m[3] || '').trim() || null,
  },
  // Rust: fn name(params) -> ReturnType
  {
    regex: /fn\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^\n{]+))?/,
    returnType: (m) => (m[2] ? m[2].trim() : null),
  },
];

export function extractSignature(
  fileLines: string[] | null,
  line: number | undefined,
  opts: ExtractSignatureOpts = {},
): Signature | null {
  if (!fileLines || !line) return null;
  const idx = line - 1;
  const signatureGatherLines = opts.signatureGatherLines ?? 5;
  const chunk = fileLines
    .slice(idx, Math.min(fileLines.length, idx + signatureGatherLines))
    .join('\n');

  for (const pattern of SIGNATURE_PATTERNS) {
    const m = chunk.match(pattern.regex);
    if (m) {
      return {
        params: m[1]!.trim() || null,
        returnType: pattern.returnType(m),
      };
    }
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
