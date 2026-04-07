#import "Service.h"
#import "Validators.h"

void run(void) {
    UserRepository *repo = [[UserRepository alloc] init];
    UserService *svc = [[UserService alloc] initWithRepository:repo];

    [svc createUserWithId:@"1" name:@"Alice" email:@"alice@example.com"];
    NSString *found = [svc getUserWithId:@"1"];
    if (found) {
        NSLog(@"Found: %@", found);
    }
    [svc removeUserWithId:@"1"];

    BOOL valid = [Validators isValidEmail:@"alice@example.com"];
    if (valid) {
        NSLog(@"Email is valid");
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        run();
    }
    return 0;
}
