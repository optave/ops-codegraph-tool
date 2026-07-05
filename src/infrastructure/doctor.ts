/**
 * Environment health checks ("doctor") for a codegraph checkout.
 *
 * Every git worktree (see CLAUDE.md "Parallel Sessions") gets its own
 * untracked `node_modules/` and `grammars/` — neither is shared via git, so
 * every fresh `git worktree add` needs its own `npm install`. Two classes of
 * drift are both silent until something fails deep inside a build or test
 * run, surfacing as a cryptic native-module stack trace or a swallowed parse
 * failure rather than a clear diagnosis (issue #1733):
 *
 *   1. `better-sqlite3`'s compiled `.node` binary is a classic V8/NAN addon
 *      (not N-API), so it is tied to the exact Node ABI
 *      (`process.versions.modules`) it was compiled under. Upgrading Node in
 *      place without `npm rebuild` leaves a stale binary that throws on load
 *      — and better-sqlite3 sits on the hot path for nearly every command
 *      (see `db/builder/pipeline.ts`), so this one failure looks like almost
 *      everything is broken.
 *   2. `grammars/*.wasm` is populated by `npm run build:wasm` (via the
 *      `prepare` lifecycle script) from tree-sitter grammar devDependencies.
 *      A worktree set up before that step finished — or where it failed
 *      partway — is left with only a partial grammar set.
 *
 * Grammar completeness is NOT all-or-nothing: `LANGUAGE_REGISTRY` marks only
 * JS/TS/TSX as `required: true` — every other language is designed to fail
 * gracefully at runtime when its grammar is missing (see this repo's own
 * CLAUDE.md: "Non-required parsers ... fail gracefully if their WASM grammar
 * is unavailable"). A worktree that can't fetch one optional grammar's
 * devDependency (e.g. a sandboxed environment and a `git+ssh` grammar
 * package) should still be able to build/test with reduced language coverage
 * — not get hard-blocked before a single test runs. So `checkWasmGrammars`
 * only fails (blocks `pretest`) when a *required* grammar is missing; a
 * missing optional grammar is surfaced as a non-blocking 'warn'.
 *
 * Design: each check's *decision* logic is a pure function (`parseAbiMismatchError`,
 * `findMissingGrammars`) that takes plain data and is trivial to unit test with
 * fake inputs. The public `checkXxx` functions wrap that logic with the real
 * I/O (a `require()` attempt, a directory listing) behind an injectable
 * parameter, so tests can simulate a broken environment without touching this
 * worktree's real native binary or grammars/ directory.
 *
 * This module only detects — it never mutates the environment. `scripts/doctor.ts`
 * is the CLI entry point that also knows how to *fix* what this module reports.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { GRAMMARS_DIR, LANGUAGE_REGISTRY } from '../domain/parser.js';
import type { LanguageRegistryEntry } from '../types.js';

const _require = createRequire(import.meta.url);

/**
 * 'ok' — nothing to report. 'warn' — non-blocking (e.g. an optional grammar
 * is missing); does not fail the check or the overall report. 'fail' —
 * blocking; fails the overall report and `pretest`.
 */
type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

/**
 * Result of a single doctor check. Not exported by name — consumers (e.g.
 * `scripts/doctor.ts`) type against `DoctorReport['checks'][number]` /
 * `ReturnType<typeof runDoctorChecks>` structurally rather than importing
 * this interface, since nothing outside this module currently constructs a
 * `DoctorCheck` independently of calling `checkBetterSqlite3Abi` /
 * `checkWasmGrammars` / `runDoctorChecks`.
 */
interface DoctorCheck {
  /** Stable machine-readable id, e.g. 'better-sqlite3-abi'. */
  id: string;
  /** Human-readable label for report output. */
  label: string;
  status: DoctorCheckStatus;
  /** One-line human-readable explanation of the result. */
  detail: string;
  /** Shell command that resolves this failure/warning. Absent when status is 'ok'. */
  fixCommand?: string;
}

