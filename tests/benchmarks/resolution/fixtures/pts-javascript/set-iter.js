// pts-set: for-of loop over a Set constructed from an array of function literals
function setFn1() {}
function setFn2() {}

function iterSet() {
  const arr = [setFn1, setFn2];
  const s = new Set(arr);
  for (const cb of s) {
    cb();
  }
}
