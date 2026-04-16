/**
 * Stage: runAnalyses
 *
 * Dispatches to the unified AST analysis engine (AST nodes, complexity, CFG, dataflow).
 * Reverse-dep files are no longer in allSymbols (they are not reparsed since #932/#933),
 * so no filtering is needed here.
 */
import { warn } from '../../../../infrastructure/logger.js';
import type { PipelineContext } from '../context.js';

export async function runAnalyses(ctx: PipelineContext): Promise<void> {
  const { db, allSymbols, rootDir, opts, engineOpts } = ctx;

  const { runAnalyses: runAnalysesFn } = await import('../../../../ast-analysis/engine.js');
  try {
    const analysisTiming = await runAnalysesFn(db, allSymbols, rootDir, opts, engineOpts);
    ctx.timing.astMs = analysisTiming.astMs;
    ctx.timing.complexityMs = analysisTiming.complexityMs;
    ctx.timing.cfgMs = analysisTiming.cfgMs;
    ctx.timing.dataflowMs = analysisTiming.dataflowMs;
  } catch (err) {
    warn(
      `Analysis engine failed (AST/complexity/CFG/dataflow may be incomplete): ${(err as Error).message}`,
    );
  }
}
