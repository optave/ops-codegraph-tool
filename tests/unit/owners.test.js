import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCodeownersCache,
  matchOwners,
  parseCodeowners,
  parseCodeownersContent,
  patternToRegex,
} from '../../src/features/owners.js';

// ─── parseCodeownersContent ──────────────────────────────────────────

describe('parseCodeownersContent', () => {
  it('skips comments and empty lines', () => {
    const content = `# This is a comment

# Another comment
*.js @frontend
`;
    const rules = parseCodeownersContent(content);
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe('*.js');
    expect(rules[0].owners).toEqual(['@frontend']);
  });

  it('parses multi-owner rules', () => {
    const rules = parseCodeownersContent('src/ @team-a @team-b @user1');
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(['@team-a', '@team-b', '@user1']);
  });

  it('parses email-style owners', () => {
    const rules = parseCodeownersContent('*.py dev@example.com @python-team');
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(['dev@example.com', '@python-team']);
  });

  it('rejects malformed email-style owners', () => {
    // foo@ has no domain — rejected by the email regex
    // @bar passes as a GitHub handle (startsWith('@'))
    const rules = parseCodeownersContent('*.js foo@ @bar');
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toEqual(['@bar']);
  });

  it('rejects @bar-only-at as email (no local part)', () => {
    // Standalone token that looks like @domain but not a handle check
    // This tests the email path: '@bar' would pass startsWith('@'), which is fine
    // But 'nothandle' without @ is rejected, and 'a@' without domain is rejected
    const rules = parseCodeownersContent('*.js a@ nothandle');
    expect(rules).toHaveLength(0);
  });

  it('skips lines with no owners', () => {
    const rules = parseCodeownersContent('*.js\nsrc/ @team');
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe('src/');
  });

  it('handles multiple rules', () => {
    const content = `* @default
/src/ @dev-team
*.test.js @qa-team`;
    const rules = parseCodeownersContent(content);
    expect(rules).toHaveLength(3);
  });
});

// ─── patternToRegex ──────────────────────────────────────────────────

describe('patternToRegex', () => {
  it('matches *.js anywhere', () => {
    const re = patternToRegex('*.js');
    expect(re.test('app.js')).toBe(true);
    expect(re.test('src/app.js')).toBe(true);
    expect(re.test('src/deep/app.js')).toBe(true);
    expect(re.test('app.ts')).toBe(false);
  });

  it('matches /src/*.js anchored to root', () => {
    const re = patternToRegex('/src/*.js');
    expect(re.test('src/app.js')).toBe(true);
    expect(re.test('src/utils.js')).toBe(true);
    expect(re.test('src/deep/app.js')).toBe(false);
    expect(re.test('lib/src/app.js')).toBe(false);
  });

  it('matches /docs/**/*.md with double-star', () => {
    const re = patternToRegex('/docs/**/*.md');
    expect(re.test('docs/readme.md')).toBe(true);
    expect(re.test('docs/api/ref.md')).toBe(true);
    expect(re.test('docs/deep/nested/file.md')).toBe(true);
    expect(re.test('lib/docs/readme.md')).toBe(false);
    expect(re.test('docs/readme.txt')).toBe(false);
  });

  it('matches src/ as directory (contents under it)', () => {
    const re = patternToRegex('src/');
    expect(re.test('src/app.js')).toBe(true);
    expect(re.test('src/deep/file.js')).toBe(true);
    expect(re.test('lib/src/app.js')).toBe(true);
    expect(re.test('srcfile.js')).toBe(false);
  });

  it('matches /Makefile anchored bare filename', () => {
    const re = patternToRegex('/Makefile');
    expect(re.test('Makefile')).toBe(true);
    expect(re.test('sub/Makefile')).toBe(false);
  });

  it('matches * (everything)', () => {
    const re = patternToRegex('*');
    expect(re.test('anything.js')).toBe(true);
    expect(re.test('src/deep/file.py')).toBe(true);
  });

  it('matches bare filename anywhere', () => {
    const re = patternToRegex('Makefile');
    expect(re.test('Makefile')).toBe(true);
    expect(re.test('sub/Makefile')).toBe(true);
  });

  it('matches /src/ anchored directory', () => {
    const re = patternToRegex('/src/');
    expect(re.test('src/app.js')).toBe(true);
    expect(re.test('src/deep/file.js')).toBe(true);
    expect(re.test('lib/src/app.js')).toBe(false);
  });
});

