package repository

class UserRepository {
    private Map<String, String> store = [:]

    void save(String id, String name) {
        store[id] = name
    }

    String findById(String id) {
        return store[id]
    }

    boolean delete(String id) {
        return store.remove(id) != null
    }

    int count() {
        return store.size()
    }
}
