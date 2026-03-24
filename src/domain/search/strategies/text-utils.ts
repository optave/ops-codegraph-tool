/**
 * Split an identifier into readable words.
 */
export function splitIdentifier(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * Extract leading comment text above a function line.
 */
export function extractLeadingComment(lines: string[], fnLineIndex: number): string | null {
  if (fnLineIndex > lines.length) return null;
  const raw: string[] = [];
  for (let i = fnLineIndex - 1; i >= Math.max(0, fnLineIndex - 15); i--) {
    if (i >= lines.length) continue;
    const trimmed = lines[i]!.trim();
    if (/^(\/\/|\/\*|\*\/|\*|#|\/\/\/)/.test(trimmed)) {
      raw.unshift(trimmed);
    } else if (trimmed === '') {
      if (raw.length > 0) break;
    } else {
      break;
    }
  }
  if (raw.length === 0) return null;
  return raw
    .map((line) =>
      line
        .replace(/^\/\*\*?\s?|\*\/$/g, '')
        .replace(/^\*\s?/, '')
        .replace(/^\/\/\/?\s?/, '')
        .replace(/^#\s?/, '')
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join(' ');
}
