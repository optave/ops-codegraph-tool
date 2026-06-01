#pragma once

#include <string>
#include <vector>

class Service {
public:
    virtual ~Service() = default;
    virtual bool process(const std::string& input) = 0;
};

class UserService : public Service {
public:
    UserService();
    bool process(const std::string& input) override;
    bool create_user(const std::string& name, const std::string& email);
    bool delete_user(const std::string& name);

private:
    std::vector<std::string> users_;
    void log_action(const std::string& action);
};
