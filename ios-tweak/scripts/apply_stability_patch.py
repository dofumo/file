#!/usr/bin/env python3
"""Apply the v2.4 stable scan pipeline to the prepared iOS content script.

Run after prepare_content.py and before embed_resources.py.
The patch is intentionally fail-closed: every expected upstream anchor must be
present exactly once or the build stops instead of producing a half-patched dylib.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTENT = ROOT / "ios-tweak" / "Resources" / "content.js"
CORE = Path(__file__).with_name("scan_pipeline_core.js")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"[{label}] expected exactly one match, found {count}; source was not changed.")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"[{label}] start marker not found; source was not changed.")
    b = text.find(end, a + len(start))
    if b < 0:
        raise SystemExit(f"[{label}] end marker not found; source was not changed.")
    return text[:a] + replacement + text[b:]


def main() -> None:
    if not CONTENT.is_file() or not CORE.is_file():
        raise SystemExit("Missing prepared content.js or scan_pipeline_core.js")
    text = CONTENT.read_text(encoding="utf-8")
    core = CORE.read_text(encoding="utf-8").strip()

    # Inject pure, testable helpers into the same JS payload so the dylib remains standalone.
    marker = "  if (window.__quizTutorAI) return;"
    if "window.__QTScanCore" not in text:
        text = replace_once(text, marker, core + "\n\n" + marker, "inject scan core")

    text = replace_once(
        text,
        "  const LABEL_RE = /^\\s*(?:câu|bài|question|q)\\s*\\.?\\s*(\\d{1,3})\\s*(?:[.:)\\-–]|$|\\s)/i;",
        "  const LABEL_RE = /^\\s*(?:câu(?:\\s+hỏi)?|bài|question|q)\\s*(?:số\\s*)?[.#:]?\\s*(\\d{1,3})\\s*(?:[.:)\\-–—]|$|\\s)/i;",
        "broaden question label matcher",
    )

    # Treat display:contents nodes as logical DOM containers. This prevents all
    # question cards inside a flex/grid list from collapsing into one collected line.
    text = replace_once(
        text,
        "  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'contents', 'ruby', 'ruby-text']);",
        "  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'ruby', 'ruby-text']);",
        "preserve display-contents question containers",
    )

    # Replace both the old label detector and count-only chunker with the tested core.
    start = "  function detectAnchors(lines) {"
    end = "  // Giải riêng (theo lô 4 câu) những câu mà lượt quét toàn trang bỏ sót"
    replacement = """  function detectAnchors(lines) {
    return window.__QTScanCore.detectAnchors(lines, LABEL_RE);
  }

  function makeAnchorChunks(lines, anchors, perChunk, maxChars) {
    return window.__QTScanCore.planQuestionChunks(lines, anchors, {
      calcScore,
      maxTheoryChars: maxChars || 11000,
      maxComplexChars: Math.min(maxChars || 7200, 9000),
      maxImages: 8
    });
  }

