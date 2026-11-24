(() => {
  if (window.__quizTutorAI) return;
  window.__quizTutorAI = true;

  const DEFAULTS = {
    language: 'Tiếng Việt', apiKey: '', model: '',
    sendImages: true, deepSolve: true, refineScope: 'smart', visionShot: false, debug: false, strongModel: 'gemini-3.5-flash-lite', strongThinking: 'high', parallel: 3, detail: 'brief', accuracy: true, useCode: false, codeSupport: 'unknown', thinking: 'auto',
    fabColor: '#333333', fabIcon: '#ffffff', fabOpacity: 0.8,
    badgeColor: '#222222', badgeText: '#ffffff', badgeOpacity: 0.9, lowColor: '#8a5a00',
    popColor: '#ffffff', popText: '#000000', popOpacity: 0.97,
    toastColor: '#222222', toastText: '#ffffff', toastOpacity: 0.9,
    fabTextOpacity: 1, badgeTextOpacity: 1, popTextOpacity: 1, toastTextOpacity: 1
  };
  const store = {
    get: (d) => new Promise((res, rej) => {
      try { chrome.storage.local.get(d, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))); } catch (e) { rej(e); }
    }),
    set: (o) => new Promise((res, rej) => {
      try { chrome.storage.local.set(o, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())); } catch (e) { rej(e); }
    })
  };
  // Thiết bị cảm ứng (điện thoại/máy tính bảng)
  const IS_TOUCH = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || /Android|Mobile|iPhone|iPad/i.test(navigator.userAgent);
  const FAB = IS_TOUCH ? 48 : 42;
  const vv = window.visualViewport || null; // viewport thị giác: đúng khi người dùng pinch-zoom
  const vp = () => (vv ? { l: vv.offsetLeft, t: vv.offsetTop, w: vv.width, h: vv.height, k: 1 / vv.scale } : { l: 0, t: 0, w: innerWidth, h: innerHeight, k: 1 });
  const isSheet = () => IS_TOUCH || vp().w < 600; // bảng giải thích dạng "ngăn kéo" ở cạnh dưới màn hình
  const MAX_REFINE = 24;
  const MATH_SEL = '.katex, mjx-container, .MathJax, .MathJax_SVG, .MathJax_CHTML, math';
  const OVERLAP_LINES = 12;
  const CONCURRENCY = 3;
  const MAX_IMAGES_PAGE = 80;
  const MAX_IMAGES_REQ = 30;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'IFRAME', 'HEAD', 'TITLE']);
  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'contents', 'ruby', 'ruby-text']);

  const state = { status: 'idle', items: [], visible: true, active: null };
  let scanId = 0;
  let pageImages = [];
  let pageLines = [];
  let pageEls = [];
  let cacheKeyCur = null;
  let pageAnchors = [];
  let licWarn = '';
  let codeUnsupported = false;
  let compactMode = false;
  const VERSION = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; } })();

  /* ---------- UI (Shadow DOM để không đụng CSS của trang) ---------- */
  const host = document.createElement('div');
  host.id = 'quiz-tutor-ai-host';
  if (IS_TOUCH) host.setAttribute('data-m', '1');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    *{box-sizing:border-box;font-family:sans-serif}
    .fab{position:fixed;width:${FAB}px;height:${FAB}px;border-radius:50%;border:0;padding:0;cursor:pointer;pointer-events:auto;
      background:var(--fab-bg);color:var(--fab-fg);font:700 14px/1 sans-serif;touch-action:none;user-select:none}
    .fab.hide{opacity:0}
    .fab.off{text-decoration:line-through}
    .badge{position:fixed;pointer-events:auto;min-width:28px;max-width:130px;height:24px;padding:0 8px;border:0;border-radius:4px;
      background:var(--badge-bg);color:var(--badge-fg);font:700 13px/24px sans-serif;text-align:center;cursor:pointer;
      transform:translateX(-100%);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none}
    .badge.low{background:var(--low-bg)}
    .badge.free{max-width:220px}
    :host([data-m]) .badge.free{max-width:260px}
    .pop{position:fixed;pointer-events:auto;width:min(440px,92vw);max-height:min(70vh,520px);overflow:auto;
      background:var(--pop-bg);color:var(--pop-fg);border:1px solid var(--pop-bd);border-radius:4px;font:14px/1.5 sans-serif;padding:10px 12px}
    .pop[hidden],.toast[hidden]{display:none}
    .hd{display:flex;justify-content:space-between;align-items:center;gap:8px}
    .x{border:0;background:transparent;color:inherit;font:inherit;font-size:18px;line-height:1;cursor:pointer;padding:0 4px}
    .sec{margin-top:8px;font-weight:700}
    .body p{margin:0 0 6px}.body ul{margin:0 0 6px;padding-left:18px}
    .at,.tip,.note,.warn{margin-top:8px;padding-left:8px;border-left:2px solid var(--pop-bd)}
    .toast{position:fixed;top:8px;left:50%;transform:translateX(-50%);pointer-events:auto;max-width:min(520px,92vw);
      background:var(--toast-bg);color:var(--toast-fg);padding:6px 10px;border-radius:4px;font:13px/1.4 sans-serif}
    .toast a{color:inherit;text-decoration:underline;cursor:pointer;margin-left:6px}
    .fab,.badge{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
    .fab{z-index:2}.pop{z-index:3}.toast{z-index:4}
    .badge{touch-action:manipulation}
    .ft{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
    .ft button{font:inherit;color:inherit;background:transparent;border:1px solid var(--pop-bd);border-radius:4px;padding:5px 10px;cursor:pointer}
    :host([data-m]) .fab{font-size:16px}
    :host([data-m]) .badge{min-width:36px;max-width:150px;height:32px;padding:0 10px;border-radius:6px;font:700 15px/32px sans-serif}
    :host([data-m]) .pop{font-size:15px;padding:12px 14px}
    :host([data-m]) .x{font-size:26px;padding:0 10px;min-height:40px}
    :host([data-m]) .ft button{padding:10px 14px}
    :host([data-m]) .toast{font-size:14px}
  </style>
  <div id="layer"></div>
  <div class="pop" id="pop" hidden></div>
  <div class="toast" id="toast" hidden></div>
  <button class="fab" id="fab">Q</button>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const fab = $('fab'), layer = $('layer'), pop = $('pop'), toastEl = $('toast');
  const FAB_TITLE = 'Bấm: quét · Giữ nửa giây: ẩn/hiện nút · Chuột phải: quét mới · Alt+bấm: cài đặt · Ctrl+bấm: báo cáo chẩn đoán · Kéo: di chuyển';
  fab.title = FAB_TITLE;

  /* ---------- Màu sắc / độ trong suốt ---------- */
  const rgba = (hex, a) => {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  function applyStyle(c) {
    const n = (v, d = 1) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(1, Math.max(0, +v)) : d);
    const st = host.style;
    st.setProperty('--fab-bg', rgba(c.fabColor, n(c.fabOpacity, 0.8)));
    st.setProperty('--fab-fg', rgba(c.fabIcon, n(c.fabTextOpacity)));
    st.setProperty('--badge-bg', rgba(c.badgeColor, n(c.badgeOpacity)));
    st.setProperty('--badge-fg', rgba(c.badgeText, n(c.badgeTextOpacity)));
    st.setProperty('--low-bg', rgba(c.lowColor, n(c.badgeOpacity)));
    st.setProperty('--pop-bg', rgba(c.popColor, n(c.popOpacity)));
    st.setProperty('--pop-fg', rgba(c.popText, n(c.popTextOpacity)));
    st.setProperty('--pop-bd', rgba(c.popText, n(c.popTextOpacity) * 0.35));
    st.setProperty('--toast-bg', rgba(c.toastColor, n(c.toastOpacity)));
    st.setProperty('--toast-fg', rgba(c.toastText, n(c.toastTextOpacity)));
  }
  applyStyle(DEFAULTS);
  try {
    store.get(DEFAULTS).then(applyStyle).catch(() => {});
    chrome.storage.onChanged.addListener((_c, area) => {
      if (area === 'local') store.get(DEFAULTS).then(applyStyle).catch(() => {});
    });
  } catch (_) {}

  /* ---------- Nút tròn: kéo thả + click ---------- */
  let fabPos = { fx: 0.97, fy: 0.85 };
  const fabSize = () => FAB * vp().k; // giữ kích thước nút không đổi khi pinch-zoom
  function placeFab() {
    const v = vp(), size = FAB * v.k;
    const x = v.l + fabPos.fx * Math.max(0, v.w - size);
    const y = v.t + fabPos.fy * Math.max(0, v.h - size);
    fab.style.left = Math.max(v.l, Math.min(v.l + v.w - size, x)) + 'px';
    fab.style.top = Math.max(v.t, Math.min(v.t + v.h - size, y)) + 'px';
    fab.style.transformOrigin = '0 0';
    fab.style.transform = v.k !== 1 ? `scale(${v.k})` : '';
  }
  try {
    store.get({ fabPos, fabHidden: false }).then((v) => { fabPos = v.fabPos || fabPos; placeFab(); toggleFabHidden(!!v.fabHidden); }).catch(() => {});
  } catch (_) {}
  placeFab();

  let drag = null, lpTimer = null, longFired = false, fabHidden = false, lastPtr = 'mouse';
  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: fab.offsetLeft, oy: fab.offsetTop, moved: false };
    longFired = false;
    lastPtr = e.pointerType || 'mouse';
    clearTimeout(lpTimer);
    // cảm ứng: 450ms (trước khi trình duyệt mở menu giữ-chạm 500ms); chuột: 600ms
    lpTimer = setTimeout(() => { if (drag && !drag.moved) { longFired = true; toggleFabHidden(); } }, lastPtr === 'mouse' ? 600 : 450);
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    clearTimeout(lpTimer);
    const v = vp(), size = FAB * v.k;
    fab.style.left = Math.max(v.l, Math.min(v.l + v.w - size, drag.ox + dx)) + 'px';
    fab.style.top = Math.max(v.t, Math.min(v.t + v.h - size, drag.oy + dy)) + 'px';
  });
  fab.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    clearTimeout(lpTimer);
    try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
    if (longFired) { longFired = false; return; }
    if (moved) {
      const v = vp(), size = FAB * v.k;
      fabPos = { fx: (fab.offsetLeft - v.l) / Math.max(1, v.w - size), fy: (fab.offsetTop - v.t) / Math.max(1, v.h - size) };
      try { store.set({ fabPos }); } catch (_) {}
    } else {
      onFabClick(e);
    }
  });
  fab.addEventListener('pointercancel', () => { drag = null; clearTimeout(lpTimer); });

  // Giữ nút ~0,6 giây: ẩn hoàn toàn (vẫn bấm được ở đúng vị trí cũ); giữ lần nữa: hiện lại
  function toggleFabHidden(on) {
    fabHidden = typeof on === 'boolean' ? on : !fabHidden;
    fab.classList.toggle('hide', fabHidden);
    fab.title = fabHidden ? '' : FAB_TITLE;
    try { store.set({ fabHidden }); } catch (_) {}
    if (typeof on !== 'boolean') toast(fabHidden ? 'Đã ẩn nút (vẫn bấm được tại vị trí cũ). Giữ nút khoảng nửa giây để hiện lại.' : 'Đã hiện lại nút.', 'info', { ms: 3500 });
  }
  fab.addEventListener('contextmenu', (e) => { e.preventDefault(); if (lastPtr === 'mouse') scan(true); }); // cảm ứng: giữ-chạm dùng để ẩn/hiện nút, quét mới nằm trong bảng giải thích

  function onFabClick(e) {
    if (e.ctrlKey || e.metaKey) return copyDiagnostic();
    if (e.altKey) return chrome.runtime.sendMessage({ type: 'openOptions' });
    if (state.status === 'loading') return;
    if (state.items.length) {
      state.visible = !state.visible;
      layer.style.display = state.visible ? '' : 'none';
      fab.classList.toggle('off', !state.visible);
      if (!state.visible) closePop(); else layout();
    } else {
      scan();
    }
  }

  /* ---------- Báo cáo chẩn đoán (Ctrl + bấm nút) ---------- */
  async function copyDiagnostic() {
    if (!pageLines.length) return toast('Hãy quét trang một lần (bấm nút) rồi Ctrl+bấm để sao chép báo cáo.');
    const cfg = await store.get(DEFAULTS);
    const clip = (t, n = 200) => (t && t.length > n ? t.slice(0, n) + '…' : t);
    const safeHtml = (el) => {
      let cur = el;
      for (let i = 0; i < 6 && cur.parentElement && cur.parentElement !== document.body; i++) {
        if (cur.parentElement.outerHTML.length > 6000) break;
        cur = cur.parentElement;
      }
      const clone = cur.cloneNode(true);
      clone.querySelectorAll('script,style,svg,noscript').forEach((x) => x.remove());
      for (const x of [clone, ...clone.querySelectorAll('*')].slice(0, 500)) {
        for (const at of [...x.attributes]) {
          if (at.name === 'src') {
            try { const u = new URL(at.value, location.href); x.setAttribute('src', u.origin + u.pathname.slice(0, 60)); } catch (_) { x.setAttribute('src', '…'); }
          } else if (!['class', 'id', 'role', 'alt', 'type'].includes(at.name)) x.removeAttribute(at.name);
        }
      }
      const w = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) if (t.nodeValue.length > 120) t.nodeValue = t.nodeValue.slice(0, 120) + '…';
      return clip(clone.outerHTML, 5000);
    };
    const all = [...document.querySelectorAll('*')].slice(0, 6000);
    const d = {
      version: VERSION,
      page: location.origin + location.pathname,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      counts: {
        lines: pageLines.length, anchors: pageAnchors.length, images: pageImages.length, questions: state.items.length,
        iframes: document.querySelectorAll('iframe').length, canvases: document.querySelectorAll('canvas').length,
        shadowHosts: all.filter((e) => e.shadowRoot).length
      },
      settings: { thinking: cfg.thinking, model: cfg.model, deepSolve: cfg.deepSolve, strongModel: cfg.strongModel, strongThinking: cfg.strongThinking, refineScope: cfg.refineScope, visionShot: cfg.visionShot, sendImages: cfg.sendImages, detail: cfg.detail },
      first80Lines: pageLines.slice(0, 80).map((t, i) => `[${i}] ${clip(t)}`),
      questions: state.items.slice(0, 10).map((it) => {
        const { a, end } = segmentOf(it);
        return {
          anchor: it.q.anchor, answer: it.q.answer, conf: it.q.confidence, calc: it.q.needs_calc, kind: qKind(it),
          refinedBy: it.refinedBy, prevAnswer: it.prevAnswer,
          anchorEl: it.el.tagName.toLowerCase() + '.' + clip(String(it.el.className || ''), 80),
          segment: pageLines.slice(a, Math.min(end, a + 10)).map((t, i) => `[${a + i}] ${clip(t)}`),
          explanation: clip(it.q.explanation, 400)
        };
      }),
      htmlOfFirstTwoQuestions: state.items.slice(0, 2).map((it) => safeHtml(it.el))
    };
    const text = '=== QuizTutor chẩn đoán ===\n' + JSON.stringify(d, null, 1);
    try { await navigator.clipboard.writeText(text); } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    console.log(text);
    toast('Đã sao chép báo cáo chẩn đoán vào clipboard. Hãy xem lại và dán vào cuộc trò chuyện.', 'info', { ms: 6000 });
  }

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg, kind = 'info', opts = {}) {
    clearTimeout(toastTimer);
    toastEl.className = 'toast ' + (kind === 'error' ? 'error' : '');
    toastEl.textContent = msg;
    if (opts.settings) {
      const a = document.createElement('a');
      a.textContent = 'Mở cài đặt';
      a.onclick = () => chrome.runtime.sendMessage({ type: 'openOptions' });
      toastEl.appendChild(a);
    }
    toastEl.hidden = false;
    placeToast();
    if (!opts.sticky) toastTimer = setTimeout(() => (toastEl.hidden = true), opts.ms || 4500);
  }
  function placeToast() {
    const v = vp();
    toastEl.style.left = v.l + v.w / 2 + 'px';
    toastEl.style.top = v.t + 8 + 'px';
    toastEl.style.maxWidth = Math.floor(v.w * 0.92) + 'px';
  }
  const hideToast = () => { clearTimeout(toastTimer); toastEl.hidden = true; };

  function updateFab() {
    fab.textContent = state.status === 'loading' ? '…' : state.status === 'error' ? '!' : state.items.length ? String(state.items.length) : 'Q';
  }
  function setStatus(s) {
    state.status = s;
    updateFab();
  }

  /* ---------- Thu thập text + ảnh theo "dòng" (block) ---------- */
  function collectLines() {
    const usable = new Map();
    const isUsable = (el) => {
      if (usable.has(el)) return usable.get(el);
      let ok = true;
      if (SKIP_TAGS.has(el.tagName) || el instanceof SVGElement || host.contains(el) || (el.parentElement && el.parentElement.closest(MATH_SEL))) ok = false;
      else if (typeof el.checkVisibility === 'function') ok = el.checkVisibility({ checkVisibilityCSS: true });
      else ok = el.getClientRects().length > 0;
      usable.set(el, ok);
      return ok;
    };
    const blockCache = new Map();
    const blockOf = (el) => {
      if (blockCache.has(el)) return blockCache.get(el);
      let cur = el;
      while (cur && cur !== document.body) {
        if (!INLINE_DISPLAY.has(getComputedStyle(cur).display)) break;
        cur = cur.parentElement;
      }
      const res = cur || document.body;
      blockCache.set(el, res);
      return res;
    };

    const images = [];
    const mathCache = new Map();
    const inMath = (el) => {
      if (!mathCache.has(el)) mathCache.set(el, !!el.closest(MATH_SEL));
      return mathCache.get(el);
    };
    const groups = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 ? (n.tagName === 'IMG' || n.tagName === 'TEXTAREA' || n.tagName === 'INPUT' || n.matches(MATH_SEL) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT)
    });
    let n;
    const isFreeInput = (el) => {
      if (el.tagName === 'TEXTAREA') return 'long';
      if (el.tagName === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return (t === 'text' || t === 'email' || t === 'search') ? 'short' : null;
      }
      return null;
    };
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') {
          // Không dùng isUsable() ở đây: nó loại cả TEXTAREA (SKIP_TAGS) vì lý do khác (không đọc text BÊN TRONG
          // textarea/select) - còn ở đây ta cần phát hiện CHÍNH cái textarea/input như một mốc UI, nên tự kiểm tra
          // hiển thị riêng, không qua SKIP_TAGS.
          const kind = isFreeInput(n);
          const visible = typeof n.checkVisibility === 'function' ? n.checkVisibility({ checkVisibilityCSS: true }) : n.getClientRects().length > 0;
          if (!kind || !n.parentElement || host.contains(n) || !visible) continue;
          const b = blockOf(n.parentElement);
          if (!groups.has(b)) groups.set(b, []);
          groups.get(b).push(kind === 'long' ? '[Ô trả lời: viết dài/tự luận]' : '[Ô trả lời: điền ngắn]');
          continue;
        }
        if (n.tagName !== 'IMG') {
          // Công thức render bằng KaTeX/MathJax/MathML -> lấy LaTeX gốc thay vì text lộn xộn
          if (!n.parentElement || !isUsable(n)) continue;
          const tex = mathToText(n);
          if (!tex) continue;
          const mb = blockOf(n.parentElement);
          if (!groups.has(mb)) groups.set(mb, []);
          groups.get(mb).push('$' + tex + '$');
          continue;
        }
        if (images.length >= MAX_IMAGES_PAGE) continue;
        let url = n.currentSrc || n.src || n.getAttribute('data-src') || n.getAttribute('data-original') || n.getAttribute('data-lazy-src') || '';
        if (!url || !n.parentElement || !isUsable(n)) continue;
        try { url = new URL(url, location.href).href; } catch (_) {}
        const r = n.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        const b = blockOf(n.parentElement);
        if (!groups.has(b)) groups.set(b, []);
        images.push({ url });
        // Ảnh công thức thường có alt/URL chứa LaTeX (vd. codecogs) -> kèm làm gợi ý
        let hint = (n.alt || '').trim();
        if (!hint && /codecogs|latex|mathtex|tex\?/i.test(url) && url.includes('?')) {
          try { hint = decodeURIComponent(url.split('?').slice(1).join('?')); } catch (_) {}
        }
        hint = /[\\^_=+{}0-9]/.test(hint) ? hint.replace(/[\[\]\n]/g, ' ').slice(0, 160) : '';
        groups.get(b).push(hint ? `[Hình ${images.length}: ${hint}]` : `[Hình ${images.length}]`);
        continue;
      }
      const t = n.nodeValue;
      if (!t || !t.trim()) continue;
      const p = n.parentElement;
      if (!p || !isUsable(p) || inMath(p)) continue;
      const b = blockOf(p);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(t);
    }

    const lines = [], els = [];
    for (const [el, parts] of groups) {
      const text = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push(text.length > 1200 ? text.slice(0, 1200) + '…' : text);
      els.push(el);
    }
    return { lines, els, images };
  }

  // Nhận diện nội dung nặng tính toán (toán/lý/hóa...) để chọn mức suy luận và cỡ batch
  function calcScore(text) {
    if (!text) return 0;
    let t = text.toLowerCase();
    // bỏ năm, ngày tháng, số hiệu điều luật/câu/trang... để không nhầm với toán
    t = t.replace(/(?:điều|khoản|điểm|chương|mục|trang|câu|bài|hình|năm|ngày|tháng|lớp|nghị quyết|thông tư|nghị định|số)\s*\d+[a-z]?/g, ' ')
      .replace(/\b(?:1[0-9]{3}|20[0-9]{2})\b/g, ' ')
      .replace(/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g, ' ');
    let sc = 0;
    // số + đơn vị đo/tiền tệ: càng nhiều đại lượng càng giống bài tính
    const qty = (t.match(/\d[\d.,]*\s*(?:kg|mg|m\/s|km\/h|km|cm|mm|ms|kn|kj|kw|hp|mv|ma|hz|khz|mhz|mol|mmol|ev|pa|atm|°c|ml|đồng|vnd|usd|triệu|tỷ|%|(?:g|m|s|n|j|w|v|a|l|k)(?![a-zà-ỹ0-9]))/g) || []).length;
    sc += qty >= 2 ? 3 : qty === 1 ? 1 : 0;
    if (/\d\s*[+\-−×*·÷\/^=]\s*\d/.test(t)) sc += 2; // phép tính giữa các số
    if (/[=≈≤≥]/.test(t) && /\d/.test(t)) sc += 1;
    if (/\$[^$]*[=+\-^_\\\/][^$]*\$|\\frac|\\sqrt|√|∑|∫|π|Δ/.test(text)) sc += 2; // công thức
    const kw = (t.match(/tính |giải phương trình|bao nhiêu|vận tốc|gia tốc|công suất|cường độ|hiệu điện thế|điện trở|đạo hàm|tích phân|xác suất|ma trận|giá trị của|nghiệm|khối lượng|bán kính|diện tích|thể tích|nồng độ|phản ứng|lực |năng lượng|động năng|thế năng/g) || []).length;
    sc += Math.min(kw, 2);
    return sc;
  }
  const isCalc = (text) => calcScore(text) >= 3;

  const hashStr = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return location.hostname + ':' + (h >>> 0).toString(36) + ':' + str.length;
  };

  function mathToText(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"]');
    if (ann && ann.textContent.trim()) return ann.textContent.trim().slice(0, 400);
    const mml = el.matches('math') ? el : el.querySelector('mjx-assistive-mml, math');
    const t = (mml?.textContent || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 400);
  }

  const imageIdsIn = (lineArr) => {
    const ids = new Set();
    for (const l of lineArr) for (const m of l.matchAll(/\[Hình (\d+)[\]:]/g)) ids.add(+m[1]);
    return [...ids].slice(0, MAX_IMAGES_REQ);
  };

  /* ---------- Ảnh: tải -> thu nhỏ -> base64 JPEG ---------- */
  const imgCache = new Map();
  const sendMsg = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r)));

  async function getBlob(url) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) return await r.blob();
    } catch (_) {}
    const res = await sendMsg({ type: 'fetchImage', url });
    if (!res?.ok) throw new Error(res?.error || 'Không tải được ảnh');
    const bin = atob(res.b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: res.mime });
  }

  async function decode(blob) {
    try { return await createImageBitmap(blob); } catch (_) {}
    const img = new Image();
    const u = URL.createObjectURL(blob);
    img.src = u;
    try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(u), 3000); }
    return img;
  }

  const failedUrls = new Set();
  const imgWarn = () => (failedUrls.size ? ` Lưu ý: ${failedUrls.size} ảnh không đọc được (câu phụ thuộc ảnh có thể sai).` : '') + licWarn;

  async function prepareImage(url) {
    if (imgCache.has(url)) return imgCache.get(url);
    const p = (async () => {
      try {
        let blob;
        if (url.startsWith('data:')) blob = await (await fetch(url)).blob();
        else blob = await getBlob(url);
        const bmp = await decode(blob);
        const bw = bmp.width || bmp.naturalWidth || 300, bh = bmp.height || bmp.naturalHeight || 150;
        const maxSide = Math.max(bw, bh);
        // Ảnh công thức thường rất nhỏ -> phóng to để Gemini đọc rõ; ảnh quá lớn -> thu nhỏ
        const scale = maxSide > 1400 ? 1400 / maxSide : maxSide < 500 ? Math.min(4, 500 / maxSide) : 1;
        const pad = 10;
        const w = Math.max(1, Math.round(bw * scale)), h = Math.max(1, Math.round(bh * scale));
        const c = document.createElement('canvas');
        c.width = w + pad * 2; c.height = h + pad * 2;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height); // nền trắng để PNG trong suốt (công thức) không bị đen
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, pad, pad, w, h);
        const mime = c.width * c.height < 600000 ? 'image/png' : 'image/jpeg';
        const out = await new Promise((r) => c.toBlob(r, mime, 0.92));
        const data = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = rej;
          fr.readAsDataURL(out);
        });
        return { mimeType: mime, data };
      } catch (_) {
        failedUrls.add(url);
        return null;
      }
    })();
    imgCache.set(url, p);
    return p;
  }

  async function buildParts(text, ids, cfg) {
    const parts = [{ text }];
    if (!cfg.sendImages || !ids.length) return parts;
    const failed = [];
    const prepared = await Promise.all(ids.map((id) => prepareImage(pageImages[id - 1].url)));
    ids.forEach((id, i) => {
      if (prepared[i]) {
        parts.push({ text: `Hình ${id}:` });
        parts.push({ inlineData: prepared[i] });
      } else failed.push(id);
    });
    if (failed.length) parts[0].text += `\n\n(Lưu ý: không đọc được hình ${failed.join(', ')}; nếu câu hỏi phụ thuộc hình đó, hãy giảm confidence và nói rõ.)`;
    return parts;
  }

  /* ---------- Prompt ---------- */
  const CALC_RULES = `Quy tắc với câu cần tính toán (toán, lý, hóa, thống kê, kinh tế định lượng…):
- Văn bản trang có thể bị LỖI TRÍCH XUẤT/OCR: chữ "l" hoặc "I" thay cho số 1 (l0s = 10 s; l,56Hp = 1,56 Hp), "O" thay cho 0, số mũ/chỉ số bị dính liền (m2/s3 = m²/s³; "g = 10m/s 2" = 10 m/s²; "600" = 60° khi đó là góc). Hãy sửa hợp lý theo ngữ cảnh và đơn vị TRƯỚC khi tính. Đáp án đúng luôn nằm trong các phương án; nếu kết quả không khớp phương án nào, hãy kiểm tra lại cách đọc đề/đơn vị rồi mới chọn phương án gần nhất.
- Đọc kỹ đề và HÌNH ẢNH/bảng/đồ thị đi kèm (các ảnh được đánh dấu "[Hình k]" trong văn bản). Chép lại dữ kiện đã cho kèm đơn vị.
- Viết công thức, thay số, tính TỪNG BƯỚC, kiểm tra đơn vị và thứ nguyên; dùng đúng giá trị hằng số mà đề cho (ví dụ g, π). Không đoán mò.
- Tính xong phải so với từng phương án; nếu kết quả không khớp phương án nào, tính lại bằng cách khác trước khi chọn phương án gần nhất (và nói rõ làm tròn).
- Đáp án (answer) PHẢI khớp với kết quả tính được trong phần explanation.
- Nếu các PHƯƠNG ÁN (A/B/C/D) là HÌNH ẢNH hoặc công thức: đọc kỹ từng hình, CHÉP LẠI công thức của từng phương án bằng ký hiệu văn bản trong explanation, so với kết quả tính được rồi mới chọn nhãn. Không chọn theo cảm tính.
- Viết công thức bằng văn bản thường/Unicode (v = s/t, a·b, x², √, π, Δ, ×, ÷), KHÔNG dùng LaTeX hay $...$.`;

  function buildSystem(lang, detail, withCalc = true) {
    const detailTxt = detail === 'detailed'
      ? 'CHI TIẾT'
      : detail === 'brief'
        ? 'RẤT NGẮN (tối đa 2–3 dòng: chỉ phép tính/ý then chốt dẫn tới đáp án; hãy dồn nỗ lực vào bước suy nghĩ nội bộ để đáp án ĐÚNG)'
        : 'NGẮN GỌN (tối đa 3–4 gạch đầu dòng: ý chính, vì sao đáp án đúng, phương án dễ nhầm)';
    return `Bạn là gia sư giúp người học ôn luyện và HỌC THUỘC trắc nghiệm (lý thuyết như triết học, lịch sử, pháp luật, kinh tế chính trị… và cả bài tập toán, lý).
Bạn nhận văn bản của một trang web, chia thành các dòng đánh số dạng "[n] nội dung". Ảnh trong trang xuất hiện dưới dạng "[Hình k]" và được đính kèm ở cuối; phần sau dấu ":" trong "[Hình k: …]" là chú thích/mã LaTeX của ảnh. Công thức hiển thị trên trang được chép dạng LaTeX trong $...$.

Nhiệm vụ:
0. QUAN TRỌNG: trong mỗi phần tử JSON, hãy viết "explanation" (lập luận/tính toán ĐÃ CHỐT, gọn, không viết nháp kiểu "chờ chút") TRƯỚC, rồi mới chốt "answer". "answer" PHẢI trùng với kết luận cuối cùng của explanation. Không được bỏ sót câu nào.
- Tìm MỌI câu hỏi (trắc nghiệm, điền khuyết, tự luận) có trong văn bản (bỏ qua menu, quảng cáo, nội dung không phải câu hỏi).
- Một số câu KHÔNG có phương án trắc nghiệm mà có ô để người học tự gõ câu trả lời, đánh dấu bằng dòng
   "[Ô trả lời: điền ngắn]" (điền từ/cụm từ/số ngắn) hoặc "[Ô trả lời: viết dài/tự luận]" (viết đoạn văn/giải thích dài).
   Với các câu này: đặt free_response:true và answer là CÂU TRẢ LỜI ĐẦY ĐỦ (không phải nhãn) - với "điền ngắn" thì
   answer là từ/cụm từ/số cần điền; với "viết dài/tự luận" thì answer là một đoạn trả lời hoàn chỉnh, đúng trọng tâm,
   đủ ý như một bài làm mẫu. Các câu trắc nghiệm bình thường thì free_response:false (hoặc bỏ qua trường này).
- Với mỗi câu trả về:
   - anchor: số n của dòng nơi ĐỀ BÀI bắt đầu (không phải dòng của đáp án).
   - answer: nhãn đáp án đúng, viết đúng như trang hiển thị (A/B/C/D, hoặc 1/2/3/4, hoặc a/b/c...). Nếu các lựa chọn không có nhãn thì đánh số 1,2,3... theo thứ tự xuất hiện. Câu nhiều đáp án: "A, C". Câu Đúng/Sai: "Đúng" hoặc "Sai". Câu điền khuyết không có lựa chọn: ghi ngắn gọn từ/số cần điền. Nếu đáp án nằm trong ảnh, vẫn chọn nhãn tương ứng.
   - answer_text: nội dung đầy đủ của đáp án đúng.
   - explanation: hướng dẫn giải ${detailTxt} để hiểu và nhớ (dùng gạch đầu dòng "- " và **in đậm** từ khóa). Câu lý thuyết: nêu khái niệm/nguyên lý/sự kiện liên quan, vì sao đúng, vì sao từng phương án còn lại sai. Câu tính toán: trình bày lời giải từng bước.
   - memory_tip: một mẹo ghi nhớ ngắn (từ khóa, công thức, so sánh dễ nhầm, mốc thời gian...).
   - confidence: 0 đến 1. Nếu trang đã hiển thị sẵn đáp án thì chỉ tham khảo và vẫn tự kiểm tra lại. Nếu không chắc, nói rõ trong explanation và đặt confidence thấp. Tuyệt đối không bịa.
   - needs_calc: true nếu câu cần tính toán nhiều bước HOẶC phụ thuộc vào hình ảnh/bảng/đồ thị; ngược lại false.
- Viết giải thích bằng: ${lang}.

${withCalc ? CALC_RULES : ''}${withCalc && detail !== 'detailed' ? '\n- Lời giải tính toán phải gọn: công thức → thay số → kết quả → đối chiếu phương án, tối đa khoảng 6 dòng.' : ''}

Các dòng đầu của đoạn văn bản có thể chỉ là ngữ cảnh lặp lại; chỉ trả về câu hỏi có anchor >= giá trị được yêu cầu.`;
  }

  function buildSolveSystem(lang, detail, withCalc = true) {
    return `Bạn là giáo viên giỏi, đang GIẢI LẠI một số câu trắc nghiệm một cách cực kỳ cẩn thận (đây là lượt kiểm tra kỹ). Văn bản gồm nhiều khối, mỗi khối bắt đầu bằng "=== CÂU (anchor a) ===" rồi các dòng "[n] nội dung"; câu cần giải bắt đầu ở dòng đầu của khối. Có thể có vài dòng thừa cuối khối thuộc câu khác – bỏ qua. Ảnh "[Hình k]" được đính kèm; phần sau dấu ":" trong "[Hình k: …]" là chú thích/mã LaTeX của ảnh; $...$ là công thức LaTeX hiển thị trên trang.

Nếu khối có "ảnh chụp màn hình đính kèm": đó là ảnh chụp đúng như người học nhìn thấy – hãy ƯU TIÊN ảnh này làm nguồn chính xác về đề bài, công thức, hình vẽ và các phương án (văn bản trích xuất có thể thiếu hoặc sai).

Điền "explanation" (lập luận/tính toán đã chốt, gọn, không viết nháp) TRƯỚC rồi mới chốt "answer"; "answer" PHẢI trùng với kết luận cuối của explanation.

Nếu khối có dòng "[Ô trả lời: điền ngắn]" hoặc "[Ô trả lời: viết dài/tự luận]": đây là câu điền khuyết/tự luận, không có phương án trắc nghiệm. Đặt free_response:true và answer là CÂU TRẢ LỜI ĐẦY ĐỦ (từ/cụm từ cần điền, hoặc một đoạn trả lời hoàn chỉnh nếu là tự luận).

Trả về mảng JSON, mỗi khối đúng 1 phần tử: anchor (đúng số a của khối), answer (nhãn đáp án đúng như trang hiển thị; nếu không có nhãn thì đánh số 1,2,3 theo thứ tự), answer_text, explanation (lời giải từng bước, gọn), free_response, memory_tip, confidence (0–1), needs_calc.
Viết bằng: ${lang}.

${withCalc ? CALC_RULES : ''}
Trước khi chốt, kiểm tra lại kết quả một lần nữa (tính ngược hoặc ước lượng bậc độ lớn).${detail === 'detailed' ? '' : '\nexplanation chỉ cần ngắn gọn (tối đa khoảng 4 dòng): các phép tính/ý then chốt dẫn tới đáp án; độ CHÍNH XÁC của answer quan trọng hơn lời giải.'}`;
  }

  function buildCodeSystem(lang) {
    return `Bạn là giáo viên giải các câu trắc nghiệm có tính toán, có công cụ chạy Python. Văn bản gồm nhiều khối, mỗi khối bắt đầu bằng "=== CÂU (anchor a) ===" rồi các dòng "[n] nội dung" (câu cần giải bắt đầu ở dòng đầu của khối; bỏ qua dòng thừa thuộc câu khác). Ảnh "[Hình k]" được đính kèm; phần sau dấu ":" trong "[Hình k: …]" là chú thích/mã LaTeX của ảnh; "$...$" là công thức LaTeX.

Với MỖI câu: hiểu đề, rồi DÙNG PYTHON để tính chính xác bằng đúng số liệu và hằng số của đề (đổi đơn vị cẩn thận), so kết quả với từng phương án và chọn phương án khớp nhất (chú ý làm tròn). Câu lý thuyết/không cần tính thì suy luận bình thường.

${CALC_RULES}

Sau khi xong TẤT CẢ các câu, chỉ in ra ĐÚNG các dòng sau (mỗi câu một dòng, không thêm chữ nào khác, không dùng markdown):
ANCHOR <a> | <nhãn đáp án đúng như trang hiển thị; nhiều đáp án thì "A, C"> | <lý do 1 dòng ngắn kèm kết quả số>
Viết lý do bằng: ${lang}.`;
  }

  async function sendGemini(system, parts, extra = {}) {
    const res = await sendMsg({ type: 'gemini', system, parts, compact: compactMode, ...extra });
    if (!res || !res.ok) throw new Error(String(res?.error || 'Lỗi không xác định').replace(/^LICENSE_REQUIRED:\s*/, ''));
    return res.data;
  }

  /* ---------- Nhận diện chắc chắn các câu hỏi theo nhãn "Câu N" (không phụ thuộc AI) ---------- */
  const LABEL_RE = /^\s*(?:câu|bài|question|q)\s*\.?\s*(\d{1,3})\s*(?:[.:)\-–]|$|\s)/i;
  function detectAnchors(lines) {
    const idx = [], nums = [];
    lines.forEach((t, i) => {
      const m = LABEL_RE.exec(t);
      if (m && (t.length <= 60 || /^\s*(?:câu|question)\s*\d/i.test(t))) { idx.push(i); nums.push(+m[1]); }
    });
    if (idx.length < 3) return [];
    let inc = 0;
    for (let i = 1; i < nums.length; i++) if (nums[i] > nums[i - 1]) inc++;
    return inc >= (nums.length - 1) * 0.8 ? idx : [];
  }

  function makeAnchorChunks(lines, anchors, perChunk, maxChars) {
    const chunks = [];
    let i = 0;
    while (i < anchors.length) {
      let j = i, size = 0;
      while (j < anchors.length && j - i < perChunk) {
        const endLine = anchors[j + 1] ?? lines.length;
        let seg = 0;
        for (let k = anchors[j]; k < endLine; k++) seg += lines[k].length + 8;
        if (j > i && size + seg > maxChars) break;
        size += seg;
        j++;
      }
      const start = anchors[i];
      const end = j < anchors.length ? anchors[j] : Math.min(lines.length, anchors[j - 1] + 80);
      chunks.push({ from: start, start, end, expected: anchors.slice(i, j) });
      i = j;
    }
    return chunks;
  }

  // Giải riêng (theo lô 4 câu) những câu mà lượt quét toàn trang bỏ sót
  async function solveByAnchors(anchors, cfg, model, thinking) {
    const system = buildSolveSystem(cfg.language, cfg.detail, anchors.some((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))));
    const out = [];
    for (let i = 0; i < anchors.length; i += 4) {
      const group = anchors.slice(i, i + 4);
      const ids = new Set();
      const blocks = group.map((a) => {
        const next = pageAnchors.find((x) => x > a);
        const slice = pageLines.slice(a, Math.min(next ?? pageLines.length, a + 60, pageLines.length));
        imageIdsIn(slice).forEach((x) => ids.add(x));
        return `=== CÂU (anchor ${a}) ===\n` + slice.map((t, k) => `[${a + k}] ${t}`).join('\n');
      });
      const parts = await buildParts(`Trang: ${document.title}\n\n` + blocks.join('\n\n'), [...ids].slice(0, MAX_IMAGES_REQ), cfg);
      const arr = await sendGemini(system, parts, { model: model || undefined, thinking });
      for (const q of arr) if (group.includes(q?.anchor) && q.answer && String(q.answer).trim()) out.push(q);
    }
    return out;
  }

  function makeChunks(lines, maxChars) {
    const chunks = [];
    let start = 0;
    while (start < lines.length) {
      let end = start, size = 0;
      while (end < lines.length && (size + lines[end].length < maxChars || end === start)) {
        size += lines[end].length + 8;
        end++;
      }
      chunks.push({ from: Math.max(0, start - (chunks.length ? OVERLAP_LINES : 0)), start, end });
      start = end;
    }
    return chunks;
  }

  async function pool(n, count, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, count) }, async () => {
      while (next < count) await fn(next++);
    }));
  }

  /* ---------- Quét: lượt 1 (toàn trang) ---------- */
  let scanBusy = false, pendingScan = null; // gộp các lần quét yêu cầu dồn dập (vd. bấm "câu tiếp theo" liên tục) thành 1 lần chạy cuối
  async function scan(force = false) {
    if (scanBusy) { pendingScan = force || pendingScan; return; }
    scanBusy = true;
    try { await doScan(force); }
    finally {
      scanBusy = false;
      if (pendingScan !== null) { const f = pendingScan; pendingScan = null; scan(f); }
    }
  }
  async function doScan(force = false) {
    if (state.status === 'loading') return;
    let cfg;
    try {
      cfg = await store.get(DEFAULTS);
    } catch (_) {
      return toast('Extension vừa được cập nhật – hãy tải lại trang (F5).', 'error');
    }
    // Bản quyền: chưa kích hoạt/đã hết hạn thì không quét (background cũng chặn ở tầng gọi API)
    const lic = await sendMsg({ type: 'license' });
    if (lic && lic.enforced && !lic.active) {
      toast(lic.message || 'Chưa kích hoạt bản quyền.', 'error', { settings: true, ms: 9000 });
      return;
    }
    licWarn = lic && lic.enforced && lic.active && lic.daysLeft <= 3 ? ` Bản quyền còn ${lic.daysLeft} ngày, hãy xin mã gia hạn.` : '';
    if (!cfg.apiKey) {
      toast('Chưa có Gemini API key. Hãy nhập trong phần Cài đặt.', 'error', { settings: true, ms: 7000 });
      chrome.runtime.sendMessage({ type: 'openOptions' });
      return;
    }

    const myScan = ++scanId;
    compactMode = cfg.detail === 'brief';
    codeUnsupported = cfg.codeSupport === 'no';
    failedUrls.clear();
    if (force) imgCache.clear();
    clearOverlays();
    setStatus('loading');
    const { lines, els, images } = collectLines();
    pageLines = lines;
    pageEls = els;
    pageAnchors = detectAnchors(lines);
    pageImages = images;
    if (cfg.debug) console.log('[QuizTutor] dòng đã quét:\n' + lines.map((t, i) => `[${i}] ${t}`).join('\n'), '\nẢnh:', images.map((x, i) => `${i + 1}: ${x.url}`));
    if (!lines.length) {
      setStatus('idle');
      return toast('Không tìm thấy nội dung văn bản trên trang.');
    }

    // Bộ nhớ đệm: quét lại cùng nội dung trang thì không tốn request (chuột phải vào nút = quét mới)
    const cacheKey = hashStr(lines.join('\n') + '|' + [VERSION, cfg.language, cfg.detail, cfg.accuracy, cfg.model, cfg.thinking, cfg.sendImages, cfg.deepSolve ? [cfg.strongModel, cfg.strongThinking, cfg.refineScope, cfg.visionShot].join(',') : 'x'].join('|'));
    cacheKeyCur = cacheKey;
    let firstError = null, fromCache = false, cached = null;
    if (!force) {
      const { qtCache } = await store.get({ qtCache: {} });
      if (qtCache[cacheKey]) cached = qtCache[cacheKey].items;
    }
    state.visible = true;
    layer.style.display = '';
    fab.classList.remove('off');

    if (cached) {
      fromCache = true;
      addItems(cached, els);
    } else {
      // Chia nhỏ theo độ "nặng tính toán": bài toán/lý -> batch nhỏ (~8-12 câu/request) để suy luận medium không bị loãng/cắt cụt,
      // trong khi vẫn chỉ tốn vài request thay vì 1 request/câu.
      const useImgs = cfg.sendImages && images.length > 0;
      const calcShare = pageAnchors.length
        ? pageAnchors.filter((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))).length / pageAnchors.length
        : (isCalc(lines.join(' ')) ? 1 : 0);
      const heavyCalc = calcShare >= 0.4;
      const pageMathy = heavyCalc || (useImgs && images.length >= 8);
      let maxChars = 50000;
      if (cfg.accuracy) maxChars = pageMathy ? 6000 : 12000;
      else if (cfg.thinking === 'medium' || cfg.thinking === 'high') maxChars = pageMathy ? 6000 : 12000;
      else if (cfg.thinking === 'auto') maxChars = pageMathy ? 6000 : 50000;

      const chunks = pageAnchors.length ? makeAnchorChunks(lines, pageAnchors, pageMathy ? 8 : (cfg.accuracy ? 12 : 20), 20000) : makeChunks(lines, maxChars);
      const systemCalc = buildSystem(cfg.language, cfg.detail, true);
      const systemPlain = buildSystem(cfg.language, cfg.detail, false);
      let doneChunks = 0;
      const results = [];
      const progress = () => toast(`Đang giải${heavyCalc ? ' (nhiều bài tính toán)' : ''}… lô ${doneChunks}/${chunks.length} xong · đáp án hiện dần`, 'info', { sticky: true });
      progress();

      await pool(Math.max(1, Number(cfg.parallel) || 2), chunks.length, async (ci) => {
        const c = chunks[ci];
        const slice = lines.slice(c.from, c.end);
        const ids = imageIdsIn(slice);
        const body = slice.map((t, i) => `[${c.from + i}] ${t}`).join('\n');
        const expNote = c.expected ? `\nTrang này có ${c.expected.length} câu hỏi, bắt đầu tại các dòng: ${c.expected.join(', ')}. Hãy trả về ĐÚNG ${c.expected.length} phần tử (mỗi câu một phần tử, không bỏ sót câu nào), anchor là một trong các số dòng đó, theo thứ tự tăng dần.` : '';
        const text = `Trang: ${document.title}\nTên miền: ${location.hostname}\nChỉ trả về câu hỏi có anchor >= ${c.start}.${expNote}\n\nNỘI DUNG:\n${body}`;
        const thinking = cfg.accuracy ? 'medium' : cfg.thinking === 'auto' ? ((isCalc(body) || (cfg.sendImages && ids.length > 0)) ? 'medium' : 'minimal') : cfg.thinking;
        try {
          const parts = await buildParts(text, ids, cfg);
          const withCalc = c.expected ? c.expected.some((a) => isCalc(pageLines.slice(a, anchorEnd(a)).join(' '))) : isCalc(body);
          const arr = await sendGemini(withCalc ? systemCalc : systemPlain, parts, { thinking });
          const exp = c.expected || null;
          const snap = (a) => (!exp ? a : exp.includes(a) ? a : (exp.filter((x) => x <= a).pop() ?? null));
          const seenA = new Set();
          let valid = arr
            .filter((q) => Number.isInteger(q?.anchor) && q.anchor >= c.start && q.anchor < c.end && q.answer && String(q.answer).trim())
            .map((q) => ({ ...q, anchor: snap(q.anchor) }))
            .filter((q) => q.anchor !== null && !seenA.has(q.anchor) && seenA.add(q.anchor));
          if (exp) { // câu nào bị bỏ sót thì giải bù ngay
            const missing = exp.filter((a) => !seenA.has(a));
            if (missing.length && myScan === scanId) {
              try { valid = valid.concat(await solveByAnchors(missing, cfg, null, 'medium')); } catch (_) {}
            }
          }
          results.push(...valid);
          if (myScan === scanId) addItems(valid, els); // hiện đáp án ngay khi lô này xong
        } catch (e) {
          firstError = firstError || e;
        }
        doneChunks++;
        if (myScan === scanId) progress();
      });
      if (myScan !== scanId) return;

      if (results.length && !firstError && (!pageAnchors.length || new Set(results.map((q) => q.anchor)).size >= pageAnchors.length)) {
        try {
          const seen = new Set();
          const uniq = results.filter((q) => !seen.has(q.anchor) && seen.add(q.anchor)).sort((x, y) => x.anchor - y.anchor);
          const { qtCache } = await store.get({ qtCache: {} });
          qtCache[cacheKey] = { t: Date.now(), items: uniq };
          const keys = Object.keys(qtCache).sort((x, y) => qtCache[y].t - qtCache[x].t);
          for (const k of keys.slice(25)) delete qtCache[k];
          await store.set({ qtCache });
        } catch (_) {}
      }
    }
    if (myScan !== scanId) return;

    if (!state.items.length) {
      setStatus('error');
      setTimeout(() => state.status === 'error' && setStatus('idle'), 3500);
      return toast(firstError ? 'Lỗi: ' + firstError.message : 'Không tìm thấy câu hỏi trắc nghiệm nào trên trang.', 'error', { settings: !!firstError, ms: 8000 });
    }

    setStatus('done');
    updateFab();
    layout();
    if (cfg.debug) console.log('[QuizTutor] đáp án:', state.items.map((i) => i.q.answer).join(' '));
    const missingN = pageAnchors.length ? Math.max(0, pageAnchors.length - state.items.length) : 0;

    const todo = pickRefine(cfg);
    if (cfg.debug) console.log('[QuizTutor] kết quả lượt 1:', state.items.map((i) => ({ anchor: i.q.anchor, answer: i.q.answer, conf: i.q.confidence, calc: i.q.needs_calc })));
    if (firstError) toast(`Xong ${state.items.length} câu, nhưng một lô bị lỗi: ${firstError.message}`, 'error', { ms: 9000, settings: true });
    else if (!todo.length) toast(`Đã giải ${state.items.length}${pageAnchors.length ? '/' + pageAnchors.length : ''} câu${missingN ? ` (còn ${missingN} câu chưa giải được – chuột phải vào nút để quét lại)` : ''}${fromCache ? ' (dùng kết quả đã lưu, không tốn request)' : ''}. Bấm vào ô đáp án để xem hướng dẫn.${imgWarn()}`, 'info', { ms: 7000 });

    if (todo.length) refine(todo, cfg, myScan);
  }

  const anchorEnd = (a) => Math.min(pageAnchors.find((x) => x > a) ?? pageLines.length, a + 60, pageLines.length);
  const segmentOf = (it) => {
    const idx = state.items.indexOf(it);
    const a = it.q.anchor;
    const nextA = pageAnchors.length ? (pageAnchors.find((x) => x > a) ?? pageLines.length) : (state.items[idx + 1]?.q.anchor ?? pageLines.length);
    return { a, end: Math.min(nextA, a + 60, pageLines.length) };
  };
  function pickRefine(cfg) {
    if (!cfg.deepSolve || !cfg.strongModel) return [];
    if (cfg.accuracy) { // chế độ chính xác: kiểm tra chéo câu rủi ro (tính toán/có hình/công thức); scope 'all' = tất cả
      const all = cfg.refineScope === 'all';
      return state.items.filter((it) => !it.refinedBy && (all || needsRefine(it))).slice(0, 80);
    }
    const scope = cfg.refineScope || 'smart';
    const pick = state.items.filter((it) => !it.refinedBy && (
      scope === 'all' || needsRefine(it) || (scope === 'uncertain' && !(typeof it.q.confidence === 'number' && it.q.confidence >= 0.85))));
    return pick.slice(0, scope === 'all' ? 60 : MAX_REFINE);
  }

  /* ---------- Chụp ảnh từng câu (Vision) để Gemini "nhìn" đúng như người dùng thấy ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function scrollableAncestors(el) {
    const out = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 2) out.push(p);
    }
    return out;
  }
  function unionRect(els) {
    let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
    for (const e of els) {
      const rc = e.getBoundingClientRect();
      if (rc.width < 1 || rc.height < 1) continue;
      l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom);
    }
    return r > l && b > t ? { l, t, r, b } : null;
  }
  async function cropShot(dataUrl, rc) {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const ratio = bmp.width / innerWidth;
    const pad = 6;
    const x = Math.max(0, rc.l - pad), y = Math.max(0, rc.t - pad);
    const w = Math.min(innerWidth, rc.r + pad) - x, h = Math.min(innerHeight, rc.b + pad) - y;
    if (w < 20 || h < 20) return null;
    const k = Math.min(1, 1600 / Math.max(w * ratio, h * ratio));
    const c = document.createElement('canvas');
    c.width = Math.round(w * ratio * k); c.height = Math.round(h * ratio * k);
    c.getContext('2d').drawImage(bmp, x * ratio, y * ratio, w * ratio, h * ratio, 0, 0, c.width, c.height);
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    const data = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(out);
    });
    return { mimeType: 'image/jpeg', data };
  }

  async function captureShots(items, myScan, onProgress) {
    const shots = new Map();
    const saved = [{ el: window, x: scrollX, y: scrollY }];
    const seen = new Set();
    for (const it of items) for (const p of scrollableAncestors(it.el)) if (!seen.has(p)) { seen.add(p); saved.push({ el: p, x: p.scrollLeft, y: p.scrollTop }); }
    host.style.visibility = 'hidden'; // ẩn UI của extension khỏi ảnh chụp
    try {
      for (let i = 0; i < items.length; i++) {
        if (myScan !== scanId) break;
        const { a, end } = segmentOf(items[i]);
        const els = pageEls.slice(a, end).filter((e) => e && e.isConnected);
        if (!els.length) continue;
        els[0].scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        scrollBy(0, -70); // tránh header dính (sticky)
        await sleep(520); // chờ cuộn + ảnh lazy-load; captureVisibleTab giới hạn ~2 lần/giây
        const rc = unionRect(els);
        if (!rc) continue;
        const res = await sendMsg({ type: 'capture' });
        if (!res?.ok) {
          if (!shots.size) throw new Error(res?.error || 'captureVisibleTab thất bại');
          continue;
        }
        try {
          const shot = await cropShot(res.dataUrl, rc);
          if (shot) shots.set(items[i], shot);
        } catch (_) {}
        onProgress(i + 1);
      }
    } finally {
      host.style.visibility = '';
      for (const sv of saved.reverse()) {
        if (sv.el === window) scrollTo(sv.x, sv.y);
        else { sv.el.scrollLeft = sv.x; sv.el.scrollTop = sv.y; }
      }
    }
    return shots;
  }

  // Phân loại từng câu theo NỘI DUNG (không tin hoàn toàn cờ needs_calc của AI): tính toán thật / có hình
  function qKind(it) {
    const { a, end } = segmentOf(it);
    const seg = pageLines.slice(a, end);
    const sc = calcScore(seg.join(' '));
    return { calc: sc >= 3, image: imageIdsIn(seg).length > 0 }; // chỉ dựa vào nội dung, không dựa cờ needs_calc của AI (hay gắn nhầm)
  }
  function needsRefine(it) {
    const k = qKind(it);
    return k.calc || k.image;
  }

  /* ---------- Lượt 2: giải lại kỹ từng câu tính toán / có hình bằng model mạnh ---------- */
  const normAns = (x) => String(x ?? '').toUpperCase().replace(/\s+/g, '').replace(/[.;&]|VÀ/g, ',').split(',').filter(Boolean).sort().join(',');
  const TIE_NOTE = '\nLƯU Ý: mỗi khối kèm 2 lời giải ĐÃ BẤT ĐỒNG về đáp án. Đừng tin cả hai: tự giải lại từ đầu thật cẩn thận, kiểm tra TỪNG phương án, chỉ ra lời giải nào sai ở bước nào, rồi mới chốt answer.';

  async function refine(todo, cfg, myScan) {
    const acc = !!cfg.accuracy;
    const sys2 = buildSolveSystem(cfg.language, cfg.detail);
    const sys3 = sys2 + TIE_NOTE;
    const sysCode = buildCodeSystem(cfg.language);
    const sysCode3 = sysCode + TIE_NOTE;
    todo.forEach((it) => { it.refining = true; refreshBadge(it); });
    const cnt = { failed: 0, err: null, fellBack: false };
    const clip = (t, n = 500) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');
    const stats = { agree: 0, conflict: 0, resolved: 0, unresolved: 0, changed: 0 };

    let shots = new Map();
    if (cfg.visionShot) {
      try {
        shots = await captureShots(todo, myScan, (n) => toast(`Đang chụp ảnh từng câu… (${n}/${todo.length}) – vui lòng đừng cuộn trang`, 'info', { sticky: true }));
      } catch (e) {
        toast('Không chụp được màn hình: ' + e.message + ' – dùng văn bản/ảnh trích xuất.', 'error', { ms: 6000 });
      }
      if (myScan !== scanId) return;
    }

    const mkBlock = (it, ids, extra = '') => {
      const { a, end } = segmentOf(it);
      const slice = pageLines.slice(a, end);
      const shot = shots.get(it);
      if (!shot) imageIdsIn(slice).forEach((x) => ids.add(x));
      return `=== CÂU (anchor ${a}) ===${shot ? ' (có ảnh chụp màn hình đính kèm)' : ''}\n` + slice.map((t, k) => `[${a + k}] ${t}`).join('\n') + extra;
    };

    const runStage = async (items, o) => {
      const batches = [];
      for (let i = 0; i < items.length; i += o.batch) batches.push(items.slice(i, i + o.batch));
      let done = 0;
      o.label(0, items.length);
      await pool(Math.max(1, Number(cfg.parallel) || 1), batches.length, async (bi) => {
        const group = batches[bi];
        try {
          const ids = new Set();
          const blocks = group.map((it) => mkBlock(it, ids, o.extra ? o.extra(it) : ''));
          const parts = await buildParts(`Trang: ${document.title}\n\n` + blocks.join('\n\n'), [...ids].slice(0, MAX_IMAGES_REQ), cfg);
          for (const it of group) {
            const shot = shots.get(it);
            if (shot) { parts.push({ text: `Ảnh chụp màn hình của câu (anchor ${it.q.anchor}):` }); parts.push({ inlineData: shot }); }
          }
          let arr;
          const wantCode = !!o.sysCode && !codeUnsupported;
          const call = (withCode) => sendGemini(withCode ? o.sysCode : o.system, parts, { model: o.model, thinking: o.thinking, tools: withCode ? 'code' : undefined });
          try {
            arr = await call(wantCode);
          } catch (e) {
            if (wantCode && /CODE_UNSUPPORTED/.test(e.message)) { // model/key không hỗ trợ chạy Python -> suy luận thuần
              codeUnsupported = true;
              store.set({ codeSupport: 'no' }).catch(() => {});
              arr = await call(false);
            } else if (o.model && /404|not found|not supported|403|permission/i.test(e.message)) { // model không dùng được -> quay về model lượt 1
              cnt.fellBack = true;
              arr = await sendGemini(o.system, parts, { thinking: o.thinking });
            } else throw e;
          }
          if (myScan !== scanId) return;
          for (const it of group) {
            const res = arr.find((x) => x?.answer && x.anchor === it.q.anchor);
            if (res) o.apply(it, res); else cnt.failed++;
          }
        } catch (e) {
          cnt.failed += group.length;
          cnt.err = cnt.err || e;
        } finally {
          done += group.length;
          if (myScan === scanId) { o.label(done, items.length); if (o.after) o.after(group); }
        }
      });
    };

    const kindOf = new Map(todo.map((it) => [it, qKind(it)]));
    const calcItems = todo.filter((it) => kindOf.get(it).calc);
    const imgItems = todo.filter((it) => !kindOf.get(it).calc);
    const usePy = !!cfg.useCode && !codeUnsupported; // Python chỉ dùng cho câu tính toán thật
    const stageName = acc ? 'Lượt 2/3' : 'Kiểm tra lại';

    // ---- Lượt 2: giải độc lập (suy luận cao) ----
    const apply2 = (it, res) => {
      const old = String(it.q.answer).trim();
      const nw = String(res.answer).trim();
      it.tmp = { e1: it.q.explanation, e2: res.explanation };
      if (acc) {
        const same = normAns(old) === normAns(nw);
        const v = same ? { status: 'agree', first: old } : { status: 'conflict', first: old, second: nw };
        it.q = { ...it.q, ...res, anchor: it.q.anchor, __refined: cfg.strongModel, __verify: v };
        if (same) stats.agree++; else { stats.conflict++; it.prevAnswer = old; }
      } else {
        it.q = { ...it.q, ...res, anchor: it.q.anchor, __refined: cfg.strongModel };
        if (normAns(old) !== normAns(nw)) { it.prevAnswer = old; stats.changed++; }
      }
      it.refinedBy = cfg.strongModel;
    };
    const after2 = (group) => group.forEach((it) => {
      if (!acc || it.q.__verify?.status === 'agree') { it.refining = false; it.badge.classList.remove('refining'); }
      refreshBadge(it);
    });
    if (calcItems.length) {
      await runStage(calcItems, {
        system: sys2, sysCode: usePy ? sysCode : null, batch: 4, model: cfg.strongModel, thinking: cfg.strongThinking,
        label: (n, t) => toast(`${stageName}: giải lại ${t} câu tính toán${usePy && !codeUnsupported ? ' bằng Python' : ''}… (${n}/${t}) – đáp án sơ bộ đã hiện`, 'info', { sticky: true }),
        apply: apply2, after: after2
      });
      if (myScan !== scanId) return;
    }
    if (imgItems.length) {
      await runStage(imgItems, {
        system: sys2, sysCode: null, batch: 4, model: cfg.strongModel, thinking: cfg.strongThinking,
        label: (n, t) => toast(`${stageName}: đọc lại ${t} câu có hình… (${n}/${t}) – đáp án sơ bộ đã hiện`, 'info', { sticky: true }),
        apply: apply2, after: after2
      });
      if (myScan !== scanId) return;
    }

    // ---- Lượt 3: phân xử những câu hai lượt giải bất đồng ----
    const conflicts = acc ? todo.filter((it) => it.q.__verify?.status === 'conflict') : [];
    const tie = (items, withCode) => runStage(items, {
      system: sys3, sysCode: withCode ? sysCode3 : null, batch: 4, model: cfg.strongModel, thinking: 'high',
      extra: (it) => `\n--- Lời giải 1 (chọn ${it.q.__verify.first}): ${clip(it.tmp?.e1)}\n--- Lời giải 2 (chọn ${it.q.__verify.second}): ${clip(it.tmp?.e2)}`,
      label: (n, t) => toast(`Lượt 3/3: phân xử ${t} câu hai lượt giải bất đồng… (${n}/${t})`, 'info', { sticky: true }),
      apply: (it, res) => {
        const v = it.q.__verify;
        const fin = String(res.answer).trim();
        const ok = normAns(fin) === normAns(v.first) || normAns(fin) === normAns(v.second);
        it.q = { ...it.q, ...res, anchor: it.q.anchor, __refined: cfg.strongModel, __verify: { ...v, final: fin, status: ok ? 'resolved' : 'unresolved' } };
        it.prevAnswer = normAns(fin) !== normAns(v.first) ? v.first : null;
        if (ok) stats.resolved++; else stats.unresolved++;
      },
      after: (group) => group.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); })
    });
    const confCalc = conflicts.filter((it) => kindOf.get(it).calc);
    const confOther = conflicts.filter((it) => !kindOf.get(it).calc);
    if (confCalc.length) await tie(confCalc, usePy && !codeUnsupported);
    if (myScan !== scanId) return;
    if (confOther.length) await tie(confOther, false);
    if (myScan !== scanId) return;
    todo.forEach((it) => { it.refining = false; it.badge.classList.remove('refining'); refreshBadge(it); });

    if (!cnt.failed && cacheKeyCur) {
      try { // lưu kết quả đã kiểm tra để lần sau không tốn request
        const { qtCache } = await store.get({ qtCache: {} });
        if (qtCache[cacheKeyCur]) {
          qtCache[cacheKeyCur] = { t: Date.now(), items: state.items.map((i) => i.q) };
          await store.set({ qtCache });
        }
      } catch (_) {}
    }
    let msg;
    if (acc) {
      msg = `Hoàn tất ${state.items.length} câu. ${stats.agree} câu hai lượt giải trùng khớp` +
        (stats.conflict ? `; ${stats.conflict} câu bất đồng → ${stats.resolved} câu đã chốt ở lượt 3` + (stats.unresolved ? `, ${stats.unresolved} câu vẫn chưa chắc (ô màu cam – hãy tự kiểm tra)` : '') : '') + '.';
    } else {
      msg = `Hoàn tất ${state.items.length} câu. Kiểm tra lại ${todo.length - cnt.failed}/${todo.length} câu` + (stats.changed ? `, ${stats.changed} câu đổi đáp án.` : ', đáp án giữ nguyên.');
    }
    if (cfg.useCode && codeUnsupported) msg += ' Lưu ý: Model/key không hỗ trợ chạy Python nên đã dùng suy luận thuần.';
    if (cnt.fellBack) msg += ` Lưu ý: Model ${cfg.strongModel} không dùng được với key của bạn nên đã dùng model lượt 1 – hãy đổi model lượt 2 trong Cài đặt.`;
    if (cnt.failed) msg += ` (${cnt.failed} lượt lỗi${cnt.err ? ': ' + cnt.err.message : ''}; giữ kết quả trước đó)`;
    toast(msg + imgWarn(), cnt.failed || cnt.fellBack ? 'error' : 'info', { ms: 12000 });
  }

  /* ---------- Ô đáp án đè lên đề bài ---------- */
  const isLow = (q) => q.__verify?.status === 'unresolved' || (typeof q.confidence === 'number' && q.confidence < 0.6);

  function addItems(qs, els) {
    const seen = new Set(state.items.map((i) => i.q.anchor));
    for (const q of qs) {
      if (seen.has(q.anchor) || !els[q.anchor]) continue;
      seen.add(q.anchor);
      const it = { q, el: els[q.anchor], badge: null, refining: false, refinedBy: q.__refined || null, prevAnswer: null };
      state.items.push(it);
      makeBadge(it);
    }
    state.items.sort((x, y) => x.q.anchor - y.q.anchor);
    updateFab();
    layout();
  }

  function renderBadges() {
    for (const it of state.items) makeBadge(it);
  }

  function makeBadge(it) {
    {
      const b = document.createElement('div');
      b.className = 'badge';
      b.title = 'Bấm để xem hướng dẫn giải';
      b.addEventListener('click', (e) => { e.stopPropagation(); togglePop(it); });
      layer.appendChild(b);
      it.badge = b;
      refreshBadge(it);
    }
  }

  function refreshBadge(it) {
    it.badge.textContent = String(it.q.answer).trim() + (it.refining ? '…' : '');
    it.badge.classList.toggle('low', isLow(it.q));
    it.badge.classList.toggle('free', !!it.q.free_response);
    it.badge.title = it.q.free_response ? 'Bấm để xem gợi ý câu trả lời' : 'Bấm để xem hướng dẫn giải';
    if (state.active === it) renderPop(it);
    schedule();
  }

  function clearOverlays() {
    closePop();
    layer.textContent = '';
    state.items = [];
    updateFab();
    fab.classList.remove('off');
    hideToast();
  }

  let rafPending = false;
  function schedule() {
    if (rafPending || !state.items.length || !state.visible) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; layout(); });
  }

  function layout() {
    if (!state.visible) return;
    const stacked = new Map();
    for (const it of state.items) {
      const b = it.badge;
      if (!it.el.isConnected) { b.style.display = 'none'; continue; }
      const r = it.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width === 0 || r.height === 0) { b.style.display = 'none'; continue; }
      b.style.display = '';
      const k = stacked.get(it.el) || 0;
      stacked.set(it.el, k + 1);
      const w = b.offsetWidth || 36;
      const x = Math.max(w + 6, Math.min(r.right - 4, innerWidth - 8) - k * (w + 6));
      let y = Math.max(r.top + 2, 4);
      y = Math.max(4, Math.min(y, r.bottom - ((b.offsetHeight || 28) + 4)));
      b.style.left = x + 'px';
      b.style.top = y + 'px';
    }
    if (state.active) {
      if (state.active.badge.style.display === 'none' && !isSheet()) closePop(); else placePop();
    }
  }

  /* ---------- Popup hướng dẫn giải ---------- */
  const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function md(s) {
    const inl = (t) => escHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const out = [];
    let list = false;
    for (const raw of String(s || '').split(/\r?\n/)) {
      const m = raw.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) {
        if (!list) { out.push('<ul>'); list = true; }
        out.push('<li>' + inl(m[1]) + '</li>');
      } else {
        if (list) { out.push('</ul>'); list = false; }
        if (raw.trim()) out.push('<p>' + inl(raw) + '</p>');
      }
    }
    if (list) out.push('</ul>');
    return out.join('');
  }

  function verifyNote(it) {
    const v = it.q.__verify;
    const e = escHtml;
    if (v) {
      if (v.status === 'agree') return `<div class="note">Hai lượt giải độc lập (hai model/hai lần suy luận) cùng chọn <b>${e(v.first)}</b>.</div>`;
      if (v.status === 'conflict') return `<div class="note">Hai lượt giải bất đồng (<b>${e(v.first)}</b> / <b>${e(v.second)}</b>), đang kiểm tra lần 3…</div>`;
      if (v.status === 'resolved') return `<div class="note">Lưu ý: Hai lượt giải đầu bất đồng (<b>${e(v.first)}</b> / <b>${e(v.second)}</b>). Lượt kiểm tra thứ 3 chọn <b>${e(v.final)}</b> (trùng một trong hai lượt trước).</div>`;
      if (v.status === 'unresolved') return `<div class="warn">Lưu ý: Ba lượt giải cho kết quả khác nhau (${e(v.first)} / ${e(v.second)} / ${e(v.final)}) – hãy tự kiểm tra lại câu này.</div>`;
    }
    if (it.refinedBy) return `<div class="note">Đã giải lại kỹ bằng <b>${e(it.refinedBy)}</b>${it.prevAnswer ? ` – đáp án sơ bộ trước đó là <b>${e(it.prevAnswer)}</b>, đã được sửa.` : ' – kết quả trùng khớp với lượt đầu.'}</div>`;
    return '';
  }

  function togglePop(it) {
    if (state.active === it) return closePop();
    if (state.active) state.active.badge.classList.remove('active');
    state.active = it;
    it.badge.classList.add('active');
    renderPop(it);
    pop.hidden = false;
    pop.scrollTop = 0;
    placePop();
  }

  function renderPop(it) {
    const q = it.q;
    const keep = pop.scrollTop;
    const head = q.free_response
      ? `<div class="hd"><span class="ans">Gợi ý câu trả lời</span><button class="x" title="Đóng">×</button></div><div class="at">${md(q.answer)}</div>`
      : `<div class="hd"><span class="ans">Đáp án: <b>${escHtml(q.answer)}</b></span><button class="x" title="Đóng">×</button></div>${q.answer_text ? `<div class="at">${escHtml(q.answer_text)}</div>` : ''}`;
    pop.innerHTML = `
      ${head}
      ${it.refining ? `<div class="note">Đang kiểm tra lại bằng model mạnh hơn… đáp án có thể thay đổi.</div>` : ''}
      ${verifyNote(it)}
      <div class="sec">Hướng dẫn giải</div>
      <div class="body">${md(q.explanation)}</div>
      ${q.memory_tip ? `<div class="tip"><b>Mẹo nhớ:</b> ${escHtml(q.memory_tip)}</div>` : ''}
      ${isLow(q) ? '<div class="warn">Lưu ý: AI chưa chắc chắn với câu này – hãy đối chiếu giáo trình/tự tính lại.</div>' : ''}
      <div class="ft"><button data-a="rescan">Quét mới</button><button data-a="settings">Cài đặt</button><button data-a="diag">Chẩn đoán</button></div>`;
    pop.querySelector('.x').addEventListener('click', closePop);
    pop.querySelector('.ft').addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if (act === 'rescan') { closePop(); scan(true); }
      else if (act === 'settings') sendMsg({ type: 'openOptions' });
      else if (act === 'diag') copyDiagnostic();
    });
    pop.scrollTop = keep;
  }

  function closePop() {
    if (state.active) state.active.badge.classList.remove('active');
    state.active = null;
    pop.hidden = true;
  }

  function placePop() {
    if (!state.active) return;
    const v = vp();
    if (isSheet()) { // điện thoại: ngăn kéo ở cạnh dưới màn hình
      pop.style.width = Math.floor(v.w - 16) + 'px';
      pop.style.maxHeight = Math.floor(v.h * 0.5) + 'px';
      pop.style.left = v.l + 8 + 'px';
      pop.style.top = v.t + v.h - pop.offsetHeight - 8 + 'px';
      return;
    }
    pop.style.width = '';
    pop.style.maxHeight = '';
    const br = state.active.badge.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(br.right - pw, innerWidth - pw - 8));
    let top = br.bottom + 8;
    if (top + ph > innerHeight - 8) top = br.top - ph - 8;
    top = Math.max(8, Math.min(top, innerHeight - ph - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  /* ---------- Phát hiện trang kiểu "mỗi lần hiện 1 câu" (nút câu tiếp theo / câu trước) ---------- */
  // Chỉ kích hoạt SAU KHI đã quét thành công ít nhất 1 lần trên trang này (state.items.length > 0), nên không
  // tự ý quét trang người dùng chưa từng dùng extension. Khi đã dùng rồi, bấm chuyển câu sẽ tự quét lại câu mới;
  // quay lại câu cũ thì dùng ngay kết quả đã lưu trong bộ nhớ đệm của trang (không tốn request).
  const stripDiacritics = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const NAV_RE = /^(cau\s*)?(tiep theo|sau|truoc|quay lai|ke tiep)\b|^(next|previous|prev|back)(\s*(question|cau))?\s*[»›➜→←‹«]?$/i;
  function isNavControl(el) {
    const ctl = el.closest('button, a, [role="button"], input[type="submit"], input[type="button"], [onclick]');
    if (!ctl) return false;
    const txt = [ctl.textContent, ctl.getAttribute('aria-label'), ctl.getAttribute('title')]
      .filter(Boolean).map((t) => stripDiacritics(t.trim().toLowerCase())).join(' | ');
    return NAV_RE.test(txt.slice(0, 40)) || txt.split('|').some((t) => NAV_RE.test(t.trim()));
  }
  function scheduleAutoRescan() {
    if (!state.items.length) return; // chưa từng quét thành công trên trang này -> không tự động làm gì
    let done = false;
    const go = () => { if (done) return; done = true; obs.disconnect(); clearTimeout(timer); setTimeout(() => scan(), 150); };
    const obs = new MutationObserver(go);
    try { obs.observe(document.body, { childList: true, subtree: true, characterData: true }); } catch (_) {}
    const timer = setTimeout(go, 1500); // phòng khi trang không tạo mutation rõ ràng (vd. chỉ đổi qua CSS/visibility)
  }
  document.addEventListener('click', (e) => {
    if (e.composedPath().includes(host)) return; // bỏ qua click trong UI của chính extension
    const el = e.target;
    if (el && el.nodeType === 1 && isNavControl(el)) scheduleAutoRescan();
  }, true);

  /* ---------- Sự kiện chung ---------- */
  addEventListener('scroll', schedule, { capture: true, passive: true });
  addEventListener('resize', () => { placeFab(); schedule(); });
  if (vv) {
    vv.addEventListener('resize', () => { placeFab(); schedule(); });
    vv.addEventListener('scroll', () => { placeFab(); schedule(); });
  }
  setInterval(schedule, IS_TOUCH ? 1200 : 700);
  document.addEventListener('pointerdown', (e) => {
    if (!IS_TOUCH && state.active && !e.composedPath().includes(host)) closePop(); // cảm ứng: chạm ngoài để cuộn trang không đóng bảng
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
})();
