import type { ASTNodeKind } from '../../types.js';
import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'ast_query';

interface AstQueryArgs {
  pattern?: string;
  kind?: ASTNodeKind;
  file?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: AstQueryArgs, ctx: McpToolContext): Promise<unknown> {
  const { astQueryData } = await import('../../features/ast.js');
  return astQueryData(args.pattern, ctx.dbPath, {
    kind: args.kind,
    file: args.file,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
