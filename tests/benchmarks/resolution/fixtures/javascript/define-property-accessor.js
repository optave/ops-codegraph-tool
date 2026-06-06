// Object.defineProperty accessor this-dispatch fixture (issue #1335).
// When a function is registered as a get accessor via Object.defineProperty,
// this inside that function refers to the target object.

const accessorTarget = {
  accessMethod: () => 42,
};

function accessorGetter() {
  this.accessMethod();
}

Object.defineProperty(accessorTarget, 'computed', { get: accessorGetter });

export function runAccessorThisDispatch() {
  return accessorTarget.computed;
}
