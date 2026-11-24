// Bản quyền theo mã 30 ngày. Mã do trang admin ký bằng ECDSA P-256; extension chỉ giữ KHÓA CÔNG KHAI nên không thể tự tạo mã.
// Lưu ý: đây là kiểm soát phía máy khách (đủ để ngăn dùng chung/ quên gia hạn trong nội bộ, không chống được người sửa mã extension).
(function () {
  'use strict';
  const root = typeof self !== 'undefined' ? self : window;
  const DAY = 86400000;
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const KEY = 'qtLicense';
  const enc = new TextEncoder();

  const cget = (d) => new Promise((res, rej) => {
    try { chrome.storage.local.get(d, (r) => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))); } catch (e) { rej(e); }
  });
  const cset = (o) => new Promise((res, rej) => {
    try { chrome.storage.local.set(o, () => (chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())); } catch (e) { rej(e); }
  });

  function b32enc(bytes) {
    let bits = 0, val = 0, out = '';
    for (const b of bytes) {
      val = (val << 8) | b; bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
      val &= (1 << bits) - 1;
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  function b32dec(str) {
    const out = [];
    let bits = 0, val = 0;
    for (const ch of str) {
      const i = B32.indexOf(ch);
      if (i < 0) throw new Error('Mã chứa ký tự không hợp lệ.');
      val = (val << 5) | i; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
    }
    return new Uint8Array(out);
  }
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  const normId = (s) => String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
  // 6 byte đầu của SHA-256("QT-DEV:" + mã thiết bị) -> gắn mã với đúng một thiết bị
  async function deviceTag(deviceId) { return (await sha256(enc.encode('QT-DEV:' + normId(deviceId)))).slice(0, 6); }

  function fmtId(raw) { return raw.match(/.{1,4}/g).join('-'); }
  async function getDeviceId() {
    const r = await cget({ deviceId: '' });
    if (r.deviceId) return r.deviceId;
    const id = fmtId(b32enc(crypto.getRandomValues(new Uint8Array(10)))); // 16 ký tự
    await cset({ deviceId: id });
    return id;
  }

  // Cấu trúc mã: v(1) | id(6) | dev(6) | iat(4, giây) | days(1) | redeemDays(1) | chữ ký ECDSA(64)  = 83 byte -> 133 ký tự base32
  function parseCode(code) {
    const clean = String(code || '').toUpperCase().replace(/^\s*QT1[\s-]*/, '').replace(/[^A-Z2-7]/g, '');
    if (clean.length !== 133) throw new Error('Mã không đúng định dạng (kiểm tra đã dán đủ mã chưa).');
    const bytes = b32dec(clean);
    if (bytes.length !== 83) throw new Error('Mã không đúng định dạng.');
    const payload = bytes.slice(0, 19), sig = bytes.slice(19);
    const dv = new DataView(payload.buffer, payload.byteOffset, 19);
    return { payload, sig, v: payload[0], id: hex(payload.slice(1, 7)), dev: payload.slice(7, 13), iat: dv.getUint32(13), days: payload[17], redeemDays: payload[18] };
  }
  async function verifySig(p) {
    const jwk = root.QT_PUBLIC_KEY;
    if (!jwk) throw new Error('Extension chưa được cấu hình khóa công khai (liên hệ quản trị viên).');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, p.sig, p.payload);
  }

  async function load() {
    const r = await cget({ [KEY]: null });
    const s = r[KEY] || {};
    return { end: s.end || 0, used: s.used || [], maxSeen: s.maxSeen || 0, log: s.log || [] };
  }
  const save = (s) => cset({ [KEY]: s });

  // Thời gian "đáng tin": không bao giờ lùi (chống chỉnh đồng hồ lùi); được đồng bộ theo header Date của Google khi gọi API
  async function trustedNow() {
    const s = await load();
    const t = Math.max(Date.now(), s.maxSeen);
    if (t - s.maxSeen > 60000) { s.maxSeen = t; await save(s); }
    return t;
  }
  async function noteTime(ms) {
    if (!(ms > 0)) return;
    const s = await load();
    if (ms > s.maxSeen) { s.maxSeen = ms; await save(s); }
  }

  async function status() {
    const enforced = root.__qtDevBypass !== true; // mặc định LUÔN bật; chỉ tắt khi nạp thêm license-config.dev.js (không phát hành)
    const deviceId = await getDeviceId();
    const configured = !!root.QT_PUBLIC_KEY;
    if (!enforced) return { enforced: false, active: true, configured, deviceId, end: 0, daysLeft: null, message: '' };
    const s = await load();
    const now = await trustedNow();
    const active = configured && s.end > now;
    const message = !configured ? 'Extension chưa được cấu hình khóa bản quyền (liên hệ quản trị viên).'
      : active ? '' : (s.end ? 'Bản quyền đã hết hạn. Mở Cài đặt và nhập mã gia hạn.' : 'Chưa kích hoạt. Mở Cài đặt và nhập mã kích hoạt.');
    return { enforced, active, configured, deviceId, end: s.end, daysLeft: active ? Math.ceil((s.end - now) / DAY) : 0, message };
  }
  async function assertActive() {
    const st = await status();
    if (!st.active) throw new Error('LICENSE_REQUIRED: ' + st.message);
    return st;
  }

  async function redeem(code) {
    const p = parseCode(code);
    if (p.v !== 1) throw new Error('Mã không đúng phiên bản.');
    if (p.days < 1 || p.days > 120) throw new Error('Mã không hợp lệ (số ngày).');
    if (!(await verifySig(p))) throw new Error('Mã không hợp lệ (chữ ký sai).');
    const tag = await deviceTag(await getDeviceId());
    const wildcard = p.dev.every((b) => b === 0);
    if (!wildcard && hex(p.dev) !== hex(tag)) throw new Error('Mã này được cấp cho thiết bị khác.');
    const s = await load();
    const now = await trustedNow();
    if (p.iat * 1000 > now + 2 * DAY) throw new Error('Mã chưa đến thời điểm hiệu lực (kiểm tra ngày giờ của máy).');
    if (now > (p.iat + p.redeemDays * 86400) * 1000) throw new Error('Mã đã quá hạn kích hoạt. Hãy xin mã mới.');
    if (s.used.includes(p.id)) throw new Error('Mã này đã được dùng trên thiết bị này.');
    const end = Math.max(now, s.end) + p.days * DAY; // gia hạn nối tiếp nếu còn hạn
    if (end - now > 366 * DAY) throw new Error('Đã gia hạn quá dài (tối đa 366 ngày tính từ hôm nay).');
    s.end = end;
    s.used = [...s.used, p.id].slice(-200);
    s.log = [...s.log, { at: now, id: p.id, days: p.days }].slice(-50);
    await save(s);
    return { end, days: p.days };
  }

  root.QTLicense = { status, assertActive, redeem, noteTime, getDeviceId, parseCode, b32enc, b32dec, deviceTag, normId };
})();
