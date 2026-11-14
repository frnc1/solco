/*
 * SOLCO — libreria dei brani (IndexedDB): schede, file audio, forme d'onda, impostazioni.
 */
'use strict';
(function (root) {
  const DB = 'solco', VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB assente')); return; }
      let rq;
      try { rq = indexedDB.open(DB, VER); } catch (e) { reject(e); return; }
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('waves')) db.createObjectStore('waves', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }

  // se IndexedDB non è disponibile (alcuni browser o finestre protette) si lavora in memoria
  let mem = null;
  function memTx(store, fn) {
    const m = mem[store];
    const keyOf = (v) => (store === 'kv' ? v.k : v.id);
    const s = {
      getAll: () => ({ result: [...m.values()] }), get: (k) => ({ result: m.get(k) }),
      put: (v) => { m.set(keyOf(v), v); return { result: undefined }; },
      delete: (k) => { m.delete(k); return { result: undefined }; }, clear: () => { m.clear(); return { result: undefined }; },
    };
    const r = fn(s);
    return Promise.resolve(r ? r.result : undefined);
  }
  function tx(store, mode, fn) {
    if (mem) return memTx(store, fn);
    return open().catch(() => {
      mem = { tracks: new Map(), files: new Map(), waves: new Map(), kv: new Map() };
      Library.memoryOnly = true;
      return null;
    }).then((db) => (mem ? memTx(store, fn) : new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    })));
  }

  const Library = {
    open,
    allTracks: () => tx('tracks', 'readonly', (s) => s.getAll()).then((a) => a || []),
    getTrack: (id) => tx('tracks', 'readonly', (s) => s.get(id)),
    putTrack: (t) => tx('tracks', 'readwrite', (s) => s.put(t)),
    putFile: (id, blob) => tx('files', 'readwrite', (s) => s.put({ id, blob })),
    getFile: (id) => tx('files', 'readonly', (s) => s.get(id)).then((r) => r ? r.blob : null),
    putWave: (id, wave) => tx('waves', 'readwrite', (s) => s.put({ id, wave })),
    getWave: (id) => tx('waves', 'readonly', (s) => s.get(id)).then((r) => r ? r.wave : null),
    getKV: (k) => tx('kv', 'readonly', (s) => s.get(k)).then((r) => r ? r.v : undefined),
    setKV: (k, v) => tx('kv', 'readwrite', (s) => s.put({ k, v })),
    async deleteTrack(id) {
      await tx('tracks', 'readwrite', (s) => s.delete(id));
      await tx('files', 'readwrite', (s) => s.delete(id));
      await tx('waves', 'readwrite', (s) => s.delete(id));
    },
    async clearAll() {
      for (const st of ['tracks', 'files', 'waves']) await tx(st, 'readwrite', (s) => s.clear());
    },
    async estimate() {
      try { return await navigator.storage.estimate(); } catch (e) { return null; }
    },
    async persist() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* niente */ }
      return false;
    }
  };

  root.SolcoLibrary = Library;
})(typeof self !== 'undefined' ? self : this);
