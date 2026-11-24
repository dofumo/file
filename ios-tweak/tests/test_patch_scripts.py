#!/usr/bin/env python3
"""Run both fail-closed patchers against controlled upstream-shaped fixtures."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "ios-tweak" / "scripts"


def load_module(name: str, path: Path):
    spec = spec_from_file_location(name, path)
    module = module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


CONTENT_FIXTURE = r'''(() => {
  if (window.__quizTutorAI) return;
  const LABEL_RE = /^\s*(?:câu|bài|question|q)\s*\.?\s*(\d{1,3})\s*(?:[.:)\-–]|$|\s)/i;
  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'contents', 'ruby', 'ruby-text']);
  const css = `
    .fab.hide{opacity:0}
    .fab.off{text-decoration:line-through}
  `;
  function detectAnchors(lines) {
    const idx = [], nums = [];
    lines.forEach((t, i) => { const m = LABEL_RE.exec(t); if (m) { idx.push(i); nums.push(+m[1]); } });
    if (idx.length < 3) return [];
    return idx;
  }
  function makeAnchorChunks(lines, anchors, perChunk, maxChars) { return []; }
  // Giải riêng (theo lô 4 câu) những câu mà lượt quét toàn trang bỏ sót
  async function solveByAnchors(anchors, cfg, model, thinking) { return []; }
  function makeChunks(lines, maxChars) { return []; }
  function updateFab() {
    fab.textContent = state.status === 'loading' ? '…' : state.status === 'error' ? '!' : state.items.length ? String(state.items.length) : 'Q';
  }
  function refreshBadge(it) {
    if (state.active === it) renderPop(it);
    schedule();
  }
  async function refineFixture() {
    todo.forEach((it) => { it.refining = true; refreshBadge(it); });
    const cnt = { failed: 0, err: null, fellBack: false };
      await pool(Math.max(1, Number(cfg.parallel) || 1), batches.length, async (bi) => {});
    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });

    if (!cnt.failed && cacheKeyCur) {
      cacheKeyCur = null;
    }
  }
  async function doScan() {
    const { qtCache } = await store.get({ qtCache: {} });
      if (qtCache[cacheKey]) cached = qtCache[cacheKey].items;
    let firstError = null, fromCache = false, cached = null;
    if (cached) {
      fromCache = true;
    } else {
      const useImgs = cfg.sendImages && images.length > 0;
      const calcShare = 0;
      const heavyCalc = false;
      const pageMathy = false;
      let maxChars = 50000;
      const chunks = pageAnchors.length ? makeAnchorChunks(lines, pageAnchors, 8, 20000) : makeChunks(lines, maxChars);
    }
    if (myScan !== scanId) return;

    if (!state.items.length) return;
    if (firstError) toast(`Xong ${state.items.length} câu, nhưng một lô bị lỗi: ${firstError.message}`, 'error', { ms: 9000, settings: true });
    else if (!todo.length) toast(`Đã giải ${state.items.length}${pageAnchors.length ? '/' + pageAnchors.length : ''} câu${missingN ? ` (còn ${missingN} câu chưa giải được – chuột phải vào nút để quét lại)` : ''}${fromCache ? ' (dùng kết quả đã lưu, không tốn request)' : ''}. Bấm vào ô đáp án để xem hướng dẫn.${imgWarn()}`, 'info', { ms: 7000 });
    const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };
    const d = {
      first80Lines: pageLines.slice(0, 80).map((t, i) => `[${i}] ${clip(t)}`),
    };
    const missingN = pageAnchors.length ? Math.max(0, pageAnchors.length - state.items.length) : 0;
  }
})();
'''

PIN_OLD = '''static void QTPinFallbackForModelPair(NSString *primaryModel, NSString *fallbackModel, NSString *reason) {
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
MODELS_OLD = '''    NSString *requestedModel = [message[@"model"] isKindOfClass:[NSString class]] && [message[@"model"] length]
        ? message[@"model"]
        : ([config[@"model"] isKindOfClass:[NSString class]] && [config[@"model"] length] ? config[@"model"] : @"gemini-3.5-flash-lite");
    NSString *fallbackModel = [config[@"fallbackModel"] isKindOfClass:[NSString class]]
        ? [config[@"fallbackModel"] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] : @"";
    if (!fallbackModel.length) fallbackModel = @"gemini-3.1-flash-lite";
    NSString *pinnedFallback = QTStickyFallbackForModelPair(requestedModel, fallbackModel);
    BOOL isUsingPinnedFallback = pinnedFallback.length > 0;
    NSString *effectiveModel = isUsingPinnedFallback ? pinnedFallback : requestedModel;
'''
NETWORK_OLD = '''        if (networkError) {
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
HIGH_OLD = '''        if (highDemand) {
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


def main():
    with tempfile.TemporaryDirectory(prefix="qt-patcher-test-") as temp:
        root = Path(temp)
        (root / "ios-tweak" / "scripts").mkdir(parents=True)
        (root / "ios-tweak" / "Resources").mkdir()
        (root / "ios-tweak" / "tests").mkdir()

        # Scan-pipeline patcher fixture.
        content_path = root / "ios-tweak" / "Resources" / "content.js"
        content_path.write_text(CONTENT_FIXTURE, encoding="utf-8")
        shim_path = root / "ios-tweak" / "Resources" / "quiz-tutor-shim.js"
        shim_path.write_text("chrome.runtime.getManifest = () => ({ version: '2.3.0-ios' });\n", encoding="utf-8")
        (root / "ios-tweak" / "scripts" / "scan_pipeline_core.js").write_text(
            (SCRIPTS / "scan_pipeline_core.js").read_text(encoding="utf-8"), encoding="utf-8"
        )
        apply_mod = load_module("apply_stability_patch_test", SCRIPTS / "apply_stability_patch.py")
        apply_mod.ROOT = root
        apply_mod.CONTENT = content_path
        apply_mod.CORE = root / "ios-tweak" / "scripts" / "scan_pipeline_core.js"
        apply_mod.main()
        patched_content = content_path.read_text(encoding="utf-8")
        assert "window.__QTScanCore.detectAnchors" in patched_content
        assert "coverageKnown = pageAnchors.length > 0" in patched_content
        assert "repairDone" in patched_content
        assert "pageAnchors.length > 0 && pageAnchors.every" in patched_content
        assert "2.4.0-ios" in shim_path.read_text(encoding="utf-8")
        assert ".fab.refining" in patched_content
        assert "Đang tinh chỉnh" in patched_content
        subprocess.run(["node", "--check", str(content_path)], check=True, capture_output=True, text=True)

        # Native router patcher fixture.
        tweak_path = root / "ios-tweak" / "Tweak.xm"
        tweak_path.write_text(
            PIN_OLD + "\n" + MODELS_OLD + "\n" + NETWORK_OLD + "\n" +
            '        BOOL keyInvalid = (status == 400 || status == 403) && ([lowerError containsString:@"api_key_invalid"] || [lowerError containsString:@"api key not valid"] || [lowerError containsString:@"invalid api key"] || [lowerError containsString:@"api key is invalid"]);\n' +
            '        BOOL highDemand = status == 503 || [lowerError containsString:@"high demand"] || [lowerError containsString:@"overloaded"] || [lowerError containsString:@"model_capacity_exhausted"] || [lowerError containsString:@"no capacity available for model"];\n' +
            HIGH_OLD + '\n        if (quotaLimited || keyInvalid || status == 403) { rotate(); }\n',
            encoding="utf-8"
        )
        native_mod = load_module("patch_native_router_test", SCRIPTS / "patch_native_router.py")
        native_mod.ROOT = root
        native_mod.TWEAK = tweak_path
        native_mod.main()
        patched_native = tweak_path.read_text(encoding="utf-8")
        assert "static BOOL QTPinFallbackForModelPair" in patched_native
        assert "@synchronized (defaults)" in patched_native
        assert "BOOL highDemand = [lowerError containsString:@\"high demand\"]" in patched_native
        assert "BOOL highDemand = status == 503 ||" not in patched_native
        assert "configuredPrimaryModel" in patched_native
        assert "A transport failure is not evidence of a bad key" in patched_native
        assert "status == 401" in patched_native
        assert "if (quotaLimited || keyInvalid)" in patched_native

    print("patch_scripts: PASS (scan patcher + native routing patcher)")


if __name__ == "__main__":
    main()
