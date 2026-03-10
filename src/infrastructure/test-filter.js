/** Pattern matching test/spec/stories files. */
export const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;

/** Check whether a file path looks like a test file. */
export function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}
