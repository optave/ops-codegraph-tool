/**
 * Regression coverage for #1913: the sed-injection helpers in
 * tracer-common.sh must produce output that is byte-identical on GNU sed
 * (Linux CI) and BSD sed (macOS dev boxes), which — unlike GNU — rejects the
 * single-line `a\text` / `i\text` shortcut and requires the text on the line
 * after the backslash.
 *
 * These tests exercise the shared helpers directly with bash + sed (whatever
 * sed the host provides), independent of any per-language compiler toolchain
 * (javac/kotlinc/scalac/groovyc/dotnet/dart/zig), so they run identically in
 * every environment regardless of which toolchains happen to be installed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACER_DIR = __dirname;
const TRACER_COMMON = path.join(TRACER_DIR, 'tracer-common.sh');

function runHelper(fnCall: string, file: string): string {
  execFileSync('bash', ['-c', `source "${TRACER_COMMON}"; ${fnCall}`]);
  return fs.readFileSync(file, 'utf8');
}

describe('tracer-common.sh sed-injection helpers (#1913)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tracer-common-test-')));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sedi_insert_before inserts text directly before the matching line (native-tracer.sh csharp RunWithValidation site)', () => {
    const file = path.join(tmpDir, 'Program.cs');
    fs.writeFileSync(
      file,
      [
        'class Program {',
        '    public static void Main() {',
        '        CallTracer.Dump();',
        '    }',
        '}',
        '',
      ].join('\n'),
    );

    const out = runHelper(
      `sedi_insert_before '/CallTracer.Dump/' '        RunWithValidation();' "${file}"`,
      file,
    );

    expect(out).toContain('        RunWithValidation();\n        CallTracer.Dump();');
  });

  it('sedi_insert_before_end inserts before the matching brace within a range (jvm/native dump-injection sites)', () => {
    const file = path.join(tmpDir, 'main.dart');
    fs.writeFileSync(file, ['void main() {', '  print(1);', '}', ''].join('\n'));

    const out = runHelper(
      `sedi_insert_before_end '/^void main/' '/^\\}/' '/^\\}/' '  CallTracer.instance.dump();' "${file}"`,
      file,
    );

    expect(out.split('\n')).toEqual([
      'void main() {',
      '  print(1);',
      '  CallTracer.instance.dump();',
      '}',
      '',
    ]);
  });

  it('sedi_insert_before_end honors distinct range-end and insert-line patterns (jvm-tracer.sh java dump site)', () => {
    // java's dump site scopes the range with a loose /\}/ end-address but
    // only inserts before a line that is *purely* a closing brace, so the
    // range and insertion patterns must be tracked independently.
    const file = path.join(tmpDir, 'Main.java');
    fs.writeFileSync(
      file,
      [
        'public class Main {',
        '    public static void main(String[] args) {',
        '        foo();',
        '    }',
        '}',
        '',
      ].join('\n'),
    );

    const out = runHelper(
      `sedi_insert_before_end '/public static void main/' '/\\}/' '/^[[:space:]]*\\}/' '        CallTracer.dump();' "${file}"`,
      file,
    );

    expect(out).toContain('        foo();\n        CallTracer.dump();\n    }\n}');
  });

  it('sedi_append_unless appends after matching lines except negated ones, including a space before the brace (jvm-tracer.sh java/groovy per-method sites)', () => {
    const file = path.join(tmpDir, 'BaseService.java');
    fs.writeFileSync(
      file,
      [
        'public abstract class BaseService {',
        '',
        '    protected void log(String message) {',
        '        System.out.println(message);',
        '    }',
        '}',
        '',
      ].join('\n'),
    );

    const out = runHelper(
      `sedi_append_unless '/\\)[[:space:]]*\\{$/' '/class |interface /' '        CallTracer.traceCall();' "${file}"`,
      file,
    );

    // The method signature line (ending in ") {") gets the call appended...
    expect(out).toContain(
      '    protected void log(String message) {\n        CallTracer.traceCall();',
    );
    // ...but the class declaration line (also ending in "{") is excluded.
    expect(out.split('\n')[0]).toBe('public abstract class BaseService {');
  });

  it('rejects a regression back to the GNU-only single-line a\\/i\\ shortcut in the tracer scripts', () => {
    // Every dump()/traceCall() injection now goes through the shared helpers
    // above, so the raw sed scripts embedded directly in the language
    // tracers should contain zero remaining single-line "i\text"/"a\text"
    // occurrences (the exact defect #1913 fixed) — this guards against
    // future injection sites reintroducing the GNU-only shortcut.
    //
    // tracer-common.sh itself is deliberately NOT in this list: its helpers
    // build the sed script inside double-quoted bash strings, so a literal
    // backslash is written as "i\\" (escaped for the enclosing quotes)
    // immediately followed by a newline. That raw "\\" trips the /[ai]\\\S/
    // pattern below as a false positive — the second backslash satisfies \S
    // — even though it's the correct portable multi-line form, not the
    // banned single-line shortcut. Trade-off: a future helper mistakenly
    // written with the real GNU-only form directly inside tracer-common.sh
    // would go undetected by this guard.
    const guardedFiles = ['jvm-tracer.sh', 'native-tracer.sh', 'go-tracer.sh'];

    for (const name of guardedFiles) {
      const code = fs
        .readFileSync(path.join(TRACER_DIR, name), 'utf8')
        .split('\n')
        // Drop comment lines so prose that *describes* the banned form (as
        // this very fix's changelog comments do) isn't mistaken for it.
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      // \S excludes the newline that must immediately follow a portable
      // "i\" / "a\" — so this only matches the banned single-line form
      // where real text follows the backslash on the same line.
      const offender = code.match(/[ai]\\\S/);
      expect(
        offender,
        `${name} contains a GNU-only single-line a\\/i\\ form: ${offender}`,
      ).toBeNull();
    }
  });
});
