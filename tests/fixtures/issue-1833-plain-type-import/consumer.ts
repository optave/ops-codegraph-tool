// Plain import — no `type` keyword — of an interface (Config) and a type
// alias (Mode), used only in type position below. TypeScript allows
// importing type-level declarations this way; codegraph must still credit
// Config/Mode as consumed since interfaces/type aliases are erased before
// runtime and can never receive a `calls` edge (#1833).
import { Config, Mode } from './types.js';

export function useConfig(cfg: Config): Mode {
  return cfg.name.length > 0 ? 'fast' : 'slow';
}
