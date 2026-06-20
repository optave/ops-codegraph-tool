// Fixture: Java reflection patterns
// getMethod("name") → resolved as reflection kind
// invoke() → flagged as unresolved-dynamic
import java.lang.reflect.Method;

public class Reflection {

    public static String greet(String name) {
        return "Hello, " + name;
    }

    public static String farewell(String name) {
        return "Goodbye, " + name;
    }

    // getMethod("greet") — resolved to greet() via reflection key
    public static void runGetMethod(Class<?> clazz) throws Exception {
        Method m = clazz.getMethod("greet", String.class);
    }

    // method.invoke(target, args) — unresolved; target known only at runtime
    public static Object runInvoke(Method method, Object target) throws Exception {
        return method.invoke(target, "world");
    }

    // Class.forName("Reflection") — dynamic class loading; flagged
    public static void runForName() throws Exception {
        Class<?> clazz = Class.forName("Reflection");
    }
}
