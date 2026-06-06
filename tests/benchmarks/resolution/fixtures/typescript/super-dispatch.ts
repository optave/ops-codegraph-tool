// super.method() dispatch fixture — class-inheritance resolution
// Uses a closed hierarchy (no further subclasses) to avoid CHA fan-out
// into unrelated implementations.

export class Logger {
  log(msg: string): void {
    console.log(msg);
  }
}

export class TimestampLogger extends Logger {
  log(msg: string): void {
    super.log(`[${Date.now()}] ${msg}`); // super.method() → Logger.log
  }
}

export class PrefixLogger extends TimestampLogger {
  log(msg: string): void {
    super.log(`[PREFIX] ${msg}`); // super.method() → TimestampLogger.log (nearest parent)
  }
}
