/**
 * Compute the benchmark version string from git state.
 *
 * Uses `git describe --tags --match "v*"` to find the nearest release tag
 * and derive the version from it. This keeps the strategy aligned with
 * publish.yml's compute-version job (both use git describe, not package.json).
 *
 * - If HEAD is exactly a release tag (v2.5.0): returns "2.5.0"
 * - Otherwise: returns "2.5.N-dev.hash" (e.g. "2.5.3-dev.c50f7f5")
 *   where N = commits since last release tag, hash = short commit SHA
 *
 * This prevents dev/dogfood benchmark runs from overwriting release data
 * in the historical benchmark reports (which deduplicate by version).
 */

import { execFileSync } from 'node:child_process';

export function getBenchmarkVersion(pkgVersion, cwd) {
	try {
		const desc = execFileSync('git', ['describe', '--tags', '--match', 'v*', '--always'], {
			cwd,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		}).trim();

		// Exact tag match: "v2.5.0" → "2.5.0"
		const exact = desc.match(/^v(\d+\.\d+\.\d+)$/);
		if (exact) return exact[1];

		// Dev build: "v2.5.0-3-gc50f7f5" → "2.5.3-dev.c50f7f5"
		// Format matches publish.yml: MAJOR.MINOR.(PATCH+COMMITS)-dev.SHORT_SHA
		const dev = desc.match(/^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)$/);
		if (dev) {
			const [, major, minor, patch, commits, hash] = dev;
			const devPatch = Number(patch) + Number(commits);
			return `${major}.${minor}.${devPatch}-dev.${hash}`;
		}
	} catch {
		/* git not available or no tags */
	}

	// Fallback: no git or no tags — use package.json version with dev suffix
	return `${pkgVersion}-dev`;
}
