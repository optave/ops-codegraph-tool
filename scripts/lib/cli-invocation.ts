/**
 * Resolve `node` argv for spawning the codegraph CLI as a subprocess.
 *
 * Benchmark scripts (`token-benchmark.ts`) need to run the actual
 * `codegraph` CLI (`build`, `mcp`) against a target directory, not just
 * import its programmatic API. This repo ships TypeScript source with no
 * compiled `dist/` required for local development, so `node <root>/src/cli.js`
 * fails outright — only `cli.ts` exists (#1907). Even after fixing the
 * extension, a spawned child process doesn't inherit the parent's
 * `--experimental-strip-types` / `--import <loader>` flags the way
 * statically- or dynamically-imported modules in the parent process do, so
 * those flags must be passed explicitly. Mirrors the pattern already used by
 * `tests/integration/cli.test.ts`'s `NODE_TS_FLAGS`.
 */
import path from 'node:path';

/**
 * @param root Absolute path to the codegraph repo root (the directory
 *   containing `src/`, not `src/` itself).
 * @returns argv (excluding `node` itself) to spawn `src/cli.ts` with the
 *   flags required to run TypeScript source directly.
 */
export function resolveCliNodeArgs(root: string): string[] {
	const loaderUrl = new URL('../ts-resolve-loader.ts', import.meta.url).href;
	return ['--experimental-strip-types', '--import', loaderUrl, path.join(root, 'src', 'cli.ts')];
}
