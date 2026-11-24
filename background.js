try { importScripts('dev-mode.js', 'license-config.js', 'license.js'); } catch (_) {} // MV3 service worker; ở MV2 các file này được nạp qua manifest
const store = {
  get: (d) => new Promise((res, rej) => {
    try { chrome.storage.local.get(d, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))); } catch (e) { rej(e); }
  }),
  set: (o) => new Promise((res, rej) => {
    try { chrome.storage.local.set(o, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())); } catch (e) { rej(e); }
  })
};

// Service worker: gọi Gemini API + tải ảnh bị chặn CORS (giữ API key ở đây, không lộ cho trang web)
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULTS = { apiKey: '', model: 'gemini-3.5-flash-lite', thinking: 'auto', language: 'Tiếng Việt' };

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    // explanation (lập luận) đứng TRƯỚC answer để model suy luận xong mới chốt đáp án
    propertyOrdering: ['anchor', 'explanation', 'answer', 'answer_text', 'memory_tip', 'confidence', 'needs_calc'],
    properties: {
      anchor: { type: 'INTEGER', description: 'Số dòng [n] nơi đề bài của câu hỏi bắt đầu' },
      explanation: { type: 'STRING', description: 'Lập luận/lời giải đã chốt, gọn. Viết trước khi chọn answer.' },
      answer: { type: 'STRING', description: 'Nhãn đáp án đúng, trùng kết luận của explanation: A / B / 1 / 2 / "A, C" / Đúng / Sai' },
      answer_text: { type: 'STRING', description: 'Nội dung đầy đủ của đáp án đúng' },
      memory_tip: { type: 'STRING', description: 'Mẹo ghi nhớ ngắn' },
      confidence: { type: 'NUMBER', description: 'Độ tự tin từ 0 đến 1' },
      needs_calc: { type: 'BOOLEAN', description: 'Câu cần tính toán nhiều bước hoặc phụ thuộc hình ảnh/bảng/đồ thị' },
      free_response: { type: 'BOOLEAN', description: 'true nếu câu hỏi là điền khuyết/tự luận (có ô nhập liệu để viết, không có các phương án trắc nghiệm)' }
    },
    required: ['anchor', 'explanation', 'answer']
  }
};

// Một lần: dùng gemini-3.5-flash-lite + Python để tính, ưu tiên đáp án đúng (giữ nguyên API key và màu sắc)
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await store.get({ cfgVersion: 0 });
  if (cur.cfgVersion < 4) {
    await store.set({
      cfgVersion: 4, model: 'gemini-3.5-flash-lite', accuracy: true, deepSolve: true, detail: 'brief', thinking: 'auto',
      strongModel: 'gemini-3.5-flash-lite', strongThinking: 'high', refineScope: 'smart', parallel: '3', useCode: true
    });
  }
  if (cur.cfgVersion < 5) await store.set({ cfgVersion: 5, useCode: false, codeSupport: 'unknown' }); // Python mặc định tắt
});

// Schema gọn (khi giải thích chỉ là phụ): bớt trường -> output ngắn, nhanh hơn
const SCHEMA_COMPACT = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    propertyOrdering: ['anchor', 'explanation', 'answer', 'free_response', 'needs_calc'],
    properties: {
      anchor: SCHEMA.items.properties.anchor,
      explanation: SCHEMA.items.properties.explanation,
      answer: SCHEMA.items.properties.answer,
      free_response: SCHEMA.items.properties.free_response,
      needs_calc: SCHEMA.items.properties.needs_calc
    },
    required: ['anchor', 'explanation', 'answer']
  }
};

function openSettings() {
  const fallback = () => { try { chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); } catch (_) {} };
  try { chrome.runtime.openOptionsPage(() => { if (chrome.runtime.lastError) fallback(); }); } catch (_) { fallback(); }
}

function capture(winId) {
  return new Promise((res, rej) => {
    if (!chrome.tabs || !chrome.tabs.captureVisibleTab) return rej(new Error('Trình duyệt này không hỗ trợ chụp màn hình'));
    const cb = (url) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(url));
    const opts = { format: 'jpeg', quality: 88 };
    try { if (winId == null) chrome.tabs.captureVisibleTab(opts, cb); else chrome.tabs.captureVisibleTab(winId, opts, cb); } catch (e) { rej(e); }
  });
}

