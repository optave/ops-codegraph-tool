class C {
  constructor() {
    // biome-ignore lint/correctness/noConstructorReturn: intentional — constructor returns function for extraction testing
    return () => {
      console.log('here');
    };
  }
}

class Parser extends C {
  constructor() {
    super();
  }
}

var x = new Parser();
x();
