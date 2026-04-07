#import "Repository.h"

@implementation UserRepository {
    NSMutableDictionary *_store;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _store = [NSMutableDictionary dictionary];
    }
    return self;
}

- (void)saveWithId:(NSString *)userId name:(NSString *)name {
    _store[userId] = name;
}

- (NSString *)findById:(NSString *)userId {
    return _store[userId];
}

- (BOOL)deleteWithId:(NSString *)userId {
    if (_store[userId]) {
        [_store removeObjectForKey:userId];
        return YES;
    }
    return NO;
}

@end
