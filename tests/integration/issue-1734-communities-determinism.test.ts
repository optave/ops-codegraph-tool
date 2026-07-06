/**
 * Regression test for #1734: `codegraph communities --drift` produced
 * different modularity/community assignments across separate full rebuilds
 * of byte-identical source code.
 *
 * Root causes (both fixed):
 *  1. The native build pipeline collected parsed file symbols into a
 *     `std::collections::HashMap` (`crates/codegraph-core/.../pipeline.rs`),
 *     whose iteration order is randomized per-process. That order drove
 *     node/edge insertion order into SQLite, so the same file could get a
 *     different autoincrement `id` — and hence a different position in the
 *     in-memory graph — on every rebuild.
 *  2. The native Louvain local-move phase (`graph/algorithms/louvain.rs`)
 *     accumulated per-candidate-community weights in a `HashMap`, so a
 *     genuine tie in modularity gain was broken by hashmap iteration order
 *     instead of a reproducible rule, even with a fixed random seed.
 *
 * This test builds a small but non-trivial fixture (three tightly-connected
 * clusters bridged by one file that imports equally from each) into two
 * independent full rebuilds and asserts the community-detection output is
 * identical between them — exercising the real end-to-end pipeline rather
 * than just the in-memory algorithm.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder/pipeline.js';
import { communitiesData } from '../../src/features/communities.js';

let tmpDir: string;
const dbPathA = () => path.join(tmpDir, 'a.db');
const dbPathB = () => path.join(tmpDir, 'b.db');

function clusterFile(clusterName: string, index: number, peers: number[]): string {
  const imports = peers
    .map((p) => `import { ${clusterName}${p} } from './${clusterName}${p}.js';`)
    .join('\n');
  const uses = peers.map((p) => `  ${clusterName}${p}();`).join('\n');
  return `${imports}
export function ${clusterName}${index}() {
${uses}
  return ${index};
}
`;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-communities-determinism-'));

  // Three fully-connected triangles (clusters A, B, C) — each file imports
  // both peers in its own cluster.
  for (const cluster of ['a', 'b', 'c']) {
    for (let i = 1; i <= 3; i++) {
      const peers = [1, 2, 3].filter((p) => p !== i);
      fs.writeFileSync(path.join(tmpDir, `${cluster}${i}.js`), clusterFile(cluster, i, peers));
    }
  }

  // Bridge file imports equally from one member of each cluster — symmetric
  // three-way tie, mirroring the unit-level regression test in
  // tests/graph/algorithms/louvain.test.ts.
  fs.writeFileSync(
    path.join(tmpDir, 'bridge.js'),
    `import { a1 } from './a1.js';
import { b1 } from './b1.js';
import { c1 } from './c1.js';
export function bridge() {
  a1();
  b1();
  c1();
}
`,
  );
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

  // Two independent full rebuilds of the identical source, into separate DBs.
  await buildGraph(tmpDir, { dbPath: dbPathA(), incremental: false });
  await buildGraph(tmpDir, { dbPath: dbPathB(), incremental: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('communities determinism across independent full rebuilds (#1734)', () => {
  it('produces identical modularity and community structure', () => {
    const resultA = communitiesData(dbPathA(), { noTests: true });
    const resultB = communitiesData(dbPathB(), { noTests: true });

    expect(resultA.modularity).toBe(resultB.modularity);
    expect((resultA.summary as { communityCount: number }).communityCount).toBe(
      (resultB.summary as { communityCount: number }).communityCount,
    );
    expect((resultA.summary as { driftScore: number }).driftScore).toBe(
      (resultB.summary as { driftScore: number }).driftScore,
    );

    // Compare full community structure (files grouped per community, not raw
    // numeric community IDs — those are arbitrary labels and may legitimately
    // differ in assignment order between independent runs even when the
    // underlying grouping is identical).
    type CommunityShape = { members?: Array<{ file: string }> };
    const toFileSets = (data: Record<string, unknown>): string[][] =>
      (data.communities as CommunityShape[])
        .map((c) => (c.members ?? []).map((m) => m.file).sort())
        .sort((x, y) => x.join(',').localeCompare(y.join(',')));

    expect(toFileSets(resultA)).toEqual(toFileSets(resultB));

    // Drift output (the exact shape returned by `communities --drift`) must
    // also match byte-for-byte.
    const driftA = communitiesData(dbPathA(), { noTests: true, drift: true });
    const driftB = communitiesData(dbPathB(), { noTests: true, drift: true });
    expect(driftA).toEqual(driftB);
  });
});
