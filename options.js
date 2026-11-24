const store = {
  get: (d) => new Promise((res, rej) => {
    try { chrome.storage.local.get(d, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))); } catch (e) { rej(e); }
  }),
  set: (o) => new Promise((res, rej) => {
    try { chrome.storage.local.set(o, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())); } catch (e) { rej(e); }
  })
};

function fmtDate(d) { const x = new Date(d); return String(x.getDate()).padStart(2, '0') + '/' + String(x.getMonth() + 1).padStart(2, '0') + '/' + x.getFullYear(); }

const DEFAULTS = {
  apiKey: '', model: 'gemini-3.5-flash-lite', thinking: 'auto', language: 'Tiếng Việt', parallel: '3', detail: 'brief',
  accuracy: true, useCode: false, sendImages: true, deepSolve: true, refineScope: 'smart', visionShot: false, debug: false,
  strongModel: 'gemini-3.5-flash-lite', strongThinking: 'high',
  fabColor: '#333333', fabIcon: '#ffffff', fabOpacity: 0.8, fabTextOpacity: 1,
  badgeColor: '#222222', badgeText: '#ffffff', badgeOpacity: 0.9, badgeTextOpacity: 1, lowColor: '#8a5a00',
  popColor: '#ffffff', popText: '#000000', popOpacity: 0.97, popTextOpacity: 1,
  toastColor: '#222222', toastText: '#ffffff', toastOpacity: 0.9, toastTextOpacity: 1
};
const STYLE_KEYS = [
  'fabColor', 'fabIcon', 'fabOpacity', 'fabTextOpacity',
  'badgeColor', 'badgeText', 'badgeOpacity', 'badgeTextOpacity', 'lowColor',
  'popColor', 'popText', 'popOpacity', 'popTextOpacity',
  'toastColor', 'toastText', 'toastOpacity', 'toastTextOpacity'
];
const $ = (id) => document.getElementById(id);

function rgba(hex, a) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function setVal(id, v) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
}
function getVal(id) {
  const el = $(id);
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range') return parseFloat(el.value);
  return el.type === 'text' || el.type === 'password' ? el.value.trim() : el.value;
}
function preview() {
  const p = $('preview').style;
  p.setProperty('--fab-bg', rgba(getVal('fabColor'), getVal('fabOpacity')));
  p.setProperty('--fab-fg', rgba(getVal('fabIcon'), getVal('fabTextOpacity')));
  p.setProperty('--badge-bg', rgba(getVal('badgeColor'), getVal('badgeOpacity')));
  p.setProperty('--badge-fg', rgba(getVal('badgeText'), getVal('badgeTextOpacity')));
  p.setProperty('--low-bg', rgba(getVal('lowColor'), getVal('badgeOpacity')));
  p.setProperty('--pop-bg', rgba(getVal('popColor'), getVal('popOpacity')));
  p.setProperty('--pop-fg', rgba(getVal('popText'), getVal('popTextOpacity')));
  p.setProperty('--pop-bd', rgba(getVal('popText'), getVal('popTextOpacity') * 0.35));
  p.setProperty('--toast-bg', rgba(getVal('toastColor'), getVal('toastOpacity')));
  p.setProperty('--toast-fg', rgba(getVal('toastText'), getVal('toastTextOpacity')));
  for (const k of STYLE_KEYS) {
    const v = $(k + 'Val');
    if (v) v.textContent = Math.round(getVal(k) * 100) + '%';
  }
}

store.get(DEFAULTS).then((cfg) => {
  for (const k of Object.keys(DEFAULTS)) setVal(k, cfg[k]);
  preview();
});
for (const k of STYLE_KEYS) $(k).addEventListener('input', preview);

$('save').addEventListener('click', async () => {
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = getVal(k);
  cfg.model = cfg.model || DEFAULTS.model;
  cfg.strongModel = cfg.strongModel || DEFAULTS.strongModel;
  cfg.language = cfg.language || DEFAULTS.language;
  cfg.codeSupport = 'unknown'; // thử lại khả năng chạy Python sau khi đổi cài đặt
  await store.set(cfg);
  $('st').textContent = 'Đã lưu';
  setTimeout(() => ($('st').textContent = ''), 2000);
});

$('resetStyle').addEventListener('click', () => {
  for (const k of STYLE_KEYS) setVal(k, DEFAULTS[k]);
  preview();
  $('st').textContent = 'Nhớ bấm "Lưu cài đặt"';
});


// ---------- Bản quyền: chưa kích hoạt thì chỉ hiện ô nhập mã, chưa cho vào phần cài đặt ----------
async function renderLicense() {
  if (self.__qtDevMode) { $('licBox').hidden = true; $('main').hidden = false; return; } // bản DEV: bỏ qua hoàn toàn
  const st = await QTLicense.status();
  $('devId').value = st.deviceId;
  let text;
  if (!st.enforced) text = 'Bản quyền: không bắt buộc (bản phát triển).';
  else if (!st.configured) text = 'Extension chưa được cấu hình khóa bản quyền. Hãy liên hệ quản trị viên.';
  else if (st.active) text = 'Đã kích hoạt. Còn ' + st.daysLeft + ' ngày (đến ' + fmtDate(st.end) + '). Nhập mã mới để gia hạn thêm.';
  else text = (st.end ? 'Bản quyền đã hết hạn. ' : 'Chưa kích hoạt. ') + 'Nhập mã kích hoạt để sử dụng.';
  $('licStatus').textContent = text;
  $('main').hidden = !st.active;
}
$('copyDev').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('devId').value); } catch (_) { $('devId').select(); document.execCommand('copy'); }
  $('licMsg').textContent = 'Đã sao chép mã thiết bị.';
});
$('redeem').addEventListener('click', async () => {
  try {
    const r = await QTLicense.redeem($('licCode').value);
    $('licCode').value = '';
    $('licMsg').textContent = 'Thành công: +' + r.days + ' ngày.';
  } catch (e) {
    $('licMsg').textContent = 'Lỗi: ' + e.message;
  }
  renderLicense();
});
renderLicense().catch((e) => { $('licStatus').textContent = 'Lỗi bản quyền: ' + e.message; });
