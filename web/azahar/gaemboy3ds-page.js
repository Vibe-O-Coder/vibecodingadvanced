// Page side of the GAEMBOY 3DS web POC. The emulator runs in gaemboy3ds-worker.js (+ its pthreads);
// this page draws frames and writes input through the SharedState struct exported by
// gaemboy3ds_web.cpp (offsets below must match it), and plays audio through an AudioWorklet.
const OFF = {
  status: 0, frameSeq: 4, fbWidth: 8, fbHeight: 12, fbPtr: 16, throttle: 20, buttons: 24,
  pointerX: 28, pointerY: 32, pointerDown: 36, analogLX: 40, analogLY: 44, framesTotal: 48,
  audioFrames: 52, lastFrameMs: 56, avgFrameMs: 60, emuFps: 64, loadMs: 68, messageSeq: 72,
  message: 76, analogRX: 332, analogRY: 336, audioRingPtr: 340, audioRingFrames: 344,
  audioWrite: 348, audioRead: 352, audioDropped: 356,
};
import {
  forgetRootHandle, gamesFromFileList, loadRootHandle, metadataOf, openGame, saveRootHandle, scanDirectoryHandle,
} from './gaemboy3ds-library.js?v=26';
import { bindTouchControls } from './gaemboy3ds-touch.js?v=26';

const STATE_SIZE = 360;
const STATUS = ['avvio', 'caricamento…', 'in esecuzione', 'errore'];
const NATIVE_FPS = 59.83;
const AUDIO_HZ = 32728;
// libretro joypad ids: B0 Y1 Select2 Start3 Up4 Down5 Left6 Right7 A8 X9 L10 R11 ZL12 ZR13 Home14
const KEYMAP = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, KeyX: 8, KeyZ: 0, KeyS: 9, KeyA: 1,
  KeyQ: 10, KeyW: 11, KeyE: 12, KeyR: 13, Enter: 3, Backspace: 2,
};
// Analog sticks on the keyboard (libretro analog: Y grows downwards).
const STICK_KEYS = {
  KeyJ: ['analogLX', -1], KeyL: ['analogLX', 1], KeyI: ['analogLY', -1], KeyK: ['analogLY', 1],
  KeyF: ['analogRX', -1], KeyH: ['analogRX', 1], KeyT: ['analogRY', -1], KeyG: ['analogRY', 1],
};
// Standard Gamepad API layout mapped by position, Nintendo style (bottom = B, right = A, ...).
const PAD_BUTTONS = { 0: 0, 1: 8, 2: 1, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13, 8: 2, 9: 3, 12: 4, 13: 5, 14: 6, 15: 7, 16: 14 };
const PAD_DEADZONE = 0.15;
const AXES = ['analogLX', 'analogLY', 'analogRX', 'analogRY'];
const buttonKeys = Object.fromEntries(Object.entries(KEYMAP).map(([key, id]) => [id, key]));
const buttonPads = Object.fromEntries(Object.entries(PAD_BUTTONS).map(([index, id]) => [id, index]));
const buttonActions = ['B', 'Y', 'Select', 'Start', 'Cima', 'Baixo', 'Esquerda', 'Direita',
  'A', 'X', 'L', 'R', 'ZL', 'ZR', 'Home'].map((label, id) => ({
  id, label, key: buttonKeys[id], pad: [SiteControls.buttonInput(buttonPads[id])],
}));
const stickActions = Object.entries(STICK_KEYS).map(([key, [axis, direction]]) => {
  const index = AXES.indexOf(axis);
  const arrows = index % 2 ? ['↑', '↓'] : ['←', '→'];
  return {
    id: `${axis}:${direction}`, key, axis, direction,
    label: `${index < 2 ? 'Analógico esquerdo' : 'Analógico direito'} ${arrows[direction > 0 ? 1 : 0]}`,
    pad: [SiteControls.axisInputs(index)[direction > 0 ? 1 : 0]],
  };
});
const stickDirections = new Map(stickActions.map(action => [action.id, action]));

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const gameMenu = $('game-menu');
const touchControls = bindTouchControls($('touch-controls'));
const controls = SiteControls.create({
  id: 'azahar', actions: [...buttonActions, ...stickActions],
  button: [$('setup-controls'), $('game-controls')], clearInput: resetInput,
  focusGame: () => { if (!$('game-view').hidden) canvas.focus({ preventScroll: true }); },
});
const urlParams = new URLSearchParams(location.search);
// WebGL2 (GPU) everywhere, Safari included; ?sw forces the much slower software renderer.
const useSw = urlParams.has('sw');
const ctx = useSw ? canvas.getContext('2d') : null;
const logEl = $('log');
const bench = { startedAt: 0, frames: [] };
window.__gb3ds = bench;

// The log panel keeps the last lines only and is re-rendered at most twice a second.
const LOG_KEEP = 400;
const logLines = [];
// Larger history kept only for the "Scarica log" export (freeze reports).
const LOG_EXPORT_KEEP = 20000;
const logHistory = [];
let logDirty = false;
let logTotal = 0;
let logRate = { t: performance.now(), total: 0, perSec: 0 };
function log(line) {
  logHistory.push(`${(performance.now() / 1000).toFixed(3)} ${line}`);
  if (logHistory.length > LOG_EXPORT_KEEP) logHistory.splice(0, logHistory.length - LOG_EXPORT_KEEP);
  logLines.push(line);
  if (logLines.length > LOG_KEEP) logLines.splice(0, logLines.length - LOG_KEEP);
  logDirty = true;
}
setInterval(() => {
  if (!logDirty) return;
  logDirty = false;
  logEl.textContent = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}, 500);
