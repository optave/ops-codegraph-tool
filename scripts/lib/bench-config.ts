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
 * Parse `--version <v>` and `--npm` from process.argv.
 */
export function parseArgs() {
	const args = process.argv.slice(2);
	let version = null;
	let npm = false;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--version' && i + 1 < args.length) {
			version = args[++i];
		} else if (args[i] === '--npm') {
			npm = true;
		}
	}

	return { version, npm };
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
	const { version: cliVersion, npm } = parseArgs();

	if (!npm) {
		// Local mode — use repo src/, version derived from git state
		const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..');
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		return {
			version: cliVersion || getBenchmarkVersion(pkg.version, root),
			srcDir: path.join(root, 'src'),
			cleanup() {},
		};
	}

	// npm mode — install @optave/codegraph@<version> into a temp dir
	const version = cliVersion || 'latest';
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bench-'));

	console.error(`Installing @optave/codegraph@${version} into ${tmpDir}...`);

	// Write a minimal package.json so npm install works
	fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ private: true }));

	// Retry with backoff for npm propagation delays
	const maxRetries = 5;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			execFileSync('npm', ['install', `@optave/codegraph@${version}`, '--no-audit', '--no-fund'], {
				cwd: tmpDir,
				stdio: 'pipe',
				timeout: 120_000,
			});
			break;
		} catch (err) {
			if (attempt === maxRetries) {
				// Clean up before throwing
				fs.rmSync(tmpDir, { recursive: true, force: true });
				throw new Error(`Failed to install @optave/codegraph@${version} after ${maxRetries} attempts: ${err.message}`);
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
			const nativeVersion = optDeps[nativePkg];
			console.error(`Installing native package ${nativePkg}@${nativeVersion}...`);
			for (let attempt = 1; attempt <= maxRetries; attempt++) {
				try {
					execFileSync('npm', ['install', `${nativePkg}@${nativeVersion}`, '--no-audit', '--no-fund', '--no-save'], {
						cwd: tmpDir,
						stdio: 'pipe',
						timeout: 120_000,
					});
					break;
				} catch (innerErr) {
					if (attempt === maxRetries) throw innerErr;
					const delay = attempt * 15_000;
					console.error(`  Native install attempt ${attempt} failed, retrying in ${delay / 1000}s...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
			console.error(`Installed ${nativePkg}@${nativeVersion}`);
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
			console.error(`Installing @huggingface/transformers@${hfVersion} for embedding benchmarks...`);
			execFileSync('npm', ['install', `@huggingface/transformers@${hfVersion}`, '--no-audit', '--no-fund', '--no-save'], {
				cwd: tmpDir,
				stdio: 'pipe',
				timeout: 120_000,
			});
			console.error('Installed @huggingface/transformers');
		}
	} catch (err) {
		console.error(`Warning: failed to install @huggingface/transformers: ${err.message}`);
	}

	const srcDir = path.join(pkgDir, 'src');

	if (!fs.existsSync(srcDir)) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		throw new Error(`Installed package does not contain src/ at ${srcDir}`);
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
 * @param {string} srcDir  Absolute path to the codegraph src/ directory
 * @param {string} file    Relative filename within src/ (e.g. 'builder.js')
 * @returns {string}       file:// URL string
 */
export function srcImport(srcDir, file) {
	return pathToFileURL(path.join(srcDir, file)).href;
}
