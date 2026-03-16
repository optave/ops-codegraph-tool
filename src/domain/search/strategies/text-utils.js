/**
 * Split an identifier into readable words.
 * camelCase/PascalCase -> "camel Case", snake_case -> "snake case", kebab-case -> "kebab case"
 */
export function splitIdentifier(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * Extract leading comment text (JSDoc, //, #, etc.) above a function line.
 * Returns the cleaned comment text or null if none found.
 */
export function extractLeadingComment(lines, fnLineIndex) {
  if (fnLineIndex > lines.length) return null;
  const raw = [];
  for (let i = fnLineIndex - 1; i >= Math.max(0, fnLineIndex - 15); i--) {
    if (i >= lines.length) continue;
    const trimmed = lines[i].trim();
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
        .replace(/^\/\*\*?\s?|\*\/$/g, '') // opening /** or /* and closing */
        .replace(/^\*\s?/, '') // middle * lines
        .replace(/^\/\/\/?\s?/, '') // // or ///
        .replace(/^#\s?/, '') // # (Python/Ruby)
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join(' ');
}
