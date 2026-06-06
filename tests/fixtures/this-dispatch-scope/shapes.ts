// Three unrelated classes in one file, each with an area() method.
// this.area() inside Shape.describe must resolve only to Shape.area,
// not to Calculator.area or Formatter.area.

export class Shape {
  describe(): string {
    return `area=${this.area()}`;
  }
  area(): number {
    return 0;
  }
}

export class Calculator {
  area(): number {
    return 100;
  }
}

export class Formatter {
  area(): string {
    return 'n/a';
  }
}
