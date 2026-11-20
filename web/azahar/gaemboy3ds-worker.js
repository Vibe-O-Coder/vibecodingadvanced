// Hosts the Emscripten module in a dedicated worker so the user's game file can be mounted with
// WORKERFS: the core reads it lazily (FileReaderSync on slices), nothing is copied into memory or
// uploaded anywhere. Saves live in IDBFS (IndexedDB) and are flushed periodically.
import createGaemboy3DS from './gaemboy3ds.js?v=26';
import { createSaveArchive } from './gaemboy3ds-archive.js?v=26';
const ASSET_VERSION = '26';

const SAVES = '/gaemboy/3ds/saves';
// libctru homebrew only start NDSP if sdmc:/3ds/dspfirm.cdc exists; Azahar's HLE DSP ignores
// its content, so an empty placeholder (no Nintendo code) is enough. Retail games don't need it.
const DSP_PLACEHOLDER = `${SAVES}/Azahar/sdmc/3ds/dspfirm.cdc`;
const SYNC_MS = 10000;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const SLOT_COUNT = 3;

const post = (type, data = {}, transfer) => self.postMessage({ type, ...data }, transfer);
let mod = null;
let gameKey = '';
let storageError = null;
let syncQueue = Promise.resolve();
let commandQueue = Promise.resolve();

// Core logs are batched: a game spamming warnings must not flood the page's main thread.
const LOG_MAX_PER_FLUSH = 200;
let logBuffer = [];
let logDropped = 0;
let logTotal = 0;
const logLine = (line) => {
  logTotal++;
  if (logBuffer.length < LOG_MAX_PER_FLUSH) logBuffer.push(line);
  else logDropped++;
};
setInterval(() => {
  if (!logBuffer.length && !logDropped) return;
  post('logs', { lines: logBuffer, dropped: logDropped, total: logTotal });
  logBuffer = [];
  logDropped = 0;
}, 250);

// ---------------------------------------------------------------- perf breakdown
// Lightweight per-second breakdown of where the emulator thread spends time: WebGL calls by
// category (shader compile/link stalls surface in the blocking calls or the first draw with a new
// program), lazy reads of the game file and the duration of each frame tick. Single calls over
// LONG_CALL_MS are reported by name so freezes can be attributed.
const LONG_CALL_MS = 25;
const PNAME = { 0x91B1: 'COMPLETION_STATUS', 0x8B82: 'LINK_STATUS', 0x8B81: 'COMPILE_STATUS', 0x8B84: 'INFO_LOG_LENGTH',
  0x8B86: 'ACTIVE_UNIFORMS', 0x8B89: 'ACTIVE_ATTRIBUTES', 0x8A36: 'ACTIVE_UNIFORM_BLOCKS' };