const actionApi = chrome.action || chrome.browserAction; // MV3: action, MV2: browserAction
if (actionApi && actionApi.onClicked) actionApi.onClicked.addListener(openSettings);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'gemini') {
    withKeepAlive(async () => { await requireLicense(); return callGemini(msg); }).then(
      (data) => sendResponse({ ok: true, data }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  }
  if (msg?.type === 'license') {
    (self.QTLicense ? self.QTLicense.status() : Promise.resolve({ enforced: true, active: false, message: 'Thiếu module bản quyền.' }))
      .then(sendResponse, (e) => sendResponse({ enforced: true, active: false, message: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'fetchImage') {
    fetchImage(msg.url).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  }
  if (msg?.type === 'capture') {
    capture(sender.tab && sender.tab.windowId).then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) })
    );
    return true;
  }
  if (msg?.type === 'openOptions') openSettings();
});

// Chặn mọi lệnh gọi Gemini nếu chưa kích hoạt/đã hết hạn (đây là điểm duy nhất gọi API nên không thể bỏ qua từ trang web)
async function requireLicense() {
  if (self.__qtDevMode) return; // bản DEV: bỏ qua hoàn toàn (xem dev-mode.js)
  if (!self.QTLicense) throw new Error('LICENSE_REQUIRED: Thiếu module bản quyền.');
  await self.QTLicense.assertActive();
}

// MV3: service worker bị tắt nếu một request kéo dài >30s -> gọi API extension định kỳ để giữ sống (MV2: vô hại)
function withKeepAlive(fn) {
  const t = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch (_) {} }, 20000);
  return Promise.resolve().then(fn).finally(() => clearInterval(t));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchImage(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 12 * 1024 * 1024) throw new Error('Ảnh quá lớn');
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return { mime: res.headers.get('content-type') || 'image/png', b64: btoa(s) };
}

async function callGemini({ system, parts, model, thinking, tools, compact }) {
  const cfg = await store.get(DEFAULTS);
  if (!cfg.apiKey) throw new Error('Chưa có Gemini API key.');
  const useModel = model || cfg.model || DEFAULTS.model;
  let level = thinking ?? cfg.thinking;
  if (level === 'auto') level = 'minimal';
  const url = `${API}/${encodeURIComponent(useModel)}:generateContent`;
  let useThinking = level && level !== 'off';

  for (let attempt = 0; attempt < 4; attempt++) {
    const useCode = tools === 'code';
    // Code execution không đi chung với JSON schema -> chế độ "plain": model in các dòng ANCHOR n | đáp án | lý do
    const generationConfig = useCode ? {} : { responseMimeType: 'application/json', responseSchema: compact ? SCHEMA_COMPACT : SCHEMA };
    if (useThinking) generationConfig.thinkingConfig = { thinkingLevel: level };

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig
    };
    if (useCode) body.tools = [{ codeExecution: {} }];

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 200000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      if (attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(e.name === 'AbortError' ? 'Hết thời gian chờ Gemini.' : 'Lỗi mạng: ' + e.message);
    } finally {
      clearTimeout(timer);
    }

    try { if (self.QTLicense) self.QTLicense.noteTime(Date.parse(res.headers.get('Date'))); } catch (_) {} // đồng bộ giờ theo máy chủ Google
    if (res.ok) return useCode ? parsePlain(await res.json()) : parseResponse(await res.json());

    const raw = await res.text();
    let msg = raw;
    try { msg = JSON.parse(raw).error.message; } catch (_) {}

    if (res.status === 400 && useCode && /code.?execution|tool/i.test(msg)) throw new Error('CODE_UNSUPPORTED: ' + msg);
    if (res.status === 400 && useThinking && /think/i.test(msg)) { useThinking = false; continue; }
    if (res.status === 429 && /PerDay|per day|daily/i.test(raw)) throw new Error('Đã hết quota ngày của free tier cho model này. Thử lại vào ngày mai hoặc đổi model trong Cài đặt.');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep((res.status === 429 ? 8000 : 2000) * (attempt + 1)); continue; }
    throw new Error(`Gemini ${res.status} (${useModel}): ${msg}`);
  }
  throw new Error('Gemini không phản hồi.');
}

function parsePlain(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('\n');
  const out = [];
  const re = /ANCHOR\s*(\d+)\s*[|:：]\s*([^|\n]+?)\s*[|:：]\s*([^\n]*)/gi;
  let m;
  while ((m = re.exec(text))) out.push({ anchor: +m[1], answer: m[2].replace(/^đáp án\s*[:：]?\s*/i, '').trim(), explanation: m[3].trim(), needs_calc: true });
  if (!out.length) throw new Error('Không đọc được kết quả (chế độ Python) từ Gemini.');
  return out;
}

function parseResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  let text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || 'rỗng';
    throw new Error('Gemini trả về kết quả rỗng (' + reason + ').');
  }
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : v.questions || [];
  } catch (_) {
    const end = text.lastIndexOf('}');
    if (end > 0) {
      try { return JSON.parse(text.slice(0, end + 1) + ']'); } catch (_) {}
    }
    throw new Error('Không đọc được JSON từ Gemini.');
  }
}
