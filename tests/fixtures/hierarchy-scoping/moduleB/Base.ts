// Unrelated declaration that happens to share a name with moduleA/Base.ts.
// A pre-#1812 bare global-by-name lookup would match this too.
export class Repository {
  save(): void {}
}

export interface Readable {
  scan(): void;
}
