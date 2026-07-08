export class Repository {
  getAll(): void {}
}

export interface Readable {
  read(): void;
}

// Only same-language-family declaration of this name in the fixture (the
// decoy Python file below shares the name but is a different language).
export class UniqueBase {
  identify(): void {}
}
