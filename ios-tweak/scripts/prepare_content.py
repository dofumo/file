#!/usr/bin/env python3
from pathlib import Path
import sys
import re

repo = Path(__file__).resolve().parents[2]
source = repo / "content.js"
out = repo / "ios-tweak" / "Resources" / "content.js"

if not source.is_file():
    raise SystemExit("Không tìm thấy content.js ở thư mục gốc repository.")

text = source.read_text(encoding="utf-8")
# Remove the license gate from the personal iOS port. Keep the Gemini API key
# configuration: it is an API credential, not the extension activation/license key.
license_block = re.compile(
    r"    // Bản quyền: chưa kích hoạt/đã hết hạn thì không quét \(background cũng chặn ở tầng gọi API\)\n"
    r"    const lic = await sendMsg\(\{ type: 'license' \}\);\n"
    r"    if \(lic && lic\.enforced && !lic\.active\) \{\n"
    r"      toast\(lic\.message \|\| 'Chưa kích hoạt bản quyền\.', 'error', \{ settings: true, ms: 9000 \}\);\n"
    r"      return;\n"
    r"    \}\n"
    r"    licWarn = lic && lic\.enforced && lic\.active && lic\.daysLeft <= 3 \? ` Bản quyền còn \$\{lic\.daysLeft\} ngày, hãy xin mã gia hạn\.` : '';\n"
)
text, removed = license_block.subn("    licWarn = ''; // Personal iOS build: no extension activation/license gate.\n", text, count=1)
if removed != 1:
    raise SystemExit("Không tìm thấy chính xác khối license trong content.js; dừng để tránh xóa nhầm.")

needle = "  if (window.__quizTutorAI) return;"
if needle not in text:
    raise SystemExit("content.js không còn khớp điểm chèn host guard đã biết; dừng để tránh patch sai.")

host_guard = """  const __qtHost = String(location.hostname || '').toLowerCase();
  if (__qtHost !== 'azota.vn' && !__qtHost.endsWith('.azota.vn')) return;
  if (window.__quizTutorAI) return;"""
text = text.replace(needle, host_guard, 1)


# Native iOS settings: add size and panel-height defaults, then wire them into live layout.
def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"Không tìm thấy điểm patch {label}; dừng để tránh sửa sai.")
    return source.replace(old, new, 1)

text = replace_once(
    text,
    "    fabColor: '#333333', fabIcon: '#ffffff', fabOpacity: 0.8,\n",
    "    fabColor: '#333333', fabIcon: '#ffffff', fabOpacity: 0.8, fabSize: 48,\n",
    "fabSize default"
)
text = replace_once(
    text,
    "    popColor: '#ffffff', popText: '#000000', popOpacity: 0.97,\n",
    "    popColor: '#ffffff', popText: '#000000', popOpacity: 0.97, popHeight: 0.6,\n",
    "popHeight default"
)
text = replace_once(text, "  const FAB = IS_TOUCH ? 48 : 42;", "  let FAB = IS_TOUCH ? 48 : 42;\n  let popHeightRatio = 0.6;", "dynamic FAB size")

# applyStyle already exists in the upstream content script; add live updates for native controls.
text = replace_once(
    text,
    "    st.setProperty('--toast-fg', rgba(c.toastText, n(c.toastTextOpacity)));\n",
    "    st.setProperty('--toast-fg', rgba(c.toastText, n(c.toastTextOpacity)));\n"
    "    FAB = Math.round(Math.max(36, Math.min(72, Number(c.fabSize) || (IS_TOUCH ? 48 : 42))));\n"
    "    popHeightRatio = Math.max(0.35, Math.min(0.85, Number(c.popHeight) || 0.6));\n"
    "    if (fab) { fab.style.width = FAB + 'px'; fab.style.height = FAB + 'px'; }\n",
    "apply native sizing"
)
text = replace_once(
    text,
    "    store.get(DEFAULTS).then(applyStyle).catch(() => {});\n    chrome.storage.onChanged.addListener((_c, area) => {\n      if (area === 'local') store.get(DEFAULTS).then(applyStyle).catch(() => {});\n    });",
    "    store.get(DEFAULTS).then((c) => { applyStyle(c); placeFab(); schedule(); }).catch(() => {});\n"
    "    chrome.storage.onChanged.addListener((_c, area) => {\n"
    "      if (area === 'local') store.get(DEFAULTS).then((c) => { applyStyle(c); placeFab(); schedule(); }).catch(() => {});\n"
    "    });",
    "live style refresh"
)
text = replace_once(
    text,
    "      pop.style.maxHeight = Math.floor(v.h * 0.5) + 'px';",
    "      pop.style.maxHeight = Math.floor(v.h * popHeightRatio) + 'px';",
    "mobile panel height"
)
text = replace_once(
    text,
    "    pop.style.maxHeight = '';\n    const br = state.active.badge.getBoundingClientRect();",
    "    pop.style.maxHeight = Math.min(Math.floor(v.h * popHeightRatio), 520) + 'px';\n    const br = state.active.badge.getBoundingClientRect();",
    "desktop panel height"
)

def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Không tìm thấy điểm patch {label}: expected 1, got {count}")
    return source.replace(old, new, 1)

