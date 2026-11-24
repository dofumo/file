#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <Security/Security.h>
#import "Generated/QTEmbeddedScripts.h"

static const void *kQTInstalledKey = &kQTInstalledKey;
static const void *kQTHandlerKey = &kQTHandlerKey;
static NSString * const kQTTargetBundle = @"azt.azt";

static NSString *QTJSONString(id object) {
    if (!object) object = [NSNull null];
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingFragmentsAllowed error:nil];
    if (!data) return @"null";
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"null";
}

// The two JavaScript assets are generated into this header during the CI build.
// Their bytes become part of this dylib, so no external .bundle is required.
static NSString *QTLoadResource(NSString *name) {
    if ([name isEqualToString:@"quiz-tutor-shim"]) {
        return [[NSString alloc] initWithBytes:QTShimJS
                                        length:sizeof(QTShimJS)
                                      encoding:NSUTF8StringEncoding];
    }
    if ([name isEqualToString:@"content"]) {
        return [[NSString alloc] initWithBytes:QTContentJS
                                        length:sizeof(QTContentJS)
                                      encoding:NSUTF8StringEncoding];
    }
    return nil;
}

static BOOL QTIsAzotaHost(NSURL *url) {
    NSString *host = url.host.lowercaseString;
    return host.length && ([host isEqualToString:@"azota.vn"] || [host hasSuffix:@".azota.vn"]);
}

static BOOL QTIsTargetApp(void) {
    return [[[NSBundle mainBundle] bundleIdentifier] isEqualToString:kQTTargetBundle];
}

// Keep the Gemini API key in the iOS Keychain, not in the Azota website's IndexedDB.
static NSString *QTReadAPIKey(void) {
    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: @"com.dofumo.quiztutor.gemini",
        (__bridge id)kSecAttrAccount: @"api-key",
        (__bridge id)kSecReturnData: @YES,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne
    };
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status != errSecSuccess || !result) return @"";
    NSData *data = CFBridgingRelease(result);
    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
}

static void QTSaveAPIKey(NSString *apiKey) {
    NSDictionary *query = @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: @"com.dofumo.quiztutor.gemini",
        (__bridge id)kSecAttrAccount: @"api-key"
    };
    SecItemDelete((__bridge CFDictionaryRef)query);
    if (![apiKey isKindOfClass:[NSString class]] || !apiKey.length) return;
    NSMutableDictionary *item = [query mutableCopy];
    item[(__bridge id)kSecValueData] = [apiKey dataUsingEncoding:NSUTF8StringEncoding];
    item[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    SecItemAdd((__bridge CFDictionaryRef)item, NULL);
}

static void QTReply(WKWebView *webView, id requestID, NSDictionary *payload) {
    if (!webView || !requestID) return;
    NSString *script = [NSString stringWithFormat:@"window.__qtNativeReply(%@,%@);", QTJSONString(requestID), QTJSONString(payload ?: @{})];
    dispatch_async(dispatch_get_main_queue(), ^{
        [webView evaluateJavaScript:script completionHandler:nil];
    });
}

static UIViewController *QTTopViewController(UIView *view) {
    UIResponder *responder = view;
    UIViewController *controller = nil;
    while (responder) {
        if ([responder isKindOfClass:[UIViewController class]]) {
            controller = (UIViewController *)responder;
            break;
        }
        responder = [responder nextResponder];
    }
    if (!controller) controller = view.window.rootViewController;
    while (controller.presentedViewController) controller = controller.presentedViewController;
    return controller;
}