// Italian hints for the core messages a user hits with real game dumps.
const HINTS = [
  [/encrypted/i, 'Il gioco è criptato: Azahar richiede un dump decrittato della tua cartuccia (es. GodMode9 → "Decrypt").'],
  [/obtain loader|not supported|invalid format/i, 'Formato non riconosciuto: usa .3ds/.cci/.cxi/.app decrittati o un homebrew .3dsx (i .cia vanno prima installati).'],
  [/GBA Virtual Console/i, 'I titoli GBA Virtual Console non sono supportati da Azahar.'],
  [/system archive/i, 'Il gioco richiede file di sistema del 3DS che non sono inclusi.'],
  [/ROM metadata/i, 'Il file non sembra un gioco 3DS valido (danneggiato, troncato o di un altro sistema).'],
];
function notice(text, kind = 'info') {
  const hint = HINTS.find(([re]) => re.test(text));
  if (hint) text = `${text} — ${hint[1]}`;
  $('notice').hidden = false;
  $('notice').className = kind;
  $('notice').textContent = text;
  if (gameMenu.open && kind === 'bad') $('menu-status').textContent = text;
}

if (useSw) {
  notice(`Renderer software forzato da ?sw: i giochi 3D pesanti girano molto più lenti. Per WebGL2 (GPU, consigliato) apri ${location.origin}${location.pathname}`, 'bad');
}
if (!crossOriginIsolated) {
  notice('La pagina non è cross-origin isolated (servono header COOP/COEP): i thread WASM non possono partire.', 'bad');
}

let worker = null;
let memory = null;
let base = 0;
let cameraBuffer = 0;
let storageAvailable = false;
let featureBusy = false;
let mediaBusy = false;
let slots = [];
let nextRequestId = 1;
const pendingRequests = new Map();
const i32 = () => new Int32Array(memory.buffer);
const f32 = () => new Float32Array(memory.buffer);
const u8 = () => new Uint8Array(memory.buffer);
const readI = (k) => Atomics.load(i32(), (base + OFF[k]) >> 2);
const writeI = (k, v) => Atomics.store(i32(), (base + OFF[k]) >> 2, v);
const readF = (k) => f32()[(base + OFF[k]) >> 2];

function featureMessage(message, error = false) {
  $('feature-status').textContent = message;
  $('feature-status').className = error ? 'bad' : 'good';
  if (error) log(`[funzioni] ${message}`);
}

function refreshFeatureControls() {
  const running = !!memory && readI('status') === 2;
  $('touch-controls').disabled = !running || gameMenu.open;
  $('back-library').disabled = featureBusy || mediaBusy;
  $('storage-actions').disabled = $('cheat-actions').disabled = !running || !storageAvailable || featureBusy;
  $('media-actions').disabled = !running || mediaBusy;
  const selected = slots.find((slot) => slot.slot === Number($('state-slot').value));
  $('state-save').disabled = !selected;
  $('state-load').disabled = $('state-delete').disabled = !selected?.exists;
  $('camera-facing').disabled = !!cameraStream;
}

function requestCommand(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({ type: 'command', id, action, ...data });
    } catch (err) {
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

function failRequests(message) {
  for (const { reject } of pendingRequests.values()) reject(new Error(message));
  pendingRequests.clear();
}

function renderSlots(items) {
  slots = items;
  for (const slot of items) {
    const option = $('state-slot').querySelector(`option[value="${slot.slot}"]`);
    option.textContent = slot.exists
      ? `Slot ${slot.slot} — ${new Date(slot.modified).toLocaleString()}`
      : `Slot ${slot.slot} — vuoto`;
  }
  refreshFeatureControls();
}

function renderCheats(items) {
  const list = $('cheat-list');
  list.replaceChildren();
  for (const [index, cheat] of items.entries()) {
    const item = document.createElement('div');
    item.className = 'cheat-item';
    const label = document.createElement('label');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = cheat.enabled;
    enabled.addEventListener('change', async () => {
      const result = await performFeature('toggle-cheat', { index, enabled: enabled.checked }, 'Cheat aggiornato.');
      if (!result) enabled.checked = cheat.enabled;
    });
    label.append(enabled, document.createTextNode(cheat.name));
    const code = document.createElement('pre');
    code.textContent = cheat.code;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'alt';
    remove.textContent = 'Elimina';
    remove.addEventListener('click', () => {
      if (confirm(`Eliminare il cheat "${cheat.name}"?`)) {
        performFeature('delete-cheat', { index }, 'Cheat eliminato.');
      }
    });
    item.append(label, code, remove);
    list.append(item);
  }
}

async function performFeature(action, data = {}, success = '') {
  featureBusy = true;
  refreshFeatureControls();
  try {
    const result = await requestCommand(action, data);
    if (result.slots) renderSlots(result.slots);
    if (result.cheats) renderCheats(result.cheats);
    if (success) featureMessage(success);
    return result;
  } catch (err) {
    let message = err.message || String(err);
    const refresh = action === 'save-state' || action === 'delete-state' ? 'slots' :
      action === 'add-cheat' || action === 'toggle-cheat' || action === 'delete-cheat' ? 'cheats' : null;
    if (refresh) {
      try {
        const current = await requestCommand(refresh);
        if (current.slots) renderSlots(current.slots);
        if (current.cheats) renderCheats(current.cheats);
      } catch (refreshError) {
        message += ` Impossibile aggiornare la lista: ${refreshError.message || refreshError}`;
      }
    }
    featureMessage(message, true);
    return null;
  } finally {
    featureBusy = false;
    refreshFeatureControls();
  }
}

async function initializeFeatures() {
  await performFeature('slots');
  await performFeature('cheats');
}

// ---------------------------------------------------------------- audio
let audioCtx = null;
let audioNode = null;
let audioOn = true;
async function ensureAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    await audioCtx.audioWorklet.addModule('./gaemboy3ds-audio.js');
    audioNode = new AudioWorkletNode(audioCtx, 'gaemboy3ds-audio', { outputChannelCount: [2] });
    audioNode.connect(audioCtx.destination);
    audioNode.port.postMessage({ type: 'mute', muted: !audioOn });
    if (memory) initAudio();
  } catch (err) {
    log(`[audio] non disponibile: ${err}`);
    audioCtx = null;
  }
}
function initAudio() {
  if (!audioNode || !memory) return;
  audioNode.port.postMessage({
    type: 'init', buffer: memory.buffer, state: base, srcRate: AUDIO_HZ,
    ringPtr: readI('audioRingPtr'), ringFrames: readI('audioRingFrames'),
  });
  audioCtx.resume();
}

