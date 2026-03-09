/**
 * Pure metric computations extracted from complexity.js.
 *
 * Contains Halstead derived metrics, LOC metrics, and Maintainability Index —
 * all stateless math that can be reused by visitor-based and standalone paths.
 */

// ─── Halstead Derived Metrics ─────────────────────────────────────────────

/**
 * Compute Halstead derived metrics from raw operator/operand counts.
 *
 * @param {Map<string, number>} operators - operator type/text → count
 * @param {Map<string, number>} operands  - operand text → count
 * @returns {{ n1: number, n2: number, bigN1: number, bigN2: number, vocabulary: number, length: number, volume: number, difficulty: number, effort: number, bugs: number }}
 */
export function computeHalsteadDerived(operators, operands) {
  const n1 = operators.size;
  const n2 = operands.size;
  let bigN1 = 0;
  for (const c of operators.values()) bigN1 += c;
  let bigN2 = 0;
  for (const c of operands.values()) bigN2 += c;

  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (bigN2 / n2) : 0;
  const effort = difficulty * volume;
  const bugs = volume / 3000;

  return {
    n1,
    n2,
    bigN1,
    bigN2,
    vocabulary,
    length,
    volume: +volume.toFixed(2),
    difficulty: +difficulty.toFixed(2),
    effort: +effort.toFixed(2),
    bugs: +bugs.toFixed(4),
  };
}

// ─── LOC Metrics ──────────────────────────────────────────────────────────

const C_STYLE_PREFIXES = ['//', '/*', '*', '*/'];

const COMMENT_PREFIXES = new Map([
  ['javascript', C_STYLE_PREFIXES],
  ['typescript', C_STYLE_PREFIXES],
  ['tsx', C_STYLE_PREFIXES],
  ['go', C_STYLE_PREFIXES],
  ['rust', C_STYLE_PREFIXES],
  ['java', C_STYLE_PREFIXES],
  ['csharp', C_STYLE_PREFIXES],
  ['python', ['#']],
  ['ruby', ['#']],
  ['php', ['//', '#', '/*', '*', '*/']],
]);

/**
 * Compute LOC metrics from a function node's source text.
 *
 * @param {object} functionNode - tree-sitter node
 * @param {string} [language] - Language ID (falls back to C-style prefixes)
 * @returns {{ loc: number, sloc: number, commentLines: number }}
 */
export function computeLOCMetrics(functionNode, language) {
  const text = functionNode.text;
  const lines = text.split('\n');
  const loc = lines.length;
  const prefixes = (language && COMMENT_PREFIXES.get(language)) || C_STYLE_PREFIXES;

  let commentLines = 0;
  let blankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      blankLines++;
    } else if (prefixes.some((p) => trimmed.startsWith(p))) {
      commentLines++;
    }
  }

  const sloc = Math.max(1, loc - blankLines - commentLines);
  return { loc, sloc, commentLines };
}

// ─── Maintainability Index ────────────────────────────────────────────────

/**
 * Compute normalized Maintainability Index (0-100 scale).
 *
 * Original SEI formula: MI = 171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC) + 50*sin(sqrt(2.4*CM))
 * Microsoft normalization: max(0, min(100, MI * 100/171))
 *
 * @param {number} volume - Halstead volume
 * @param {number} cyclomatic - Cyclomatic complexity
 * @param {number} sloc - Source lines of code
 * @param {number} [commentRatio] - Comment ratio (0-1), optional
 * @returns {number} Normalized MI (0-100)
 */
export function computeMaintainabilityIndex(volume, cyclomatic, sloc, commentRatio) {
  const safeVolume = Math.max(volume, 1);
  const safeSLOC = Math.max(sloc, 1);

  let mi = 171 - 5.2 * Math.log(safeVolume) - 0.23 * cyclomatic - 16.2 * Math.log(safeSLOC);

  if (commentRatio != null && commentRatio > 0) {
    mi += 50 * Math.sin(Math.sqrt(2.4 * commentRatio));
  }

  const normalized = Math.max(0, Math.min(100, (mi * 100) / 171));
  return +normalized.toFixed(1);
}
