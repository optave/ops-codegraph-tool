/**
 * Stage: runAnalyses
 *
 * Dispatches to the unified AST analysis engine (AST nodes, complexity, CFG, dataflow).
 * Filters out reverse-dep files for incremental builds.
 */
import { debug, warn } from '../../../../logger.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function runAnalyses(ctx) {
  const { db, allSymbols, rootDir, opts, engineOpts, isFullBuild, filesToParse } = ctx;

  // For incremental builds, exclude reverse-dep-only files
  let astComplexitySymbols = allSymbols;
  if (!isFullBuild) {
    const reverseDepFiles = new Set(
      filesToParse.filter((item) => item._reverseDepOnly).map((item) => item.relPath),
    );
    if (reverseDepFiles.size > 0) {
      astComplexitySymbols = new Map();
      for (const [relPath, symbols] of allSymbols) {
        if (!reverseDepFiles.has(relPath)) {
          astComplexitySymbols.set(relPath, symbols);
        }
      }
      debug(
        `AST/complexity/CFG/dataflow: processing ${astComplexitySymbols.size} changed files (skipping ${reverseDepFiles.size} reverse-deps)`,
      );
    }
  }

  const { runAnalyses: runAnalysesFn } = await import('../../../../ast-analysis/engine.js');
  try {
    const analysisTiming = await runAnalysesFn(db, astComplexitySymbols, rootDir, opts, engineOpts);
    ctx.timing.astMs = analysisTiming.astMs;
    ctx.timing.complexityMs = analysisTiming.complexityMs;
    ctx.timing.cfgMs = analysisTiming.cfgMs;
    ctx.timing.dataflowMs = analysisTiming.dataflowMs;
  } catch (err) {
    warn(`Analysis engine failed (AST/complexity/CFG/dataflow may be incomplete): ${err.message}`);
  }
}
