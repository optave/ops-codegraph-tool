/**
 * Shared renderers for the "Calls" / "Called by" / "Tests" sections rendered by
 * both `codegraph audit` (presentation/audit.js) and `codegraph explain`/`codegraph query`
 * (presentation/queries-cli/inspect.js — `audit --quick` is an alias for `explain`).
 *
 * Both commands render these sections from the same underlying shape and must stay
 * visually identical — this module is the single source of truth for that format.
 */

import { kindIcon } from '../domain/queries.js';

/** A single call reference rendered under the "Calls"/"Called by" sections. */
export interface CallRefLike {
  name: string;
  kind: string;
  file: string;
  line: number;
}

/** A single related-test-file reference rendered under the "Tests" section. */
export interface RelatedTestRefLike {
  file: string;
}

export interface RenderCallRefsSectionOpts {
  /**
   * Indent prefix applied to every printed line. Used by `explain`'s recursive
   * dependency rendering; top-level callers (e.g. `codegraph audit`) omit this
   * and get the sensible default of no indent.
   * Default: ''.
   */
  indent?: string;
}

/**
 * Render a single labeled call-reference list — used for both the "Calls" and
 * "Called by" sections (same shape, different label):
 *
 *   {indent}  Calls (2):
 *   {indent}    f parse  src/p.ts:1
 *   {indent}    m Parser.run  src/p.ts:20
 *
 * Prints nothing when `refs` is empty (see `renderNoCallEdgesFallback` for the
 * combined "no edges at all" message).
 */
export function renderCallRefsSection(
  label: string,
  refs: CallRefLike[],
  opts: RenderCallRefsSectionOpts = {},
): void {
  if (refs.length === 0) return;
  const { indent = '' } = opts;
  console.log(`\n${indent}  ${label} (${refs.length}):`);
  for (const c of refs) {
    console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
  }
}

export interface RenderNoCallEdgesFallbackOpts {
  /** Indent prefix applied to the printed line. Default: ''. */
  indent?: string;
}

/**
 * Print the "no call edges" fallback line when a function has neither callers
 * nor callees. Call this once, after rendering both the "Calls" and "Called by"
 * sections (which print nothing individually when empty) — it no-ops unless
 * both counts are zero.
 */
export function renderNoCallEdgesFallback(
  calleeCount: number,
  callerCount: number,
  opts: RenderNoCallEdgesFallbackOpts = {},
): void {
  if (calleeCount > 0 || callerCount > 0) return;
  const { indent = '' } = opts;
  console.log(`${indent}  (no call edges found -- may be invoked dynamically or via re-exports)`);
}

export interface RenderRelatedTestsSectionOpts {
  /** Indent prefix applied to every printed line. Default: ''. */
  indent?: string;
}

/**
 * Render the related-test-file list for an audited/explained function, with a
 * singular/plural "file"/"files" label:
 *
 *   {indent}  Tests (1 file):
 *   {indent}    tests/parse.test.ts
 */
export function renderRelatedTestsSection(
  tests: RelatedTestRefLike[],
  opts: RenderRelatedTestsSectionOpts = {},
): void {
  if (tests.length === 0) return;
  const { indent = '' } = opts;
  const label = tests.length === 1 ? 'file' : 'files';
  console.log(`\n${indent}  Tests (${tests.length} ${label}):`);
  for (const t of tests) {
    console.log(`${indent}    ${t.file}`);
  }
}
