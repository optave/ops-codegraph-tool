/**
 * Compute the benchmark version string from git state.
 *
 * Uses the same strategy as publish.yml's compute-version job:
 *   1. `git describe --tags --match "v*" --abbrev=0` → find nearest release tag
 *   2. `git rev-list <tag>..HEAD --count` → count commits since that tag
 *
 * - If HEAD is exactly tagged (0 commits): returns "3.1.5"
 * - Otherwise: returns "3.1.6-dev.12" (NEXT_PATCH-dev.COMMIT_COUNT)
 *   This keeps dev versions in the correct semver range between the
 *   current release and the next, avoiding inflated patch numbers.
 *
 * This prevents dev/dogfood benchmark runs from overwriting release data
 * in the historical benchmark reports (which deduplicate by version).
 */

import { execFileSync } from 'node:child_process';

const GIT_OPTS = { encoding: 'utf8', timeout: 10_000 };

export function getBenchmarkVersion(pkgVersion, cwd) {
	try {
		// Step 1: find the nearest release tag (mirrors publish.yml --abbrev=0)
		const tag = execFileSync('git', ['describe', '--tags', '--match', 'v*', '--abbrev=0'], {
			cwd,
			...GIT_OPTS,
		}).trim();

		// Step 2: count commits since that tag (mirrors publish.yml git rev-list)
		const commits = Number(
			execFileSync('git', ['rev-list', `${tag}..HEAD`, '--count'], { cwd, ...GIT_OPTS }).trim(),
		);

		const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
		if (!m) return `${pkgVersion}-dev`;

		const [, major, minor, patch] = m;

		// Exact tag (0 commits since tag): return clean release version
		if (commits === 0) return `${major}.${minor}.${patch}`;

		// Dev build: MAJOR.MINOR.(PATCH+1)-dev.COMMITS
		const nextPatch = Number(patch) + 1;
		return `${major}.${minor}.${nextPatch}-dev.${commits}`;
	} catch {
		/* git not available or no tags */
	}

	// Fallback: no git or no tags — match publish.yml's no-tags behavior (COMMITS=1)
	const parts = pkgVersion.split('.');
	if (parts.length === 3) {
		const [major, minor, patch] = parts;
		return `${major}.${minor}.${Number(patch) + 1}-dev.1`;
	}
	return `${pkgVersion}-dev`;
}
