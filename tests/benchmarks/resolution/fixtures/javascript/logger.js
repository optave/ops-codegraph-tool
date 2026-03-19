export class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  info(msg) {
    this._write('INFO', msg);
  }

  warn(msg) {
    this._write('WARN', msg);
  }

  error(msg) {
    this._write('ERROR', msg);
  }

  _write(level, msg) {
    console.log(`[${this.prefix}] ${level}: ${msg}`);
  }
}
