/**
 * Node >= 22.6 supports --experimental-strip-types, required for tests that
 * spawn child processes loading .ts source files directly.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
export const canStripTypes = major > 22 || (major === 22 && minor >= 6);
