import fs from 'node:fs';
import { openReadonlyOrFail } from '../../db.js';
import {
  exportDOT,
  exportGraphML,
  exportGraphSON,
  exportJSON,
  exportMermaid,
  exportNeo4jCSV,
} from '../../export.js';

export const command = {
  name: 'export',
  description: 'Export dependency graph as DOT, Mermaid, JSON, GraphML, GraphSON, or Neo4j CSV',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-f, --format <format>', 'Output format: dot, mermaid, json, graphml, graphson, neo4j', 'dot'],
    ['--functions', 'Function-level graph instead of file-level'],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['--min-confidence <score>', 'Minimum edge confidence threshold (default: 0.5)', '0.5'],
    ['--direction <dir>', 'Flowchart direction for Mermaid: TB, LR, RL, BT', 'LR'],
    ['-o, --output <file>', 'Write to file instead of stdout'],
  ],
  execute(_args, opts, ctx) {
    const db = openReadonlyOrFail(opts.db);
    const exportOpts = {
      fileLevel: !opts.functions,
      noTests: ctx.resolveNoTests(opts),
      minConfidence: parseFloat(opts.minConfidence),
      direction: opts.direction,
    };

    let output;
    switch (opts.format) {
      case 'mermaid':
        output = exportMermaid(db, exportOpts);
        break;
      case 'json':
        output = JSON.stringify(exportJSON(db, exportOpts), null, 2);
        break;
      case 'graphml':
        output = exportGraphML(db, exportOpts);
        break;
      case 'graphson':
        output = JSON.stringify(exportGraphSON(db, exportOpts), null, 2);
        break;
      case 'neo4j': {
        const csv = exportNeo4jCSV(db, exportOpts);
        if (opts.output) {
          const base = opts.output.replace(/\.[^.]+$/, '') || opts.output;
          fs.writeFileSync(`${base}-nodes.csv`, csv.nodes, 'utf-8');
          fs.writeFileSync(`${base}-relationships.csv`, csv.relationships, 'utf-8');
          db.close();
          console.log(`Exported to ${base}-nodes.csv and ${base}-relationships.csv`);
          return;
        }
        output = `--- nodes.csv ---\n${csv.nodes}\n\n--- relationships.csv ---\n${csv.relationships}`;
        break;
      }
      default:
        output = exportDOT(db, exportOpts);
        break;
    }

    db.close();

    if (opts.output) {
      fs.writeFileSync(opts.output, output, 'utf-8');
      console.log(`Exported ${opts.format} to ${opts.output}`);
    } else {
      console.log(output);
    }
  },
};
