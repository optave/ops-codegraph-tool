import { openReadonlyOrFail } from './db.js';
import { warn } from './logger.js';
import { paginateResult, printNdjson } from './paginate.js';
import { isTestFile } from './queries.js';

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  fanIn: 0.25,
  complexity: 0.3,
  churn: 0.2,
  role: 0.15,
  mi: 0.1,
};

const ROLE_WEIGHTS = {
  core: 1.0,
  utility: 0.9,
  entry: 0.8,
  adapter: 0.5,
  leaf: 0.2,
  dead: 0.1,
};

const DEFAULT_ROLE_WEIGHT = 0.5;

// ─── Helpers ──────────────────────────────────────────────────────────

/** Min-max normalize an array of numbers. All-equal → all zeros. */
function minMaxNormalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0);
  const range = max - min;
  return values.map((v) => (v - min) / range);
}

// ─── Data Function ────────────────────────────────────────────────────

/**
 * Compute composite risk scores for all symbols.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts]
 * @returns {{ items: object[], summary: object, _pagination?: object }}
 */
export function triageData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const fileFilter = opts.file || null;
  const kindFilter = opts.kind || null;
  const roleFilter = opts.role || null;
  const minScore = opts.minScore != null ? Number(opts.minScore) : null;
  const sort = opts.sort || 'risk';
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };

  // Build WHERE clause
  let where = "WHERE n.kind IN ('function','method','class')";
  const params = [];

  if (noTests) {
    where += ` AND n.file NOT LIKE '%.test.%'
       AND n.file NOT LIKE '%.spec.%'
       AND n.file NOT LIKE '%__test__%'
       AND n.file NOT LIKE '%__tests__%'
       AND n.file NOT LIKE '%.stories.%'`;
  }
  if (fileFilter) {
    where += ' AND n.file LIKE ?';
    params.push(`%${fileFilter}%`);
  }
  if (kindFilter) {
    where += ' AND n.kind = ?';
    params.push(kindFilter);
  }
  if (roleFilter) {
    where += ' AND n.role = ?';
    params.push(roleFilter);
  }

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line, n.role,
              COALESCE(fi.cnt, 0) AS fan_in,
              COALESCE(fc.cognitive, 0) AS cognitive,
              COALESCE(fc.maintainability_index, 0) AS mi,
              COALESCE(fc.cyclomatic, 0) AS cyclomatic,
              COALESCE(fc.max_nesting, 0) AS max_nesting,
              COALESCE(fcc.commit_count, 0) AS churn
       FROM nodes n
       LEFT JOIN (SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind='calls' GROUP BY target_id) fi
         ON n.id = fi.target_id
       LEFT JOIN function_complexity fc ON fc.node_id = n.id
       LEFT JOIN file_commit_counts fcc ON n.file = fcc.file
       ${where}
       ORDER BY n.file, n.line`,
      )
      .all(...params);
  } catch (err) {
    warn(`triage query failed: ${err.message}`);
    db.close();
    return {
      items: [],
      summary: { total: 0, analyzed: 0, avgScore: 0, maxScore: 0, weights, signalCoverage: {} },
    };
  }

  // Post-filter test files (belt-and-suspenders)
  const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

  if (filtered.length === 0) {
    db.close();
    return {
      items: [],
      summary: { total: 0, analyzed: 0, avgScore: 0, maxScore: 0, weights, signalCoverage: {} },
    };
  }

  // Extract raw signal arrays
  const fanIns = filtered.map((r) => r.fan_in);
  const cognitives = filtered.map((r) => r.cognitive);
  const churns = filtered.map((r) => r.churn);
  const mis = filtered.map((r) => r.mi);

  // Min-max normalize
  const normFanIns = minMaxNormalize(fanIns);
  const normCognitives = minMaxNormalize(cognitives);
  const normChurns = minMaxNormalize(churns);
  // MI: higher is better, so invert: 1 - norm(mi)
  const normMIsRaw = minMaxNormalize(mis);
  const normMIs = normMIsRaw.map((v) => round4(1 - v));

  // Compute risk scores
  const items = filtered.map((r, i) => {
    const roleWeight = ROLE_WEIGHTS[r.role] ?? DEFAULT_ROLE_WEIGHT;
    const riskScore =
      weights.fanIn * normFanIns[i] +
      weights.complexity * normCognitives[i] +
      weights.churn * normChurns[i] +
      weights.role * roleWeight +
      weights.mi * normMIs[i];

    return {
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      role: r.role || null,
      fanIn: r.fan_in,
      cognitive: r.cognitive,
      churn: r.churn,
      maintainabilityIndex: r.mi,
      normFanIn: round4(normFanIns[i]),
      normComplexity: round4(normCognitives[i]),
      normChurn: round4(normChurns[i]),
      normMI: round4(normMIs[i]),
      roleWeight,
      riskScore: round4(riskScore),
    };
  });

  // Apply minScore filter
  const scored = minScore != null ? items.filter((it) => it.riskScore >= minScore) : items;

  // Sort
  const sortFns = {
    risk: (a, b) => b.riskScore - a.riskScore,
    complexity: (a, b) => b.cognitive - a.cognitive,
    churn: (a, b) => b.churn - a.churn,
    'fan-in': (a, b) => b.fanIn - a.fanIn,
    mi: (a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
  };
  scored.sort(sortFns[sort] || sortFns.risk);

  // Signal coverage: % of items with non-zero signal
  const signalCoverage = {
    complexity: round4(filtered.filter((r) => r.cognitive > 0).length / filtered.length),
    churn: round4(filtered.filter((r) => r.churn > 0).length / filtered.length),
    fanIn: round4(filtered.filter((r) => r.fan_in > 0).length / filtered.length),
    mi: round4(filtered.filter((r) => r.mi > 0).length / filtered.length),
  };

  const scores = scored.map((it) => it.riskScore);
  const avgScore =
    scores.length > 0 ? round4(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const maxScore = scores.length > 0 ? round4(Math.max(...scores)) : 0;

  const result = {
    items: scored,
    summary: {
      total: filtered.length,
      analyzed: scored.length,
      avgScore,
      maxScore,
      weights,
      signalCoverage,
    },
  };

  db.close();

  return paginateResult(result, 'items', {
    limit: opts.limit,
    offset: opts.offset,
  });
}

// ─── CLI Formatter ────────────────────────────────────────────────────

/**
 * Print triage results to console.
 *
 * @param {string} [customDbPath]
 * @param {object} [opts]
 */
export function triage(customDbPath, opts = {}) {
  const data = triageData(customDbPath, opts);

  if (opts.ndjson) {
    printNdjson(data, 'items');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.items.length === 0) {
    if (data.summary.total === 0) {
      console.log('\nNo symbols found. Run "codegraph build" first.\n');
    } else {
      console.log('\nNo symbols match the given filters.\n');
    }
    return;
  }

  console.log('\n# Risk Audit Queue\n');

  console.log(
    `  ${'Symbol'.padEnd(35)} ${'File'.padEnd(28)} ${'Role'.padEnd(8)} ${'Score'.padStart(6)} ${'Fan-In'.padStart(7)} ${'Cog'.padStart(4)} ${'Churn'.padStart(6)} ${'MI'.padStart(5)}`,
  );
  console.log(
    `  ${'─'.repeat(35)} ${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(5)}`,
  );

  for (const it of data.items) {
    const name = it.name.length > 33 ? `${it.name.slice(0, 32)}…` : it.name;
    const file = it.file.length > 26 ? `…${it.file.slice(-25)}` : it.file;
    const role = (it.role || '-').padEnd(8);
    const score = it.riskScore.toFixed(2).padStart(6);
    const fanIn = String(it.fanIn).padStart(7);
    const cog = String(it.cognitive).padStart(4);
    const churn = String(it.churn).padStart(6);
    const mi = it.maintainabilityIndex > 0 ? String(it.maintainabilityIndex).padStart(5) : '    -';
    console.log(
      `  ${name.padEnd(35)} ${file.padEnd(28)} ${role} ${score} ${fanIn} ${cog} ${churn} ${mi}`,
    );
  }

  const s = data.summary;
  console.log(
    `\n  ${s.analyzed} symbols scored (of ${s.total} total) | avg: ${s.avgScore.toFixed(2)} | max: ${s.maxScore.toFixed(2)} | sort: ${opts.sort || 'risk'}`,
  );
  console.log();
}

// ─── Utilities ────────────────────────────────────────────────────────

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
