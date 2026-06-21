// Fixture: Kotlin callable reference patterns
// ::greet → resolved as reflection kind
// invoke() → flagged as unresolved-dynamic

fun greet(name: String): String = "Hello, $name"

fun farewell(name: String): String = "Goodbye, $name"

// ::greet callable reference — resolved to top-level greet()
fun runCallableRef(): (String) -> String {
    return ::greet
}

// ::farewell callable reference — resolved to top-level farewell()
fun runFarewellRef(): (String) -> String {
    return ::farewell
}

// fn.invoke(args) — unresolved; fn could be any callable
fun runInvoke(fn: (String) -> String): String {
    return fn.invoke("world")
}

// Member callable reference: Greeter::greet must resolve to Greeter.greet,
// not the top-level greet() above, even though both share the same name.
class Greeter {
    fun greet(name: String): String = "Hi, $name"
}

fun runMemberCallableRef(): (Greeter, String) -> String {
    return Greeter::greet
}