const GL_CATEGORY = {
  shader: ['createShader', 'shaderSource', 'compileShader', 'attachShader', 'createProgram', 'linkProgram',
    'getProgramParameter', 'getShaderParameter', 'getProgramInfoLog', 'getShaderInfoLog', 'deleteShader',
    'deleteProgram', 'detachShader', 'bindAttribLocation', 'getUniformLocation', 'getUniformBlockIndex',
    'uniformBlockBinding', 'getAttribLocation', 'useProgram', 'getActiveUniform', 'getActiveAttrib'],
  draw: ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear',
    'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi'],
  upload: ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'texStorage2D', 'texImage3D',
    'texSubImage3D', 'compressedTexImage2D', 'copyTexSubImage2D', 'copyBufferSubData', 'generateMipmap'],
  sync: ['readPixels', 'getError', 'finish', 'flush', 'fenceSync', 'clientWaitSync', 'getSyncParameter',
    'getBufferSubData', 'checkFramebufferStatus', 'getParameter'],
  fbo: ['blitFramebuffer', 'framebufferTexture2D', 'framebufferRenderbuffer', 'bindFramebuffer',
    'invalidateFramebuffer', 'createFramebuffer', 'createTexture', 'deleteTexture', 'renderbufferStorage'],
};
const perf = { gl: {}, glCount: {}, file: 0, fileBytes: 0, fileCalls: 0, fileHits: 0, mirrorHits: 0, ticks: 0, tickMs: 0, tickMax: 0, long: [] };
const resetPerf = () => {
  perf.gl = {}; perf.glCount = {};
  perf.file = perf.fileBytes = perf.fileCalls = perf.fileHits = perf.mirrorHits = perf.ticks = perf.tickMs = perf.tickMax = 0;
  perf.long = [];
};
const noteLong = (name, dt) => { if (perf.long.length < 20) perf.long.push(`${name} ${dt.toFixed(0)}ms`); };
function instrumentGL() {
  const P = self.WebGL2RenderingContext && WebGL2RenderingContext.prototype;
  if (!P) return;
  const cat = {};
  for (const [c, names] of Object.entries(GL_CATEGORY)) for (const n of names) cat[n] = c;
  for (const name of Object.getOwnPropertyNames(P)) {
    const d = Object.getOwnPropertyDescriptor(P, name);
    if (!d || typeof d.value !== 'function' || name === 'constructor') continue;
    const fn = d.value;
    const c = cat[name] || 'other';
    P[name] = function (...args) {
      const t0 = performance.now();
      const r = fn.apply(this, args);
      const dt = performance.now() - t0;
      perf.gl[c] = (perf.gl[c] || 0) + dt;
      if (c === 'shader' && (name === 'linkProgram' || name === 'compileShader')) {
        perf.glCount[name] = (perf.glCount[name] || 0) + 1;
      }
      const pname = (name === 'getProgramParameter' || name === 'getShaderParameter') ? args[1] : 0;
      if (pname === 0x91B1) {
        // COMPLETION_STATUS_KHR: shows whether the browser really links in the background.
        const k = r ? 'completionDone' : 'completionPending';
        perf.glCount[k] = (perf.glCount[k] || 0) + 1;
      }
      if (dt > LONG_CALL_MS) noteLong(pname ? `${name}(${PNAME[pname] || '0x' + pname.toString(16)})` : name, dt);
      return r;
    };
  }
}
function instrumentFileReads() {
  if (!self.FileReaderSync) return;
  const P = FileReaderSync.prototype;
  const fn = P.readAsArrayBuffer;
  // iOS Safari occasionally fails a read of a large picked file with NotReadableError (the file
  // provider is momentarily busy); a failed read would abort the core, so retry with a short
  // blocking backoff before giving up with an actionable message.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const RETRY_MS = [20, 50, 100, 200, 400, 800];
  P.readAsArrayBuffer = function (blob) {
    const t0 = performance.now();
    let r;
    for (let attempt = 0; ; attempt++) {
      try {
        r = fn.call(this, blob);
        if (attempt) noteLong(`fileRead riuscita dopo ${attempt} tentativi`, performance.now() - t0);
        break;
      } catch (err) {
        if (err?.name !== 'NotReadableError' || attempt >= RETRY_MS.length) {
          if (err?.name === 'NotReadableError') {
            throw new Error('Safari non riesce più a leggere il file del gioco (NotReadableError). ' +
              'Ricarica la pagina e riapri il gioco; se succede spesso copia la ROM in «Sul mio iPhone».');
          }
          throw err;
        }
        Atomics.wait(sleeper, 0, 0, RETRY_MS[attempt]);
      }
    }
    const dt = performance.now() - t0;
    perf.file += dt;
    perf.fileCalls++;
    perf.fileBytes += blob.size || 0;
    if (dt > LONG_CALL_MS) noteLong(`fileRead ${((blob.size || 0) / 1024).toFixed(0)}KB`, dt);
    return r;
  };
}
// Picked files on Android (and sometimes iOS) cost ~80 ms per FileReaderSync call regardless of
// size, so the core's many small reads stalled whole frames. Read the ROM in aligned 1 MB blocks
// and keep the most recent ones (LRU) so nearby reads are served from memory.
const ROM_BLOCK = 1 << 20;
const ROM_CACHE_BLOCKS = 64;
// Large ROMs are also mirrored into the origin private file system (OPFS), whose synchronous
// reads take ~1 ms: a helper worker copies the picked file in the background and the copy is kept
// for the next sessions. Needs concurrent sync handles (Chrome 121+); elsewhere a mirror is only
// used once it is complete, otherwise reads keep going to the picked file.
const MIRROR_DIR = 'gaemboy-rom-mirror';
const MIRROR_MIN_SIZE = 32 << 20;
let romMirror = null;
async function openRomMirror(file, key) {
  if (file.size < MIRROR_MIN_SIZE || !navigator.storage?.getDirectory || !self.FileSystemSyncAccessHandle) return null;
  const concurrent = 'mode' in FileSystemSyncAccessHandle.prototype;
  const total = Math.ceil(file.size / ROM_BLOCK);
  const control = new SharedArrayBuffer(16 + 4 * Math.ceil(total / 32));
  const ctl = new Int32Array(control);
  const bits = ctl.subarray(4);
  ctl[3] = total;
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(MIRROR_DIR, { create: true });
  try {
    const saved = await (await (await dir.getFileHandle(`${key}.map`)).getFile()).arrayBuffer();
    if (saved.byteLength === 8 + bits.byteLength && new Float64Array(saved, 0, 1)[0] === file.size) {
      bits.set(new Int32Array(saved, 8));
    }
  } catch { /* no saved progress */ }
  for (let i = 0; i < total; i++) if ((bits[i >> 5] >>> (i & 31)) & 1) ctl[1]++;
  const complete = ctl[1] === total;
  if (!complete && !concurrent) return null;
  if (!complete && !(await makeRoomForMirror(dir, key, file.size))) {
    logLine('[gaemboy] spazio insufficiente per la copia locale della ROM');
    return null;
  }
  const handle = await (await dir.getFileHandle(`${key}.bin`, { create: true }))
    .createSyncAccessHandle(concurrent ? { mode: 'readwrite-unsafe' } : undefined);
  if (handle.getSize() !== file.size) handle.truncate(file.size);
  const mirror = {
    file, handle, ctl, bits, total, writable: concurrent,
    has: (i) => (Atomics.load(bits, i >> 5) >>> (i & 31)) & 1,
    mark(i) {
      if (!(Atomics.or(bits, i >> 5, 1 << (i & 31)) & (1 << (i & 31)))) Atomics.add(ctl, 1, 1);
    },
  };
  if (complete) {
    ctl[2] = 1;
    logLine('[gaemboy] ROM letta dalla copia locale (nessuna lettura lenta dal file)');
  } else {
    logLine(`[gaemboy] avvio copia locale della ROM (${ctl[1]}/${total} MB già copiati)`);
    const copier = new Worker(new URL(`gaemboy3ds-rommirror.js?v=${ASSET_VERSION}`, self.location));
    copier.onmessage = ({ data }) => { logLine(data.line); copier.terminate(); };
    copier.onerror = (e) => { logLine(`[gaemboy] copia locale della ROM fallita: ${e.message}`); Atomics.store(ctl, 2, 2); };
    copier.postMessage({ file, dir: MIRROR_DIR, key, control, block: ROM_BLOCK });
  }
  return mirror;
}
// Keeps the mirror directory within quota by deleting the least recently used other mirrors.
async function makeRoomForMirror(dir, key, size) {
  const others = [];
  for await (const [name, entry] of dir.entries()) {
    const k = name.replace(/\.(bin|map)$/, '');
    if (k === key || entry.kind !== 'file') continue;
    const f = await entry.getFile();
    let o = others.find((x) => x.key === k);
    if (!o) others.push((o = { key: k, bytes: 0, used: 0 }));
    o.bytes += f.size;
    o.used = Math.max(o.used, f.lastModified);
  }
  others.sort((a, b) => a.used - b.used);
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  let free = quota - usage;
  const need = size + (64 << 20);
  while (free < need && others.length) {
    const o = others.shift();
    for (const ext of ['bin', 'map']) await dir.removeEntry(`${o.key}.${ext}`).catch(() => {});
    free += o.bytes;
    logLine(`[gaemboy] rimossa una vecchia copia locale (${(o.bytes / 1048576).toFixed(0)} MB)`);
  }
  return free >= need;
}
function cacheWorkerfsReads(WORKERFS) {
  const ops = WORKERFS.stream_ops;
  if (ops.__gbCached) return;
  ops.__gbCached = true;
  const caches = new WeakMap();
  const block = (blob, index) => {
    let cache = caches.get(blob);
    if (!cache) caches.set(blob, (cache = new Map()));
    let data = cache.get(index);
    if (data) {
      cache.delete(index);
      perf.fileHits++;
    } else {
      const start = index * ROM_BLOCK;
      const end = Math.min(blob.size, start + ROM_BLOCK);
      const mirror = romMirror?.file === blob ? romMirror : null;
      if (mirror?.has(index)) {
        data = new Uint8Array(end - start);
        mirror.handle.read(data, { at: start });
        perf.mirrorHits++;
      } else {
        if (mirror) Atomics.store(mirror.ctl, 0, index + 1);
        data = new Uint8Array(WORKERFS.reader.readAsArrayBuffer(blob.slice(start, end)));
        if (mirror?.writable) {
          try {
            mirror.handle.write(data, { at: start });
            mirror.mark(index);
          } catch { /* the background copy will fill it */ }
        }
      }
      if (cache.size >= ROM_CACHE_BLOCKS) cache.delete(cache.keys().next().value);
    }
    cache.set(index, data);
    return data;
  };
  ops.read = (stream, buffer, offset, length, position) => {
    const blob = stream.node.contents;
    if (position >= blob.size) return 0;
    const end = Math.min(blob.size, position + length);
    let pos = position;
    while (pos < end) {
      const index = Math.floor(pos / ROM_BLOCK);
      const data = block(blob, index);
      const from = pos - index * ROM_BLOCK;
      const n = Math.min(data.length - from, end - pos);
      buffer.set(data.subarray(from, from + n), offset + (pos - position));
      pos += n;
    }
    return end - position;
  };
}
// The frontend schedules each frame through self.__gb3ds_mc (MessageChannel); wrap its handler
// once it exists to time whole ticks (emulation + GL submission + throttle wait).
function instrumentTicks() {
  const mc = self.__gb3ds_mc;
  if (!mc || mc.__gbWrapped) return;
  const handler = mc.port1.onmessage;
  if (!handler) return;
  mc.__gbWrapped = true;
  mc.port1.onmessage = (e) => {
    const t0 = performance.now();
    handler(e);
    const dt = performance.now() - t0;
    perf.ticks++;
    perf.tickMs += dt;
    if (dt > perf.tickMax) perf.tickMax = dt;
    if (performance.now() - lastPerfFlush >= 1000) flushPerf();
  };
}
instrumentGL();
instrumentFileReads();
let lastPerfFlush = performance.now();
function flushPerf() {
  lastPerfFlush = performance.now();
  const gl = {};
  for (const [k, v] of Object.entries(perf.gl)) gl[k] = Math.round(v * 10) / 10;
  post('perf', {
    ticks: perf.ticks,
    tickMs: Math.round(perf.tickMs),
    tickMax: Math.round(perf.tickMax),
    gl,
    compiles: perf.glCount,
    fileMs: Math.round(perf.file),
    fileKB: Math.round(perf.fileBytes / 1024),
    fileCalls: perf.fileCalls,
    fileHits: perf.fileHits,
    mirrorHits: perf.mirrorHits,
    romCopy: romMirror ? Math.floor((100 * Atomics.load(romMirror.ctl, 1)) / romMirror.total) : null,
    long: perf.long,
  });
  resetPerf();
}
// Safari can starve worker timers while the frame loop saturates the MessageChannel, so the
// tick wrapper also flushes; the interval covers idle periods and installs the tick wrapper.
setInterval(() => {
  instrumentTicks();
  if (performance.now() - lastPerfFlush >= 1000) flushPerf();
}, 1000);

