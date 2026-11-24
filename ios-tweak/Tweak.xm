#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <Security/Security.h>
#import <math.h>
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


static NSDictionary *QTUIStyleDefaults(void) {
    return @{
        @"fabColor": @"#333333", @"fabIcon": @"#ffffff", @"fabOpacity": @0.80, @"fabTextOpacity": @1.0,
        @"fabSize": @48,
        @"badgeColor": @"#222222", @"badgeText": @"#ffffff", @"badgeOpacity": @0.90, @"badgeTextOpacity": @1.0,
        @"lowColor": @"#8a5a00",
        @"popColor": @"#ffffff", @"popText": @"#000000", @"popOpacity": @0.97, @"popTextOpacity": @1.0,
        @"popHeight": @0.60,
        @"toastColor": @"#222222", @"toastText": @"#ffffff", @"toastOpacity": @0.90, @"toastTextOpacity": @1.0
    };
}

static UIColor *QTColorFromHex(NSString *value) {
    NSString *hex = [[value stringByReplacingOccurrencesOfString:@"#" withString:@""] uppercaseString];
    if (hex.length != 6) return UIColor.systemBlueColor;
    unsigned int rgb = 0;
    NSScanner *scanner = [NSScanner scannerWithString:hex];
    if (![scanner scanHexInt:&rgb]) return UIColor.systemBlueColor;
    return [UIColor colorWithRed:((rgb >> 16) & 0xFF) / 255.0
                           green:((rgb >> 8) & 0xFF) / 255.0
                            blue:(rgb & 0xFF) / 255.0 alpha:1.0];
}

static NSString *QTHexFromColor(UIColor *color) {
    CGFloat r = 0, g = 0, b = 0, a = 1;
    if (![color getRed:&r green:&g blue:&b alpha:&a]) return @"#333333";
    return [NSString stringWithFormat:@"#%02X%02X%02X", (int)lrint(r * 255), (int)lrint(g * 255), (int)lrint(b * 255)];
}

@interface QTSettingsViewController : UIViewController <UIColorPickerViewControllerDelegate>
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, copy) NSDictionary *initialConfig;
@property (nonatomic, strong) NSMutableDictionary<NSString *, id> *values;
@property (nonatomic, strong) NSMutableDictionary<NSString *, UIButton *> *colorButtons;
@property (nonatomic, strong) NSMutableDictionary<NSString *, UISlider *> *sliders;
@property (nonatomic, strong) NSMutableDictionary<NSString *, UILabel *> *sliderValues;
@property (nonatomic, strong) UITextField *apiKeyField;
@property (nonatomic, strong) UITextField *modelField;
@property (nonatomic, strong) UITextField *languageField;
@property (nonatomic, copy) NSString *activeColorKey;
@property (nonatomic, strong) UIStackView *formStack;
@property (nonatomic) BOOL hasSavedKey;
- (instancetype)initWithWebView:(WKWebView *)webView config:(NSDictionary *)config;
@end

@implementation QTSettingsViewController