static NSDictionary *QTResponseSchema(BOOL compact) {
    NSDictionary *anchor = @{ @"type": @"INTEGER", @"description": @"Số dòng [n] nơi đề bài của câu hỏi bắt đầu" };
    NSDictionary *explanation = @{ @"type": @"STRING", @"description": @"Lập luận/lời giải ngắn, đã kiểm tra" };
    NSDictionary *answer = @{ @"type": @"STRING", @"description": @"Nhãn đáp án đúng như trang hiển thị" };
    NSDictionary *freeResponse = @{ @"type": @"BOOLEAN", @"description": @"true nếu đây là câu tự luận hoặc điền khuyết" };
    NSDictionary *needsCalc = @{ @"type": @"BOOLEAN", @"description": @"true nếu cần tính toán hoặc phụ thuộc hình ảnh/bảng/đồ thị" };
    NSMutableDictionary *properties = [@{
        @"anchor": anchor,
        @"explanation": explanation,
        @"answer": answer,
        @"free_response": freeResponse,
        @"needs_calc": needsCalc
    } mutableCopy];
    NSArray *ordering = @[ @"anchor", @"explanation", @"answer", @"free_response", @"needs_calc" ];
    if (!compact) {
        properties[@"answer_text"] = @{ @"type": @"STRING", @"description": @"Nội dung đầy đủ của đáp án" };
        properties[@"memory_tip"] = @{ @"type": @"STRING", @"description": @"Mẹo ghi nhớ ngắn" };
        properties[@"confidence"] = @{ @"type": @"NUMBER", @"description": @"Độ tự tin từ 0 đến 1" };
        ordering = @[ @"anchor", @"explanation", @"answer", @"answer_text", @"memory_tip", @"confidence", @"needs_calc", @"free_response" ];
    }
    NSDictionary *item = @{
        @"type": @"OBJECT",
        @"propertyOrdering": ordering,
        @"properties": properties,
        @"required": @[ @"anchor", @"explanation", @"answer" ]
    };
    return @{ @"type": @"ARRAY", @"items": item };
}

static NSArray *QTParseGeminiResponse(NSDictionary *json, NSString **errorText) {
    NSArray *candidates = [json[@"candidates"] isKindOfClass:[NSArray class]] ? json[@"candidates"] : @[];
    NSDictionary *candidate = candidates.firstObject;
    NSArray *parts = [candidate[@"content"] isKindOfClass:[NSDictionary class]] ? candidate[@"content"][@"parts"] : nil;
    NSMutableString *text = [NSMutableString string];
    for (NSDictionary *part in parts) {
        if (![part[@"thought"] boolValue] && [part[@"text"] isKindOfClass:[NSString class]]) [text appendString:part[@"text"]];
    }
    NSString *result = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!result.length) {
        NSString *reason = json[@"promptFeedback"][@"blockReason"] ?: candidate[@"finishReason"] ?: @"rỗng";
        if (errorText) *errorText = [NSString stringWithFormat:@"Gemini trả về kết quả rỗng (%@).", reason];
        return nil;
    }
    if ([result hasPrefix:@"```"]) {
        NSRange firstLine = [result rangeOfString:@"\n"];
        if (firstLine.location != NSNotFound) result = [result substringFromIndex:firstLine.location + 1];
        NSRange fence = [result rangeOfString:@"```" options:NSBackwardsSearch];
        if (fence.location != NSNotFound) result = [result substringToIndex:fence.location];
        result = [result stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    }
    NSData *data = [result dataUsingEncoding:NSUTF8StringEncoding];
    id decoded = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil] : nil;
    if ([decoded isKindOfClass:[NSArray class]]) return decoded;
    if ([decoded isKindOfClass:[NSDictionary class]] && [decoded[@"questions"] isKindOfClass:[NSArray class]]) return decoded[@"questions"];
    if (errorText) *errorText = @"Không đọc được JSON từ Gemini.";
    return nil;
}

@interface QTScriptBridge : NSObject <WKScriptMessageHandler>
- (void)callGemini:(NSDictionary *)message config:(NSDictionary *)config webView:(WKWebView *)webView requestID:(id)requestID attempt:(NSInteger)attempt thinkingEnabled:(BOOL)thinkingEnabled;
- (void)showSettingsForWebView:(WKWebView *)webView config:(NSDictionary *)config;
@end

@implementation QTScriptBridge

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    if (!QTIsAzotaHost(message.frameInfo.request.URL)) return;
    NSDictionary *envelope = message.body;
    NSDictionary *payload = [envelope[@"message"] isKindOfClass:[NSDictionary class]] ? envelope[@"message"] : @{};
    NSDictionary *config = [envelope[@"config"] isKindOfClass:[NSDictionary class]] ? envelope[@"config"] : @{};
    id requestID = envelope[@"id"];
    WKWebView *webView = message.webView;
    NSString *type = [payload[@"type"] isKindOfClass:[NSString class]] ? payload[@"type"] : @"";

    if ([type isEqualToString:@"license"]) {
        QTReply(webView, requestID, @{ @"enforced": @NO, @"active": @YES, @"configured": @YES, @"message": @"" });
        return;
    }
    if ([type isEqualToString:@"openOptions"]) {
        [self showSettingsForWebView:webView config:config];
        QTReply(webView, requestID, @{ @"ok": @YES });
        return;
    }
    if ([type isEqualToString:@"capture"]) {
        QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"Chụp ảnh màn hình từng câu không được bật trong bản iOS này." });
        return;
    }
    if ([type isEqualToString:@"gemini"]) {
        [self callGemini:payload config:config webView:webView requestID:requestID attempt:0 thinkingEnabled:YES];
        return;
    }
    if ([type isEqualToString:@"fetchImage"]) {
        [self fetchImage:payload[@"url"] webView:webView requestID:requestID];
        return;
    }
    QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"Loại yêu cầu chưa được hỗ trợ trên iOS." });
}

