const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
export function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}
