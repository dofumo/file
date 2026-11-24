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
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text, encoding="utf-8")
print(f"Prepared {out} ({len(text)} bytes)")