- (void)showSettingsForWebView:(WKWebView *)webView config:(NSDictionary *)config {
    if (!webView) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *controller = QTTopViewController(webView);
        if (!controller || controller.presentedViewController) return;
        UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Quiz Tutor AI – Cài đặt"
                                                                       message:@"Nhập Gemini API key cá nhân. License key không được sử dụng trong bản iOS này."
                                                                preferredStyle:UIAlertControllerStyleAlert];
        [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
            field.placeholder = @"Gemini API key";
            field.secureTextEntry = YES;
            NSString *savedKey = QTReadAPIKey();
            NSString *legacyKey = [config[@"apiKey"] isKindOfClass:[NSString class]] ? config[@"apiKey"] : @"";
            field.text = savedKey.length ? savedKey : ([legacyKey isEqualToString:@"__qt_keychain__"] ? @"" : legacyKey);
            field.autocorrectionType = UITextAutocorrectionTypeNo;
            field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        }];
        [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
            field.placeholder = @"Model (ví dụ: gemini-3.5-flash-lite)";
            field.text = [config[@"model"] isKindOfClass:[NSString class]] ? config[@"model"] : @"gemini-3.5-flash-lite";
            field.autocorrectionType = UITextAutocorrectionTypeNo;
            field.autocapitalizationType = UITextAutocapitalizationTypeNone;
        }];
        [alert addTextFieldWithConfigurationHandler:^(UITextField *field) {
            field.placeholder = @"Ngôn ngữ giải thích";
            field.text = [config[@"language"] isKindOfClass:[NSString class]] ? config[@"language"] : @"Tiếng Việt";
        }];
        [alert addAction:[UIAlertAction actionWithTitle:@"Hủy" style:UIAlertActionStyleCancel handler:nil]];
        [alert addAction:[UIAlertAction actionWithTitle:@"Lưu" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
            NSString *key = alert.textFields[0].text ?: @"";
            NSString *model = alert.textFields[1].text.length ? alert.textFields[1].text : @"gemini-3.5-flash-lite";
            NSString *language = alert.textFields[2].text.length ? alert.textFields[2].text : @"Tiếng Việt";
            QTSaveAPIKey(key);
            // A non-secret marker lets content.js know a key exists; the actual key stays in Keychain.
            NSDictionary *values = @{ @"apiKey": key.length ? @"__qt_keychain__" : @"", @"model": model, @"language": language, @"visionShot": @NO };
            NSString *script = [NSString stringWithFormat:@"window.__qtStorageSet(%@);", QTJSONString(values)];
            [webView evaluateJavaScript:script completionHandler:nil];
        }]];
        [controller presentViewController:alert animated:YES completion:nil];
    });
}

