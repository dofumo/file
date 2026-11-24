# Quiz Tutor AI — iOS / Theos single-dylib port

The iOS build reuses the repository-root `content.js` and embeds both JavaScript assets directly into `AzotaQuizTutor.dylib`. No external Resources.bundle is required.

## Native settings UI

On first use, tap the floating Q button. If no Gemini API key is configured, the prompt includes **Mở cài đặt**. After a scan, tap an answer badge to open its explanation panel, then tap **Cài đặt**. The native iOS settings sheet provides:

- Gemini API key (stored in iOS Keychain), model, and explanation language.
- Floating button: background/icon colors, both opacities, and size (36–72 pt).
- Answer badges: background/text/caution colors and opacities.
- Explanation panel: background/text colors, opacities, and maximum height.
- Toast notifications: background/text colors and opacities.
- Reset visual settings and clear the saved Gemini API key.

Settings are saved to the page's extension-compatible IndexedDB store; the API key itself stays in Keychain. Changes to colors, opacity, button size, and panel height are applied live by the injected content script. Color swatches open the native iOS color picker; sliders update their numeric labels while moving.

## Build

Keep the original repository-root `content.js`, add `ios-tweak/` and `.github/workflows/build-ios.yml`, then run **Actions → Build Quiz Tutor AI iOS tweak**. The workflow runs `prepare_content.py`, `embed_resources.py`, JavaScript syntax checks, and builds a rootless arm64 package for iOS 15+.

The single `.dylib` contains the injected JavaScript byte arrays. The `.deb` is optional for package-manager installation; manual injection needs only `AzotaQuizTutor.dylib`.

## Notes

- The target is filtered to app bundle ID `azt.azt` and main-frame pages on `azota.vn` / its subdomains.
- Gemini API key remains required; extension activation/license checks are not included in this personal port.
- Browser screenshot capture and Python Code Execution are not implemented.
- This is a first-party personal tweak port; verify on a practice page and treat AI output as fallible study guidance.