function syncSaves(reason) {
  const run = async () => {
    try {
      if (!mod || storageError) throw new Error(storageError || 'Emulatore non disponibile.');
      await new Promise((resolve, reject) => {
        mod.FS.syncfs(false, (err) => err ? reject(err) : resolve());
      });
      post('saved', { ok: true, reason });
    } catch (err) {
      post('saved', { ok: false, reason, error: String(err) });
      throw err;
    }
  };
  syncQueue = syncQueue.then(run, run);
  return syncQueue;
}

function ensurePath(FS, dir) {
  let cur = '';
  for (const part of dir.split('/').filter(Boolean)) {
    cur += `/${part}`;
    if (!FS.analyzePath(cur).exists) FS.mkdir(cur);
    if (!FS.isDir(FS.stat(cur).mode)) throw new Error(`Non è una cartella: ${cur}`);
  }
}

async function fingerprint(file) {
  const sampleSize = Math.min(file.size, 128 * 1024);
  const positions = file.size <= sampleSize
    ? [0]
    : Array.from({ length: 9 }, (_, i) => Math.floor((file.size - sampleSize) * i / 8));
  const samples = await Promise.all(positions.map((start) => file.slice(start, start + sampleSize).arrayBuffer()));
  const bytes = new Uint8Array(8 + samples.reduce((size, sample) => size + sample.byteLength, 0));
  new DataView(bytes.buffer).setBigUint64(0, BigInt(file.size), true);
  let offset = 8;
  for (const sample of samples) {
    bytes.set(new Uint8Array(sample), offset);
    offset += sample.byteLength;
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function callWithStrings(strings, callback) {
  const pointers = [];
  try {
    for (const text of strings) {
      const bytes = new TextEncoder().encode(text);
      const pointer = mod._malloc(bytes.length + 1);
      if (!pointer) throw new Error('Memoria insufficiente.');
      pointers.push(pointer);
      const heap = new Uint8Array(mod.wasmMemory.buffer);
      heap.set(bytes, pointer);
      heap[pointer + bytes.length] = 0;
    }
    return callback(...pointers);
  } finally {
    for (const pointer of pointers) mod._free(pointer);
  }
}

const stateDir = () => `${SAVES}/web-states/${gameKey}`;
const cheatPath = () => `${SAVES}/web-cheats/${gameKey}.json`;
function slotPath(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) throw new Error('Slot non valido.');
  return `${stateDir()}/slot-${slot}.gb3dsstate`;
}

function listSlots() {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const slot = index + 1;
    const path = slotPath(slot);
    if (!mod.FS.analyzePath(path).exists) return { slot, exists: false };
    const stat = mod.FS.stat(path);
    return { slot, exists: true, size: stat.size, modified: stat.mtime.getTime() };
  });
}

