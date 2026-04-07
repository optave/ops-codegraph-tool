package service

import repository.UserRepository
import validators.Validators

class UserService {
    private UserRepository repo = new UserRepository()

    void createUser(String id, String name, String email) {
        if (!Validators.isValidEmail(email)) return
        if (!Validators.isValidName(name)) return
        repo.save(id, name)
    }

    String getUser(String id) {
        return repo.findById(id)
    }

    boolean removeUser(String id) {
        return repo.delete(id)
    }

    String summary() {
        return "repository contains ${repo.count()} users"
    }
}
