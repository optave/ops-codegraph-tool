/* Fixture: C dynamic dispatch patterns
 * (*fp)(args) → flagged as unresolved-dynamic
 * dlsym(handle, "symbol") → flagged as unresolved-dynamic (cross-lib)
 */
#include <stdio.h>
#include <dlfcn.h>

void greet(const char *name) {
    printf("Hello, %s\n", name);
}

void farewell(const char *name) {
    printf("Goodbye, %s\n", name);
}

/* (*fp)(args) — function pointer dereference; unresolvable statically */
void runFunctionPointer(void (*fp)(const char *)) {
    (*fp)("world");
}

/* dlsym(handle, "symbol") — dynamic symbol loading; flagged */
void runDlsym(void *handle) {
    void (*fn)(const char *) = dlsym(handle, "greet");
    if (fn) fn("world");
}
