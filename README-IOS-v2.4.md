# QuizTutorAI iOS v2.4 — scan/retry stability patch

This is a patch for the existing `dofumo/file` repository. It does **not** replace
or reformat the 75 KB upstream `content.js`; CI prepares it, then applies a
fail-closed stability patch before embedding it in the standalone dylib.

## What changed

### 1. Question extraction and coverage

- Question labels support `Câu 1`, `Câu hỏi số 1`, `Bài 1`, `Question 1`, and `Q1` forms.
- The detector chooses the longest increasing sequence of explicit question labels,
  rejecting repeated UI labels and unrelated counters.
- Diagnostics now include the number and sample of detected anchors. This helps
  distinguish a DOM extraction problem (e.g. only 22 anchors were collected) from
  an AI response problem (43 anchors were collected, fewer answers were returned).

### 2. Adaptive batching

- Short theory questions: up to 4 per request.
- Normal questions: up to 3 per request.
- Questions with calculations/images or longer content: 1–2 per request.
- A request is capped by a text-size and image-count budget.
- At most 2 first-pass requests run concurrently; refinement and tie-break requests
  are also capped at 2 concurrent calls.

### 3. Strict answer-to-question matching

- Responses are matched to the question segment that contains the returned anchor.
- An answer cannot silently be assigned to an unrelated question.
- Duplicate answers for one anchor do not falsely mark another question as completed.
- Missing questions are collected globally after the first pass, avoiding duplicate
  repair calls launched independently by each chunk.
- Two bounded repair passes run sequentially: first groups of 2, then individual
  questions. Remaining omissions are reported instead of being hidden.
- If the page does not expose enough explicit question labels to establish coverage,
  the tweak does not claim that all questions were found and does not cache the
  unknown-coverage result as complete.

### 4. Cache correctness

- Partial cache entries are rejected when they do not cover every detected question.
- The iOS cache namespace is bumped to `2.4.0-ios`, so incomplete 2.3.x results are
  not reused as if they were complete.
- Cache is written only when all detected anchors have a result.

### 5. Gemini request routing

- An explicit high-demand / overloaded / `MODEL_CAPACITY_EXHAUSTED` response pins the
  configured fallback model once for the entire app route (first pass, recovery,
  and refinement), not separately per request. A generic HTTP 503 without an
  overload/capacity indication is retried once with the same model and key.
- Concurrent requests that encounter the same capacity failure do not repeatedly
  emit fallback notifications; the route pin is protected by a synchronized write
  and all requests re-enter through the pinned route.
- If the fallback model is also overloaded, the request stops with a clear message.
- HTTP 429 quota and explicit invalid-key responses may rotate through configured
  backup keys while keeping the selected model unchanged.
- Generic 403 permission errors and transport/DNS/TLS failures do not rotate keys.
- Network errors and generic 5xx errors receive one retry with the same model/key;
  transport failures never rotate API keys because they do not prove a key is bad.

## Files in this patch

- `ios-tweak/scripts/scan_pipeline_core.js`: pure question detection, adaptive planner,
  anchor normalization and grouping functions.
- `ios-tweak/scripts/apply_stability_patch.py`: applies the tested helpers to the
  prepared `content.js` and invalidates old partial cache entries.
- `ios-tweak/scripts/patch_native_router.py`: hardens sticky fallback and retry policy
  in `Tweak.xm` at build time.
- `ios-tweak/tests/scan_pipeline.test.js`: Node tests with a synthetic 43-question page,
  adaptive mixed-complexity batching, anchor normalization and missing-answer repair.
- `ios-tweak/tests/test_patch_scripts.py`: verifies both fail-closed patchers against
  upstream-shaped fixtures and syntax-checks the generated JavaScript.
- `.github/workflows/build-ios.yml`: runs patching, syntax checks, tests and Theos build.

## Apply to `dofumo/file`

Copy the included `ios-tweak/` directory over the existing one, and replace
`.github/workflows/build-ios.yml` with the included workflow. Keep the root
`content.js`, `manifest.json`, and existing settings files unchanged.

Then commit/push and run **Actions → Build Quiz Tutor AI iOS tweak**. The workflow
will stop before Theos if a patch marker changes or a test fails.

## Validation and limitations

The synthetic unit tests cover 43 labels, duplicate labels, adaptive coverage,
anchor-offset normalization, duplicate AI outputs, missing-answer detection and
repair grouping. The patch scripts fail closed if the current upstream source no
longer matches expected code markers. A green GitHub Actions run is still required
to prove Objective-C/Theos compilation. A successful build does not guarantee that
Azota exposes all 43 questions in the WKWebView DOM. If diagnostics detect only 22
anchors, the remaining questions were not present as recognizable question blocks
in the collected DOM at scan time; batching cannot recover content the page did not
expose. The diagnostic anchor count is therefore essential.

Gemini can still omit or misunderstand content. The system reports the exact
remaining count after two repair passes; it does not claim completeness when
questions are missing. Answers should be treated as study explanations and checked
against the course material.
