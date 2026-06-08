// Class hierarchy fixture — tests class-inheritance and constructor edges
// Includes a 3-level hierarchy (Shape → Circle → Ellipse) to validate
// transitive CHA closure (issue #1313).

export class Shape {
  area(): number {
    return 0;
  }

  describe(): string {
    return `Area: ${this.area()}`;
  }
}

export class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}

export class Ellipse extends Circle {
  constructor(
    private rx: number,
    private ry: number,
  ) {
    super(rx);
  }

  area(): number {
    return Math.PI * this.rx * this.ry;
  }
}

export class Rectangle extends Shape {
  constructor(
    private width: number,
    private height: number,
  ) {
    super();
  }

  area(): number {
    return this.width * this.height;
  }
}

export function printShape(shape: Shape): void {
  console.log(shape.describe());
}

export function makeCircle(r: number): Circle {
  return new Circle(r);
}

export function makeEllipse(rx: number, ry: number): Ellipse {
  return new Ellipse(rx, ry);
}

export function makeRectangle(w: number, h: number): Rectangle {
  return new Rectangle(w, h);
}
