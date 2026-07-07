/**
 * Regression test for issue #1842: docs/guides/recommended-practices.md
 * referenced `codegraph check` predicate flags (`--no-new-cycles`,
 * `--max-blast-radius`, `--no-boundary-violations`) that were renamed to
 * `--cycles`, `--blast-radius`, `--boundaries` (plus `--signatures`, which
 * was never documented at all) and never updated.
 *
 * Rather than pin the doc to today's flag names, this derives the valid
 * flag set from `command.options` in src/cli/commands/check.ts — the single
 * source of truth — so a future rename that isn't reflected in the doc
 * fails here instead of silently drifting again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { command as checkCommand } from '../../src/cli/commands/check.js';

const DOC_PATH = path.join(__dirname, '../../docs/guides/recommended-practices.md');

/** Extract long-form flag names (e.g. "--blast-radius") from a commander option tuple's flags string. */
function longFlagNames(flags: string): string[] {
  return flags
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('--'))
    .map((part) => part.split(/\s/)[0]);
}

function validCheckFlags(): Set<string> {
  const valid = new Set<string>();
  for (const option of checkCommand.options) {
    const flags = option[0];
    for (const name of longFlagNames(flags)) {
      valid.add(name);
    }
  }
  return valid;
}

/** Pull every `--flag`-shaped token out of `codegraph check ...` example lines. */
function flagsUsedInCheckExamples(doc: string): string[] {
  const flags: string[] = [];
  for (const line of doc.split('\n')) {
    if (!/codegraph check\b/.test(line)) continue;
    for (const match of line.matchAll(/--[a-zA-Z][a-zA-Z-]*/g)) {
      flags.push(match[0]);
    }
  }
  return flags;
}

describe('docs/guides/recommended-practices.md check flag references (#1842)', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const valid = validCheckFlags();

  it('does not reference known-stale codegraph check flag names', () => {
    const stale = [
      '--no-new-cycles',
      '--max-blast-radius',
      '--no-boundary-violations',
      '--max-complexity',
    ];
    for (const flag of stale) {
      expect(doc).not.toContain(flag);
    }
  });

  it('only references check flags that exist on the check command', () => {
    const used = flagsUsedInCheckExamples(doc);
    expect(used.length).toBeGreaterThan(0);
    for (const flag of used) {
      expect(valid.has(flag)).toBe(true);
    }
  });
});
