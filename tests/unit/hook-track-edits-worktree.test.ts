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
});
