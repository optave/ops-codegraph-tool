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
    // biome-ignore lint/complexity/noThisInStatic: intentional super call for class-inheritance resolution test
    return super.count() * 2; // static super.method() → Counter.count
  }
}
