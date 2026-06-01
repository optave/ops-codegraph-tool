#include "service.hpp"
#include "validators.h"
#include <iostream>

UserService::UserService() {
    log_action("initialized");
}

void UserService::log_action(const std::string& action) {
    std::cout << "[UserService] " << action << std::endl;
}

bool UserService::process(const std::string& input) {
    return create_user(input, input + "@example.com");
}

bool UserService::create_user(const std::string& name, const std::string& email) {
    if (!validate_name(name)) {
        log_action("invalid name: " + name);
        return false;
    }
    if (!validate_email(email)) {
        log_action("invalid email: " + email);
        return false;
    }
    users_.push_back(name);
    log_action("created user: " + name);
    return true;
}

bool UserService::delete_user(const std::string& name) {
    log_action("deleted user: " + name);
    return true;
}
