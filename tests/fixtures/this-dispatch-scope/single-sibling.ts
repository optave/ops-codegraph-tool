// Two classes in one file; only one defines area().
// this.area() inside Caller.run must NOT resolve to Sibling.area
// even when Sibling.area is the only method with that suffix in the file.
// The caller's own class (Caller) has no area() → the edge must be omitted.

export class Caller {
  run(): string {
    return `result=${this.area()}`;
  }
}

export class Sibling {
  area(): number {
    return 42;
  }
}
