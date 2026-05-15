/**
 * Shared benchmark configuration — CLI arg parsing and source resolution.
 *
 * All 4 benchmark scripts use this to determine:
 *   - version label ("dev" for local, semver for npm releases)
 *   - srcDir (local src/ or npm-installed package src/)
 *   - cleanup function (removes temp dir for npm mode)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getBenchmarkVersion } from '../bench-version.js';

/**
 * Globs excluded from every benchmark's `buildGraph(root, ...)` invocation.
 *
 * Resolution-benchmark fixtures (`tests/benchmarks/resolution/fixtures/**`)
 * are hand-annotated scaffolding for the static-resolution test suite, not
 * representative source code. They inflate dogfooding timing measurements
 * disproportionately whenever a new-language PR lands a heavyweight grammar
 * (e.g. tree-sitter-verilog added ~850ms to native fullBuildMs in #1107).
 * Excluding them here keeps build/query/incremental benchmarks measuring
 * codegraph's own source rather than its test fixtures.
 */
export const BENCHMARK_EXCLUDES: readonly string[] = [
	'tests/benchmarks/resolution/fixtures/**',
];

// On Windows, `npm` is `npm.cmd` and Node refuses to spawn `.cmd`/`.bat`
// without `shell: true` (since Node 18.20 / 20.15). When `shell: true`, the
// Windows `cmd.exe` shell resolves bare `npm` to `npm.cmd` automatically, so
// a single boolean is sufficient.
const NPM_SHELL = os.platform() === 'win32';

// Strict guards for any string that gets interpolated into an npm install
// spec while running with `shell: true`. Registry-sourced values are
// constrained by npm itself, but we enforce the constraint locally so a
// compromised upstream or local `package.json` can't inject shell metacharacters.
const PKG_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
// Permit exact versions, ranges, dist-tags, and common operators — but no
// shell metacharacters. Intentionally conservative; tighten if needed.
const PKG_VERSION_RE = /^[a-z0-9._+\-~^>=<|* ]+$/i;

function assertSafePkgName(name: string): string {
	if (!PKG_NAME_RE.test(name)) {
		throw new Error(`Refusing to install package with unsafe name: ${JSON.stringify(name)}`);
	}
	return name;
}

function assertSafePkgVersion(version: string): string {
	if (!PKG_VERSION_RE.test(version)) {
		throw new Error(`Refusing to install package with unsafe version: ${JSON.stringify(version)}`);
	}
	return version;
}

/**
 * Parse `--version <v>`, `--npm`, and `--dist` from process.argv.
 *
 * `--dist` selects local-built `dist/` over `src/` so the benchmark loads the
 * compiled JavaScript that ships to npm — matching the loading path used for
 * historical baselines (where `--npm` installs a published package whose
 * `bench-config` already prefers `dist/`). Without this, the pre-publish gate
 * runs `src/` via `--strip-types` while baselines were measured against
 * compiled JS, which introduces per-call JIT/loader overhead deltas that are
 * artifacts of measurement, not the code under test.
 */
export function parseArgs() {
	const args = process.argv.slice(2);
	let version = null;
	let npm = false;
	let dist = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--version' && i + 1 < args.length) {
			version = args[++i];
		} else if (args[i] === '--npm') {
			npm = true;
		} else if (args[i] === '--dist') {
			dist = true;
		}
	}

	return { version, npm, dist };
}

/**
 * Resolve where to import codegraph source from.
 *
 * @returns {{ version: string, srcDir: string, cleanup: () => void }}
 *   - version:  "dev" (local) or the semver string (npm)
 *   - srcDir:   absolute path to the codegraph src/ directory to import from
 *   - cleanup:  call when done — removes the temp dir in npm mode, no-op otherwise
 */