function listCheats() {
  const count = mod._gb3ds_cheat_count();
  if (count < 0) throw new Error('Gioco non in esecuzione.');
  return Array.from({ length: count }, (_, index) => ({
    name: mod.UTF8ToString(mod._gb3ds_cheat_name(index)),
    code: mod.UTF8ToString(mod._gb3ds_cheat_code(index)),
    enabled: !!mod._gb3ds_cheat_enabled(index),
  }));
}

function addCheat(cheat, validateOnly = false) {
  if (!cheat || typeof cheat.name !== 'string' || typeof cheat.code !== 'string' ||
      typeof cheat.enabled !== 'boolean' || cheat.name.length > 128 ||
      cheat.code.length > 65536 || !cheat.name.trim()) {
    throw new Error('Nome o codice cheat non valido.');
  }
  const ok = callWithStrings([cheat.name, cheat.code], (name, code) =>
    mod._gb3ds_cheat_add(name, code, validateOnly ? -1 : Number(cheat.enabled)));
  if (!ok) throw new Error(`Codice Gateway non valido: ${cheat.name}.`);
}

function restoreCheats() {
  const path = cheatPath();
  if (!mod.FS.analyzePath(path).exists) return;
  const data = JSON.parse(mod.FS.readFile(path, { encoding: 'utf8' }));
  if (data.version !== 1 || data.gameKey !== gameKey || !Array.isArray(data.cheats) ||
      data.cheats.length > 256) throw new Error('Il file dei cheat non è valido.');
  for (const cheat of data.cheats) addCheat(cheat, true);
  mod._gb3ds_cheat_clear();
  for (const cheat of data.cheats) addCheat(cheat);
}

