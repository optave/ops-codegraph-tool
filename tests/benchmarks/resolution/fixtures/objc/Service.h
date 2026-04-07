#import <Foundation/Foundation.h>
#import "Repository.h"

@interface UserService : NSObject

- (instancetype)initWithRepository:(UserRepository *)repo;
- (void)createUserWithId:(NSString *)userId name:(NSString *)name email:(NSString *)email;
- (NSString *)getUserWithId:(NSString *)userId;
- (BOOL)removeUserWithId:(NSString *)userId;

@end
