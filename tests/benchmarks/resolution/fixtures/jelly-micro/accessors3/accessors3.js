// Micro-test: Object.defineProperty accessor this-dispatch.
// When getter is registered as a get accessor for obj, this inside getter === obj.
// So this.baz() inside getter must resolve to baz (the arrow function on obj).

const obj = {
  baz: () => {
    console.log('baz');
  },
};

function getter() {
  this.baz();
}

Object.defineProperty(obj, 'bar', { get: getter });

const _x = obj.bar;
