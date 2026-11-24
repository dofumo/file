# Quiz Tutor AI — iOS / Theos port

This directory adds an iOS rootless tweak port of the Chrome extension in the repository root.
The original `content.js` remains the source of the DOM scanner, floating button, answer badges,
explanations, caching, and multi-pass Gemini logic. A small WKWebView compatibility layer replaces
Chrome Extension APIs with IndexedDB storage and a native Objective-C message bridge.

## Features carried over

- Injects only in the Azota iOS app (`azt.azt`) and only on `azota.vn` / subdomains.
- Reuses the existing `content.js` after a build-time host guard is added.
- Provides Chrome-compatible `storage.local`, `storage.onChanged`, `runtime.getManifest`, and
  `runtime.sendMessage` shims.
- Sends Gemini requests through native `NSURLSession`, avoiding webpage CORS restrictions.
- Stores the Gemini API key in the iOS Keychain; IndexedDB contains only a non-secret “key configured” marker.
- Downloads DOM-linked images through the native bridge when page-side fetch is blocked.
- Keeps the original floating Q button, scan flow, overlays, explanations, cache, and rescan behavior.
- No extension license activation, ECDSA public key, device code, or 30-day expiry checks are included.

## Still required

- A personal Gemini API key is still required. This is the API credential used to call Gemini; it is
  separate from the removed Quiz Tutor license/activation key.
- Internet access is required for Gemini requests and remote images.
- The target iOS app must use `WKWebView`, and the assessment page must expose its content in the
  main-frame DOM. Native Flutter-only views, cross-origin subframes, canvas-only text, and protected
  content may not be readable.

## Intentionally not ported

- Browser-tab screenshots / `captureVisibleTab` and the optional `visionShot` workflow are not
  available. The bridge returns a clear unsupported response for `capture`; DOM image extraction
  remains available. This does not disable or bypass iOS/ Azota screenshot-protection features.
- Python code execution is not included; the existing content script falls back to normal Gemini
  reasoning when the native bridge returns `CODE_UNSUPPORTED`.
- The Chrome options page is replaced by a small native settings dialog for Gemini API key, model,
  and explanation language. Other original defaults remain in `content.js`.

## Single-file dylib

The CI workflow runs `scripts/embed_resources.py` after preparing `Resources/content.js`. The script
generates `Generated/QTEmbeddedScripts.h` containing both JavaScript assets as byte arrays. `Tweak.xm`
reads these arrays from the compiled image. The generated header is ignored by Git and recreated on
every CI build. The Theos Makefile builds only the tweak target; there is no resource-bundle target.

## Build with GitHub Actions

The workflow is `.github/workflows/build-ios.yml`.

1. Keep the original repository-root `content.js` in place.
2. Add the `ios-tweak/` directory and `.github/workflows/build-ios.yml` to the repository.
3. Push to `main`, or use **Actions → Build Quiz Tutor AI iOS tweak → Run workflow**.
4. Download artifact `QuizTutorAI-iOS-rootless`.
5. It contains the `.deb` package and a standalone `AzotaQuizTutor.dylib`. Both JavaScript assets are embedded in the dylib during CI; no external resource bundle is required.

The workflow uses an **absolute** `theos-dir` path. The Theos action changes its working directory while
installing SDKs, so a relative `theos-dir` can cause `mv: theos/sdks is not a directory`.

## Install

This is a rootless package for iOS 15+ and arm64. Install the `.deb` using your jailbreak package
manager. The tweak is filtered to bundle ID `azt.azt`.

After opening Azota, open a page on `azota.vn`. Tap the floating **Q** button to scan. If no Gemini
API key is saved yet, the tweak opens its native settings dialog automatically. The dialog can also
be opened by the content script's `openOptions` message.

## Important compatibility notes

- This is a first iOS port, not a byte-for-byte reproduction of Chrome's extension runtime.
- `WKUserScript` injection is installed at document start/end for future navigations. A fallback
  injection is also attempted when a WebView joins a window.
- If Azota changes its WebView architecture, app bundle ID, or the web page moves off `azota.vn`,
  this target/host filter and injection point may need adjustment.
- Verify first on your own practice/test page. Gemini output can be wrong; treat explanations as
  study guidance and verify against the material.