// ---------------------------------------------------------------- boot
function boot(file) {
  if (worker) return;
  for (const id of ['demo', 'demo3d']) $(id).disabled = true;
  $('pick').disabled = true;
  $('rom-info').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · letto in locale, nessun upload`;
  log(`Avvio ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
  const t0 = performance.now();
  worker = new Worker('./gaemboy3ds-worker.js?v=26', { type: 'module' });
  $('selection-view').hidden = $('selection-footer').hidden = true;
  $('game-view').hidden = false;
  document.body.classList.add('playing');
  $('game-title').textContent = file.name;
  $('notice').hidden = true;
  $('game-status').textContent = 'Caricamento…';
  canvas.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  renderLibrary();
  worker.onerror = (e) => {
    watchdog.reported = true;
    const msg = `${e.message || 'errore sconosciuto'} (${e.filename || '?'}:${e.lineno || '?'})`;
    log(`[worker] ${msg}`);
    $('game-status').textContent = 'Errore: apri il Menu per cambiare gioco.';
    resetInput();
    $('touch-controls').disabled = true;
    notice(`Il worker dell'emulatore si è interrotto: ${msg}`, 'bad');
    failRequests(`Worker interrotto: ${msg}`);
  };
  worker.onmessageerror = () => {
    log('[worker] messaggio non deserializzabile');
    failRequests('Risposta del worker non leggibile.');
  };
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'logs':
        for (const line of data.lines) log(line);
        if (data.dropped) log(`… ${data.dropped} righe di log omesse`);
        logTotal = data.total;
        break;
      case 'error':
        $('game-status').textContent = 'Caricamento non riuscito: apri il Menu per cambiare gioco.';
        notice(`Errore nel caricamento del modulo: ${data.message}`, 'bad');
        log(`[errore] ${data.message}`);
        failRequests(data.message);
        break;
      case 'warning':
        featureMessage(data.message, true);
        break;
      case 'response': {
        const request = pendingRequests.get(data.id);
        if (!request) break;
        pendingRequests.delete(data.id);
        if (data.ok) request.resolve(data.result);
        else request.reject(new Error(data.error));
        break;
      }
      case 'perf':
        onPerf(data);
        break;
      case 'saved':
        $('s-saves').textContent = data.ok ? `ok ${new Date().toLocaleTimeString()}` : `errore: ${data.error}`;
        if (!data.ok) notice(`Impossibile conservare i salvataggi nel browser: ${data.error}`, 'bad');
        break;
      case 'ready':
        memory = data.memory;
        base = data.state;
        cameraBuffer = data.cameraBuffer;
        if (data.stateSize !== STATE_SIZE) {
          notice(`Struct condivisa incoerente (${data.stateSize} B, attesi ${STATE_SIZE}): ricompila.`, 'bad');
          return;
        }
        log(`Modulo WASM pronto in ${(performance.now() - t0).toFixed(0)} ms`);
        bench.startedAt = performance.now();
        for (const id of ['throttle', 'audio', 'save']) $(id).disabled = false;
        storageAvailable = !data.storageError;
        if (data.storageError) featureMessage(`Salvataggi non disponibili: ${data.storageError}`, true);
        refreshFeatureControls();
        if (storageAvailable && readI('status') === 2) initializeFeatures();
        initAudio();
        requestAnimationFrame(frame);
        setInterval(updateStats, 250);
        break;
      default:
        break;
    }
  };
  // ?args=a,b passes extra argv to the frontend (e.g. --io-selftest for large-file diagnostics).
  const extraArgs = (new URLSearchParams(location.search).get('args') || '').split(',').filter(Boolean);
  if (useSw) extraArgs.push('--sw');
  // ?cpu=NN underclocks the emulated CPU (Citra's classic fix for CPU-bound heavy games).
  const cpuClock = parseInt(new URLSearchParams(location.search).get('cpu'), 10);
  if (cpuClock >= 25 && cpuClock <= 400) {
    extraArgs.push(`--opt=citra_cpu_clock_percentage=${cpuClock}`);
    log(`[gaemboy] clock CPU emulata al ${cpuClock}%`);
  }
  // ?stream=ring restores the old ring-buffer upload path (default: orphan every upload).
  if (new URLSearchParams(location.search).get('stream') === 'ring') extraArgs.push('--stream=ring');
  // ?shaders=sync disables background shader linking (default: async, draws skipped until ready).
  if (new URLSearchParams(location.search).get('shaders') === 'sync') extraArgs.push('--shaders=sync');
  let offscreen = null;
  if (!useSw && canvas.transferControlToOffscreen) {
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch (err) {
      log(`[video] OffscreenCanvas non disponibile, uso software: ${err.message}`);
    }
  }
  // Ask to keep site storage (saves and the local ROM copy) from being evicted under pressure.
  navigator.storage?.persist?.().catch(() => {});
  if (offscreen) {
    worker.postMessage({ type: 'boot', file, extraArgs, canvas: offscreen }, [offscreen]);
  } else {
    if (!extraArgs.includes('--sw')) extraArgs.push('--sw');
    worker.postMessage({ type: 'boot', file, extraArgs });
  }
}

// ---------------------------------------------------------------- video + input loop
let lastSeq = 0;
let lastMsgSeq = 0;
let image = null;
let keyButtons = 0;
const keySticks = new Set();
let padName = '';

