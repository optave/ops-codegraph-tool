#include "service.cuh"
#include "validators.cuh"
#include <cstring>
#include <cstdio>

static char store[100][128];
static int storeCount = 0;

void UserRepository::save(const char *id, const char *name) {
    snprintf(store[storeCount++], 128, "%s:%s", id, name);
}

const char *UserRepository::findById(const char *id) {
    for (int i = 0; i < storeCount; i++) {
        if (strncmp(store[i], id, strlen(id)) == 0) {
            return store[i];
        }
    }
    return nullptr;
}

bool UserRepository::deleteById(const char *id) {
    for (int i = 0; i < storeCount; i++) {
        if (strncmp(store[i], id, strlen(id)) == 0) {
            store[i][0] = '\0';
            return true;
        }
    }
    return false;
}

void UserService::createUser(const char *id, const char *name, const char *email) {
    if (!validateEmail(email)) return;
    if (!validateName(name)) return;
    repo.save(id, name);
}

const char *UserService::getUser(const char *id) {
    return repo.findById(id);
}

bool UserService::removeUser(const char *id) {
    return repo.deleteById(id);
}
