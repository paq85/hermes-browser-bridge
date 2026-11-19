// Minimal animated-GIF encoder (GIF89a, one global 256-colour palette, LZW).
// frames: array of RGBA Uint8ClampedArray, all width x height.

function buildPalette(frames) {
  // Popularity over a 15-bit colour histogram: screenshots are dominated by a
  // few flat colours, so the most common ones give a clean result.
  const hist = new Uint32Array(32768);
  for (const px of frames) {
    for (let i = 0; i < px.length; i += 4) hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
  }
  const used = [];
  for (let c = 0; c < 32768; c++) if (hist[c]) used.push(c);
  used.sort((a, b) => hist[b] - hist[a]);
  const top = used.slice(0, 256);
  const palette = new Uint8Array(768);
  top.forEach((c, i) => {
    palette[i * 3] = ((c >> 10) & 31) << 3 | 4;
    palette[i * 3 + 1] = ((c >> 5) & 31) << 3 | 4;
    palette[i * 3 + 2] = (c & 31) << 3 | 4;
  });
  const lookup = new Int16Array(32768).fill(-1);
  top.forEach((c, i) => { lookup[c] = i; });
  const n = Math.max(top.length, 1);
  const nearest = (c) => {
    const r = ((c >> 10) & 31) << 3 | 4;
    const g = ((c >> 5) & 31) << 3 | 4;
    const b = (c & 31) << 3 | 4;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = r - palette[i * 3];
      const dg = g - palette[i * 3 + 1];
      const db = b - palette[i * 3 + 2];
      const d = dr * dr * 2 + dg * dg * 4 + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  return { palette, index: (c) => (lookup[c] >= 0 ? lookup[c] : (lookup[c] = nearest(c))) };
}

function lzw(indices, out) {
  const minCode = 8;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let next = eoi + 1;
  let dict = new Map();
  let cur = 0;
  let bits = 0;
  let block = [];
  const flushBlock = () => { if (block.length) { out.push(block.length, ...block); block = []; } };
  const emit = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block.push(cur & 255);
      if (block.length === 255) flushBlock();
      cur >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = dict.get(key);
    if (code !== undefined) { prefix = code; continue; }
    emit(prefix);
    if (next < 4096) {
      if (next >= (1 << codeSize)) codeSize++;
      dict.set(key, next++);
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) { block.push(cur & 255); }
  flushBlock();
  out.push(0);
}

export function encodeGif(frames, width, height, delayMs) {
  const { palette, index } = buildPalette(frames);
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  u16(width); u16(height);
  out.push(0xf7, 0, 0);
  for (let i = 0; i < 768; i++) out.push(palette[i]);
  out.push(0x21, 0xff, 11, ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
  const delay = Math.max(2, Math.round(delayMs / 10));
  const count = width * height;
  frames.forEach((px, f) => {
    out.push(0x21, 0xf9, 4, 0);
    u16(f === frames.length - 1 ? delay * 3 : delay); // hold the last frame longer
    out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    out.push(8);
    const idx = new Uint8Array(count);
    for (let i = 0, p = 0; i < count; i++, p += 4) idx[i] = index(((px[p] >> 3) << 10) | ((px[p + 1] >> 3) << 5) | (px[p + 2] >> 3));
    lzw(idx, out);
  });
  out.push(0x3b);
  return new Uint8Array(out);
}