function readGamepad() {
  const [pad] = SiteControls.gamepads();
  if (!pad) {
    padName = '';
    return { buttons: 0, axes: [0, 0, 0, 0] };
  }
  padName = pad.id;
  let buttons = 0;
  for (const { id } of buttonActions) {
    if (controls.value(pad, id) > .5) buttons |= 1 << id;
  }
  const axes = AXES.map((axis) => {
    const v = controls.value(pad, `${axis}:1`) - controls.value(pad, `${axis}:-1`);
    return Math.abs(v) < PAD_DEADZONE ? 0 : v;
  });
  return { buttons, axes };
}

function frame() {
  const acceptingInput = !gameMenu.open && !controls.editing && !document.hidden && readI('status') === 2;
  const pad = acceptingInput ? readGamepad() : { buttons: 0, axes: [0, 0, 0, 0] };
  const touch = touchControls.read();
  writeI('buttons', acceptingInput ? keyButtons | pad.buttons | touch.buttons : 0);
  const key = { analogLX: 0, analogLY: 0, analogRX: 0, analogRY: 0 };
  for (const input of keySticks) {
    const { axis, direction } = stickDirections.get(input);
    key[axis] += direction;
  }
  const axis = (k, index) => writeI(k, acceptingInput
    ? Math.round(Math.max(-1, Math.min(1, key[k] || touch.axes[index] || pad.axes[index])) * 0x7fff) : 0);
  axis('analogLX', 0);
  axis('analogLY', 1);
  axis('analogRX', 2);
  axis('analogRY', 3);

  // video (in WebGL2 mode the worker draws directly onto the OffscreenCanvas)
  if (ctx) {
    const seq = readI('frameSeq');
    if (seq !== lastSeq) {
      lastSeq = seq;
      const w = readI('fbWidth');
      const h = readI('fbHeight');
      const ptr = readI('fbPtr');
      if (w > 0 && h > 0) {
        if (!image || image.width !== w || image.height !== h) {
          canvas.width = w;
          canvas.height = h;
          image = new ImageData(w, h);
        }
        image.data.set(u8().subarray(ptr, ptr + w * h * 4));
        ctx.putImageData(image, 0, 0);
      }
    }
  }
  requestAnimationFrame(frame);
}

function updateStats() {
  const status = readI('status');
  refreshFeatureControls();
  const frames = readI('framesTotal');
  const fps = readF('emuFps');
  const avgMs = readF('avgFrameMs');
  const audio = readI('audioFrames');
  const elapsed = (performance.now() - bench.startedAt) / 1000;
  const speed = (100 * fps) / NATIVE_FPS;
  const buffered = (readI('audioWrite') - readI('audioRead')) >>> 0;
  $('s-status').textContent = STATUS[status] ?? status;
  $('game-status').textContent = status === 2 ? (romCopyPct != null && romCopyPct < 100 ? `Prima partita: copia locale del gioco ${romCopyPct}%` : '') : status === 3 ? 'Errore: apri il Menu per cambiare gioco.' : 'Caricamento…';
  $('s-renderer').textContent = ctx ? 'Software (CPU)' : 'WebGL2 (GPU)';
  $('s-status').className = status === 2 ? 'good' : status === 3 ? 'bad' : 'mid';
  $('s-load').textContent = readF('loadMs') ? `${readF('loadMs').toFixed(0)} ms` : '—';
  $('s-frames').textContent = frames;
  $('s-fps').textContent = fps.toFixed(1);
  $('s-speed').textContent = `${speed.toFixed(0)}%`;
  $('s-speed').className = speed >= 95 ? 'good' : speed >= 60 ? 'mid' : 'bad';
  $('s-ms').textContent = `${avgMs.toFixed(1)} ms (budget 16,7)`;
  $('s-audio').textContent = audio
    ? `${(audio / AUDIO_HZ).toFixed(1)} s · buffer ${((1000 * buffered) / AUDIO_HZ).toFixed(0)} ms${audioOn ? '' : ' · muto'}`
    : `nessun campione${audioOn ? '' : ' · muto'}`;
  $('s-input').textContent = padName ? `tastiera + ${padName.slice(0, 28)}` : 'tastiera + touch';
  $('s-mem').textContent = `${navigator.hardwareConcurrency} core · ${(memory.buffer.byteLength / 1048576).toFixed(0)} MB`;
  const now = performance.now();
  if (now - logRate.t >= 2000) {
    logRate = { t: now, total: logTotal, perSec: ((logTotal - logRate.total) * 1000) / (now - logRate.t) };
  }
  $('s-log').textContent = `${logRate.perSec.toFixed(0)} righe/s`;
  $('s-log').className = logRate.perSec > 50 ? 'mid' : '';
  const msgSeq = readI('messageSeq');
  if (msgSeq !== lastMsgSeq) {
    lastMsgSeq = msgSeq;
    const bytes = u8().slice(base + OFF.message, base + OFF.message + 256);
    const msg = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
    log(`[core] ${msg}`);
    notice(msg, status === 3 || /encrypt|fail|error|unable|not supported/i.test(msg) ? 'bad' : 'info');
  }
  if (status === 3 && $('notice').hidden) notice('Il core non è riuscito a caricare il file (Menu → Avanzate).', 'bad');
  bench.frames.push({ t: elapsed, frames, fps, avgMs, audioSeconds: audio / AUDIO_HZ, status });
  if (bench.frames.length > 4000) bench.frames.splice(0, bench.frames.length - 4000);
  checkFreeze(status, frames, now);
}

