export function globMatch(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  let regex = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  regex = regex.replace(/\*\*/g, '\0');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/\0/g, '.*');
  regex = regex.replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${regex}$`).test(normalized);
  } catch {
    return normalized.includes(pattern);
  }
}

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;

export interface FilterOpts {
  filePattern?: string | string[];
  noTests?: boolean;
}

export function applyFilters<T extends { file: string }>(rows: T[], opts: FilterOpts = {}): T[] {
  let filtered = rows;
  const fp = opts.filePattern;
  const fpArr = Array.isArray(fp) ? fp : fp ? [fp] : [];
  if (fpArr.length > 0) {
    filtered = filtered.filter((row) =>
      fpArr.some((p) => {
        const patternIsGlob = /[*?[\]]/.test(p);
        return patternIsGlob ? globMatch(row.file, p) : row.file.includes(p);
      }),
    );
  }
  if (opts.noTests) {
    filtered = filtered.filter((row) => !TEST_PATTERN.test(row.file));
  }
  return filtered;
}
