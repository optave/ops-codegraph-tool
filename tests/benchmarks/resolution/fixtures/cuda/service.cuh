#pragma once

class UserRepository {
public:
    void save(const char *id, const char *name);
    const char *findById(const char *id);
    bool deleteById(const char *id);
};

class UserService {
    UserRepository repo;
public:
    void createUser(const char *id, const char *name, const char *email);
    const char *getUser(const char *id);
    bool removeUser(const char *id);
};

bool validateEmail(const char *email);
bool validateName(const char *name);
