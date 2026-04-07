#import <Foundation/Foundation.h>

@interface UserRepository : NSObject

- (void)saveWithId:(NSString *)userId name:(NSString *)name;
- (NSString *)findById:(NSString *)userId;
- (BOOL)deleteWithId:(NSString *)userId;

@end
