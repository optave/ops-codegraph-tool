// pts-for-of: for-of loop over plain array of function literals
function forOf1() {}
function forOf2() {}

function iterPlain() {
  const arr = [forOf1, forOf2];
  for (const cb of arr) {
    cb();
  }
}
