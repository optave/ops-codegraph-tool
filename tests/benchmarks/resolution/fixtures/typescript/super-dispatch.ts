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

// Bare super(...) constructor call — same CHA parents-map resolution as
// super.method(), but for the keyword-callee constructor invocation (#1929).
// Named distinctly from hierarchy.ts's Shape/Circle/Rectangle/Ellipse to avoid
// cross-file base-class name collisions in the global CHA parents map.
export class Container {
  constructor(public label: string) {}
}

export class Box extends Container {
  constructor(
    label: string,
    public sides: number,
  ) {
    super(label); // bare super(...) → Container.constructor
  }
}
