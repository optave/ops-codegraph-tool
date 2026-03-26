import type { Role } from '../../types.js';
import { effectiveLimit, effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'triage';

interface TriageArgs {
  level?: string;
  sort?: string;
  min_score?: number;
  role?: string;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  weights?: Record<string, number>;
  limit?: number;
  offset?: number;
}

export async function handler(args: TriageArgs, ctx: McpToolContext): Promise<unknown> {
  if (args.level === 'file' || args.level === 'directory') {
    const { hotspotsData } = await import('../../features/structure.js');
    const TRIAGE_TO_HOTSPOT: Record<string, string> = {
      risk: 'fan-in',
      complexity: 'density',
      churn: 'coupling',
      mi: 'fan-in',
    };
    const metric = TRIAGE_TO_HOTSPOT[args.sort as string] ?? args.sort;
    return hotspotsData(ctx.dbPath, {
      metric,
      level: args.level,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.hotspots ?? 100, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
      noTests: args.no_tests,
    });
  }
  const { triageData } = await import('../../features/triage.js');
  return triageData(ctx.dbPath, {
    sort: args.sort,
    minScore: args.min_score,
    role: args.role as Role | undefined,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    weights: args.weights,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
