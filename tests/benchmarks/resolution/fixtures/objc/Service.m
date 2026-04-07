#import "Service.h"
#import "Validators.h"

@implementation UserService {
    UserRepository *_repo;
}

- (instancetype)initWithRepository:(UserRepository *)repo {
    self = [super init];
    if (self) {
        _repo = repo;
    }
    return self;
}

- (void)createUserWithId:(NSString *)userId name:(NSString *)name email:(NSString *)email {
    if (![Validators isValidEmail:email]) {
        return;
    }
    if (![Validators isValidName:name]) {
        return;
    }
    [_repo saveWithId:userId name:name];
}

- (NSString *)getUserWithId:(NSString *)userId {
    return [_repo findById:userId];
}

- (BOOL)removeUserWithId:(NSString *)userId {
    return [_repo deleteWithId:userId];
}

@end
