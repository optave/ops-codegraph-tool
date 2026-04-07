import service.UserService
import validators.Validators

class Main {
    static void main(String[] args) {
        def svc = new UserService()
        svc.createUser("1", "Alice", "alice@example.com")
        def found = svc.getUser("1")
        if (found) {
            println "Found: $found"
        }
        svc.removeUser("1")

        boolean valid = Validators.validateUser("Bob", "bob@example.com")
        println "Valid: $valid"
    }
}
