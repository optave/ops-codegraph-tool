/**
 * Extends #2005's docs-drift protection (originally JSON-syntax validity
 * for docs/examples/MCP.md's ```json blocks) to docs/examples/CLI.md,
 * whose blocks are plain-text terminal output, not JSON — a different kind
 * of check is needed (#2212).
 *
 * Two tiers, deliberately NOT full output-content diffing (#2212 itself
 * flags that as materially larger scope — it needs designing normalization
 * rules for dynamic content like counts/paths/timestamps and deciding how
 * strict a diff should be, which a docs-example test file shouldn't decide
 * unilaterally):
 *
 *  - Tier 1 (every documented command, cheap/static): the base command (and,
 *    for command groups like `registry`/`snapshot`, the subcommand) and
 *    every `--flag` used in each ```bash block still exist in the CURRENT
 *    CLI's own --help output. Catches the most common and highest-impact
 *    form of drift — a renamed/removed command or flag — without needing to
 *    run anything against a real graph.
 *  - Tier 2 (a curated, representative subset, real execution): actually
 *    run the documented invocation shape (args substituted for the small
 *    fixture project also used by tests/integration/cli.test.ts, since
 *    CLI.md's own examples reference this repo's specific internal
 *    symbols/files, which don't exist in any small fixture) against a real,
 *    freshly-built graph, and assert it exits 0. Catches a command that
 *    parses fine but throws/crashes when actually invoked — something Tier
 *    1's static check can't see.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.join(__dirname, '../..');
const CLI_DOC_PATH = path.join(REPO_ROOT, 'docs/examples/CLI.md');
const CLI = path.resolve(REPO_ROOT, 'src/cli.ts');
const LOADER = new URL('../../scripts/ts-resolve-loader.js', import.meta.url).href;
const NODE_TS_FLAGS = ['--experimental-strip-types', '--import', LOADER];

/** Extract every `codegraph ...` invocation line from every ```bash block. */
function extractCommandLines(doc: string): string[] {
  const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  const lines: string[] = [];
  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('codegraph ')) lines.push(line);
    }
  }
  return lines;
}

/** Split a `codegraph ...` line into shell-like tokens (no quoting support needed — none of CLI.md's examples use quoted multi-word args except a bare symbol name). */
function tokenize(line: string): string[] {
  return line
    .replace(/^codegraph\s+/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^"(.*)"$/, '$1'));
}

// Command groups whose subcommands have their own --help, distinct from the
// group's own (which only lists the subcommands themselves, not flags).
const COMMAND_GROUPS = new Set(['registry', 'snapshot']);

/**
 * Check that `token` (e.g. "--staged") appears in `helpText` as a whole
 * flag name, not merely as a substring of a longer one (e.g. a renamed
 * "--staged-changes" would otherwise still match "--staged" via plain
 * `.includes()`, silently missing the rename — Greptile, #2212 review).
 * Bounded on the left by start-of-line/whitespace/comma (commander's
 * `-x, --flag` list format) and on the right by whitespace/comma/`<`
 * (a value placeholder) or end-of-line.
 */