async function persistCheats() {
  const path = cheatPath();
  try {
    ensurePath(mod.FS, path.slice(0, path.lastIndexOf('/')));
    const temporary = `${path}.tmp`;
    mod.FS.writeFile(temporary, JSON.stringify({ version: 1, gameKey, cheats: listCheats() }, null, 2));
    mod.FS.rename(temporary, path);
    await syncSaves('cheat');
  } catch (err) {
    throw new Error(`Cheat applicati, ma non salvati nel browser: ${err}`);
  }
}

function collectBackupEntries() {
  const entries = [];
  let bytes = 0;
  const excluded = new Set([
    'web-shader-cache-v1.bin', 'web-shader-cache-v1.bin.tmp',
    'Azahar/shaders', 'Azahar/cache', 'Azahar/log',
  ]);
  function visit(relative) {
    if (excluded.has(relative)) return;
    const absolute = relative ? `${SAVES}/${relative}` : SAVES;
    const stat = mod.FS.lstat(absolute);
    if (mod.FS.isLink(stat.mode)) throw new Error(`Link simbolico non esportabile: ${relative}`);
    if (mod.FS.isDir(stat.mode)) {
      for (const name of mod.FS.readdir(absolute)) {
        if (name !== '.' && name !== '..') visit(relative ? `${relative}/${name}` : name);
      }
    } else if (mod.FS.isFile(stat.mode)) {
      if (relative.endsWith('.tmp')) return;
      bytes += stat.size;
      if (bytes > MAX_BACKUP_BYTES) throw new Error('Backup oltre il limite di 512 MB.');
      if (entries.length >= 65535) throw new Error('Troppi file nel backup.');
      entries.push({ name: relative, data: mod.FS.readFile(absolute), modified: stat.mtime });
    } else {
      throw new Error(`Tipo di file non esportabile: ${relative}`);
    }
  }
  visit('');
  return entries;
}

