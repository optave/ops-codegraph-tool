// Class hierarchy fixture — tests class-inheritance and constructor edges

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

export function makeRectangle(w: number, h: number): Rectangle {
  return new Rectangle(w, h);
}
