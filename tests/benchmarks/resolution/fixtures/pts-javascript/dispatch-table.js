// pts-dispatch-table: inline object-literal subscript dispatch {a:fnA,b:fnB}[k]()
function dtFn1() {}
function dtFn2() {}

function runDispatch(key) {
  ({ a: dtFn1, b: dtFn2 })[key]();
}
