import { kindIcon } from '../domain/queries.js';
import { branchCompareData, branchCompareMermaid } from '../features/branch-compare.js';
import { outputResult } from '../infrastructure/result-formatter.js';

// ─── Text Formatting ────────────────────────────────────────────────────

function formatText(data) {
  if (data.error) return `Error: ${data.error}`;

  const lines = [];
  const shortBase = data.baseSha.slice(0, 7);
  const shortTarget = data.targetSha.slice(0, 7);

  lines.push(`branch-compare: ${data.baseRef}..${data.targetRef}`);
  lines.push(`  Base:   ${data.baseRef} (${shortBase})`);
  lines.push(`  Target: ${data.targetRef} (${shortTarget})`);
  lines.push(`  Files changed: ${data.changedFiles.length}`);

  if (data.added.length > 0) {
    lines.push('');
    lines.push(`  + Added (${data.added.length} symbol${data.added.length !== 1 ? 's' : ''}):`);
    for (const sym of data.added) {
      lines.push(`    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.line}`);
    }
  }

  if (data.removed.length > 0) {
    lines.push('');
    lines.push(
      `  - Removed (${data.removed.length} symbol${data.removed.length !== 1 ? 's' : ''}):`,
    );
    for (const sym of data.removed) {
      lines.push(`    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.line}`);
      if (sym.impact && sym.impact.length > 0) {
        lines.push(
          `      ^ ${sym.impact.length} transitive caller${sym.impact.length !== 1 ? 's' : ''} affected`,
        );
      }
    }
  }

  if (data.changed.length > 0) {
    lines.push('');
    lines.push(
      `  ~ Changed (${data.changed.length} symbol${data.changed.length !== 1 ? 's' : ''}):`,
    );
    for (const sym of data.changed) {
      const parts = [];
      if (sym.changes.lineCount !== 0) {
        parts.push(`lines: ${sym.base.lineCount} -> ${sym.target.lineCount}`);
      }
      if (sym.changes.fanIn !== 0) {
        parts.push(`fan_in: ${sym.base.fanIn} -> ${sym.target.fanIn}`);
      }
      if (sym.changes.fanOut !== 0) {
        parts.push(`fan_out: ${sym.base.fanOut} -> ${sym.target.fanOut}`);
      }
      const detail = parts.length > 0 ? `  (${parts.join(', ')})` : '';
      lines.push(
        `    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.base.line}${detail}`,
      );
      if (sym.impact && sym.impact.length > 0) {
        lines.push(
          `      ^ ${sym.impact.length} transitive caller${sym.impact.length !== 1 ? 's' : ''} affected`,
        );
      }
    }
  }

  const s = data.summary;
  lines.push('');
  lines.push(
    `  Summary: +${s.added} added, -${s.removed} removed, ~${s.changed} changed` +
      ` -> ${s.totalImpacted} caller${s.totalImpacted !== 1 ? 's' : ''} impacted` +
      (s.filesAffected > 0
        ? ` across ${s.filesAffected} file${s.filesAffected !== 1 ? 's' : ''}`
        : ''),
  );

  return lines.join('\n');
}

// ─── CLI Display Function ───────────────────────────────────────────────

export async function branchCompare(baseRef, targetRef, opts = {}) {
  const data = await branchCompareData(baseRef, targetRef, opts);

  if (opts.format === 'json') opts = { ...opts, json: true };
  if (outputResult(data, null, opts)) return;

  if (opts.format === 'mermaid') {
    console.log(branchCompareMermaid(data));
    return;
  }

  console.log(formatText(data));
}
