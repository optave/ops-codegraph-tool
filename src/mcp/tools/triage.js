import { effectiveLimit, effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';

export const name = 'triage';

export async function handler(args, ctx) {
  if (args.level === 'file' || args.level === 'directory') {
    const { hotspotsData } = await import('../../structure.js');
    const TRIAGE_TO_HOTSPOT = {
      risk: 'fan-in',
      complexity: 'density',
      churn: 'coupling',
      mi: 'fan-in',
    };
    const metric = TRIAGE_TO_HOTSPOT[args.sort] ?? args.sort;
    return hotspotsData(ctx.dbPath, {
      metric,
      level: args.level,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.hotspots, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
      noTests: args.no_tests,
    });
  }
  const { triageData } = await import('../../triage.js');
  return triageData(ctx.dbPath, {
    sort: args.sort,
    minScore: args.min_score,
    role: args.role,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    weights: args.weights,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
