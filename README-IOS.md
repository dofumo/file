# Quiz Tutor AI — iOS / Theos single-dylib port

This personal rootless tweak embeds the extension JavaScript into `AzotaQuizTutor.dylib`.

## Changes in 2.3.0

- First-pass answers are requested one question at a time when question anchors are detected (two-question groups only above 24 detected questions). Each answer badge is added as soon as its own request completes. At most two Gemini requests run in parallel to avoid a large request burst. This is progressive per question, not token-by-token streaming. If a page has no recognizable question labels, it falls back to smaller text chunks.
- While scanning, the floating Q button shows the number of answers already visible instead of staying on an ellipsis. During secondary refinement it pulses and shows a refresh glyph; individual answer badges also show their refining state.
- Native Settings now includes a live preview for the floating button, answer badge, explanation panel, and toast. Preview updates while selecting colors or moving sliders.
- Supports one primary Gemini API key plus two backup keys, all stored separately in iOS Keychain. Backup keys should be keys you own and have permission to use; keys in the same project can share quota and may not provide extra capacity.
- Supports an optional fallback model. HTTP 429 / quota errors rotate to the next key; HTTP 503 / overloaded / high-demand / MODEL_CAPACITY_EXHAUSTED errors switch directly to the fallback model rather than wasting retries on more keys. If the fallback model is also overloaded, the app returns a clear error instead of rotating keys. A one-time transient retry is performed for network failures. Google distinguishes 429 rate/quota errors from 503 temporary service-capacity errors; key rotation cannot solve a service-wide 503.
- Extension activation/license keys remain removed from this personal port. Gemini API keys are still required.

## Settings

Open the explanation panel and tap **Cài đặt**. Configure:

- Primary Gemini API key and up to two backup API keys.
- Primary model and optional fallback model.
- Explanation language.
- Colors, opacities, floating button size (36–72 pt), and explanation panel height.

The preview at the top of Settings shows how the current values will look. Save to apply them to the injected page. API keys are stored only in iOS Keychain; the IndexedDB compatibility store receives non-secret markers.

## Build

Keep the repository-root `content.js` unchanged. Add/replace `ios-tweak/` and `.github/workflows/build-ios.yml`, then run **Actions → Build Quiz Tutor AI iOS tweak**. The workflow runs `prepare_content.py`, `embed_resources.py`, JavaScript syntax checks, and builds a rootless arm64 package for iOS 15+.

The output is a single `AzotaQuizTutor.dylib`; the `.deb` is optional for package-manager installation. No external `.bundle` is required.

## Limitations

- Browser screenshot capture and Python Code Execution are not implemented.
- Progressive output is per completed request batch, not streaming individual tokens or partial JSON objects.
- Backup keys and fallback models help only when the failure is key- or model-specific. They cannot fix network outages or account-wide quota limits shared by all configured keys.
- Verify on a practice page; AI output can be wrong and should be checked against learning materials.
