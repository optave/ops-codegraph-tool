import { prepareGraphData } from '../features/graph-enrichment.js';
import type { BetterSqlite3Database } from '../types.js';
import { DEFAULT_CONFIG, type PlotConfig, renderPlotHTML } from './viewer.js';

/**
 * Generate a full interactive HTML plot document for the dependency graph.
 * Thin wrapper: prepares graph data (features layer) then renders it (presentation layer).
 */
export function generatePlotHTML(
  db: BetterSqlite3Database,
  opts: {
    fileLevel?: boolean;
    noTests?: boolean;
    minConfidence?: number;
    config?: PlotConfig;
  } = {},
): string {
  const cfg = opts.config || DEFAULT_CONFIG;
  const data = prepareGraphData(db, opts);
  return renderPlotHTML(data, cfg);
}