"""
    text = replace_between(text, start, end, replacement, "replace detector and planner")

    # Recovery now sends only the missing anchors, maps model line offsets to their
    # containing question segment, and returns canonical anchor IDs.
    start = "  // Giải riêng (theo lô 4 câu) những câu mà lượt quét toàn trang bỏ sót"
    end = "  function makeChunks(lines, maxChars) {"
    replacement = """  // Repair only questions that were not returned in the first pass.
  async function solveByAnchors(anchors, cfg, model, thinking) {
    const group = (anchors || []).slice();
    if (!group.length) return [];
    const system = buildSolveSystem(cfg.language, cfg.detail, group.some((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))));
    const ids = new Set();
    const blocks = group.map((a) => {
      const next = pageAnchors.find((x) => x > a);
      const slice = pageLines.slice(a, next ?? pageLines.length);
      imageIdsIn(slice).forEach((x) => ids.add(x));
      return `=== CÂU (anchor ${a}) ===\\n` + slice.map((t, k) => `[${a + k}] ${t}`).join('\\n');
    });
    const exact = `\\n\\nCHỈ giải đúng các câu có anchor: ${group.join(', ')}. Mỗi câu đúng một phần tử JSON. Trường anchor phải bằng chính xác một trong các số trên; không dùng anchor của dòng phương án hoặc dòng giải thích.`;
    const parts = await buildParts(`Trang: ${document.title}\\n\\n` + blocks.join('\\n\\n') + exact, [...ids].slice(0, MAX_IMAGES_REQ), cfg);
    const arr = await sendGemini(system, parts, { model: model || undefined, thinking: thinking || 'medium' });
    const afterLast = pageAnchors.find((x) => x > group[group.length - 1]) ?? pageLines.length;
    const ranges = group.map((a) => ({ anchor: a, start: a, end: pageAnchors.find((x) => x > a) ?? pageLines.length }));
    const chunk = { start: group[0], from: group[0], end: afterLast, expected: group, ranges };
    return window.__QTScanCore.normalizeAnswers(arr, chunk).items;
  }

