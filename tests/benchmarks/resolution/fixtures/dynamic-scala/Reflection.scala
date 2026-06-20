// Fixture: Scala reflection patterns
// getMethod("name") → resolved as reflection kind
// invoke() → flagged as unresolved-dynamic

object Reflection {

  def greet(name: String): String = s"Hello, $name"

  def farewell(name: String): String = s"Goodbye, $name"

  // clazz.getMethod("greet") — resolved to greet() via reflection key
  def runGetMethod(clazz: Class[_]): java.lang.reflect.Method = {
    clazz.getMethod("greet", classOf[String])
  }

  // method.invoke(target, args) — unresolved; runtime reflection
  def runInvoke(method: java.lang.reflect.Method, target: Object): Object = {
    method.invoke(target, "world")
  }
}
