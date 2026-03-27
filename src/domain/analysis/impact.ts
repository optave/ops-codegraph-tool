/**
 * impact.ts — Re-export barrel for backward compatibility.
 *
 * The implementation has been split into focused modules:
 * - fn-impact.ts: bfsTransitiveCallers, impactAnalysisData, fnImpactData
 * - diff-impact.ts: diffImpactData and git diff analysis helpers
 * - presentation/diff-impact-mermaid.ts: diffImpactMermaid (Mermaid diagram generation)
 */

export { diffImpactData } from './diff-impact.js';
export { bfsTransitiveCallers, fnImpactData, impactAnalysisData } from './fn-impact.js';