- (instancetype)initWithWebView:(WKWebView *)webView config:(NSDictionary *)config {
    self = [super initWithNibName:nil bundle:nil];
    if (self) {
        _webView = webView;
        _initialConfig = [config copy] ?: @{};
        _values = [NSMutableDictionary dictionaryWithDictionary:QTUIStyleDefaults()];
        [_values addEntriesFromDictionary:config ?: @{}];
        _colorButtons = [NSMutableDictionary dictionary];
        _sliders = [NSMutableDictionary dictionary];
        _sliderValues = [NSMutableDictionary dictionary];
        _hasSavedKey = QTReadAPIKey().length > 0;
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.view.backgroundColor = UIColor.systemGroupedBackgroundColor;
    self.title = @"Quiz Tutor AI";

    UIScrollView *scroll = [UIScrollView new];
    scroll.translatesAutoresizingMaskIntoConstraints = NO;
    scroll.keyboardDismissMode = UIScrollViewKeyboardDismissModeOnDrag;
    [self.view addSubview:scroll];

    self.formStack = [[UIStackView alloc] initWithFrame:CGRectZero];
    self.formStack.axis = UILayoutConstraintAxisVertical;
    self.formStack.spacing = 12;
    self.formStack.translatesAutoresizingMaskIntoConstraints = NO;
    [scroll addSubview:self.formStack];

    [NSLayoutConstraint activateConstraints:@[
        [scroll.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
        [scroll.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
        [scroll.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
        [scroll.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
        [self.formStack.topAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.topAnchor constant:16],
        [self.formStack.leadingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.leadingAnchor constant:16],
        [self.formStack.trailingAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.trailingAnchor constant:-16],
        [self.formStack.bottomAnchor constraintEqualToAnchor:scroll.contentLayoutGuide.bottomAnchor constant:-24],
        [self.formStack.widthAnchor constraintEqualToAnchor:scroll.frameLayoutGuide.widthAnchor constant:-32]
    ]];

    UIStackView *header = [[UIStackView alloc] initWithFrame:CGRectZero];
    header.axis = UILayoutConstraintAxisHorizontal;
    header.alignment = UIStackViewAlignmentCenter;
    header.distribution = UIStackViewDistributionFill;
    UILabel *title = [UILabel new];
    title.text = @"Giao diện & cài đặt";
    title.font = [UIFont preferredFontForTextStyle:UIFontTextStyleTitle2];
    title.adjustsFontForContentSizeCategory = YES;
    UIButton *close = [UIButton buttonWithType:UIButtonTypeSystem];
    [close setTitle:@"Đóng" forState:UIControlStateNormal];
    [close addTarget:self action:@selector(closeSettings) forControlEvents:UIControlEventTouchUpInside];
    [header addArrangedSubview:title];
    [header addArrangedSubview:[[UIView alloc] initWithFrame:CGRectZero]];
    [header addArrangedSubview:close];
    [self.formStack addArrangedSubview:header];

    UILabel *subtitle = [UILabel new];
    subtitle.text = @"Tùy chỉnh trực tiếp nút nổi, ô đáp án và bảng giải thích. Thay đổi được lưu vào cấu hình của Quiz Tutor trên thiết bị này.";
    subtitle.font = [UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    subtitle.textColor = UIColor.secondaryLabelColor;
    subtitle.numberOfLines = 0;
    [self.formStack addArrangedSubview:subtitle];

    [self addSection:@"Gemini"];
    self.apiKeyField = [self addLabeledTextField:@"Gemini API key" placeholder:(self.hasSavedKey ? @"Đã lưu trong Keychain — nhập mới để thay thế" : @"Dán Gemini API key") secure:YES value:@""];
    self.modelField = [self addLabeledTextField:@"Model" placeholder:@"gemini-3.5-flash-lite" secure:NO value:[self stringValue:@"model" fallback:@"gemini-3.5-flash-lite"]];
    self.languageField = [self addLabeledTextField:@"Ngôn ngữ giải thích" placeholder:@"Tiếng Việt" secure:NO value:[self stringValue:@"language" fallback:@"Tiếng Việt"]];

    [self addSection:@"Nút nổi"];
    [self addColorRow:@"fabColor" title:@"Màu nền nút"];
    [self addColorRow:@"fabIcon" title:@"Màu biểu tượng"];
    [self addSliderRow:@"fabOpacity" title:@"Độ trong suốt nền" min:0 max:1 percent:YES];
    [self addSliderRow:@"fabTextOpacity" title:@"Độ trong suốt biểu tượng" min:0 max:1 percent:YES];
    [self addSliderRow:@"fabSize" title:@"Kích thước nút" min:36 max:72 percent:NO];

    [self addSection:@"Ô đáp án"];
    [self addColorRow:@"badgeColor" title:@"Màu nền đáp án"];
    [self addColorRow:@"badgeText" title:@"Màu chữ đáp án"];
    [self addColorRow:@"lowColor" title:@"Màu đáp án cần kiểm tra"];
    [self addSliderRow:@"badgeOpacity" title:@"Độ trong suốt nền" min:0 max:1 percent:YES];
    [self addSliderRow:@"badgeTextOpacity" title:@"Độ trong suốt chữ" min:0 max:1 percent:YES];

    [self addSection:@"Bảng giải thích"];
    [self addColorRow:@"popColor" title:@"Màu nền bảng"];
    [self addColorRow:@"popText" title:@"Màu chữ bảng"];
    [self addSliderRow:@"popOpacity" title:@"Độ trong suốt nền" min:0 max:1 percent:YES];
    [self addSliderRow:@"popTextOpacity" title:@"Độ trong suốt chữ" min:0 max:1 percent:YES];
    [self addSliderRow:@"popHeight" title:@"Chiều cao tối đa" min:0.35 max:0.85 percent:YES];

    [self addSection:@"Thông báo"];
    [self addColorRow:@"toastColor" title:@"Màu nền thông báo"];
    [self addColorRow:@"toastText" title:@"Màu chữ thông báo"];
    [self addSliderRow:@"toastOpacity" title:@"Độ trong suốt nền" min:0 max:1 percent:YES];
    [self addSliderRow:@"toastTextOpacity" title:@"Độ trong suốt chữ" min:0 max:1 percent:YES];

    UIButton *reset = [UIButton buttonWithType:UIButtonTypeSystem];
    [reset setTitle:@"Khôi phục giao diện mặc định" forState:UIControlStateNormal];
    reset.backgroundColor = UIColor.secondarySystemBackgroundColor;
    reset.layer.cornerRadius = 10;
    reset.contentEdgeInsets = UIEdgeInsetsMake(12, 14, 12, 14);
    [reset addTarget:self action:@selector(resetStyles) forControlEvents:UIControlEventTouchUpInside];
    [self.formStack addArrangedSubview:reset];

    UIButton *clearKey = [UIButton buttonWithType:UIButtonTypeSystem];
    [clearKey setTitle:@"Xóa Gemini API key đã lưu" forState:UIControlStateNormal];
    [clearKey setTitleColor:UIColor.systemRedColor forState:UIControlStateNormal];
    [clearKey addTarget:self action:@selector(clearAPIKey) forControlEvents:UIControlEventTouchUpInside];
    [self.formStack addArrangedSubview:clearKey];

    UIButton *save = [UIButton buttonWithType:UIButtonTypeSystem];
    [save setTitle:@"Lưu cài đặt" forState:UIControlStateNormal];
    [save setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
    save.backgroundColor = UIColor.systemBlueColor;
    save.layer.cornerRadius = 10;
    save.titleLabel.font = [UIFont boldSystemFontOfSize:17];
    save.contentEdgeInsets = UIEdgeInsetsMake(14, 18, 14, 18);
    [save addTarget:self action:@selector(saveSettings) forControlEvents:UIControlEventTouchUpInside];
    [self.formStack addArrangedSubview:save];
}

- (NSString *)stringValue:(NSString *)key fallback:(NSString *)fallback {
    id value = self.values[key];
    return [value isKindOfClass:[NSString class]] && [value length] ? value : fallback;
}

- (CGFloat)numberValue:(NSString *)key fallback:(CGFloat)fallback {
    id value = self.values[key];
    return [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : fallback;
}

- (void)addSection:(NSString *)title {
    UILabel *label = [UILabel new];
    label.text = title;
    label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];
    label.textColor = UIColor.labelColor;
    label.accessibilityTraits = UIAccessibilityTraitHeader;
    [self.formStack addArrangedSubview:label];
    UIView *line = [UIView new];
    line.backgroundColor = UIColor.separatorColor;
    [line.heightAnchor constraintEqualToConstant:1 / UIScreen.mainScreen.scale].active = YES;
    [self.formStack addArrangedSubview:line];
}

- (UITextField *)addLabeledTextField:(NSString *)labelText placeholder:(NSString *)placeholder secure:(BOOL)secure value:(NSString *)value {
    UILabel *label = [UILabel new];
    label.text = labelText;
    label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleSubheadline];
    [self.formStack addArrangedSubview:label];

    UITextField *field = [UITextField new];
    field.borderStyle = UITextBorderStyleRoundedRect;
    field.backgroundColor = UIColor.secondarySystemBackgroundColor;
    field.placeholder = placeholder;
    field.text = value;
    field.secureTextEntry = secure;
    field.autocorrectionType = UITextAutocorrectionTypeNo;
    field.autocapitalizationType = UITextAutocapitalizationTypeNone;
    field.clearButtonMode = UITextFieldViewModeWhileEditing;
    field.returnKeyType = UIReturnKeyDone;
    field.translatesAutoresizingMaskIntoConstraints = NO;
    [field.heightAnchor constraintGreaterThanOrEqualToConstant:44].active = YES;
    [self.formStack addArrangedSubview:field];
    return field;
}

- (void)addColorRow:(NSString *)key title:(NSString *)title {
    UIStackView *row = [[UIStackView alloc] initWithFrame:CGRectZero];
    row.axis = UILayoutConstraintAxisHorizontal;
    row.alignment = UIStackViewAlignmentCenter;
    row.spacing = 12;
    UILabel *label = [UILabel new];
    label.text = title;
    label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleSubheadline];
    [row addArrangedSubview:label];
    UIView *spacer = [UIView new];
    [row addArrangedSubview:spacer];
    UIButton *swatch = [UIButton buttonWithType:UIButtonTypeSystem];
    swatch.layer.cornerRadius = 9;
    swatch.layer.borderWidth = 1;
    swatch.layer.borderColor = UIColor.separatorColor.CGColor;
    [swatch.widthAnchor constraintEqualToConstant:62].active = YES;
    [swatch.heightAnchor constraintEqualToConstant:34].active = YES;
    swatch.accessibilityLabel = title;
    swatch.accessibilityHint = @"Chọn màu";
    swatch.accessibilityIdentifier = key;
    [swatch addTarget:self action:@selector(chooseColor:) forControlEvents:UIControlEventTouchUpInside];
    [row addArrangedSubview:swatch];
    [self.formStack addArrangedSubview:row];
    self.colorButtons[key] = swatch;
    [self updateColorButton:key];
}

- (void)updateColorButton:(NSString *)key {
    UIButton *button = self.colorButtons[key];
    if (!button) return;
    NSString *hex = [self stringValue:key fallback:@"#333333"];
    button.backgroundColor = QTColorFromHex(hex);
    [button setTitle:hex.uppercaseString forState:UIControlStateNormal];
    UIColor *color = QTColorFromHex(hex);
    CGFloat r = 0, g = 0, b = 0, a = 1;
    [color getRed:&r green:&g blue:&b alpha:&a];
    BOOL light = (r * 299 + g * 587 + b * 114) / 1000.0 > 0.58;
    [button setTitleColor:(light ? UIColor.blackColor : UIColor.whiteColor) forState:UIControlStateNormal];
    button.titleLabel.font = [UIFont monospacedSystemFontOfSize:11 weight:UIFontWeightSemibold];
}

- (void)chooseColor:(UIButton *)sender {
    self.activeColorKey = sender.accessibilityIdentifier;
    UIColorPickerViewController *picker = [UIColorPickerViewController new];
    picker.delegate = self;
    picker.selectedColor = QTColorFromHex([self stringValue:self.activeColorKey fallback:@"#333333"]);
    picker.supportsAlpha = NO;
    [self presentViewController:picker animated:YES completion:nil];
}

- (void)colorPickerViewControllerDidSelectColor:(UIColorPickerViewController *)viewController {
    if (!self.activeColorKey) return;
    self.values[self.activeColorKey] = QTHexFromColor(viewController.selectedColor);
    [self updateColorButton:self.activeColorKey];
}

- (void)addSliderRow:(NSString *)key title:(NSString *)title min:(CGFloat)min max:(CGFloat)max percent:(BOOL)percent {
    UIStackView *container = [[UIStackView alloc] initWithFrame:CGRectZero];
    container.axis = UILayoutConstraintAxisVertical;
    container.spacing = 4;
    UIStackView *top = [[UIStackView alloc] initWithFrame:CGRectZero];
    top.axis = UILayoutConstraintAxisHorizontal;
    top.alignment = UIStackViewAlignmentCenter;
    UILabel *label = [UILabel new];
    label.text = title;
    label.font = [UIFont preferredFontForTextStyle:UIFontTextStyleSubheadline];
    UILabel *valueLabel = [UILabel new];
    valueLabel.font = [UIFont monospacedDigitSystemFontOfSize:12 weight:UIFontWeightRegular];
    valueLabel.textColor = UIColor.secondaryLabelColor;
    valueLabel.textAlignment = NSTextAlignmentRight;
    [valueLabel.widthAnchor constraintEqualToConstant:54].active = YES;
    [top addArrangedSubview:label];
    [top addArrangedSubview:[[UIView alloc] initWithFrame:CGRectZero]];
    [top addArrangedSubview:valueLabel];
    [container addArrangedSubview:top];

    UISlider *slider = [UISlider new];
    slider.minimumValue = min;
    slider.maximumValue = max;
    slider.value = MIN(max, MAX(min, [self numberValue:key fallback:(percent ? 0.8 : (min + max) / 2)]));
    slider.accessibilityIdentifier = key;
    [slider addTarget:self action:@selector(sliderChanged:) forControlEvents:UIControlEventValueChanged];
    [container addArrangedSubview:slider];
    [self.formStack addArrangedSubview:container];
    self.sliders[key] = slider;
    self.sliderValues[key] = valueLabel;
    [self updateSliderLabel:key percent:percent];
}

- (void)updateSliderLabel:(NSString *)key percent:(BOOL)percent {
    UISlider *slider = self.sliders[key];
    UILabel *label = self.sliderValues[key];
    if (!slider || !label) return;
    if (percent) label.text = [NSString stringWithFormat:@"%d%%", (int)lrint(slider.value * 100)];
    else label.text = [NSString stringWithFormat:@"%d pt", (int)lrint(slider.value)];
}

- (void)sliderChanged:(UISlider *)slider {
    NSString *key = slider.accessibilityIdentifier;
    if (!key) return;
    self.values[key] = @(slider.value);
    BOOL percent = ![key isEqualToString:@"fabSize"];
    [self updateSliderLabel:key percent:percent];
}

- (void)resetStyles {
    [self.values addEntriesFromDictionary:QTUIStyleDefaults()];
    for (NSString *key in self.colorButtons) [self updateColorButton:key];
    for (NSString *key in self.sliders) {
        UISlider *slider = self.sliders[key];
        slider.value = [self numberValue:key fallback:0.5];
        [self updateSliderLabel:key percent:![key isEqualToString:@"fabSize"]];
    }
}

- (void)clearAPIKey {
    QTSaveAPIKey(@"");
    self.hasSavedKey = NO;
    self.apiKeyField.text = @"";
    self.apiKeyField.placeholder = @"Chưa có API key — nhập Gemini API key";
    [self.webView evaluateJavaScript:@"window.__qtStorageSet({apiKey: ''});" completionHandler:nil];
}

- (void)saveSettings {
    NSString *newKey = [self.apiKeyField.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] ?: @"";
    if (newKey.length) QTSaveAPIKey(newKey);

    NSMutableDictionary *values = [NSMutableDictionary dictionaryWithDictionary:self.values ?: @{}];
    values[@"apiKey"] = (newKey.length || self.hasSavedKey) ? @"__qt_keychain__" : @"";
    values[@"model"] = self.modelField.text.length ? self.modelField.text : @"gemini-3.5-flash-lite";
    values[@"language"] = self.languageField.text.length ? self.languageField.text : @"Tiếng Việt";
    values[@"visionShot"] = @NO;
    for (NSString *key in self.sliders) values[key] = @(self.sliders[key].value);
    for (NSString *key in self.colorButtons) if (![values[key] isKindOfClass:[NSString class]]) values[key] = QTUIStyleDefaults()[key];

    WKWebView *webView = self.webView;
    if (webView) {
        NSString *script = [NSString stringWithFormat:@"window.__qtStorageSet(%@);", QTJSONString(values)];
        [webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
            if (error) NSLog(@"[QuizTutor] Settings save bridge error: %@", error.localizedDescription);
        }];
    }
    [self dismissViewControllerAnimated:YES completion:nil];
}

- (void)closeSettings {
    [self dismissViewControllerAnimated:YES completion:nil];
}

@end

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
        QTSettingsViewController *settings = [[QTSettingsViewController alloc] initWithWebView:webView config:config];
        settings.modalPresentationStyle = UIModalPresentationPageSheet;
        if (@available(iOS 15.0, *)) {
            settings.sheetPresentationController.detents = @[UISheetPresentationControllerDetent.largeDetent];
            settings.sheetPresentationController.prefersGrabberVisible = YES;
            settings.sheetPresentationController.preferredCornerRadius = 18.0;
        }
        [controller presentViewController:settings animated:YES completion:nil];
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
