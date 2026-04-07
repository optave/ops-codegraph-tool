#include "service.cuh"
#include "validators.cuh"
#include <cstdio>

__global__ void processKernel(int *data, int n) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < n) {
        data[idx] = data[idx] * 2;
    }
}

void runService() {
    UserService svc;
    svc.createUser("1", "Alice", "alice@example.com");
    const char *found = svc.getUser("1");
    if (found) {
        printf("Found: %s\n", found);
    }
    svc.removeUser("1");
}

void runValidation() {
    bool valid = validateEmail("alice@example.com");
    if (valid) {
        bool nameOk = validateName("Alice");
        printf("Name valid: %d\n", nameOk);
    }
}

int main() {
    runService();
    runValidation();
    return 0;
}
