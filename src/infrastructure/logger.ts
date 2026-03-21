let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}
export function isVerbose(): boolean {
  return verbose;
}

export function warn(msg: string): void {
  process.stderr.write(`[codegraph WARN] ${msg}\n`);
}

export function debug(msg: string): void {
  if (verbose) process.stderr.write(`[codegraph DEBUG] ${msg}\n`);
}

export function info(msg: string): void {
  process.stderr.write(`[codegraph] ${msg}\n`);
}

export function error(msg: string): void {
  process.stderr.write(`[codegraph ERROR] ${msg}\n`);
}
