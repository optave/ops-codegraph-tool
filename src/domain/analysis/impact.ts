/**
 * impact.ts — Re-export barrel for backward compatibility.
 *
 * The implementation has been split into focused modules:
 * - fn-impact.ts: bfsTransitiveCallers, impactAnalysisData, fnImpactData
 * - diff-impact.ts: diffImpactData and git diff analysis helpers
 *
 * Note: diffImpactMermaid lives in presentation/diff-impact-mermaid.ts and is
 * re-exported from domain/queries.ts (not here) to avoid a domain → presentation
 * dependency edge.
 */

export { diffImpactData } from './diff-impact.js';
export { bfsTransitiveCallers, fnImpactData, impactAnalysisData } from './fn-impact.js';