// Watchdog: the stats above are read from shared memory, so they keep updating even when the
// emulator thread is stuck — a frame counter that stops while "running" means a freeze.
const watchdog = { frames: -1, since: 0, reported: false };
function checkFreeze(status, frames, now) {
  if (status !== 2 || frames !== watchdog.frames) {
    if (watchdog.reported && status === 2) {
      log(`[watchdog] l'emulazione è ripartita (frame ${frames})`);
      notice('L\'emulazione è ripartita.', 'info');
    }
    watchdog.frames = frames;
    watchdog.since = now;
    watchdog.reported = false;
    return;
  }
  if (!watchdog.reported && now - watchdog.since > 5000 && !document.hidden) {
    watchdog.reported = true;
    log(`[watchdog] nessun frame da ${((now - watchdog.since) / 1000).toFixed(1)} s (fermo a ${frames})`);
    notice(`L'emulazione sembra bloccata (frame fermi a ${frames}). Apri Menu → Avanzate per scaricare il log.`, 'bad');
  }
}

// Per-second breakdown sent by the worker (see gaemboy3ds-worker.js): kept for the log export.
const perfHistory = [];
let romCopyPct = null;
function onPerf(p) {
  const t = bench.startedAt ? (performance.now() - bench.startedAt) / 1000 : 0;
  perfHistory.push({ t: Math.round(t * 10) / 10, ...p });
  romCopyPct = p.romCopy;
  if (perfHistory.length > 900) perfHistory.splice(0, perfHistory.length - 900);
  const glTotal = Object.values(p.gl).reduce((a, b) => a + b, 0);
  const links = p.compiles.linkProgram || 0;
  const el = $('s-perf');
  el.textContent = `GL ${glTotal.toFixed(0)} ms/s · shader ${(p.gl.shader || 0).toFixed(0)} ms` +
    `${links ? ` (${links} link)` : ''} · file ${p.fileMs} ms` +
    `${p.romCopy != null && p.romCopy < 100 ? ` · copia ROM ${p.romCopy}%` : ''} · frame max ${p.tickMax} ms`;
  el.className = p.tickMax > 100 ? 'bad' : p.tickMax > 34 ? 'mid' : '';
  for (const l of p.long) log(`[perf] chiamata lenta: ${l}`);
}

function downloadLog() {
  const report = {
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    url: location.href,
    renderer: ctx ? 'software' : 'webgl2',
    rom: $('rom-info').textContent,
    notice: $('notice').hidden ? '' : $('notice').textContent,
    watchdog,
    stats: bench.frames.slice(-240),
    perf: perfHistory,
    logs: logHistory,
  };
  const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gaemboy3ds-log-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('dl-log').onclick = downloadLog;

// ---------------------------------------------------------------- local game library
// Chromium keeps a FileSystemDirectoryHandle (permission may be asked again after a reload);
// Safari/Firefox use <input webkitdirectory>, whose files must be selected again on each visit.
const LIB_META_KEY = 'gb3ds-library-meta';
const LIB_LAST_KEY = 'gb3ds-library-last';
const hasDirectoryPicker = typeof window.showDirectoryPicker === 'function';
let library = null; // { folderName, games, truncated, live }
let rootHandle = null;
let pendingGamePath = null; // game to launch once the folder is selected again (Safari/Firefox)

function libStatus(text, error = false) {
  $('lib-status').textContent = text;
  $('lib-status').className = error ? 'bad' : '';
}

function formatSize(bytes) {
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

function renderLibrary() {
  const list = $('lib-list');
  list.replaceChildren();
  $('library').hidden = !library && !rootHandle;
  $('lib-forget').disabled = !library && !rootHandle;
  $('lib-refresh').disabled = !library && !rootHandle;
  if (!library) return;
  $('lib-filter').hidden = library.games.length < 8;
  const query = $('lib-filter').value.trim().toLowerCase();
  const last = localStorage.getItem(LIB_LAST_KEY);
  for (const game of library.games) {
    if (query && !game.path.toLowerCase().includes(query)) continue;
    const item = document.createElement('li');
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Gioca';
    play.disabled = !!worker;
    if (!library.live) play.title = hasDirectoryPicker
      ? 'Chiede di nuovo il permesso di lettura e avvia il gioco'
      : 'Apre la scelta della cartella: conferma la stessa cartella e il gioco parte';
    play.onclick = () => (library.live ? launchGame(game) : reconnectAndLaunch(game));
    const label = document.createElement('span');
    label.className = 'game';
    label.textContent = game.path + (game.path === last ? '  · ultimo avviato' : '');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = formatSize(game.size);
    item.append(play, label, meta);
    list.append(item);
  }
}

function showLibrary(result, live) {
  library = { ...result, live };
  const count = result.games.length;
  const where = result.folderName ? `«${result.folderName}»` : 'la cartella';
  let text = count ? `${count} ${count === 1 ? 'gioco' : 'giochi'} in ${where}.` : `Nessun gioco 3DS trovato in ${where}.`;
  if (result.truncated) text += ' Elenco limitato ai primi 2000 file.';
  if (!live) {
    text += hasDirectoryPicker
      ? ' Premi «Riconnetti cartella» per leggerla di nuovo.'
      : ' Premi «Gioca» e conferma la stessa cartella.';
  }
  libStatus(text);
  try {
    localStorage.setItem(LIB_META_KEY, JSON.stringify(metadataOf(result)));
  } catch { /* metadata only: the library still works for this session */ }
  renderLibrary();
}

async function scanRoot(requestAccess) {
  if (!rootHandle) return;
  let permission = await rootHandle.queryPermission({ mode: 'read' });
  if (permission !== 'granted' && requestAccess) permission = await rootHandle.requestPermission({ mode: 'read' });
  if (permission !== 'granted') {
    $('lib-refresh').textContent = 'Riconnetti cartella';
    const saved = readSavedMetadata();
    if (saved) showLibrary(saved, false);
    else libStatus(`Cartella «${rootHandle.name}» memorizzata: premi «Riconnetti cartella» per leggerla.`);
    renderLibrary();
    return;
  }
  $('lib-refresh').textContent = 'Aggiorna';
  libStatus('Lettura della cartella…');
  showLibrary(await scanDirectoryHandle(rootHandle), true);
}

function readSavedMetadata() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIB_META_KEY) || 'null');
    return saved && Array.isArray(saved.games) ? saved : null;
  } catch {
    return null;
  }
}

