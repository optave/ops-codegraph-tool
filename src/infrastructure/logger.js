let verbose = false;

export function setVerbose(v) {
  verbose = v;
}
export function isVerbose() {
  return verbose;
}

export function warn(msg) {
  process.stderr.write(`[codegraph WARN] ${msg}\n`);
}

export function debug(msg) {
  if (verbose) process.stderr.write(`[codegraph DEBUG] ${msg}\n`);
}

export function info(msg) {
  process.stderr.write(`[codegraph] ${msg}\n`);
}

export function error(msg) {
  process.stderr.write(`[codegraph ERROR] ${msg}\n`);
}
