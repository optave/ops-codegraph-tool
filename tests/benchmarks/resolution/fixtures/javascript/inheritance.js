// Class hierarchy fixture — tests super.method() dispatch (class-inheritance resolution)

export class Animal {
  speak() {
    return 'generic sound';
  }
}

export class Dog extends Animal {
  speak() {
    super.speak(); // super.method() → Animal.speak
    return 'woof';
  }
}

export class Puppy extends Dog {
  speak() {
    super.speak(); // super.method() → Dog.speak (nearest parent, not Animal)
    return 'yip';
  }
}

// Static super.method() — same resolution path as instance methods
export class Counter {
  static count() {
    return 0;
  }
}

export class DoubleCounter extends Counter {
  static count() {
    return super.count() * 2; // static super.count() → Counter.count via CHA parents map
  }
}

// Bare super(...) constructor call — same CHA parents-map resolution as
// super.method(), but for the keyword-callee constructor invocation (#1929)
export class Vehicle {
  constructor(make) {
    this.make = make;
  }
}

export class Car extends Vehicle {
  constructor(make, model) {
    super(make); // bare super(...) → Vehicle.constructor
    this.model = model;
  }
}

export class SportsCar extends Car {
  constructor(make, model, topSpeed) {
    super(make, model); // bare super(...) → Car.constructor (nearest parent)
    this.topSpeed = topSpeed;
  }
}
