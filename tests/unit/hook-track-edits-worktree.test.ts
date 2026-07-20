/**
 * Regression guard for issue #1838: .claude/hooks/track-edits.sh (PostToolUse
 * hook for Edit/Write) resolved PROJECT_DIR from the hook process's own
 * ambient cwd (`git rev-parse --show-toplevel` with no `-C`). Edit/Write tool
 * calls carry only an absolute `file_path` with no associated "current
 * directory" state, so the hook's ambient cwd is not guaranteed to match the
 * worktree that actually owns the edited file — especially in worktree
 * sessions where the ambient cwd can lag behind interleaved Bash `cd` calls.
 * When it doesn't match, the log entry lands in the wrong worktree's
 * `.claude/session-edits.log` (or is silently dropped as a `..`-relative
 * path), and guard-git.sh later blocks a legitimate commit claiming the file
 * was "NOT edited in this session".
 *
 * The fix derives PROJECT_DIR from the edited file's own path
 * (`git -C "<dir containing file_path>" rev-parse --show-toplevel`) instead
 * of the ambient cwd — mirroring the `-C "$WORK_DIR"` pattern guard-git.sh
 * already uses on the read side of this same check.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'track-edits.sh');

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

function runHook(filePath: string, cwd: string): void {
  const toolInput = JSON.stringify({ tool_input: { file_path: filePath } });
  execFileSync('bash', [HOOK_PATH], { cwd, input: toolInput });
}

describe("track-edits.sh resolves the log to the edited file's own worktree", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'track-edits-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('logs to the target worktree even when the hook process cwd is a different worktree', () => {
    const ambientRepo = path.join(tmpRoot, 'ambient-repo');
    const targetRepo = path.join(tmpRoot, 'target-worktree');
    initRepo(ambientRepo);
    initRepo(targetRepo);

    const targetFile = path.join(targetRepo, 'src', 'thing.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, '// content\n');

    // The hook process's ambient cwd is a DIFFERENT git worktree than the one
    // that owns the edited file — this is the racy condition from #1838.
    runHook(targetFile, ambientRepo);

    const targetLog = path.join(targetRepo, '.claude', 'session-edits.log');
    const ambientLog = path.join(ambientRepo, '.claude', 'session-edits.log');

    expect(fs.existsSync(targetLog)).toBe(true);
    expect(fs.readFileSync(targetLog, 'utf8')).toMatch(/ src\/thing\.ts$/m);
    expect(fs.existsSync(ambientLog)).toBe(false);
  });

  it('walks up to the nearest existing ancestor when Write targets a not-yet-created nested directory', () => {
    const targetRepo = path.join(tmpRoot, 'target-worktree-2');
    initRepo(targetRepo);
    // a/b/c does not exist yet — simulates the Write tool creating new nested dirs.
    const nestedFile = path.join(targetRepo, 'a', 'b', 'c', 'new-file.ts');

    // Ambient cwd is entirely outside any git repo.
    runHook(nestedFile, tmpRoot);

    const targetLog = path.join(targetRepo, '.claude', 'session-edits.log');
    expect(fs.existsSync(targetLog)).toBe(true);
    expect(fs.readFileSync(targetLog, 'utf8')).toMatch(/ a\/b\/c\/new-file\.ts$/m);
  });

  it('logs a clean relative path when the edited file is reached through a symlink to the worktree', () => {
    // Reproduces (on any OS) the same class of bug as Windows' 8.3 short-name
    // aliases (e.g. "runneradmin" vs "RUNNER~1"): two different, valid string
    // forms resolve to the identical real directory. `git rev-parse
    // --show-toplevel` returns the real (symlink-resolved) path, so without
    // canonicalizing FILE_PATH's directory the same way before computing the
    // relative path, path.relative sees two unrelated-looking trees and
    // produces a long, useless chain of '../' segments instead of a clean
    // relative path.
    const realRepo = path.join(tmpRoot, 'real-worktree');
    const symlinkRepo = path.join(tmpRoot, 'symlink-to-worktree');
    initRepo(realRepo);
    fs.mkdirSync(path.join(realRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(realRepo, 'src', 'thing.ts'), '// content\n');
    fs.symlinkSync(realRepo, symlinkRepo, 'dir');

    const targetFile = path.join(symlinkRepo, 'src', 'thing.ts');
    runHook(targetFile, tmpRoot);

    const realLog = path.join(realRepo, '.claude', 'session-edits.log');
    expect(fs.existsSync(realLog)).toBe(true);
    const content = fs.readFileSync(realLog, 'utf8');
    expect(content).toMatch(/ src\/thing\.ts$/m);
    expect(content).not.toContain('..');
  });
});

describe('track-edits.sh Windows path normalization', () => {
  // dirname (GNU/BSD coreutils) only splits on '/'. On Windows, Edit/Write's
  // file_path arrives backslash-delimited (e.g. from Node's path.join), which
  // made dirname silently no-op and return "." — undetectable on a POSIX test
  // runner via the integration tests above, since they only ever construct
  // paths with the host OS's own separator. Exercise the normalization
  // snippet directly (extracted from the real file, not duplicated by hand)
  // so a regression here is caught on any host OS.
  function extractNormalizationSnippet(hookPath: string): string {
    const src = fs.readFileSync(hookPath, 'utf8');
    const start = src.indexOf('if printf');
    const end = src.indexOf('\nfi', start);
    if (start === -1 || end === -1) {
      throw new Error(`could not locate normalization if-block in ${hookPath}`);
    }
    return src.slice(start, end + '\nfi'.length);
  }

  // Passed via env var, not argv: Windows command-line argument marshalling
  // has its own backslash-escaping rules that don't apply to environment
  // variables, and the real hook never receives FILE_PATH as a CLI arg
  // either (it comes from JSON on stdin) — so this keeps the test's
  // transport mechanism from confounding what's actually being verified.
  function normalize(hookPath: string, filePath: string): string {
    const snippet = extractNormalizationSnippet(hookPath);
    const script = `${snippet}\nprintf '%s' "$FILE_PATH"`;
    return execFileSync('bash', ['-c', script], {
      env: { ...process.env, FILE_PATH: filePath },
    }).toString();
  }

  const DOCS_HOOK_PATH = path.join(
    REPO_ROOT,
    'docs',
    'examples',
    'claude-code-hooks',
    'track-edits.sh',
  );

  it.each([
    ['live hook', HOOK_PATH],
    ['docs example', DOCS_HOOK_PATH],
  ])('%s: converts a Windows drive-letter path to forward slashes', (_label, hookPath) => {
    expect(normalize(hookPath, 'C:\\Users\\dev\\project\\src\\thing.ts')).toBe(
      'C:/Users/dev/project/src/thing.ts',
    );
  });

  it.each([
    ['live hook', HOOK_PATH],
    ['docs example', DOCS_HOOK_PATH],
  ])(
    '%s: leaves a POSIX path with a literal backslash in the filename untouched',
    (_label, hookPath) => {
      expect(normalize(hookPath, '/tmp/proj/weird\\name.ts')).toBe('/tmp/proj/weird\\name.ts');
    },
  );
});