/** Aggregate result of running every doctor check. Not exported — see DoctorCheck. */
interface DoctorReport {
  /** False only when some check's status is 'fail' — a 'warn' never flips this. */
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Parsed ABI numbers from a Node native-addon load-failure error message.
 * Not exported — it's only ever consumed as `parseAbiMismatchError`'s return
 * value; callers destructure the fields rather than naming the type.
 */
interface AbiMismatchInfo {
  /** NODE_MODULE_VERSION the binary was compiled against. */
  compiledVersion: number;
  /** NODE_MODULE_VERSION the current Node process requires. */
  requiredVersion: number;
}

// Node's native-addon ABI mismatch error has been stable for many major
// versions, e.g.:
//   "The module '/path/to/better_sqlite3.node'
//    was compiled against a different Node.js version using
//    NODE_MODULE_VERSION 127. This version of Node.js requires
//    NODE_MODULE_VERSION 131. Please try re-compiling or re-installing
//    the module (for instance, using `npm rebuild` or `npm install`)."
// Detection never depends on this regex matching — any thrown error from
// loadModule() is already treated as "broken" by checkBetterSqlite3Abi.
// This only extracts the two version numbers for a friendlier message; if a
// future Node release rewords the message, the check still fails correctly,
// it just falls back to the raw error text instead of the parsed numbers.
const ABI_MISMATCH_RE = /NODE_MODULE_VERSION (\d+)\.[\s\S]*?NODE_MODULE_VERSION (\d+)/;

/**
 * Parse Node's native-addon ABI mismatch error text into structured version
 * numbers. Returns null for any message that doesn't match the known format
 * (e.g. a missing-module error, a permission error, or reworded future text).
 */
export function parseAbiMismatchError(message: string): AbiMismatchInfo | null {
  const match = ABI_MISMATCH_RE.exec(message);
  if (!match) return null;
  return { compiledVersion: Number(match[1]), requiredVersion: Number(match[2]) };
}

/**
 * Check whether better-sqlite3's compiled native binary loads under the
 * current Node process.
 *
 * Requiring it is the only reliable way to learn a prebuilt `.node` file's
 * ABI compatibility — Node exposes no static introspection API for a
 * candidate binary's compiled-against version — so this performs a real (but
 * fast, in-process, side-effect-free beyond module caching) require() rather
 * than shelling out to a subprocess.
 *
 * `loadModule` is injectable so tests can simulate a stale binary, a missing
 * install, or a healthy load without touching this worktree's real
 * node_modules/.
 */
export function checkBetterSqlite3Abi(
  loadModule: () => unknown = () => _require('better-sqlite3'),
): DoctorCheck {
  const id = 'better-sqlite3-abi';
  const label = 'better-sqlite3 native binary';
  try {
    loadModule();
    return {
      id,
      label,
      status: 'ok',
      detail: `loads cleanly under Node ${process.version} (ABI ${process.versions.modules})`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const message = err instanceof Error ? err.message : String(err);

    if (code === 'MODULE_NOT_FOUND') {
      return {
        id,
        label,
        status: 'fail',
        detail: 'better-sqlite3 is not installed in this worktree',
        fixCommand: 'npm install',
      };
    }

    const mismatch = parseAbiMismatchError(message);
    const detail = mismatch
      ? `compiled for NODE_MODULE_VERSION ${mismatch.compiledVersion}, but Node ${process.version} requires ${mismatch.requiredVersion} — likely a stale binary from before a Node upgrade`
      : `failed to load: ${message.split('\n')[0]}`;
    return { id, label, status: 'fail', detail, fixCommand: 'npm rebuild better-sqlite3' };
  }
}

/**
 * The subset of a language registry entry the grammar-completeness check
 * needs. Not exported — `checkWasmGrammars`'s default parameter is the real
 * `LANGUAGE_REGISTRY`; this narrower shape only exists so callers (tests) can
 * pass minimal fake entries without fabricating an `extractor`/`extensions`.
 */
type GrammarRegistryEntry = Pick<LanguageRegistryEntry, 'id' | 'grammarFile' | 'required'>;

/**
 * Pure: given the language registry and the set of grammar filenames that
 * actually exist on disk, return the entries whose `.wasm` file is missing.
 */
export function findMissingGrammars(
  registry: readonly GrammarRegistryEntry[],
  existingFiles: ReadonlySet<string>,
): GrammarRegistryEntry[] {
  return registry.filter((entry) => !existingFiles.has(entry.grammarFile));
}

/** List `.wasm` filenames present in the real `grammars/` directory. */
function listInstalledGrammarFiles(): ReadonlySet<string> {
  try {
    return new Set(readdirSync(GRAMMARS_DIR).filter((f) => f.endsWith('.wasm')));
  } catch {
    return new Set(); // grammars/ doesn't exist at all
  }
}

/** Render up to `max` grammar filenames, with a "+N more" suffix beyond that. */
function sampleList(entries: readonly GrammarRegistryEntry[], max = 5): string {
  const sample = entries
    .slice(0, max)
    .map((e) => e.grammarFile)
    .join(', ');
  const suffix = entries.length > max ? `, +${entries.length - max} more` : '';
  return `${sample}${suffix}`;
}

/**
 * Check that every language in the registry has its WASM grammar file
 * present on disk. Checks the *full* registry (all 30+ languages), not just
 * the `required` tier (JS/TS/TSX) that `isWasmAvailable()` in `domain/parser.ts`
 * gates parser startup on — a worktree can start up fine with only the
 * required grammars while silently missing most language support.
 *
 * A missing `required` grammar (JS/TS/TSX) is a hard failure — the parser
 * can't function without it. A missing *optional* grammar is reported as a
 * non-blocking warning: non-required parsers are designed to fail gracefully
 * at runtime (see the module doc comment), so this must never flip `status`
 * to 'fail' on its own — that would incorrectly block `pretest`/`npm test`
 * for every worktree missing even one rarely-used language's grammar.
 *
 * Both `registry` and `listGrammarFiles` are injectable so tests can supply a
 * fake registry and a fake "what's on disk" set without touching the real
 * grammars/ directory.
 */
export function checkWasmGrammars(
  registry: readonly GrammarRegistryEntry[] = LANGUAGE_REGISTRY,
  listGrammarFiles: () => ReadonlySet<string> = listInstalledGrammarFiles,
): DoctorCheck {
  const id = 'wasm-grammars';
  const label = 'WASM tree-sitter grammars';
  const existing = listGrammarFiles();
  const missing = findMissingGrammars(registry, existing);

  if (missing.length === 0) {
    return {
      id,
      label,
      status: 'ok',
      detail: `all ${registry.length} grammar files present in grammars/`,
    };
  }

  const missingRequired = missing.filter((e) => e.required);
  const missingOptional = missing.filter((e) => !e.required);

  if (missingRequired.length > 0) {
    const optionalNote =
      missingOptional.length > 0
        ? `; ${missingOptional.length} optional grammar file(s) also missing`
        : '';
    return {
      id,
      label,
      status: 'fail',
      detail:
        `${missingRequired.length} required grammar file(s) missing ` +
        `(${sampleList(missingRequired)})${optionalNote}`,
      fixCommand: 'npm run build:wasm',
    };
  }

  // Only optional grammars are missing — all required (JS/TS/TSX) grammars
  // are present, so parsing isn't broken, just narrower. Non-blocking.
  return {
    id,
    label,
    status: 'warn',
    detail:
      `all required grammar files present; ${missingOptional.length} optional ` +
      `grammar file(s) missing, non-blocking (${sampleList(missingOptional)})`,
    fixCommand: 'npm run build:wasm',
  };
}

/**
 * Run every doctor check and aggregate the result. Fast and read-only — safe
 * to call frequently (e.g. from a `pretest` hook) since neither check spawns
 * a subprocess or mutates the environment.
 *
 * `checks` is injectable (defaulting to the two real checks) so the
 * ok/'fail'-only aggregation rule — a 'warn' must never flip the overall
 * report unhealthy — can be unit tested directly with fake check results,
 * independent of the real native binary or grammars/ directory.
 */
export function runDoctorChecks(
  checks: readonly DoctorCheck[] = [checkBetterSqlite3Abi(), checkWasmGrammars()],
): DoctorReport {
  return { ok: checks.every((c) => c.status !== 'fail'), checks: [...checks] };
}
