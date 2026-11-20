// Background copier for the ROM mirror (see openRomMirror in gaemboy3ds-worker.js).
// Picked files on Android cost ~200 ms per read regardless of size, so this worker copies the ROM
// into the origin private file system with large async reads, starting from the block the core
// asked for last. Copied blocks are published in a shared bitmap; the bitmap is also saved next
// to the copy so the next session resumes (or skips the copy entirely).
const CHUNK_BLOCKS = 8;
const MAP_SAVE_MS = 2000;

self.onmessage = async ({ data }) => {
  const { file, dir: dirName, key, control: sab, block } = data;
  const ctl = new Int32Array(sab);
  const total = ctl[3];
  const bits = ctl.subarray(4);
  const has = (i) => (Atomics.load(bits, i >> 5) >>> (i & 31)) & 1;
  let bin;
  let map;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName);
    bin = await (await dir.getFileHandle(`${key}.bin`)).createSyncAccessHandle({ mode: 'readwrite-unsafe' });
    map = await (await dir.getFileHandle(`${key}.map`, { create: true })).createSyncAccessHandle();
    const saveMap = () => {
      const header = new Float64Array([file.size]);
      map.truncate(0);
      map.write(new Uint8Array(header.buffer), { at: 0 });
      map.write(new Uint8Array(bits.slice().buffer), { at: 8 });
      map.flush();
    };
    const t0 = performance.now();
    let copiedBytes = 0;
    let lastSave = t0;
    let cursor = 0;
    let lastHint = 0;
    for (;;) {
      const hint = Atomics.load(ctl, 0);
      if (hint !== lastHint) cursor = lastHint = hint;
      let start = -1;
      for (let n = 0; n < total; n++) {
        const i = (cursor + n) % total;
        if (!has(i)) { start = i; break; }
      }
      if (start < 0) break;
      let end = start + 1;
      while (end < total && end - start < CHUNK_BLOCKS && !has(end)) end++;
      cursor = end;
      const from = start * block;
      const buf = new Uint8Array(await file.slice(from, Math.min(file.size, end * block)).arrayBuffer());
      bin.write(buf, { at: from });
      bin.flush();
      for (let i = start; i < end; i++) {
        if (!(Atomics.or(bits, i >> 5, 1 << (i & 31)) & (1 << (i & 31)))) Atomics.add(ctl, 1, 1);
      }
      copiedBytes += buf.length;
      if (performance.now() - lastSave >= MAP_SAVE_MS) {
        saveMap();
        lastSave = performance.now();
      }
    }
    saveMap();
    Atomics.store(ctl, 2, 1);
    const s = (performance.now() - t0) / 1000;
    self.postMessage({ type: 'done', line: `[gaemboy] copia locale della ROM completata: ` +
      `${(copiedBytes / 1048576).toFixed(0)} MB in ${s.toFixed(1)} s (${(copiedBytes / 1048576 / s).toFixed(1)} MB/s)` });
  } catch (err) {
    Atomics.store(ctl, 2, 2);
    self.postMessage({ type: 'done', line: `[gaemboy] copia locale della ROM interrotta: ${err?.name || ''} ${err?.message || err}` });
  } finally {
    try { bin?.close(); } catch {}
    try { map?.close(); } catch {}
  }
};
