import { snapshotDelete, snapshotList, snapshotRestore, snapshotSave } from '../../snapshot.js';

export const command = {
  name: 'snapshot',
  description: 'Save and restore graph database snapshots',
  subcommands: [
    {
      name: 'save <name>',
      description: 'Save a snapshot of the current graph database',
      options: [
        ['-d, --db <path>', 'Path to graph.db'],
        ['--force', 'Overwrite existing snapshot'],
      ],
      execute([name], opts, ctx) {
        try {
          const result = snapshotSave(name, { dbPath: opts.db, force: opts.force });
          console.log(`Snapshot saved: ${result.name} (${ctx.formatSize(result.size)})`);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
      },
    },
    {
      name: 'restore <name>',
      description: 'Restore a snapshot over the current graph database',
      options: [['-d, --db <path>', 'Path to graph.db']],
      execute([name], opts) {
        try {
          snapshotRestore(name, { dbPath: opts.db });
          console.log(`Snapshot "${name}" restored.`);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
      },
    },
    {
      name: 'list',
      description: 'List all saved snapshots',
      options: [
        ['-d, --db <path>', 'Path to graph.db'],
        ['-j, --json', 'Output as JSON'],
      ],
      execute(_args, opts, ctx) {
        try {
          const snapshots = snapshotList({ dbPath: opts.db });
          if (opts.json) {
            console.log(JSON.stringify(snapshots, null, 2));
          } else if (snapshots.length === 0) {
            console.log('No snapshots found.');
          } else {
            console.log(`Snapshots (${snapshots.length}):\n`);
            for (const s of snapshots) {
              console.log(
                `  ${s.name.padEnd(30)} ${ctx.formatSize(s.size).padStart(10)}  ${s.createdAt.toISOString()}`,
              );
            }
          }
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
      },
    },
    {
      name: 'delete <name>',
      description: 'Delete a saved snapshot',
      options: [['-d, --db <path>', 'Path to graph.db']],
      execute([name], opts) {
        try {
          snapshotDelete(name, { dbPath: opts.db });
          console.log(`Snapshot "${name}" deleted.`);
        } catch (err) {
          console.error(err.message);
          process.exit(1);
        }
      },
    },
  ],
};