// Browsers cannot reopen a folder without a user gesture, nor preselect its path in the dialog;
// the click on «Gioca» provides the gesture, and macOS usually opens the last used folder.
async function reconnectAndLaunch(game) {
  if (worker) return;
  ensureAudio();
  if (!hasDirectoryPicker) {
    pendingGamePath = game.path;
    libStatus(`Conferma la cartella «${library.folderName || 'dei giochi'}» per avviare «${game.name}».`);
    $('lib-dir').value = '';
    $('lib-dir').click();
    return;
  }
  if (!rootHandle) {
    await pickFolder();
  } else {
    try {
      await scanRoot(true);
    } catch (err) {
      libStatus(`Impossibile leggere la cartella: ${err.message}`, true);
      return;
    }
  }
  if (library?.live) launchFromLibrary(game.path, game.size);
}

function launchFromLibrary(path, size) {
  const candidates = library.games.filter((g) => g.path === path);
  const game = candidates.find((g) => g.size === size) || candidates[0];
  if (game) launchGame(game);
  else libStatus(`«${path}» non è presente nella cartella selezionata: scegli il gioco dall'elenco aggiornato.`, true);
}

async function pickFolder() {
  pendingGamePath = null;
  if (!hasDirectoryPicker) {
    $('lib-dir').value = '';
    $('lib-dir').click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'gb3ds-games', mode: 'read' });
    rootHandle = handle;
    try {
      await saveRootHandle(handle);
    } catch (err) {
      libStatus(`La cartella non potrà essere ricordata dopo il ricaricamento: ${err.message}`, true);
    }
    await scanRoot(true);
  } catch (err) {
    if (err.name !== 'AbortError') libStatus(`Impossibile leggere la cartella: ${err.message}`, true);
  }
}

async function launchGame(game) {
  if (worker) return;
  ensureAudio();
  try {
    const file = await openGame(game);
    localStorage.setItem(LIB_LAST_KEY, game.path);
    boot(file);
  } catch (err) {
    const missing = err.name === 'NotFoundError' || err.name === 'NotReadableError';
    libStatus(missing
      ? `«${game.path}» non è più leggibile (spostato, rinominato o modificato): premi «${$('lib-refresh').textContent}».`
      : `Impossibile aprire «${game.path}»: ${err.message}`, true);
  }
}

$('lib-pick').onclick = pickFolder;
$('lib-dir').onchange = (e) => {
  const pending = pendingGamePath;
  pendingGamePath = null;
  if (!e.target.files.length) return;
  const previous = library?.games.find((g) => g.path === pending);
  $('lib-refresh').textContent = 'Aggiorna';
  showLibrary(gamesFromFileList(e.target.files), true);
  if (pending) launchFromLibrary(pending, previous?.size);
};
$('lib-dir').addEventListener('cancel', () => { pendingGamePath = null; });
$('lib-refresh').onclick = () => {
  if (rootHandle) scanRoot(true).catch((err) => libStatus(`Impossibile leggere la cartella: ${err.message}`, true));
  else pickFolder();
};
$('lib-forget').onclick = async () => {
  try {
    await forgetRootHandle();
  } catch { /* nothing stored */ }
  localStorage.removeItem(LIB_META_KEY);
  localStorage.removeItem(LIB_LAST_KEY);
  rootHandle = null;
  library = null;
  $('lib-dir').value = '';
  $('lib-refresh').textContent = 'Aggiorna';
  $('lib-filter').hidden = true;
  libStatus('Cartella dimenticata. I salvataggi nel browser non sono stati toccati.');
  renderLibrary();
};
$('lib-filter').oninput = renderLibrary;

(async function restoreLibrary() {
  if (!hasDirectoryPicker) {
    $('lib-refresh').textContent = 'Riseleziona cartella';
    const saved = readSavedMetadata();
    if (saved) showLibrary(saved, false);
    return;
  }
  try {
    rootHandle = (await loadRootHandle()) || null;
    await scanRoot(false);
  } catch (err) {
    libStatus(`Impossibile ripristinare la cartella: ${err.message}`, true);
  }
})();

