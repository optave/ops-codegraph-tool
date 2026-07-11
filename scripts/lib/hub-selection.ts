/**
 * Deterministic hub/mid/leaf target selection for benchmark scripts.
 *
 * `query-benchmark.ts` and `benchmark.ts` each pick representative call-graph
 * nodes ("hub" = well-connected, "mid"/"leaf" = less connected) by `name` to
 * drive their timed queries. Both independently duplicated a `selectTargets`
 * query that filtered candidates by file path (`NOT LIKE '%test%'`/`'%spec%'`)
 * but not by `kind` — so a hub-candidate name like `buildGraph` could resolve
 * to a local `const { buildGraph } = await import(...)` binding (`kind =
 * 'constant'`) instead of the real `function buildGraph` definition, and
 * which node won depended on unspecified SQLite row order (#1904).
 *
 * This module is the single source of truth for that selection: it filters
 * to `HUB_CANDIDATE_KINDS` (mirroring `CALLABLE_SYMBOL_KINDS` in
 * `src/shared/kinds.ts`, #1888 — the same "same-name lookup with no other
 * signal" hazard) and adds an explicit `ORDER BY id` tie-break so the choice
 * is reproducible across builds that insert the same logical nodes in a
 * different physical row order (e.g. worker-thread parse completion order).
 *
 * Callers that need to act on the resolved hub's file (e.g. `benchDiffImpact`
 * writing a probe comment into it) should use the `hubFile` this returns
 * instead of re-querying `nodes` by name — a second unfiltered query can
 * disagree with this one about which physical node "the hub" is.
 */

import Database from 'better-sqlite3';

// Symbol kinds that represent a real invocable definition. Local variable
// and constant bindings must never win hub selection just because they share
// a candidate's name — mirrors CALLABLE_SYMBOL_KINDS in src/shared/kinds.ts.
export const HUB_CANDIDATE_KINDS: readonly string[] = ['function', 'method'];

// Pinned hub targets — stable function names expected to exist across
// versions. Auto-selecting the most-connected node makes version-to-version
// comparison meaningless whenever the most-connected function changes (e.g.
// a barrel/type file gets added or removed, or a new heavily-called utility
// shifts the ranking) — pinning keeps "the hub" identity stable so
// back-to-back benchmark runs measure the same node. Shared by both
// query-benchmark.ts and benchmark.ts so the two scripts can't drift apart
// on which names they consider stable.
export const PINNED_HUB_CANDIDATES: readonly string[] = ['buildGraph', 'openDb', 'loadConfig'];

export interface HubTargets {
	hub: string;
	hubFile: string;
	mid: string;
	leaf: string;
}

interface NodeRow {
	name: string;
	file: string;
}

interface RankedNodeRow extends NodeRow {
	cnt: number;
}

/**
 * Selects stable, deterministic hub/mid/leaf targets from a freshly-built
 * graph DB at `dbPath`.
 *
 * `pinnedCandidates` are tried in order (each filtered to
 * `HUB_CANDIDATE_KINDS` and non-test files) before falling back to the
 * most-connected qualifying node — pinning keeps the "hub" identity stable
 * across versions where auto-selection would otherwise drift as files are
 * added or removed.
 *
 * Throws if the graph has no qualifying nodes with edges at all (an empty or
 * malformed build), rather than silently returning a name that resolves to
 * nothing downstream.
 */
export function selectHubTargets(dbPath: string, pinnedCandidates: readonly string[] = []): HubTargets {
	const db = new Database(dbPath, { readonly: true });
	try {
		const kindPlaceholders = HUB_CANDIDATE_KINDS.map(() => '?').join(', ');

		let hub: string | null = null;
		let hubFile: string | null = null;
		for (const candidate of pinnedCandidates) {
			const row = db
				.prepare(
					`SELECT n.name, n.file FROM nodes n
           JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
           WHERE n.name = ? AND n.kind IN (${kindPlaceholders})
             AND n.file NOT LIKE '%test%' AND n.file NOT LIKE '%spec%'
           ORDER BY n.id ASC
           LIMIT 1`,
				)
				.get(candidate, ...HUB_CANDIDATE_KINDS) as NodeRow | undefined;
			if (row) {
				hub = row.name;
				hubFile = row.file;
				break;
			}
		}

		const rows = db
			.prepare(
				`SELECT n.id, n.name, n.file, COUNT(e.id) AS cnt
         FROM nodes n
         JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
         WHERE n.kind IN (${kindPlaceholders})
           AND n.file NOT LIKE '%test%' AND n.file NOT LIKE '%spec%'
         GROUP BY n.id
         ORDER BY cnt DESC, n.id ASC`,
			)
			.all(...HUB_CANDIDATE_KINDS) as RankedNodeRow[];

		if (rows.length === 0) {
			throw new Error('No nodes with edges found in graph');
		}

		if (!hub) {
			hub = rows[0].name;
			hubFile = rows[0].file;
		}

		const mid = rows[Math.floor(rows.length / 2)].name;
		const leaf = rows[rows.length - 1].name;

		return { hub, hubFile: hubFile as string, mid, leaf };
	} finally {
		db.close();
	}
}
