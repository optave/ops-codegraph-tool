#include "service.hpp"
#include "validators.h"

void run_service() {
    UserService svc;
    svc.create_user("Alice", "alice@example.com");
    svc.delete_user("Alice");
}

bool check_input(const std::string& name, const std::string& email) {
    return validate_name(name) && validate_email(email);
}

int main() {
    if (check_input("Bob", "bob@example.com")) {
        run_service();
    }
    return 0;
}