export async function resolveBenchmarkSource() {
	const { version: cliVersion, npm, dist } = parseArgs();

	if (dist && npm) {
		console.error('Warning: --dist is ignored in --npm mode (the installed package already uses dist/ automatically).');
	}

	if (!npm) {
		// Local mode — use repo src/ (or dist/ when --dist), version from git state
		const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..');
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		let srcDir = path.join(root, 'src');
		if (dist) {
			const distDir = path.join(root, 'dist');
			if (!fs.existsSync(distDir)) {
				throw new Error(`--dist requested but ${distDir} does not exist. Run "npm run build" first.`);
			}
			srcDir = distDir;
		}
		return {
			version: cliVersion || getBenchmarkVersion(pkg.version, root),
			srcDir,
			cleanup() {},
		};
	}

	// npm mode — install @optave/codegraph@<version> into a temp dir.
	// Validate the version up-front so we never log or interpolate an
	// unvalidated string (with `shell: true` on Windows, bad input would be a
	// shell-injection surface).
	const safeVersion = assertSafePkgVersion(cliVersion || 'latest');
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bench-'));

	console.error(`Installing @optave/codegraph@${safeVersion} into ${tmpDir}...`);

	// Write a minimal package.json so npm install works
	fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ private: true }));

	// Retry with backoff for npm propagation delays
	const maxRetries = 5;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			execFileSync('npm', ['install', `@optave/codegraph@${safeVersion}`, '--no-audit', '--no-fund'], {
				cwd: tmpDir,
				stdio: 'pipe',
				timeout: 120_000,
				shell: NPM_SHELL,
			});
			break;
		} catch (err) {
			if (attempt === maxRetries) {
				// Clean up before throwing
				fs.rmSync(tmpDir, { recursive: true, force: true });
				throw new Error(`Failed to install @optave/codegraph@${safeVersion} after ${maxRetries} attempts: ${err.message}`);
			}
			const delay = attempt * 15_000; // 15s, 30s, 45s, 60s
			console.error(`  Attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	const pkgDir = path.join(tmpDir, 'node_modules', '@optave', 'codegraph');

	const installedPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

	// npm does not transitively install optionalDependencies of a dependency,
	// so the platform-specific native binary is missing. Install it explicitly.
	try {
		const optDeps = installedPkg.optionalDependencies || {};
		const platform = os.platform();
		const arch = os.arch();
		let libcSuffix = '';
		if (platform === 'linux') {
			try {
				const files = fs.readdirSync('/lib');
				libcSuffix = files.some((f) => f.startsWith('ld-musl-') && f.endsWith('.so.1')) ? '-musl' : '-gnu';
			} catch {
				libcSuffix = '-gnu';
			}
		}
		const platformKey = `codegraph-${platform}-${arch}${libcSuffix}`;
		const nativePkg = Object.keys(optDeps).find((name) => name.includes(platformKey));
		if (nativePkg) {
			// Even though these originate from the installed package's
			// optionalDependencies (i.e. the npm registry), validate before
			// logging or interpolating into a `shell: true` command line.
			const safeNativePkg = assertSafePkgName(nativePkg);
			const safeNativeVersion = assertSafePkgVersion(optDeps[nativePkg]);
			console.error(`Installing native package ${safeNativePkg}@${safeNativeVersion}...`);
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					execFileSync('npm', ['install', `${safeNativePkg}@${safeNativeVersion}`, '--no-audit', '--no-fund', '--no-save'], {
						cwd: tmpDir,
						stdio: 'pipe',
						timeout: 120_000,
						shell: NPM_SHELL,
					});
					break;
				} catch (innerErr) {
					if (attempt === maxRetries) throw innerErr;
					const delay = attempt * 15_000;
					console.error(`  Native install attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
			console.error(`Installed ${safeNativePkg}@${safeNativeVersion}`);
		} else {
			console.error(`No native package found for platform ${platform}-${arch}${libcSuffix}, skipping`);
		}
	} catch (err) {
		console.error(`Warning: failed to install native package: ${err.message}`);
	}

	// @huggingface/transformers is a devDependency (lazy-loaded for embeddings).
	// It is not installed as a transitive dep in npm mode, so install it
	// explicitly so the embedding benchmark workers can import it.
	try {
		const localPkg = JSON.parse(
			fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..', 'package.json'), 'utf8'),
		);
		const hfVersion = localPkg.devDependencies?.['@huggingface/transformers'];
		if (hfVersion) {
			const safeHfVersion = assertSafePkgVersion(hfVersion);
			console.error(`Installing @huggingface/transformers@${safeHfVersion} for embedding benchmarks...`);
			execFileSync(
				'npm',
				['install', `@huggingface/transformers@${safeHfVersion}`, '--no-audit', '--no-fund', '--no-save'],
				{
					cwd: tmpDir,
					stdio: 'pipe',
					timeout: 120_000,
					shell: NPM_SHELL,
				},
			);
			console.error('Installed @huggingface/transformers');
		}
	} catch (err) {
		console.error(`Warning: failed to install @huggingface/transformers: ${err.message}`);
	}

	// v3.4.0+ publishes compiled JS in dist/ alongside raw TS in src/.
	// Node cannot strip types from node_modules, so prefer dist/ when available.
	const distDir = path.join(pkgDir, 'dist');
	const srcDir = fs.existsSync(distDir) ? distDir : path.join(pkgDir, 'src');

	if (!fs.existsSync(srcDir)) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		throw new Error(`Installed package does not contain dist/ or src/ at ${pkgDir}`);
	}

	const resolvedVersion = cliVersion || installedPkg.version;

	console.error(`Installed @optave/codegraph@${installedPkg.version}`);

	return {
		version: resolvedVersion,
		srcDir,
		cleanup() {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
				console.error(`Cleaned up temp dir: ${tmpDir}`);
			} catch {
				// best-effort
			}
		},
	};
}

/**
 * Build a file:// URL suitable for dynamic import.
 *
 * After the TypeScript migration, src/ contains .ts files while the .js
 * extension is still used in import specifiers.  This helper checks for the
 * .ts variant first (matching the actual source) and falls back to .js so it
 * works in both local-dev and npm-published layouts.
 *
 * @param {string} srcDir  Absolute path to the codegraph src/ directory
 * @param {string} file    Relative filename within src/ (e.g. 'domain/queries.js')
 * @returns {string}       file:// URL string
 */
export function srcImport(srcDir: string, file: string): string {
	const full = path.join(srcDir, file);
	if (file.endsWith('.js')) {
		const tsVariant = full.replace(/\.js$/, '.ts');
		if (fs.existsSync(tsVariant)) return pathToFileURL(tsVariant).href;
	}
	return pathToFileURL(full).href;
}
