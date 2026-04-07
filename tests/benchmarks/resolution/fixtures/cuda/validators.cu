#include "validators.cuh"
#include <cstring>

bool checkLength(const char *str, int minLen) {
    return str && (int)strlen(str) >= minLen;
}

bool validateEmail(const char *email) {
    if (!checkLength(email, 3)) return false;
    return strchr(email, '@') != nullptr && strchr(email, '.') != nullptr;
}

bool validateName(const char *name) {
    return checkLength(name, 2);
}
