/* Chrome Extension API compatibility shim for the iOS WKWebView port. */
(() => {
  if (window.__qtIOSShimInstalled) return;
  window.__qtIOSShimInstalled = true;

  const DB_NAME = 'qt-ios-extension-storage';
  const STORE_NAME = 'local';
  const listeners = [];
  const pending = new Map();
  let nextId = 0;

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Không mở được kho cài đặt iOS.'));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Lỗi IndexedDB.'));
    });
  }

  async function storageGet(defaults, callback) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let result = {};
      if (defaults === null || typeof defaults === 'undefined') {
        result = await new Promise((resolve, reject) => {
          const out = {};
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item) return resolve(out);
            out[String(item.key)] = item.value;
            item.continue();
          };
          cursor.onerror = () => reject(cursor.error || new Error('Không đọc được cài đặt.'));
        });
      } else {
        const keys = typeof defaults === 'string' ? [defaults]
          : Array.isArray(defaults) ? defaults
          : Object.keys(defaults || {});
        const values = await Promise.all(keys.map((key) => requestValue(store.get(key))));
        keys.forEach((key, index) => {
          const value = values[index];
          if (value !== undefined) result[key] = value;
          else if (defaults && typeof defaults === 'object' && !Array.isArray(defaults) && Object.prototype.hasOwnProperty.call(defaults, key)) result[key] = defaults[key];
        });
      }
      if (typeof callback === 'function') callback(result);
      return result;
    } catch (error) {
      if (typeof callback === 'function') callback({});
      return {};
    }
  }

  async function storageSet(values, callback) {
    const changes = {};
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const [key, value] of Object.entries(values || {})) {
          const get = store.get(key);
          get.onsuccess = () => {
            const oldValue = get.result;
            store.put(value, key);
            changes[key] = { oldValue, newValue: value };
          };
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Không lưu được cài đặt.'));
        tx.onabort = () => reject(tx.error || new Error('Giao dịch lưu bị hủy.'));
      });
      for (const listener of [...listeners]) {
        try { listener(changes, 'local'); } catch (_) {}
      }
      if (typeof callback === 'function') callback();
      return true;
    } catch (error) {
      if (typeof callback === 'function') callback();
      return false;
    }
  }

  const chromeCompat = window.chrome || {};
  window.chrome = chromeCompat;
  chromeCompat.storage = chromeCompat.storage || {};
  chromeCompat.storage.local = { get: storageGet, set: storageSet };
  chromeCompat.storage.onChanged = chromeCompat.storage.onChanged || {};
  chromeCompat.storage.onChanged.addListener = (callback) => {
    if (typeof callback === 'function') listeners.push(callback);
  };

  chromeCompat.runtime = chromeCompat.runtime || {};
  chromeCompat.runtime.lastError = null;
  chromeCompat.runtime.getManifest = () => ({ version: '2.3.0-ios' });
  chromeCompat.runtime.sendMessage = (message, callback) => {
    const id = String(++nextId);
    if (typeof callback === 'function') pending.set(id, callback);
    Promise.resolve().then(async () => {
      // Send only native settings; do not serialize the potentially large question cache.
      const config = await storageGet({
        apiKey: '', backupApiKey1: '', backupApiKey2: '', model: 'gemini-3.5-flash-lite', fallbackModel: '', language: 'Tiếng Việt', thinking: 'auto',
        fabColor: '#333333', fabIcon: '#ffffff', fabOpacity: 0.8, fabTextOpacity: 1, fabSize: 48,
        badgeColor: '#222222', badgeText: '#ffffff', badgeOpacity: 0.9, badgeTextOpacity: 1, lowColor: '#8a5a00',
        popColor: '#ffffff', popText: '#000000', popOpacity: 0.97, popTextOpacity: 1, popHeight: 0.6,
        toastColor: '#222222', toastText: '#ffffff', toastOpacity: 0.9, toastTextOpacity: 1
      });
      const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.qtBridge;
      if (!bridge) {
        if (pending.has(id)) {
          const cb = pending.get(id); pending.delete(id);
          cb({ ok: false, error: 'Không tìm thấy native bridge của Quiz Tutor.' });
        }
        return;
      }
      bridge.postMessage({ id, message: message || {}, config });
    }).catch((error) => {
      if (pending.has(id)) {
        const cb = pending.get(id); pending.delete(id);
        cb({ ok: false, error: String(error && error.message || error) });
      }
    });
  };

  window.__qtNativeStatus = (id, message) => {
    window.dispatchEvent(new CustomEvent('qt-native-status', { detail: { id: String(id), message: String(message || '') } }));
  };
  window.__qtNativeReply = (id, response) => {
    const key = String(id);
    const callback = pending.get(key);
    if (!callback) return;
    pending.delete(key);
    try { callback(response); } catch (_) {}
  };
  window.__qtStorageSet = (values) => storageSet(values || {});
})();