- (void)fetchImage:(NSString *)urlString webView:(WKWebView *)webView requestID:(id)requestID {
    NSURL *url = [urlString isKindOfClass:[NSString class]] ? [NSURL URLWithString:urlString] : nil;
    if (!url || !([url.scheme.lowercaseString isEqualToString:@"http"] || [url.scheme.lowercaseString isEqualToString:@"https"])) {
        QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"URL ảnh không hợp lệ." });
        return;
    }

    // Reuse only cookies whose domain/path apply to this exact image URL.
    [webView.configuration.websiteDataStore.httpCookieStore getAllCookies:^(NSArray<NSHTTPCookie *> *cookies) {
        NSString *host = url.host.lowercaseString ?: @"";
        NSString *path = url.path.length ? url.path : @"/";
        NSMutableArray<NSHTTPCookie *> *matchingCookies = [NSMutableArray array];
        for (NSHTTPCookie *cookie in cookies) {
            NSString *domain = cookie.domain.lowercaseString;
            if ([domain hasPrefix:@"."]) domain = [domain substringFromIndex:1];
            BOOL domainMatches = domain.length && ([host isEqualToString:domain] || [host hasSuffix:[@"." stringByAppendingString:domain]]);
            BOOL pathMatches = [path hasPrefix:(cookie.path.length ? cookie.path : @"/")];
            BOOL secureMatches = !cookie.isSecure || [url.scheme.lowercaseString isEqualToString:@"https"];
            if (domainMatches && pathMatches && secureMatches) [matchingCookies addObject:cookie];
        }

        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:30.0];
        if (matchingCookies.count) {
            NSDictionary *headers = [NSHTTPCookie requestHeaderFieldsWithCookies:matchingCookies];
            [request setAllHTTPHeaderFields:headers];
        }
        NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            if (error || !data) {
                QTReply(webView, requestID, @{ @"ok": @NO, @"error": error.localizedDescription ?: @"Không tải được ảnh." });
                return;
            }
            if (data.length > 12 * 1024 * 1024) {
                QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"Ảnh quá lớn." });
                return;
            }
            NSString *mime = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).MIMEType : nil;
            NSString *base64 = [data base64EncodedStringWithOptions:0];
            QTReply(webView, requestID, @{ @"ok": @YES, @"mime": mime ?: @"image/png", @"b64": base64 ?: @"" });
        }];
        [task resume];
    }];
}

- (void)callGemini:(NSDictionary *)message config:(NSDictionary *)config webView:(WKWebView *)webView requestID:(id)requestID attempt:(NSInteger)attempt thinkingEnabled:(BOOL)thinkingEnabled {
    if ([message[@"tools"] isEqualToString:@"code"]) {
        QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"CODE_UNSUPPORTED: Python code execution is not included in this iOS port." });
        return;
    }
    NSString *apiKey = QTReadAPIKey();
    if (!apiKey.length) {
        NSString *legacyKey = [config[@"apiKey"] isKindOfClass:[NSString class]] ? config[@"apiKey"] : @"";
        if (legacyKey.length && ![legacyKey isEqualToString:@"__qt_keychain__"]) {
            apiKey = legacyKey;
            QTSaveAPIKey(apiKey); // migrate once from the previous IndexedDB-backed prototype
        }
    }
    if (!apiKey.length) {
        QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"Chưa có Gemini API key. Bấm Alt+bấm nút Q để mở Cài đặt." });
        return;
    }
    NSString *model = [message[@"model"] isKindOfClass:[NSString class]] && [message[@"model"] length]
        ? message[@"model"]
        : ([config[@"model"] isKindOfClass:[NSString class]] && [config[@"model"] length] ? config[@"model"] : @"gemini-3.5-flash-lite");
    NSString *encodedModel = [model stringByAddingPercentEncodingWithAllowedCharacters:[NSCharacterSet URLPathAllowedCharacterSet]] ?: model;
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"https://generativelanguage.googleapis.com/v1beta/models/%@:generateContent", encodedModel]];
    if (!url) {
        QTReply(webView, requestID, @{ @"ok": @NO, @"error": @"Tên model Gemini không hợp lệ." });
        return;
    }

    NSArray *parts = [message[@"parts"] isKindOfClass:[NSArray class]] ? message[@"parts"] : @[];
    NSString *system = [message[@"system"] isKindOfClass:[NSString class]] ? message[@"system"] : @"";
    BOOL compact = [message[@"compact"] boolValue];
    NSMutableDictionary *generationConfig = [@{
        @"responseMimeType": @"application/json",
        @"responseSchema": QTResponseSchema(compact)
    } mutableCopy];
    NSString *thinking = [message[@"thinking"] isKindOfClass:[NSString class]] ? message[@"thinking"] : config[@"thinking"];
    if (!thinking.length) thinking = @"minimal";
    if ([thinking isEqualToString:@"auto"]) thinking = @"minimal";
    if (thinkingEnabled && ![thinking isEqualToString:@"off"]) generationConfig[@"thinkingConfig"] = @{ @"thinkingLevel": thinking };

    NSDictionary *body = @{
        @"systemInstruction": @{ @"parts": @[ @{ @"text": system } ] },
        @"contents": @[ @{ @"role": @"user", @"parts": parts } ],
        @"generationConfig": generationConfig
    };
    NSData *bodyData = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:210.0];
    request.HTTPMethod = @"POST";
    request.HTTPBody = bodyData;
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    [request setValue:apiKey forHTTPHeaderField:@"x-goog-api-key"];

    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *networkError) {
        NSInteger status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse *)response).statusCode : 0;
        NSString *raw = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
        if (networkError) {
            if (attempt < 3) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * (attempt + 1))), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    [self callGemini:message config:config webView:webView requestID:requestID attempt:attempt + 1 thinkingEnabled:thinkingEnabled];
                });
            } else {
                QTReply(webView, requestID, @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"Lỗi mạng Gemini: %@", networkError.localizedDescription ?: @"không rõ"] });
            }
            return;
        }
        NSDictionary *decoded = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil] : nil;
        if (status == 400 && thinkingEnabled && [raw.lowercaseString containsString:@"think"]) {
            [self callGemini:message config:config webView:webView requestID:requestID attempt:attempt thinkingEnabled:NO];
            return;
        }
        if ((status == 429 || status >= 500) && attempt < 3) {
            NSTimeInterval delay = status == 429 ? 8.0 * (attempt + 1) : 2.0 * (attempt + 1);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * delay)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                [self callGemini:message config:config webView:webView requestID:requestID attempt:attempt + 1 thinkingEnabled:thinkingEnabled];
            });
            return;
        }
        if (status < 200 || status >= 300) {
            NSString *error = [decoded isKindOfClass:[NSDictionary class]] ? decoded[@"error"][@"message"] : nil;
            if (![error isKindOfClass:[NSString class]] || !error.length) error = raw.length ? raw : [NSString stringWithFormat:@"HTTP %ld", (long)status];
            QTReply(webView, requestID, @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"Gemini %ld (%@): %@", (long)status, model, error] });
            return;
        }
        NSString *parseError = nil;
        NSArray *results = QTParseGeminiResponse([decoded isKindOfClass:[NSDictionary class]] ? decoded : @{}, &parseError);
        if (!results) QTReply(webView, requestID, @{ @"ok": @NO, @"error": parseError ?: @"Không đọc được phản hồi Gemini." });
        else QTReply(webView, requestID, @{ @"ok": @YES, @"data": results });
    }];
    [task resume];
}