async function command(action, data) {
  if (!mod) throw new Error('Emulatore non ancora pronto.');
  if (storageError) throw new Error(`Salvataggi non disponibili: ${storageError}`);
  switch (action) {
    case 'sync-saves':
      await syncSaves('cambio gioco');
      return {};
    case 'slots':
      return { slots: listSlots() };
    case 'save-state': {
      const path = slotPath(data.slot);
      ensurePath(mod.FS, stateDir());
      const temporary = `${path}.tmp`;
      const ok = callWithStrings([temporary], (name) => mod._gb3ds_save_state_file(name));
      if (!ok) {
        if (mod.FS.analyzePath(temporary).exists) mod.FS.unlink(temporary);
        throw new Error('Il core non è riuscito a creare lo stato. Controlla il log.');
      }
      mod.FS.rename(temporary, path);
      try {
        await syncSaves('save state');
      } catch (err) {
        throw new Error(`Stato creato, ma non salvato nel browser: ${err}`);
      }
      return { slots: listSlots() };
    }
    case 'load-state': {
      const path = slotPath(data.slot);
      if (!mod.FS.analyzePath(path).exists) throw new Error('Slot vuoto.');
      const ok = callWithStrings([path], (name) => mod._gb3ds_load_state_file(name));
      if (!ok) throw new Error('Stato incompatibile o danneggiato. Controlla il log.');
      return { slots: listSlots() };
    }
    case 'delete-state': {
      const path = slotPath(data.slot);
      if (!mod.FS.analyzePath(path).exists) throw new Error('Slot vuoto.');
      mod.FS.unlink(path);
      try {
        await syncSaves('eliminazione stato');
      } catch (err) {
        throw new Error(`Stato eliminato nella sessione, ma non nel browser: ${err}`);
      }
      return { slots: listSlots() };
    }
    case 'cheats':
      return { cheats: listCheats() };
    case 'add-cheat':
      if (mod._gb3ds_cheat_count() >= 256) throw new Error('Limite di 256 cheat raggiunto.');
      addCheat({ name: data.name.trim(), code: data.code, enabled: !!data.enabled });
      await persistCheats();
      return { cheats: listCheats() };
    case 'toggle-cheat':
      if (!mod._gb3ds_cheat_set_enabled(data.index, Number(!!data.enabled))) {
        throw new Error('Cheat non trovato.');
      }
      await persistCheats();
      return { cheats: listCheats() };
    case 'delete-cheat':
      if (!mod._gb3ds_cheat_remove(data.index)) throw new Error('Cheat non trovato.');
      await persistCheats();
      return { cheats: listCheats() };
    case 'export-saves': {
      await syncSaves('backup');
      const entries = collectBackupEntries();
      return { archive: createSaveArchive(entries), files: entries.length };
    }
    default:
      throw new Error(`Operazione sconosciuta: ${action}`);
  }
}


