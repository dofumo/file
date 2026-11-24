#!/usr/bin/env python3
"""Harden the native Gemini router: one sticky fallback route, no network/key churn."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TWEAK = ROOT / "ios-tweak" / "Tweak.xm"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"[{label}] expected 1 match, got {count}; refusing partial patch.")
    return text.replace(old, new, 1)


def main() -> None:
    text = TWEAK.read_text(encoding="utf-8")

    old_pin = '''static void QTPinFallbackForModelPair(NSString *primaryModel, NSString *fallbackModel, NSString *reason) {
    if (!primaryModel.length || !fallbackModel.length || [primaryModel isEqualToString:fallbackModel]) return;
    NSDictionary *state = @{
        @"primary": primaryModel,
        @"fallback": fallbackModel,
        @"selected": fallbackModel,
        @"reason": reason ?: @"high_demand",
        @"changedAt": @([[NSDate date] timeIntervalSince1970])
    };
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:state forKey:kQTStickyModelRouteDefaultsKey];
    [defaults synchronize];
    NSLog(@"[QuizTutor] Model %@ is pinned to %@ after high-demand response.", primaryModel, fallbackModel);
}
'''
    new_pin = '''static BOOL QTPinFallbackForModelPair(NSString *primaryModel, NSString *fallbackModel, NSString *reason) {
    if (!primaryModel.length || !fallbackModel.length || [primaryModel isEqualToString:fallbackModel]) return NO;
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    __block BOOL didPin = NO;
    @synchronized (defaults) {
        NSDictionary *oldState = [defaults objectForKey:kQTStickyModelRouteDefaultsKey];
        if ([oldState[@"primary"] isEqualToString:primaryModel] &&
            [oldState[@"fallback"] isEqualToString:fallbackModel] &&
            [oldState[@"selected"] isEqualToString:fallbackModel]) {
            return NO; // Another in-flight request already pinned this route.
        }
        NSDictionary *state = @{
            @"primary": primaryModel,
            @"fallback": fallbackModel,
            @"selected": fallbackModel,
            @"reason": reason ?: @"high_demand",
            @"changedAt": @([[NSDate date] timeIntervalSince1970])
        };
        [defaults setObject:state forKey:kQTStickyModelRouteDefaultsKey];
        [defaults synchronize];
        didPin = YES;
    }
    if (didPin) NSLog(@"[QuizTutor] Model %@ is pinned to %@ after high-demand response.", primaryModel, fallbackModel);
    return didPin;
}
'''
    text = replace_once(text, old_pin, new_pin, "idempotent sticky pin")

    old_models = '''    NSString *requestedModel = [message[@"model"] isKindOfClass:[NSString class]] && [message[@"model"] length]
        ? message[@"model"]
        : ([config[@"model"] isKindOfClass:[NSString class]] && [config[@"model"] length] ? config[@"model"] : @"gemini-3.5-flash-lite");
    NSString *fallbackModel = [config[@"fallbackModel"] isKindOfClass:[NSString class]]
        ? [config[@"fallbackModel"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
    if (!fallbackModel.length) fallbackModel = @"gemini-3.1-flash-lite";
    NSString *pinnedFallback = QTStickyFallbackForModelPair(requestedModel, fallbackModel);
    BOOL isUsingPinnedFallback = pinnedFallback.length > 0;
    NSString *effectiveModel = isUsingPinnedFallback ? pinnedFallback : requestedModel;
'''
    new_models = '''    NSString *configuredPrimaryModel = ([config[@"model"] isKindOfClass:[NSString class]] && [config[@"model"] length])
        ? [config[@"model"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
        : @"gemini-3.5-flash-lite";
    NSString *requestedModel = ([message[@"model"] isKindOfClass:[NSString class]] && [message[@"model"] length])
        ? [message[@"model"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]
        : configuredPrimaryModel;
    NSString *fallbackModel = [config[@"fallbackModel"] isKindOfClass:[NSString class]]
        ? [config[@"fallbackModel"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
    if (!fallbackModel.length) fallbackModel = @"gemini-3.1-flash-lite";

    // One route is shared by first-pass, repair and refinement calls. A high-demand
    // response from any configured request model pins the configured fallback for
    // every subsequent request until the user resets it or changes the model pair.
    NSString *pinnedFallback = QTStickyFallbackForModelPair(configuredPrimaryModel, fallbackModel);
    BOOL isUsingPinnedFallback = pinnedFallback.length > 0;
    NSString *effectiveModel = isUsingPinnedFallback ? pinnedFallback : requestedModel;
'''
    text = replace_once(text, old_models, new_models, "global route model selection")

    old_network = '''        if (networkError) {
            if (networkRetry < 1) {
                QTNotifyStatus(webView, requestID, @"Kết nối Gemini bị gián đoạn; đang thử lại cùng model và API key…");
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 1.5)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    [self callGemini:message config:config webView:webView requestID:requestID candidateIndex:candidateIndex networkRetry:networkRetry + 1 thinkingEnabled:thinkingEnabled];
                });
            } else if (keyIndex + 1 < apiKeys.count) {
                QTNotifyStatus(webView, requestID, @"Kết nối lỗi với API key hiện tại; đang thử key tiếp theo nhưng giữ nguyên model…");
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 1.0)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    [self callGemini:message config:config webView:webView requestID:requestID candidateIndex:candidateIndex + 1 networkRetry:0 thinkingEnabled:thinkingEnabled];
                });
            } else {
                QTReply(webView, requestID, @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"Lỗi mạng Gemini với model %@: %@", model, networkError.localizedDescription ?: @"không rõ"] });
            }
            return;
        }
'''
    new_network = '''        if (networkError) {
            if (networkRetry < 1) {
                QTNotifyStatus(webView, requestID, @"Kết nối Gemini bị gián đoạn; đang thử lại đúng một lần với cùng model và API key…");
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 1.5)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    [self callGemini:message config:config webView:webView requestID:requestID candidateIndex:candidateIndex networkRetry:networkRetry + 1 thinkingEnabled:thinkingEnabled];
                });
            } else {
                // A transport failure is not evidence of a bad key. Do not rotate
                // keys or models for DNS/TLS/connection failures.
                QTReply(webView, requestID, @{ @"ok": @NO, @"error": [NSString stringWithFormat:@"Lỗi mạng Gemini với model %@ (đã thử lại một lần): %@", model, networkError.localizedDescription ?: @"không rõ"] });
            }
            return;
        }
'''
    text = replace_once(text, old_network, new_network, "network retry policy")

    text = replace_once(
        text,
        "        BOOL keyInvalid = (status == 400 || status == 403) && ([lowerError containsString:@\"api_key_invalid\"] || [lowerError containsString:@\"api key not valid\"] || [lowerError containsString:@\"invalid api key\"] || [lowerError containsString:@\"api key is invalid\"]);",
        "        BOOL keyInvalid = (status == 400 || status == 401 || status == 403) && ([lowerError containsString:@\"api_key_invalid\"] || [lowerError containsString:@\"api key not valid\"] || [lowerError containsString:@\"invalid api key\"] || [lowerError containsString:@\"api key is invalid\"]);",
        "identify explicit invalid key responses",
    )
    text = replace_once(
        text,
        "        BOOL highDemand = status == 503 || [lowerError containsString:@\"high demand\"] || [lowerError containsString:@\"overloaded\"] || [lowerError containsString:@\"model_capacity_exhausted\"] || [lowerError containsString:@\"no capacity available for model\"];",
        "        BOOL highDemand = [lowerError containsString:@\"high demand\"] || [lowerError containsString:@\"overloaded\"] || [lowerError containsString:@\"model_capacity_exhausted\"] || [lowerError containsString:@\"no capacity available for model\"];",
        "pin fallback only for explicit capacity errors",
    )

    old_high = '''        if (highDemand) {
            // A high-demand response is model-level, not key-level. Pin the configured
            // fallback persistently so every later chunk/request starts on that model.
            if (!isUsingPinnedFallback && fallbackModel.length && ![fallbackModel isEqualToString:requestedModel]) {
                QTPinFallbackForModelPair(requestedModel, fallbackModel, @"high_demand");
                QTNotifyStatus(webView, requestID, [NSString stringWithFormat:@"%@ đang high demand; đã chuyển sang %@ và sẽ giữ model này cho các request tiếp theo.", model, fallbackModel]);
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 0.5)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    // Re-enter from candidate zero; the sticky route makes fallbackModel
                    // the sole active model for this and all subsequent requests.
                    [self callGemini:message config:config webView:webView requestID:requestID candidateIndex:0 networkRetry:0 thinkingEnabled:thinkingEnabled];
                });
                return;
            }
            NSString *reason = isUsingPinnedFallback
                ? [NSString stringWithFormat:@"Model dự phòng %@ cũng đang high demand. Đã giữ nguyên model dự phòng; không tự quay lại %@.", model, requestedModel]
                : [NSString stringWithFormat:@"Model %@ đang high demand nhưng chưa cấu hình model dự phòng. Hãy đặt Model dự phòng trong Cài đặt.", model];
            QTReply(webView, requestID, @{ @"ok": @NO, @"error": reason });
            return;
        }
'''
    new_high = '''        if (highDemand) {
            // High demand is model-level. Pin once against the configured primary,
            // regardless of whether this request came from first-pass or refinement.
            if (!isUsingPinnedFallback && fallbackModel.length && ![fallbackModel isEqualToString:model]) {
                BOOL newlyPinned = QTPinFallbackForModelPair(configuredPrimaryModel, fallbackModel, @"high_demand");
                if (newlyPinned) {
                    QTNotifyStatus(webView, requestID, [NSString stringWithFormat:@"%@ đang high demand; đã chuyển toàn bộ hàng đợi sang %@. Các request tiếp theo sẽ giữ model này.", model, fallbackModel]);
                }
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(NSEC_PER_SEC * 0.5)), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    [self callGemini:message config:config webView:webView requestID:requestID candidateIndex:0 networkRetry:0 thinkingEnabled:thinkingEnabled];
                });
                return;
            }
            NSString *reason = isUsingPinnedFallback
                ? [NSString stringWithFormat:@"Model dự phòng %@ cũng đang high demand. Giữ nguyên model dự phòng; không đổi key và không quay lại %@.", model, configuredPrimaryModel]
                : [NSString stringWithFormat:@"Model %@ đang high demand nhưng không có model dự phòng khác để chuyển sang.", model];
            QTReply(webView, requestID, @{ @"ok": @NO, @"error": reason });
            return;
        }
'''
    text = replace_once(text, old_high, new_high, "sticky fallback only once")

    text = replace_once(
        text,
        "        if (quotaLimited || keyInvalid || status == 403) {",
        "        if (quotaLimited || keyInvalid) {",
        "do not rotate generic 403 permission errors",
    )

    TWEAK.write_text(text, encoding="utf-8")
    print("Native Gemini router hardened: global sticky fallback, bounded retries, precise key rotation.")


if __name__ == "__main__":
    main()
