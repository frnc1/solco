/*
 * SOLCO — lettura dei file audio: tag (titolo, artista, copertina...) per
 * MP3 / AIFF / WAV / FLAC / M4A e decodifica degli AIFF (Chrome non li legge).
 */
'use strict';
(function (root) {

  const td = (enc) => { try { return new TextDecoder(enc); } catch (e) { return new TextDecoder('utf-8'); } };
  const DEC = { latin1: td('iso-8859-1'), u16le: td('utf-16le'), u16be: td('utf-16be'), u8: td('utf-8') };

  function str4(dv, o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); }
  function clean(s) { return (s || '').replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').trim(); }

  /* ---------------- ID3v2 ---------------- */
  function decodeText(bytes, enc) {
    if (!bytes.length) return '';
    if (enc === 0) return DEC.latin1.decode(bytes);
    if (enc === 3) return DEC.u8.decode(bytes);
    if (enc === 2) return DEC.u16be.decode(bytes);
    // UTF-16 con BOM
    if (bytes.length >= 2) {
      if (bytes[0] === 0xFF && bytes[1] === 0xFE) return DEC.u16le.decode(bytes.subarray(2));
      if (bytes[0] === 0xFE && bytes[1] === 0xFF) return DEC.u16be.decode(bytes.subarray(2));
    }
    return DEC.u16le.decode(bytes);
  }
  function findTerm(bytes, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
      return bytes.length;
    }
    for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return i;
    return bytes.length;
  }
  const syncsafe = (dv, o) => ((dv.getUint8(o) & 0x7f) << 21) | ((dv.getUint8(o + 1) & 0x7f) << 14) | ((dv.getUint8(o + 2) & 0x7f) << 7) | (dv.getUint8(o + 3) & 0x7f);

  function parseID3(buf, off, tags) {
    const dv = new DataView(buf);
    if (off + 10 > buf.byteLength || str4(dv, off).slice(0, 3) !== 'ID3') return 0;
    const ver = dv.getUint8(off + 3), flags = dv.getUint8(off + 5);
    const size = syncsafe(dv, off + 6);
    let p = off + 10;
    const end = Math.min(buf.byteLength, off + 10 + size);
    if (flags & 0x40) {
      const ext = ver === 4 ? syncsafe(dv, p) : dv.getUint32(p) + 4;
      p += ext;
    }
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    const map = ver === 2
      ? { TT2: 'title', TP1: 'artist', TAL: 'album', TCO: 'genre', TBP: 'bpm', TKE: 'key', TYE: 'year', TPB: 'label' }
      : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TBPM: 'bpm', TKEY: 'key', TYER: 'year', TDRC: 'year', TPUB: 'label', TIT3: 'mix' };
    while (p + hdr <= end) {
      let id = '';
      for (let i = 0; i < idLen; i++) id += String.fromCharCode(dv.getUint8(p + i));
      if (!/^[A-Z0-9]+$/.test(id)) break;
      let fs;
      if (ver === 2) fs = (dv.getUint8(p + 3) << 16) | (dv.getUint8(p + 4) << 8) | dv.getUint8(p + 5);
      else if (ver === 4) fs = syncsafe(dv, p + 4);
      else fs = dv.getUint32(p + 4);
      const ds = p + hdr;
      if (fs <= 0 || ds + fs > end) break;
      const data = new Uint8Array(buf, ds, fs);
      if (map[id] && data.length > 1) {
        const v = clean(decodeText(data.subarray(1), data[0]));
        if (v && !tags[map[id]]) tags[map[id]] = v;
      } else if ((id === 'APIC' || id === 'PIC') && !tags.artwork) {
        const enc = data[0];
        let q = 1, mime;
        if (id === 'PIC') { mime = 'image/' + DEC.latin1.decode(data.subarray(1, 4)).toLowerCase().replace('jpg', 'jpeg'); q = 4; }
        else { const t = findTerm(data, 1, 0); mime = DEC.latin1.decode(data.subarray(1, t)) || 'image/jpeg'; q = t + 1; }
        q += 1; // tipo immagine
        const t2 = findTerm(data, q, enc);
        q = t2 + ((enc === 1 || enc === 2) ? 2 : 1);
        if (q < data.length) tags.artwork = { mime: mime.indexOf('/') < 0 ? 'image/' + mime : mime, data: data.slice(q) };
      }
      p = ds + fs;
    }
    return 10 + size;
  }

  /* ---------------- FLAC ---------------- */
  function parseFLAC(buf, tags) {
    const dv = new DataView(buf);
    let p = 4;
    while (p + 4 <= buf.byteLength) {
      const h = dv.getUint8(p), type = h & 0x7f, last = h & 0x80;
      const len = (dv.getUint8(p + 1) << 16) | (dv.getUint8(p + 2) << 8) | dv.getUint8(p + 3);
      const s = p + 4;
      if (s + len > buf.byteLength) break;
      if (type === 4) {
        let q = s;
        const vlen = dv.getUint32(q, true); q += 4 + vlen;
        const count = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < count && q + 4 <= s + len; i++) {
          const cl = dv.getUint32(q, true); q += 4;
          const c = DEC.u8.decode(new Uint8Array(buf, q, cl)); q += cl;
          const eq = c.indexOf('=');
          if (eq < 0) continue;
          const k = c.slice(0, eq).toUpperCase(), v = c.slice(eq + 1).trim();
          const m = { TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', GENRE: 'genre', BPM: 'bpm', INITIALKEY: 'key', KEY: 'key', DATE: 'year', LABEL: 'label', ORGANIZATION: 'label' }[k];
          if (m && v && !tags[m]) tags[m] = v;
        }
      } else if (type === 6 && !tags.artwork) {
        let q = s + 4;
        const ml = dv.getUint32(q); q += 4;
        const mime = DEC.latin1.decode(new Uint8Array(buf, q, ml)); q += ml;
        const dl = dv.getUint32(q); q += 4 + dl + 16;
        const pl = dv.getUint32(q); q += 4;
        if (q + pl <= buf.byteLength) tags.artwork = { mime: mime || 'image/jpeg', data: new Uint8Array(buf.slice(q, q + pl)) };
      }
      p = s + len;
      if (last) break;
    }
  }

  /* ---------------- MP4 / M4A ---------------- */
  function parseMP4(buf, tags) {
    const dv = new DataView(buf);
    const walk = (start, end, depth) => {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = str4(dv, p + 4);
        let hdr = 8;
        if (size === 1) { size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < 8 || p + size > end) break;
        if (type === 'moov' || type === 'udta' || type === 'ilst') walk(p + hdr, p + size, depth + 1);
        else if (type === 'meta') walk(p + hdr + 4, p + size, depth + 1);
        else if (depth >= 2) {
          const key = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©gen': 'genre', '©day': 'year', 'covr': 'artwork', 'tmpo': 'bpm' }[type];
          if (key) {
            let q = p + hdr;
            while (q + 16 <= p + size) {
              const ds = dv.getUint32(q);
              if (str4(dv, q + 4) === 'data' && ds >= 16) {
                const kind = dv.getUint32(q + 8) & 0xffffff;
                const payload = new Uint8Array(buf, q + 16, ds - 16);
                if (key === 'artwork' && !tags.artwork) tags.artwork = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
                else if (key === 'bpm' && payload.length >= 2 && !tags.bpm) tags.bpm = String((payload[0] << 8) | payload[1]);
                else if (!tags[key]) tags[key] = clean(DEC.u8.decode(payload));
                break;
              }
              if (ds < 8) break;
              q += ds;
            }
          }
        }
        p += size;
      }
    };
    walk(0, buf.byteLength, 0);
  }

  /* ---------------- RIFF / AIFF ---------------- */
  function parseChunks(buf, little, start, cb) {
    const dv = new DataView(buf);
    let p = start;
    while (p + 8 <= buf.byteLength) {
      const id = str4(dv, p);
      const size = dv.getUint32(p + 4, little);
      cb(id, p + 8, Math.min(size, buf.byteLength - p - 8));
      p += 8 + size + (size & 1);
    }
  }

  function readTags(buf, fileName) {
    const tags = {};
    try {
      const dv = new DataView(buf);
      const head = buf.byteLength >= 12 ? str4(dv, 0) : '';
      if (head.slice(0, 3) === 'ID3') parseID3(buf, 0, tags);
      else if (head === 'fLaC') parseFLAC(buf, tags);
      else if (head === 'FORM') {
        parseChunks(buf, false, 12, (id, o) => { if (id === 'ID3 ' || id === 'id3 ') parseID3(buf, o, tags); });
      } else if (head === 'RIFF') {
        parseChunks(buf, true, 12, (id, o, size) => {
          if (id === 'id3 ' || id === 'ID3 ') parseID3(buf, o, tags);
          else if (id === 'LIST' && str4(dv, o) === 'INFO') {
            let p = o + 4;
            while (p + 8 <= o + size) {
              const k = str4(dv, p), sz = dv.getUint32(p + 4, true);
              const v = clean(DEC.latin1.decode(new Uint8Array(buf, p + 8, Math.min(sz, o + size - p - 8))));
              const m = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre' }[k];
              if (m && v && !tags[m]) tags[m] = v;
              p += 8 + sz + (sz & 1);
            }
          }
        });
      } else if (buf.byteLength > 12 && str4(dv, 4) === 'ftyp') parseMP4(buf, tags);
    } catch (e) { /* tag illeggibili: si usa il nome del file */ }
    // dal nome del file
    const base = (fileName || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const noNum = base.replace(/^\s*\d{1,3}\s*[-.)]?\s+/, '');
    const parts = noNum.split(/\s+[-–]\s+/);
    if (!tags.title) tags.title = parts.length > 1 ? parts.slice(1).join(' - ') : noNum;
    if (!tags.artist && parts.length > 1) tags.artist = parts[0];
    if (tags.bpm) { const b = parseFloat(String(tags.bpm).replace(',', '.')); tags.bpm = isFinite(b) && b > 40 && b < 260 ? b : undefined; }
    if (tags.year) tags.year = String(tags.year).slice(0, 4);
    return tags;
  }

  /* ---------------- AIFF -> PCM ---------------- */
  function readExt80(dv, o) {
    const se = dv.getUint16(o), sign = se & 0x8000 ? -1 : 1, exp = se & 0x7fff;
    const hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6);
    if (exp === 0 && hi === 0 && lo === 0) return 0;
    return sign * (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  }
  function isAiff(buf) {
    if (buf.byteLength < 12) return false;
    const dv = new DataView(buf);
    return str4(dv, 0) === 'FORM' && (str4(dv, 8) === 'AIFF' || str4(dv, 8) === 'AIFC');
  }
  function decodeAiff(buf) {
    const dv = new DataView(buf);
    const aifc = str4(dv, 8) === 'AIFC';
    let ch = 0, frames = 0, bits = 16, rate = 44100, comp = 'NONE', dataOff = -1;
    parseChunks(buf, false, 12, (id, o) => {
      if (id === 'COMM') {
        ch = dv.getInt16(o); frames = dv.getUint32(o + 2); bits = dv.getInt16(o + 6); rate = readExt80(dv, o + 8);
        if (aifc) comp = str4(dv, o + 18);
      } else if (id === 'SSND') {
        dataOff = o + 8 + dv.getUint32(o);
      }
    });
    if (!ch || dataOff < 0) throw new Error('AIFF non valido');
    const little = comp === 'sowt';
    const isFloat = comp === 'fl32' || comp === 'FL32';
    if (!little && !isFloat && comp !== 'NONE' && comp !== 'twos') throw new Error('Compressione AIFF non supportata: ' + comp);
    const bps = isFloat ? 4 : Math.ceil(bits / 8);
    frames = Math.min(frames, Math.floor((buf.byteLength - dataOff) / (bps * ch)));
    const out = [];
    for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));
    const u8 = new Uint8Array(buf);
    let p = dataOff;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) {
        let v;
        if (isFloat) v = dv.getFloat32(p, false);
        else if (bps === 2) v = dv.getInt16(p, little) / 32768;
        else if (bps === 3) {
          const b0 = little ? u8[p + 2] : u8[p], b1 = u8[p + 1], b2 = little ? u8[p] : u8[p + 2];
          let x = (b0 << 16) | (b1 << 8) | b2; if (x & 0x800000) x -= 0x1000000; v = x / 8388608;
        } else if (bps === 4) v = dv.getInt32(p, little) / 2147483648;
        else v = (dv.getInt8(p)) / 128;
        out[c][i] = v;
        p += bps;
      }
    }
    return { sampleRate: rate, channels: out };
  }

  root.SolcoMedia = { readTags, isAiff, decodeAiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SolcoMedia;
})(typeof self !== 'undefined' ? self : this);