// ---------------------------------------------------------------- UI
async function startDemo(name) {
  ensureAudio();
  try {
    const res = await fetch(`./homebrew/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    boot(new File([await res.blob()], name));
  } catch (err) {
    notice(`Impossibile aprire la demo ${name}: ${err.message}. Usa «Apri ROM».`, 'bad');
  }
}
$('demo').onclick = () => startDemo($('demo').dataset.file);
$('demo3d').onclick = () => startDemo($('demo3d').dataset.file);
// Hosted builds only ship redistributable demos: hide buttons whose file is not deployed.
function hideEmptyDemos() {
  const picker = document.querySelector('.demo-picker');
  if (picker && ['demo', 'demo3d'].every((id) => $(id).hidden)) picker.hidden = true;
}
for (const id of ['demo', 'demo3d']) {
  const hide = () => { $(id).hidden = true; hideEmptyDemos(); };
  fetch(`./homebrew/${$(id).dataset.file}`, { method: 'HEAD' })
    .then((r) => { if (!r.ok) hide(); })
    .catch(hide);
}
$('pick').onclick = () => $('file').click();
$('file').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  ensureAudio();
  boot(file);
};
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || worker) return;
  ensureAudio();
  boot(file);
});
$('throttle').onclick = () => {
  const next = readI('throttle') ? 0 : 1;
  writeI('throttle', next);
  $('throttle').textContent = next ? 'Velocità: 60 fps' : 'Velocità: massima';
};
$('audio').onclick = async () => {
  audioOn = !audioOn;
  await ensureAudio();
  if (audioNode) audioNode.port.postMessage({ type: 'mute', muted: !audioOn });
  if (audioCtx) audioCtx.resume();
  $('audio').textContent = audioOn ? 'Audio: on' : 'Audio: off';
};
$('save').onclick = () => worker && worker.postMessage({ type: 'sync' });
$('open-menu').onclick = () => {
  resetInput();
  gameMenu.showModal();
  refreshFeatureControls();
};
$('close-menu').onclick = () => gameMenu.close();
gameMenu.addEventListener('close', () => {
  resetInput();
  refreshFeatureControls();
  canvas.focus({ preventScroll: true });
});
$('back-library').onclick = async () => {
  if (!confirm('Tornare alla selezione giochi? I progressi non salvati nel gioco o in uno stato andranno persi.')) return;
  resetInput();
  if (storageAvailable) {
    const result = await performFeature('sync-saves');
    if (!result) return;
  }
  // A fresh document is required to recreate the worker and its transferred canvas.
  const url = new URL(location.href);
  url.searchParams.delete('demo');
  location.replace(url.href);
};

$('state-slot').onchange = refreshFeatureControls;
$('state-save').onclick = () => {
  const slot = slots.find((item) => item.slot === Number($('state-slot').value));
  if (slot?.exists && !confirm(`Sovrascrivere lo stato nello slot ${slot.slot}?`)) return;
  performFeature('save-state', { slot: Number($('state-slot').value) }, 'Stato salvato nel browser.');
};
$('state-load').onclick = () => {
  performFeature('load-state', { slot: Number($('state-slot').value) }, 'Stato caricato.');
};
$('state-delete').onclick = () => {
  const slot = Number($('state-slot').value);
  if (confirm(`Eliminare lo stato nello slot ${slot}?`)) {
    performFeature('delete-state', { slot }, 'Stato eliminato.');
  }
};
$('export-saves').onclick = async () => {
  const result = await performFeature('export-saves');
  if (!result) return;
  const url = URL.createObjectURL(result.archive);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gaemboy3ds-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  featureMessage(`Backup esportato: ${result.files} file.`);
};
$('cheat-add').onclick = async () => {
  const name = $('cheat-name').value.trim();
  const code = $('cheat-code').value.trim();
  if (!name || !code) {
    featureMessage('Inserisci il nome e il codice Gateway.', true);
    return;
  }
  const result = await performFeature('add-cheat', {
    name, code, enabled: $('cheat-enabled').checked,
  }, 'Cheat aggiunto.');
  if (result) {
    $('cheat-name').value = '';
    $('cheat-code').value = '';
    $('cheat-enabled').checked = false;
  }
};

// ---------------------------------------------------------------- microphone and camera
let microphoneStream = null;
let microphoneContext = null;
let microphoneNode = null;
let microphoneBuffer = null;
let cameraStream = null;
let cameraVideo = null;
let cameraTimer = null;
let pageActive = true;

function stopMicrophone() {
  if (microphoneBuffer) Atomics.store(new Int32Array(microphoneBuffer, 0, 3), 2, 0);
  if (worker) worker.postMessage({ type: 'microphone-buffer', buffer: null });
  if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
  if (microphoneNode) microphoneNode.disconnect();
  if (microphoneContext && microphoneContext.state !== 'closed') {
    microphoneContext.close().catch((err) => log(`[microfono] chiusura: ${err}`));
  }
  microphoneStream = microphoneContext = microphoneNode = microphoneBuffer = null;
  $('mic-toggle').textContent = 'Attiva microfono';
  $('mic-status').textContent = 'Disattivato';
}

async function startMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode || !window.SharedArrayBuffer) {
    throw new Error('Il browser non supporta la cattura audio richiesta.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  }, video: false });
  if (!pageActive) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Pagina chiusa.');
  }
  microphoneStream = stream;
  try {
    microphoneContext = new AudioContext({ latencyHint: 'interactive' });
    await microphoneContext.audioWorklet.addModule('./gaemboy3ds-microphone.js?v=26');
    if (!pageActive) throw new Error('Pagina chiusa.');
    microphoneBuffer = new SharedArrayBuffer(12 + 65536 * 2);
    microphoneNode = new AudioWorkletNode(microphoneContext, 'gaemboy3ds-microphone', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { buffer: microphoneBuffer },
    });
    const source = microphoneContext.createMediaStreamSource(stream);
    const silent = microphoneContext.createGain();
    silent.gain.value = 0;
    source.connect(microphoneNode).connect(silent).connect(microphoneContext.destination);
    worker.postMessage({ type: 'microphone-buffer', buffer: microphoneBuffer });
    await microphoneContext.resume();
    if (!pageActive || microphoneContext.state !== 'running') throw new Error('Acquisizione audio non avviata.');
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      stopMicrophone();
      featureMessage('Microfono scollegato.', true);
      refreshFeatureControls();
    }, { once: true });
    microphoneNode.addEventListener('processorerror', () => {
      stopMicrophone();
      featureMessage('Elaborazione del microfono interrotta.', true);
      refreshFeatureControls();
    }, { once: true });
    $('mic-toggle').textContent = 'Disattiva microfono';
    $('mic-status').textContent = 'Attivo';
  } catch (err) {
    stopMicrophone();
    throw err;
  }
}

function stopCamera() {
  if (cameraTimer) clearInterval(cameraTimer);
  if (memory && cameraBuffer) Atomics.store(new Int32Array(memory.buffer, cameraBuffer, 2), 1, 0);
  if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  if (cameraVideo) cameraVideo.srcObject = null;
  cameraStream = cameraVideo = cameraTimer = null;
  $('camera-toggle').textContent = 'Attiva fotocamera';
  $('camera-status').textContent = 'Disattivata';
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !cameraBuffer) {
    throw new Error('Il browser non supporta la cattura video richiesta.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: $('camera-facing').value }, width: { ideal: 320 }, height: { ideal: 240 } },
    audio: false,
  });
  if (!pageActive) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Pagina chiusa.');
  }
  cameraStream = stream;
  try {
    cameraVideo = document.createElement('video');
    cameraVideo.muted = true;
    cameraVideo.playsInline = true;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();
    if (!pageActive) throw new Error('Pagina chiusa.');
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = 320;
    frameCanvas.height = 240;
    const context = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Impossibile preparare i frame della fotocamera.');
    cameraTimer = setInterval(() => {
      try {
        if (!cameraVideo?.videoWidth) return;
        context.drawImage(cameraVideo, 0, 0, 320, 240);
        const pixels = context.getImageData(0, 0, 320, 240).data;
        const header = new Int32Array(memory.buffer, cameraBuffer, 2);
        if (Atomics.compareExchange(header, 0, 0, 1) !== 0) return;
        try {
          new Uint8Array(memory.buffer, cameraBuffer + 8, pixels.length).set(pixels);
          Atomics.store(header, 1, 1);
        } finally {
          Atomics.store(header, 0, 0);
        }
      } catch (err) {
        stopCamera();
        featureMessage(`Fotocamera interrotta: ${err.message || err}`, true);
        refreshFeatureControls();
      }
    }, 1000 / 30);
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stopCamera();
      featureMessage('Fotocamera scollegata.', true);
      refreshFeatureControls();
    }, { once: true });
    $('camera-toggle').textContent = 'Disattiva fotocamera';
    $('camera-status').textContent = 'Attiva';
  } catch (err) {
    stopCamera();
    throw err;
  }
}

async function toggleMedia(kind) {
  mediaBusy = true;
  refreshFeatureControls();
  try {
    if (kind === 'microfono') {
      if (microphoneStream) stopMicrophone();
      else await startMicrophone();
    } else {
      if (cameraStream) stopCamera();
      else await startCamera();
    }
  } catch (err) {
    featureMessage(`Impossibile attivare ${kind}: ${err.message || err}`, true);
  } finally {
    mediaBusy = false;
    refreshFeatureControls();
  }
}
$('mic-toggle').onclick = () => toggleMedia('microfono');
$('camera-toggle').onclick = () => toggleMedia('fotocamera');
addEventListener('pagehide', () => {
  resetInput();
  pageActive = false;
  stopMicrophone();
  stopCamera();
  if (worker) worker.postMessage({ type: 'sync' });
});

const isControl = (target) => target instanceof Element &&
  !!target.closest('input, textarea, select, button, summary, a, [contenteditable="true"]');
addEventListener('keydown', (e) => {
  if (!memory || gameMenu.open || controls.editing || readI('status') !== 2 || isControl(e.target)) return;
  const action = controls.keyAction(e.code);
  if (typeof action === 'number') { keyButtons |= 1 << action; e.preventDefault(); }
  if (typeof action === 'string') { keySticks.add(action); e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  const action = controls.keyAction(e.code);
  if (typeof action === 'number') { keyButtons &= ~(1 << action); if (!isControl(e.target)) e.preventDefault(); }
  if (typeof action === 'string') { keySticks.delete(action); if (!isControl(e.target)) e.preventDefault(); }
});
let screenPointer = null;
function resetInput() {
  keyButtons = 0;
  keySticks.clear();
  touchControls.reset();
  screenPointer = null;
  if (memory) {
    for (const key of ['buttons', 'analogLX', 'analogLY', 'analogRX', 'analogRY', 'pointerDown']) writeI(key, 0);
  }
}
addEventListener('blur', resetInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetInput();
});

// libretro pointer space is [-0x7fff, 0x7fff] over the whole output frame; the core maps it onto
// the bottom screen when it falls inside its rectangle. Works for mouse, pen and touch.
function pointer(e, down) {
  if (!memory || gameMenu.open || readI('status') !== 2) return;
  const r = canvas.getBoundingClientRect();
  const coordinate = (position, start, size) =>
    Math.round(Math.max(-1, Math.min(1, ((position - start) / size) * 2 - 1)) * 0x7fff);
  writeI('pointerX', coordinate(e.clientX, r.left, r.width));
  writeI('pointerY', coordinate(e.clientY, r.top, r.height));
  if (down !== undefined) writeI('pointerDown', down ? 1 : 0);
}
canvas.addEventListener('pointerdown', (e) => {
  if (screenPointer !== null || !memory || gameMenu.open || readI('status') !== 2) return;
  e.preventDefault();
  screenPointer = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  pointer(e, true);
});
canvas.addEventListener('pointermove', (e) => { if (screenPointer === e.pointerId) pointer(e); });
function releaseScreen(e) {
  if (screenPointer !== e.pointerId) return;
  if (memory) writeI('pointerDown', 0);
  screenPointer = null;
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, releaseScreen);

// iOS Safari: stop pinch/double-tap zoom, rubber-band scroll and long-press callouts while playing.
const playing = () => document.body.classList.contains('playing');
const insideMenu = (target) => target instanceof Element && !!target.closest('#game-menu');
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault());
}
document.addEventListener('touchmove', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
}, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (playing() && !insideMenu(e.target) && now - lastTouchEnd < 350) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
});
document.addEventListener('contextmenu', (e) => {
  if (playing() && !insideMenu(e.target)) e.preventDefault();
});
// iOS only lets audio start from a user gesture: resume on touch if it was suspended.
document.addEventListener('pointerdown', () => {
  if (audioOn && audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
}, { capture: true });

const params = new URLSearchParams(location.search);
if (params.has('mute')) { audioOn = false; $('audio').textContent = 'Audio: off'; }
if (params.get('demo') !== null) (params.get('demo') === '3d' ? $('demo3d') : $('demo')).click();