@end

static void QTInstallScripts(WKWebViewConfiguration *configuration) {
    if (!QTIsTargetApp() || !configuration) return;
    WKUserContentController *controller = configuration.userContentController;
    if (!controller || [objc_getAssociatedObject(controller, kQTInstalledKey) boolValue]) return;

    NSString *shim = QTLoadResource(@"quiz-tutor-shim");
    NSString *content = QTLoadResource(@"content");
    if (!shim.length || !content.length) {
        NSLog(@"[QuizTutor] Embedded JavaScript resources are missing or invalid.");
        return;
    }

    QTScriptBridge *bridge = [QTScriptBridge new];
    [controller addScriptMessageHandler:bridge name:@"qtBridge"];
    [controller addUserScript:[[WKUserScript alloc] initWithSource:shim injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    [controller addUserScript:[[WKUserScript alloc] initWithSource:content injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES]];
    objc_setAssociatedObject(controller, kQTHandlerKey, bridge, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    objc_setAssociatedObject(controller, kQTInstalledKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSLog(@"[QuizTutor] WKWebView scripts installed.");
}

static void QTInjectCurrentPage(WKWebView *webView) {
    if (!QTIsTargetApp() || !webView || !QTIsAzotaHost(webView.URL)) return;
    NSString *shim = QTLoadResource(@"quiz-tutor-shim");
    NSString *content = QTLoadResource(@"content");
    if (!shim.length || !content.length) return;
    NSString *script = [NSString stringWithFormat:@"%@\n%@", shim, content];
    [webView evaluateJavaScript:script completionHandler:nil];
}

%hook WKWebView

- (instancetype)initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
    if (QTIsTargetApp()) QTInstallScripts(configuration);
    return %orig(frame, configuration);
}

- (instancetype)initWithCoder:(NSCoder *)coder {
    id result = %orig;
    if (result && QTIsTargetApp()) {
        QTInstallScripts([(WKWebView *)result configuration]);
        dispatch_async(dispatch_get_main_queue(), ^{
            QTInjectCurrentPage((WKWebView *)result);
        });
    }
    return result;
}

- (void)didMoveToWindow {
    %orig;
    if (QTIsTargetApp()) {
        QTInstallScripts(self.configuration);
        WKWebView *webView = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 1.0)), dispatch_get_main_queue(), ^{
            QTInjectCurrentPage(webView);
        });
    }
}

%end