# Make first-pass answers appear sooner: issue one request per detected question
# for normal-sized pages, while limiting concurrency to avoid a burst of API calls.
text = replace_once(text, "    if (idx.length < 3) return [];", "    if (idx.length < 2) return [];", "two-question anchor detection")
text = replace_once(
    text,
    "      let maxChars = 50000;\n      if (cfg.accuracy) maxChars = pageMathy ? 6000 : 12000;\n      else if (cfg.thinking === 'medium' || cfg.thinking === 'high') maxChars = pageMathy ? 6000 : 12000;\n      else if (cfg.thinking === 'auto') maxChars = pageMathy ? 6000 : 50000;\n\n      const chunks = pageAnchors.length ? makeAnchorChunks(lines, pageAnchors, pageMathy ? 8 : (cfg.accuracy ? 12 : 20), 20000) : makeChunks(lines, maxChars);",
    "      let maxChars = 3200;\n      if (cfg.accuracy) maxChars = pageMathy ? 2400 : 3200;\n      else if (cfg.thinking === 'medium' || cfg.thinking === 'high') maxChars = pageMathy ? 2400 : 3200;\n      else if (cfg.thinking === 'auto') maxChars = pageMathy ? 2600 : 3600;\n\n      // Mỗi request xử lý một câu để badge xuất hiện ngay khi câu đó hoàn tất.\n      // Bài rất dài (trên 24 câu) nhóm 2 câu để hạn chế số request.\n      const progressiveBatch = pageAnchors.length > 24 ? 2 : 1;\n      const chunks = pageAnchors.length ? makeAnchorChunks(lines, pageAnchors, progressiveBatch, 9000) : makeChunks(lines, maxChars);",
    "smaller progressive chunks"
)
text = replace_once(
    text,
    "      await pool(Math.max(1, Number(cfg.parallel) || 2), chunks.length, async (ci) => {",
    "      await pool(Math.min(2, Math.max(1, Number(cfg.parallel) || 2)), chunks.length, async (ci) => {",
    "cap first-pass API concurrency"
)
text = replace_once(
    text,
    "      await pool(Math.max(1, Number(cfg.parallel) || 1), batches.length, async (bi) => {",
    "      await pool(Math.min(2, Math.max(1, Number(cfg.parallel) || 2)), batches.length, async (bi) => {",
    "cap refinement API concurrency"
)

text = replace_once(
    text,
    "      const progress = () => toast(`Đang giải${heavyCalc ? ' (nhiều bài tính toán)' : ''}… lô ${doneChunks}/${chunks.length} xong · đáp án hiện dần`, 'info', { sticky: true });",
    "      const progress = () => toast(`Đang giải${heavyCalc ? ' (nhiều bài tính toán)' : ''}… ${state.items.length} câu đã hiện · ${doneChunks}/${chunks.length} request hoàn tất`, 'info', { sticky: true });",
    "progress reports visible answer count"
)

# Show active refinement directly on the floating button, not only in answer badges.
text = replace_once(
    text,
    "    .fab.hide{opacity:0}\n    .fab.off{text-decoration:line-through}",
    "    .fab.hide{opacity:0}\n    .fab.off{text-decoration:line-through}\n    .fab.refining{animation:qt-refine-pulse 1.1s ease-in-out infinite;box-shadow:0 0 0 4px rgba(70,130,220,.22)}\n    @keyframes qt-refine-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}",
    "refining FAB CSS"
)
text = replace_once(
    text,
    "  function updateFab() {\n    fab.textContent = state.status === 'loading' ? '…' : state.status === 'error' ? '!' : state.items.length ? String(state.items.length) : 'Q';\n  }",
    "  function updateFab() {\n    const refiningCount = state.items.filter((it) => !!it.refining).length;\n    const refining = refiningCount > 0;\n    fab.classList.toggle('refining', refining);\n    fab.textContent = state.status === 'error' ? '!' : refining ? '↻' : state.status === 'loading' ? (state.items.length ? String(state.items.length) : '…') : state.items.length ? String(state.items.length) : 'Q';\n    fab.title = refining ? `Đang tinh chỉnh ${refiningCount} câu` : FAB_TITLE;\n  }",
    "refining FAB status"
)
text = replace_once(
    text,
    "    if (state.active === it) renderPop(it);\n    schedule();\n  }",
    "    if (state.active === it) renderPop(it);\n    updateFab();\n    schedule();\n  }",
    "refresh badge updates FAB"
)
text = replace_once(
    text,
    "    todo.forEach((it) => { it.refining = true; refreshBadge(it); });\n    const cnt = { failed: 0, err: null, fellBack: false };",
    "    todo.forEach((it) => { it.refining = true; refreshBadge(it); });\n    updateFab();\n    toast(`Đang tinh chỉnh ${todo.length} câu bằng lượt kiểm tra bổ sung…`, 'info', { sticky: true });\n    const cnt = { failed: 0, err: null, fellBack: false };",
    "refine starts visible in FAB"
)
text = replace_once(
    text,
    "    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });\n\n    if (!cnt.failed && cacheKeyCur) {",
    "    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });\n    updateFab();\n\n    if (!cnt.failed && cacheKeyCur) {",
    "refine completion updates FAB"
)

# Surface native fallback notices as short toasts while preserving the current UI flow.
text = replace_once(
    text,
    "  const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };",
    "  const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };\n  window.addEventListener('qt-native-status', (event) => {\n    const message = event && event.detail && event.detail.message;\n    if (message) toast(message, 'info', { ms: 4500 });\n  });",
    "native status toast listener"
)

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text, encoding="utf-8")
print(f"Prepared {out} ({len(text)} bytes)")
