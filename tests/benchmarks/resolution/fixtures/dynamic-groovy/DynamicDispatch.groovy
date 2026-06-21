// Fixture: Groovy dynamic dispatch patterns
// invokeMethod("name", args) → resolved as reflection kind
// obj."$dyn"() → flagged as unresolved-dynamic

class DynamicDispatch {

    def greet(String name) {
        "Hello, ${name}"
    }

    def farewell(String name) {
        "Goodbye, ${name}"
    }

    // obj.invokeMethod("greet", args) — explicit dynamic dispatch; resolved if literal
    def runInvokeMethod(Object obj) {
        obj.invokeMethod("greet", ["world"])
    }

    // obj."$dyn"() — GString method name; not statically resolvable
    def runGStringMethod(Object obj, String dyn) {
        obj."${dyn}"("world")
    }
}