// iOS Safari sometimes cannot reserve the 1 GB shared WebAssembly memory right away (memory
// pressure from other tabs or a just-closed session); the allocation fails before any module
// side effect, so wait and retry before reporting a clear error.
const MEMORY_RETRY_MS = [300, 700, 1500, 3000];
async function createWithMemoryRetry(options) {
  for (let attempt = 0; ; attempt++) {
    try {
      const m = await createGaemboy3DS(options);
      if (attempt) logLine(`[gaemboy] memoria allocata al tentativo ${attempt + 1}`);
      return m;
    } catch (err) {
      const isMemory = err instanceof RangeError || /\bMemory\b|out of memory/i.test(String(err?.stack || err));
      if (!isMemory) throw err;
      if (attempt >= MEMORY_RETRY_MS.length) {
        throw new Error('Safari non ha concesso la memoria necessaria (1 GB). Chiudi le altre schede, ' +
          'chiudi e riapri Safari, poi riprova.');
      }
      logLine(`[gaemboy] allocazione memoria fallita, nuovo tentativo tra ${MEMORY_RETRY_MS[attempt]} ms`);
      await new Promise((r) => setTimeout(r, MEMORY_RETRY_MS[attempt]));
    }
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'sync') {
    syncSaves('richiesta').catch((err) => logLine(`[gaemboy] sincronizzazione fallita: ${err}`));
    return;
  }
  if (data.type === 'microphone-buffer') {
    self.__gb3dsMic = data.buffer ? {
      control: new Int32Array(data.buffer, 0, 3),
      samples: new Int16Array(data.buffer, 12),
    } : null;
    if (self.__gb3dsMic && mod) {
      Atomics.store(self.__gb3dsMic.control, 2, mod._gb3ds_microphone_active());
    }
    return;
  }
  if (data.type === 'command') {
    const run = async () => {
      try {
        const result = await command(data.action, data);
        post('response', { id: data.id, ok: true, result });
      } catch (err) {
        post('response', { id: data.id, ok: false, error: String(err.message || err) });
      }
    };
    commandQueue = commandQueue.then(run, run);
    return;
  }
  if (data.type !== 'boot' || mod) return;
  const file = data.file;
  const romName = file.name.replace(/[^\w.\- ]/g, '_');
  try {
    gameKey = await fingerprint(file);
    try {
      romMirror = await openRomMirror(file, gameKey);
    } catch (err) {
      logLine(`[gaemboy] copia locale della ROM non disponibile: ${err?.name || ''} ${err?.message || err}`);
    }
    mod = await createWithMemoryRetry({
      canvas: data.canvas || undefined,
      locateFile: (path, prefix) =>
        path.endsWith('.wasm') ? `${prefix}${path}?v=${ASSET_VERSION}` : `${prefix}${path}`,
      arguments: [`/rom/${romName}`, ...(data.extraArgs || [])],
      print: logLine,
      printErr: logLine,
      preRun: [(m) => {
        const { FS } = m;
        FS.mkdir('/rom');
        FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name: romName, data: file }] }, '/rom');
        cacheWorkerfsReads(FS.filesystems.WORKERFS);
        ensurePath(FS, SAVES);
        FS.mount(FS.filesystems.IDBFS, {}, SAVES);
        m.addRunDependency('gb3ds-idbfs');
        FS.syncfs(true, (err) => {
          if (err) {
            storageError = String(err);
            logLine(`[gaemboy] IDBFS non disponibile: ${err}`);
          }
          if (data.dspPlaceholder !== false) {
            try {
              FS.stat(DSP_PLACEHOLDER);
            } catch {
              ensurePath(FS, DSP_PLACEHOLDER.slice(0, DSP_PLACEHOLDER.lastIndexOf('/')));
              FS.writeFile(DSP_PLACEHOLDER, new Uint8Array(0x400));
            }
          }
          m.removeRunDependency('gb3ds-idbfs');
        });
      }],
    });
    post('ready', {
      memory: mod.wasmMemory,
      state: mod._gb3ds_state(),
      stateSize: mod._gb3ds_state_size(),
      cameraBuffer: mod._gb3ds_camera_buffer(),
      storageError,
      romName,
      romSize: file.size,
    });
    if (!storageError && Atomics.load(new Int32Array(mod.wasmMemory.buffer), mod._gb3ds_state() >> 2) === 2) {
      try {
        restoreCheats();
      } catch (err) {
        post('warning', { message: `Impossibile ripristinare i cheat: ${err.message || err}` });
      }
    }
    setInterval(() => {
      syncSaves('periodico').catch((err) => logLine(`[gaemboy] sincronizzazione fallita: ${err}`));
    }, SYNC_MS);
  } catch (err) {
    post('error', { message: err?.message ? `${err.name}: ${err.message}\n${err.stack || ''}`.trim() : String(err) });
  }
};
