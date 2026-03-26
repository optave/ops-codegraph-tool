import { findDbPath } from '../../db/index.js';
import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'export_graph';

interface ExportGraphArgs {
  format: string;
  file_level?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: ExportGraphArgs, ctx: McpToolContext): Promise<unknown> {
  const { exportDOT, exportGraphML, exportGraphSON, exportJSON, exportMermaid, exportNeo4jCSV } =
    await import('../../features/export.js');
  const Database = ctx.getDatabase();
  const db = new Database(findDbPath(ctx.dbPath), { readonly: true });
  const fileLevel = args.file_level !== false;
  const exportLimit = args.limit
    ? Math.min(args.limit, MCP_MAX_LIMIT)
    : (MCP_DEFAULTS.export_graph ?? 500);

  let result: unknown;
  try {
    switch (args.format) {
      case 'dot':
        result = exportDOT(db, { fileLevel, limit: exportLimit });
        break;
      case 'mermaid':
        result = exportMermaid(db, { fileLevel, limit: exportLimit });
        break;
      case 'json':
        result = exportJSON(db, {
          limit: exportLimit,
          offset: effectiveOffset(args),
        });
        break;
      case 'graphml':
        result = exportGraphML(db, { fileLevel, limit: exportLimit });
        break;
      case 'graphson':
        result = exportGraphSON(db, {
          fileLevel,
          limit: exportLimit,
          offset: effectiveOffset(args),
        });
        break;
      case 'neo4j':
        result = exportNeo4jCSV(db, { fileLevel, limit: exportLimit });
        break;
      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown format: ${args.format}. Use dot, mermaid, json, graphml, graphson, or neo4j.`,
            },
          ],
          isError: true,
        };
    }
  } finally {
    db.close();
  }
  return result;
}