"""
    text = replace_between(text, start, end, replacement, "replace repair function")

    # Old cache entries could contain only half the questions. Refuse incomplete cache hits.
    text = replace_once(
        text,
        "      if (qtCache[cacheKey]) cached = qtCache[cacheKey].items;",
        """      if (qtCache[cacheKey] && Array.isArray(qtCache[cacheKey].items)) {
        const candidate = qtCache[cacheKey].items;
        const cachedAnchors = new Set(candidate.map((q) => Number(q && q.anchor)).filter(Number.isFinite));
        const cacheComplete = pageAnchors.length > 0 && pageAnchors.every((a) => cachedAnchors.has(a));
        if (cacheComplete) cached = candidate;
      }""",
        "reject partial cache entries",
    )

    text = replace_once(
        text,
        "    let firstError = null, fromCache = false, cached = null;",
        "    let firstError = null, failedRequests = 0, fromCache = false, cached = null;",
        "track failed request count outside scan branch",
    )

    # Replace the complete first-pass block with adaptive batching + two bounded repair passes.
    start = "      const useImgs = cfg.sendImages && images.length > 0;"
    end = "    }\n    if (myScan !== scanId) return;\n\n    if (!state.items.length)"
    new_body = """      const useImgs = cfg.sendImages && images.length > 0;
      const calcShare = pageAnchors.length
        ? pageAnchors.filter((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))).length / pageAnchors.length
        : (isCalc(lines.join(' ')) ? 1 : 0);
      const heavyCalc = calcShare >= 0.4;
      const pageMathy = heavyCalc || (useImgs && images.length >= 8);
      const maxChars = pageMathy ? 7200 : 11000;
      const chunks = pageAnchors.length
        ? window.__QTScanCore.planQuestionChunks(lines, pageAnchors, {
            calcScore,
            maxTheoryChars: 11000,
            maxComplexChars: 7200,
            maxImages: 8
          })
        : makeChunks(lines, maxChars);
      const systemCalc = buildSystem(cfg.language, cfg.detail, true);
      const systemPlain = buildSystem(cfg.language, cfg.detail, false);
      const foundByAnchor = new Map();
      let doneChunks = 0;
      let repairDone = 0;
      const progress = (phase) => {
        const total = pageAnchors.length || '?';
        const found = pageAnchors.length ? foundByAnchor.size : state.items.length;
        const work = phase === 'Đang khôi phục'
          ? `${repairDone} nhóm khôi phục đã xử lý`
          : `${doneChunks}/${chunks.length} lô ban đầu`;
        toast(`${phase || 'Đang quét'}${heavyCalc ? ' (nhiều bài tính toán)' : ''}… ${found}/${total} câu đã hiện · ${work}`, 'info', { sticky: true });
      };
      progress('Đang quét');

      // First pass: adaptive batches (3–4 theory questions, 2 complex questions,
      // one very long/image-heavy question). Never launch more than two calls at once.
      await pool(Math.min(2, Math.max(1, Number(cfg.parallel) || 2)), chunks.length, async (ci) => {
        const c = chunks[ci];
        const slice = lines.slice(c.from, c.end);
        const ids = imageIdsIn(slice);
        const body = slice.map((t, i) => `[${c.from + i}] ${t}`).join('\\n');
        const expNote = c.expected
          ? `\\nĐây là đúng ${c.expected.length} câu. Anchor bắt buộc theo thứ tự: ${c.expected.join(', ')}. Trả về một phần tử JSON cho MỖI anchor, không gộp câu, không bỏ câu; anchor phải là số dòng đề bài bắt đầu.`
          : '';
        const text = `Trang: ${document.title}\\nTên miền: ${location.hostname}\\nChỉ trả về câu hỏi có anchor >= ${c.start}.${expNote}\\n\\nNỘI DUNG:\\n${body}`;
        const thinking = cfg.accuracy ? 'medium' : cfg.thinking === 'auto' ? ((isCalc(body) || (cfg.sendImages && ids.length > 0)) ? 'medium' : 'minimal') : cfg.thinking;
        try {
          const parts = await buildParts(text, ids, cfg);
          const withCalc = c.expected ? c.expected.some((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))) : isCalc(body);
          const arr = await sendGemini(withCalc ? systemCalc : systemPlain, parts, { thinking });
          const normalized = window.__QTScanCore.normalizeAnswers(arr, c);
          for (const q of normalized.items) foundByAnchor.set(q.anchor, q);
          if (myScan === scanId && normalized.items.length) addItems(normalized.items, els);
          if (normalized.missing.length) console.warn('[QuizTutor] Lô', ci + 1, 'thiếu anchor:', normalized.missing);
        } catch (e) {
          failedRequests++;
          firstError = firstError || e;
          if (c.expected) console.warn('[QuizTutor] Lô', ci + 1, 'lỗi, sẽ đưa câu vào hàng đợi sửa:', e && e.message);
        }
        doneChunks++;
        if (myScan === scanId) progress('Đang quét');
      });
      if (myScan !== scanId) return;

      // Recovery is global, not launched independently by each chunk. This avoids
      // duplicate retries and keeps request concurrency at one during repair.
      if (pageAnchors.length) {
        for (let pass = 0; pass < 2; pass++) {
          const missing = window.__QTScanCore.missingAnchors(pageAnchors, new Set(foundByAnchor.keys()));
          if (!missing.length) break;
          const groupSize = pass === 0 ? 2 : 1;
          const groups = window.__QTScanCore.groupAnchors(missing, groupSize);
          toast(`Đang khôi phục ${missing.length} câu còn thiếu (${pass + 1}/2)…`, 'info', { sticky: true });
          for (let gi = 0; gi < groups.length; gi++) {
            if (myScan !== scanId) return;
            const group = groups[gi];
            try {
              const repaired = await solveByAnchors(group, cfg, null, 'medium');
              for (const q of repaired) foundByAnchor.set(q.anchor, q);
              if (repaired.length) addItems(repaired, els);
            } catch (e) {
              failedRequests++;
              firstError = firstError || e;
              console.warn('[QuizTutor] Khôi phục nhóm', group, 'thất bại:', e && e.message);
            }
            repairDone++;
            progress('Đang khôi phục');
          }
        }
      }

      const results = [...foundByAnchor.values()].sort((a, b) => a.anchor - b.anchor);
      const missingAfterRepair = pageAnchors.length
        ? window.__QTScanCore.missingAnchors(pageAnchors, new Set(foundByAnchor.keys()))
        : [];
      // Without a reliable expected-question list, do not call the result complete
      // and do not cache an unknown-coverage answer set.
      const complete = pageAnchors.length > 0 && missingAfterRepair.length === 0;
      if (complete) {
        try {
          const { qtCache } = await store.get({ qtCache: {} });
          qtCache[cacheKey] = { t: Date.now(), items: results };
          const keys = Object.keys(qtCache).sort((x, y) => qtCache[y].t - qtCache[x].t);
          for (const k of keys.slice(25)) delete qtCache[k];
          await store.set({ qtCache });
        } catch (_) {}
      } else if (missingAfterRepair.length) {
        console.warn('[QuizTutor] Chưa nhận được câu:', missingAfterRepair);
      }