function hasFlag(helpText: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,<]|$)`, 'm').test(helpText);
}

describe('docs/examples/CLI.md commands and flags are real (#2212)', () => {
  const doc = fs.readFileSync(CLI_DOC_PATH, 'utf-8');
  const commandLines = extractCommandLines(doc);
  const helpCache = new Map<string, string>();

  function help(...args: string[]): string {
    const key = args.join(' ');
    const cached = helpCache.get(key);
    if (cached !== undefined) return cached;
    const out = execFileSync('node', [...NODE_TS_FLAGS, CLI, ...args, '--help'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    helpCache.set(key, out);
    return out;
  }

  const topLevelHelp = help();

  it('finds a non-trivial number of documented command lines (extraction sanity check)', () => {
    expect(commandLines.length).toBeGreaterThan(50);
  });

  commandLines.forEach((line, i) => {
    it(`line ${i + 1}/${commandLines.length}: \`${line}\` uses a real command and real flags`, () => {
      const tokens = tokenize(line);
      const baseCommand = tokens[0];
      expect(topLevelHelp).toMatch(new RegExp(`^\\s*${baseCommand}\\b`, 'm'));

      // For a command group, the second token (if it's not a flag) is a
      // subcommand that needs its own --help lookup for flag validity.
      let helpArgs = [baseCommand];
      let flagTokens = tokens.slice(1);
      if (COMMAND_GROUPS.has(baseCommand) && tokens[1] && !tokens[1].startsWith('-')) {
        const groupHelp = help(baseCommand);
        expect(groupHelp).toMatch(new RegExp(`^\\s*${tokens[1]}\\b`, 'm'));
        helpArgs = [baseCommand, tokens[1]];
        flagTokens = tokens.slice(2);
      }

      const cmdHelp = help(...helpArgs);
      for (const token of flagTokens) {
        if (!token.startsWith('-') || token === '-') continue;
        expect(
          hasFlag(cmdHelp, token),
          `flag "${token}" not found in \`codegraph ${helpArgs.join(' ')} --help\`:\n${cmdHelp}`,
        ).toBe(true);
      }
    });
  });
});

describe('docs/examples/CLI.md — representative commands run successfully (#2212)', () => {
  let tmpDir: string, tmpHome: string;

  const FIXTURE_FILES = {
    'math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
export function square(x) { return multiply(x, x); }
`.trimStart(),
    'utils.js': `
import { add, square } from './math.js';
export function sumOfSquares(a, b) { return add(square(a), square(b)); }
export class Calculator {
  compute(x, y) { return sumOfSquares(x, y); }
}
`.trimStart(),
    'index.js': `
import { sumOfSquares, Calculator } from './utils.js';
import { add } from './math.js';
export function main() {
  console.log(add(1, 2));
  console.log(sumOfSquares(3, 4));
  const calc = new Calculator();
  console.log(calc.compute(5, 6));
}
`.trimStart(),
  };

  function run(...args: string[]): string {
    return execFileSync('node', [...NODE_TS_FLAGS, CLI, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-drift-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-drift-home-'));
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      fs.writeFileSync(path.join(tmpDir, name), content);
    }
    run('build', '.', '--engine', 'wasm');
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // Each entry mirrors the SHAPE of a documented CLI.md invocation, with
  // this-repo-specific symbol/file names substituted for the small fixture's
  // equivalents (buildGraph -> add, src/db.js -> math.js, etc.) — CLI.md's
  // own examples run against codegraph's own (much larger) codebase, so
  // they can't be run verbatim against any small fixture.
  const REPRESENTATIVE_COMMANDS: Array<[string, string[]]> = [
    ['stats -T', ['stats', '-T']],
    ['where <symbol> -T', ['where', 'add', '-T']],
    ['context <symbol> -T', ['context', 'add', '-T']],
    ['query <symbol> -T', ['query', 'add', '-T']],
    ['deps <file> -T', ['deps', 'math.js', '-T']],
    ['exports <file> -T', ['exports', 'utils.js', '-T']],
    ['children <symbol> -T', ['children', 'add', '-T']],
    ['dataflow <symbol> -T', ['dataflow', 'add', '-T']],
    ['check -T', ['check', '-T']],
    ['communities -T', ['communities', '-T']],
    ['roles -T', ['roles', '-T']],
    ['complexity -T --limit 5', ['complexity', '-T', '--limit', '5']],
    ['impact <file> -T', ['impact', 'math.js', '-T']],
    ['cycles', ['cycles']],
    ['map --limit 10 -T', ['map', '--limit', '10', '-T']],
    ['triage -T --limit 5', ['triage', '-T', '--limit', '5']],
  ];

  it.each(REPRESENTATIVE_COMMANDS)('`codegraph %s` runs without error', (_label, args) => {
    expect(() => run(...args)).not.toThrow();
  });
});
