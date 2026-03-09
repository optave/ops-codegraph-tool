/**
 * Assembled rule maps for all AST analysis modules.
 *
 * Re-exports per-language rules as Maps keyed by language ID.
 */

import * as csharp from './csharp.js';
import * as go from './go.js';
import * as java from './java.js';
import * as javascript from './javascript.js';
import * as php from './php.js';
import * as python from './python.js';
import * as ruby from './ruby.js';
import * as rust from './rust.js';

// ─── Complexity Rules ─────────────────────────────────────────────────────

export const COMPLEXITY_RULES = new Map([
  ['javascript', javascript.complexity],
  ['typescript', javascript.complexity],
  ['tsx', javascript.complexity],
  ['python', python.complexity],
  ['go', go.complexity],
  ['rust', rust.complexity],
  ['java', java.complexity],
  ['csharp', csharp.complexity],
  ['ruby', ruby.complexity],
  ['php', php.complexity],
]);

// ─── Halstead Rules ───────────────────────────────────────────────────────

export const HALSTEAD_RULES = new Map([
  ['javascript', javascript.halstead],
  ['typescript', javascript.halstead],
  ['tsx', javascript.halstead],
  ['python', python.halstead],
  ['go', go.halstead],
  ['rust', rust.halstead],
  ['java', java.halstead],
  ['csharp', csharp.halstead],
  ['ruby', ruby.halstead],
  ['php', php.halstead],
]);

// ─── CFG Rules ────────────────────────────────────────────────────────────

export const CFG_RULES = new Map([
  ['javascript', javascript.cfg],
  ['typescript', javascript.cfg],
  ['tsx', javascript.cfg],
  ['python', python.cfg],
  ['go', go.cfg],
  ['rust', rust.cfg],
  ['java', java.cfg],
  ['csharp', csharp.cfg],
  ['ruby', ruby.cfg],
  ['php', php.cfg],
]);

// ─── Dataflow Rules ──────────────────────────────────────────────────────

export const DATAFLOW_RULES = new Map([
  ['javascript', javascript.dataflow],
  ['typescript', javascript.dataflow],
  ['tsx', javascript.dataflow],
  ['python', python.dataflow],
  ['go', go.dataflow],
  ['rust', rust.dataflow],
  ['java', java.dataflow],
  ['csharp', csharp.dataflow],
  ['php', php.dataflow],
  ['ruby', ruby.dataflow],
]);

// ─── AST Type Maps ───────────────────────────────────────────────────────

export const AST_TYPE_MAPS = new Map([
  ['javascript', javascript.astTypes],
  ['typescript', javascript.astTypes],
  ['tsx', javascript.astTypes],
]);