"""
    text = replace_between(text, start, end, new_body, "replace first-pass pipeline")

    # Refinement and tie-break requests use the same bounded concurrency as the first pass.
    text = replace_once(
        text,
        "      await pool(Math.max(1, Number(cfg.parallel) || 1), batches.length, async (bi) => {",
        "      await pool(Math.min(2, Math.max(1, Number(cfg.parallel) || 2)), batches.length, async (bi) => {",
        "cap refinement API concurrency",
    )

    # Surface native sticky-model / API-key routing messages inside the page UI.
    text = replace_once(
        text,
        "  const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };",
        "  const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };\n"
        "  window.addEventListener('qt-native-status', (event) => {\n"
        "    const message = event && event.detail && event.detail.message;\n"
        "    if (message) toast(message, 'info', { ms: 5000 });\n"
        "  });",
        "native route status toast",
    )

    # Add explicit anchor samples to diagnostics so extraction loss can be separated
    # from Gemini omissions without guessing.
    text = replace_once(
        text,
        "      first80Lines: pageLines.slice(0, 80).map((t, i) => `[${i}] ${clip(t)}`),",
        "      detectedAnchorSamples: pageAnchors.slice(0, 100).map((a, i) => ({ questionIndex: i + 1, anchor: a, text: clip(pageLines[a] || '', 180) })),\n      first80Lines: pageLines.slice(0, 80).map((t, i) => `[${i}] ${clip(t)}`),",
        "diagnostics anchor samples",
    )

    # Show the difference between detected labels and AI answers in final status.
    text = replace_once(
        text,
        "    const missingN = pageAnchors.length ? Math.max(0, pageAnchors.length - state.items.length) : 0;",
        "    const foundAnchors = new Set(state.items.map((it) => Number(it.q.anchor)));\n    const coverageKnown = pageAnchors.length > 0;\n    const missingN = coverageKnown ? window.__QTScanCore.missingAnchors(pageAnchors, foundAnchors).length : 0;",
        "accurate final coverage count",
    )
    text = replace_once(
        text,
        "    if (firstError) toast(`Xong ${state.items.length} câu, nhưng một lô bị lỗi: ${firstError.message}`, 'error', { ms: 9000, settings: true });\n    else if (!todo.length) toast(`Đã giải ${state.items.length}${pageAnchors.length ? '/' + pageAnchors.length : ''} câu${missingN ? ` (còn ${missingN} câu chưa giải được – chuột phải vào nút để quét lại)` : ''}${fromCache ? ' (dùng kết quả đã lưu, không tốn request)' : ''}. Bấm vào ô đáp án để xem hướng dẫn.${imgWarn()}`, 'info', { ms: 7000 });",
        """    if (!coverageKnown) toast(`Đã hiển thị ${state.items.length} kết quả, nhưng không nhận diện được nhãn câu hỏi để xác nhận tổng số. Không lưu cache hoàn chỉnh; hãy xem Chẩn đoán nếu trang có nhiều câu hơn.`, 'error', { ms: 12000 });
    else if (missingN) toast(`Đã nhận ${state.items.length}/${pageAnchors.length} câu. Còn ${missingN} câu chưa có kết quả sau 2 lượt khôi phục; hãy kiểm tra Chẩn đoán để phân biệt thiếu ở bước trích xuất hay Gemini.`, 'error', { ms: 12000, settings: true });
    else if (firstError && failedRequests) toast(`Đã nhận đủ ${state.items.length}/${pageAnchors.length} câu; có ${failedRequests} request lỗi nhưng các câu thiếu đã được khôi phục.`, 'info', { ms: 8500 });
    else if (!todo.length) toast(`Đã nhận đủ ${state.items.length}/${pageAnchors.length} câu${fromCache ? ' (dùng cache đầy đủ)' : ''}. Bấm vào ô đáp án để xem hướng dẫn.${imgWarn()}`, 'info', { ms: 7000 });""",
        "final coverage message",
    )

    # Make the floating button reflect the actual refinement state, including
    # when answers are being re-checked after the first-pass badges are visible.
    text = replace_once(
        text,
        "    .fab.hide{opacity:0}\n    .fab.off{text-decoration:line-through}",
        "    .fab.hide{opacity:0}\n    .fab.off{text-decoration:line-through}\n"
        "    .fab.refining{animation:qt-refine-pulse 1.1s ease-in-out infinite;box-shadow:0 0 0 4px rgba(70,130,220,.22)}\n"
        "    @keyframes qt-refine-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}",
        "refinement button animation",
    )
    text = replace_once(
        text,
        "  function updateFab() {\n    fab.textContent = state.status === 'loading' ? '…' : state.status === 'error' ? '!' : state.items.length ? String(state.items.length) : 'Q';\n  }",
        "  function updateFab() {\n"
        "    const refiningCount = state.items.filter((it) => !!it.refining).length;\n"
        "    const refining = refiningCount > 0;\n"
        "    fab.classList.toggle('refining', refining);\n"
        "    fab.textContent = state.status === 'error' ? '!' : refining ? '↻' : state.status === 'loading' ? (state.items.length ? String(state.items.length) : '…') : state.items.length ? String(state.items.length) : 'Q';\n"
        "    fab.title = refining ? `Đang tinh chỉnh ${refiningCount} câu` : FAB_TITLE;\n"
        "  }",
        "refinement button state",
    )
    text = replace_once(
        text,
        "    if (state.active === it) renderPop(it);\n    schedule();\n  }",
        "    if (state.active === it) renderPop(it);\n    updateFab();\n    schedule();\n  }",
        "refresh FAB on badge refinement",
    )
    text = replace_once(
        text,
        "    todo.forEach((it) => { it.refining = true; refreshBadge(it); });\n    const cnt = { failed: 0, err: null, fellBack: false };",
        "    todo.forEach((it) => { it.refining = true; refreshBadge(it); });\n"
        "    updateFab();\n"
        "    toast(`Đang tinh chỉnh ${todo.length} câu bằng lượt kiểm tra bổ sung…`, 'info', { sticky: true });\n"
        "    const cnt = { failed: 0, err: null, fellBack: false };",
        "show refinement start",
    )
    text = replace_once(
        text,
        "    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });\n\n    if (!cnt.failed && cacheKeyCur) {",
        "    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });\n"
        "    updateFab();\n\n"
        "    if (!cnt.failed && cacheKeyCur) {",
        "show refinement completion",
    )

    # Native shim storage marker and cache namespace version bump invalidate bad v2.3 caches.
    shim = ROOT / "ios-tweak" / "Resources" / "quiz-tutor-shim.js"
    if shim.is_file():
        shim_text = shim.read_text(encoding="utf-8")
        if "2.3.0-ios" in shim_text:
            shim.write_text(shim_text.replace("2.3.0-ios", "2.4.0-ios"), encoding="utf-8")
        elif "2.4.0-ios" not in shim_text:
            raise SystemExit("Could not find known shim version marker; refusing to continue.")

    CONTENT.write_text(text, encoding="utf-8")
    print(f"Stable scan pipeline applied: {len(text)} bytes; cache version 2.4.0-ios")


if __name__ == "__main__":
    main()
