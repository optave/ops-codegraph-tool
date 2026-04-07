#import <Foundation/Foundation.h>

@interface Validators : NSObject

+ (BOOL)isValidEmail:(NSString *)email;
+ (BOOL)isValidName:(NSString *)name;
+ (BOOL)validateUser:(NSString *)name email:(NSString *)email;

@end
