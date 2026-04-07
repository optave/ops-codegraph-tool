#import "Validators.h"

@implementation Validators

+ (BOOL)isValidEmail:(NSString *)email {
    return [email containsString:@"@"] && [email containsString:@"."];
}

+ (BOOL)isValidName:(NSString *)name {
    return name.length >= 2;
}

+ (BOOL)validateUser:(NSString *)name email:(NSString *)email {
    return [self isValidName:name] && [self isValidEmail:email];
}

@end
