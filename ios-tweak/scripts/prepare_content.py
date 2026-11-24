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
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(text, encoding="utf-8")
print(f"Prepared {out} ({len(text)} bytes)")
