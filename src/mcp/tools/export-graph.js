import { findDbPath } from '../../db.js';
import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';

export const name = 'export_graph';

export async function handler(args, ctx) {
  const { exportDOT, exportGraphML, exportGraphSON, exportJSON, exportMermaid, exportNeo4jCSV } =
    await import('../../export.js');
  const Database = ctx.getDatabase();
  const db = new Database(findDbPath(ctx.dbPath), { readonly: true });
  const fileLevel = args.file_level !== false;
  const exportLimit = args.limit ? Math.min(args.limit, MCP_MAX_LIMIT) : MCP_DEFAULTS.export_graph;

  let result;
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
      db.close();
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
  db.close();
  return result;
}
