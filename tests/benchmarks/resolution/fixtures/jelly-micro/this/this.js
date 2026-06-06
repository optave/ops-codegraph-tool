// Jelly micro-test: this — function-as-object property methods, this-dispatch

function f() {}
f.g = function() { console.log("2"); }
f.h = function() {
    this.g();  // this === f when called as f.h()
}
f.h();
