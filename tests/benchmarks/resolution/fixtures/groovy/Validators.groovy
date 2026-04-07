package validators

class Validators {
    static boolean isValidEmail(String email) {
        return email?.contains('@') && email?.contains('.')
    }

    static boolean isValidName(String name) {
        return name?.length() >= 2
    }

    static boolean validateUser(String name, String email) {
        return isValidName(name) && isValidEmail(email)
    }
}