// ─── matchOwners ─────────────────────────────────────────────────────

describe('matchOwners', () => {
  it('returns last-match-wins', () => {
    const rules = parseCodeownersContent(`* @default
/src/ @dev-team
/src/auth/ @security-team`);
    expect(matchOwners('src/auth/login.js', rules)).toEqual(['@security-team']);
    expect(matchOwners('src/utils.js', rules)).toEqual(['@dev-team']);
    expect(matchOwners('README.md', rules)).toEqual(['@default']);
  });

  it('returns empty array for unowned files', () => {
    const rules = parseCodeownersContent('/src/ @dev-team');
    expect(matchOwners('lib/utils.js', rules)).toEqual([]);
  });

  it('handles multiple overlapping rules', () => {
    const rules = parseCodeownersContent(`* @fallback
*.js @js-team
/src/*.js @src-team`);
    expect(matchOwners('src/app.js', rules)).toEqual(['@src-team']);
    expect(matchOwners('lib/app.js', rules)).toEqual(['@js-team']);
    expect(matchOwners('readme.md', rules)).toEqual(['@fallback']);
  });
});

// ─── parseCodeowners ─────────────────────────────────────────────────

describe('parseCodeowners', () => {
  let tmpDir;

  beforeEach(() => {
    clearCodeownersCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeowners-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no CODEOWNERS file exists', () => {
    expect(parseCodeowners(tmpDir)).toBeNull();
  });

  it('finds CODEOWNERS at root', () => {
    fs.writeFileSync(path.join(tmpDir, 'CODEOWNERS'), '* @root-team\n');
    const result = parseCodeowners(tmpDir);
    expect(result).not.toBeNull();
    expect(result.path).toBe('CODEOWNERS');
    expect(result.rules).toHaveLength(1);
  });

  it('finds .github/CODEOWNERS', () => {
    fs.mkdirSync(path.join(tmpDir, '.github'));
    fs.writeFileSync(path.join(tmpDir, '.github', 'CODEOWNERS'), '/src/ @dev\n');
    const result = parseCodeowners(tmpDir);
    expect(result).not.toBeNull();
    expect(result.path).toBe('.github/CODEOWNERS');
  });

  it('finds docs/CODEOWNERS', () => {
    fs.mkdirSync(path.join(tmpDir, 'docs'));
    fs.writeFileSync(path.join(tmpDir, 'docs', 'CODEOWNERS'), '/docs/ @docs-team\n');
    const result = parseCodeowners(tmpDir);
    expect(result).not.toBeNull();
    expect(result.path).toBe('docs/CODEOWNERS');
  });

  it('prefers root CODEOWNERS over .github/', () => {
    fs.writeFileSync(path.join(tmpDir, 'CODEOWNERS'), '* @root\n');
    fs.mkdirSync(path.join(tmpDir, '.github'));
    fs.writeFileSync(path.join(tmpDir, '.github', 'CODEOWNERS'), '* @github\n');
    const result = parseCodeowners(tmpDir);
    expect(result.path).toBe('CODEOWNERS');
    expect(result.rules[0].owners).toEqual(['@root']);
  });

  it('returns cached result on repeated calls', () => {
    fs.writeFileSync(path.join(tmpDir, 'CODEOWNERS'), '* @team\n');
    const first = parseCodeowners(tmpDir);
    const second = parseCodeowners(tmpDir);
    expect(second).toEqual(first);
    // Same rule array reference means cache was hit
    expect(second.rules).toBe(first.rules);
  });

  it('invalidates cache when file mtime changes', () => {
    const filePath = path.join(tmpDir, 'CODEOWNERS');
    fs.writeFileSync(filePath, '* @old-team\n');
    const first = parseCodeowners(tmpDir);
    expect(first.rules[0].owners).toEqual(['@old-team']);

    // Write new content then force a distinct mtime (NTFS can lazily update mtime)
    fs.writeFileSync(filePath, '* @new-team\n');
    const afterWrite = fs.statSync(filePath).mtimeMs;
    fs.utimesSync(filePath, new Date(), new Date(afterWrite + 5000));

    const second = parseCodeowners(tmpDir);
    expect(second.rules[0].owners).toEqual(['@new-team']);
    expect(second.rules).not.toBe(first.rules);
  });
});
