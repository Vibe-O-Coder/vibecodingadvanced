// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const FRAME_MS = 1000 * 280896 / 16777216;
const SAVE_ACTION = Object.freeze({
  batteryOut: 0, batteryIn: 1, stateOut: 2, stateIn: 3, png: 4, bmp: 5,
  legacyIn: 6, gsvIn: 7, legacyOut: 8, eepromOut: 9, eepromIn: 10,
  cheatsOut: 11, cheatsIn: 12
});
const BUTTON_BITS = Object.freeze({ A: 1, B: 2, Select: 4, Start: 8,
  Right: 16, Left: 32, Up: 64, Down: 128, R: 256, L: 512 });
const BUTTON_NAMES = Object.freeze({
  Up: "Cima", Left: "Esquerda", Down: "Baixo", Right: "Direita",
  A: "A", B: "B", L: "L", R: "R", Start: "Start", Select: "Select"
});

const DEFAULT_KEYS = Object.freeze({
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  A: "KeyX", B: "KeyZ", L: "KeyA", R: "KeyS", Start: "Enter", Select: "Backspace"
});
const DEFAULT_PAD = Object.freeze({
  A: 0, B: 1, L: 4, R: 5, Select: 8, Start: 9, Up: 12, Down: 13, Left: 14, Right: 15
});
const PREFS_KEY = "vba-web-prefs-v1";
const DEFAULT_PREFS = Object.freeze({
  speed: "1", turbo: "4", scale: "fit", filter: "0", blend: "0", color: "0", mono: "0",
  frameskip: "0", volume: "65", touch: "auto", gamepad: "-1", mute: false,
  turboA: false, turboB: false, autoPause: true, rewind: true,
  stateBattery: false, printer: false, agbPrint: false, cheats: true,
  board: "0", saveType: "0", flash: "0", rtc: "-1", mirror: "-1", border: true, skipBios: true,
  sun: "0", tiltX: "2047", tiltY: "2047", gyro: "0", layers: 0xff00, channels: 0x30f,
  keys: DEFAULT_KEYS, pad: DEFAULT_PAD
});

function getPrefs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  // Migração: versões antigas silenciavam o som em qualquer velocidade diferente de 1×.
  // A propriedade legada não é mais utilizada nem preservada.
  delete saved.fastMute;
  return {
    ...DEFAULT_PREFS, ...saved,
    keys: { ...DEFAULT_KEYS, ...saved?.keys },
    pad: { ...DEFAULT_PAD, ...saved?.pad }
  };
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage can be disabled */ }
}

class VbaCore {
  constructor(module) {
    this.m = module;
    this.open = module.cwrap("vba_open", "number", [
      "number", "number", "number", "number", "string",
      "number", "number", "number", "number", "number", "number"
    ]);
    this.fileIO = module.cwrap("vba_io", "number", ["number", "string", "number"]);
    this.patchROM = module.cwrap("vba_patch", "number", ["number", "number", "string"]);
    this.addCheat = module.cwrap("vba_cheat_add", "number", ["number", "string", "string"]);
    this.cheatText = module.cwrap("vba_cheat_text", "string", ["number", "number"]);
    this.message = module.cwrap("vba_message", "string", []);
    this.agbLog = module.cwrap("vba_agb_log", "string", []);
  }

  reason(fallback) {
    const message = this.message();
    return message ? fallback + " (" + message + ")" : fallback;
  }

  withHeap(length, operation) {
    const pointer = this.m._malloc(length);
    if (!pointer) throw new Error("Memória insuficiente para abrir o arquivo.");
    try {
      return operation(pointer);
    } finally {
      this.m._free(pointer);
    }
  }

  withBytes(bytes, operation) {
    return this.withHeap(bytes.length, pointer => {
      this.m.HEAPU8.set(bytes, pointer);
      return operation(pointer);
    });
  }

  remove(path) {
    if (this.m.FS.analyzePath(path).exists) this.m.FS.unlink(path);
  }

  boot(game, prefs, bios) {
    const path = "/vba-bios.bin";
    if (bios) this.m.FS.writeFile(path, bios.bytes);
    try {
      const loaded = this.withBytes(game.bytes, pointer => this.open(
        pointer, game.bytes.length, game.type, Number(prefs.board), bios ? path : "",
        +prefs.skipBios, Number(prefs.saveType), Number(prefs.rtc),
        Number(prefs.flash), Number(prefs.mirror), +prefs.border
      ));
      if (!loaded) throw new Error(this.reason("O núcleo recusou o cartucho."));
    } finally {
      this.remove(path);
    }
  }

  io(action, bytes, flag = 0) {
    const path = "/vba-transfer.bin";
    this.remove(path);
    try {
      if (bytes) this.m.FS.writeFile(path, bytes);
      if (!this.fileIO(action, path, flag)) return null;
      if (bytes) return true;
      if (!this.m.FS.analyzePath(path).exists) return null;
      const result = this.m.FS.readFile(path);
      return result.length ? result : null;
    } finally {
      this.remove(path);
    }
  }

  patch(rom, patch, extension) {
    const path = "/vba-patch." + extension;
    try {
      this.m.FS.writeFile(path, patch);
      const size = this.withBytes(rom, pointer => this.patchROM(pointer, rom.length, path));
      if (!size) throw new Error("O patch foi rejeitado. Verifique o formato, a versão e a região da ROM.");
      const start = this.m._vba_patched_data();
      return this.m.HEAPU8.slice(start, start + size);
    } finally {
      this.m._vba_clear_patch();
      this.remove(path);
    }
  }

  memory(address, count) {
    return this.withHeap(count, pointer => {
      const actual = this.m._vba_memory(address, pointer, count);
      return this.m.HEAPU8.slice(pointer, pointer + actual);
    });
  }

  instructions(address, mode, limit) {
    return this.withHeap(512, pointer => {
      const result = [];
      for (let index = 0; index < limit; index++) {
        this.m.HEAPU8[pointer] = 0;
        const width = this.m._vba_inst(address, mode, pointer, 512);
        if (width <= 0) break;
        result.push(this.m.UTF8ToString(pointer, 512));
        address = (address + width) >>> 0;
      }
      return result;
    });
  }
}

class VbaEmulator extends EventTarget {
  constructor(canvas, prefs, vault, sound) {
    super();
    this.canvas = canvas;
    this.g = canvas.getContext("2d", { alpha: false });
    this.prefs = prefs;
    this.vault = vault;
    this.sound = sound;
    this.core = null;
    this.game = null;
    this.slots = new Array(10);
    this.history = [];
    this.historySize = 0;
    this.lastHistoryAt = -Infinity;
    this.pressedKeys = new Set();
    this.pointers = new Map();
    this.consideredGamepad = null;
    this.fast = false;
    this.running = false;
    this.busy = false;
    this.prevTimestamp = null;
    this.elapsed = 0;
    this.prevSpeed = 1;
    this.frameNumber = 0;
    this.fps = 0;
    this.lastFpsCount = 0;
    this.lastFpsAt = null;
    this.lastSaveAt = 0;
    this.battery = null;
    this.batteryDirty = false;
    this.printSerial = 0;
    this.frameWidth = 240;
    this.frameHeight = 160;
    this.drawn = false;
    this.frameData = null;
    this.raf = 0;
    this.ready = (typeof CreateVBAM === "function" ? CreateVBAM() :
      Promise.reject(new Error("O arquivo do núcleo VBA-M não foi encontrado.")))
      .then(module => { this.core = new VbaCore(module); })
      .catch(error => { this.startupError = error; });
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  fault(error) {
    this.emit("fault", error instanceof Error ? error.message : String(error));
  }

  get speed() {
    return this.fast ? Math.max(Number(this.prefs.turbo), Number(this.prefs.speed)) : Number(this.prefs.speed);
  }

  async open(game) {
    await this.ready;
    if (this.startupError) throw this.startupError;
    const board = Number(this.prefs.board);
    const biosType = game.type !== 2 ? "gba" : board === 1 || board === 4 ||
      (board === 0 && game.gbc) ? "gbc" : "gb";
    this.pause();
    this.flushBattery();
    const batteryKey = "battery:" + game.id;
    const results = await Promise.all([
      this.vault.read("bios:" + biosType),
      this.vault.read(batteryKey),
      this.vault.read("cheats:" + game.id),
      Promise.all(Array.from({ length: 10 }, (_, i) => this.vault.read("state:" + game.id + ":" + i)))
    ]);
    const [bios, battery, cheats, slots] = results;
    this.game = null;
    this.drawn = false;
    this.clearHistory();
    try {
      this.core.boot(game, this.prefs, bios);
    } catch (error) {
      this.emit("game");
      throw error;
    }
    this.game = game;
    this.frameNumber = 0;
    this.lastFpsCount = 0;
    this.lastFpsAt = null;
    this.fps = 0;
    this.frameData = null;
    this.slots = Array.from({ length: 10 }, (_, i) => slots?.[i]);
    this.batteryDirty = false;
    this.printSerial = this.m._vba_print_serial();
    this.applyPrefs();
    let restored = false;
    if (battery?.bytes) {
      restored = !!this.core.io(SAVE_ACTION.batteryIn, battery.bytes);
      if (!restored) this.fault("O save local não pôde ser restaurado. Confira o tipo de memória do cartucho.");
    }
    if (cheats && !this.core.io(SAVE_ACTION.cheatsIn, cheats)) {
      this.fault("A lista local de trapaças não pôde ser restaurada.");
    }
    this.battery = this.core.io(SAVE_ACTION.batteryOut);
    this.m._vba_save_pending();
    this.emit("battery", { persisted: this.vault.canStoreBattery(batteryKey), restored });
    this.emit("game");
    if (bios && !this.m._vba_bios_used()) {
      this.fault("A BIOS selecionada não foi aceita pelo núcleo. O cartucho abriu com a BIOS interna.");
    }
    this.draw();
    this.resume();
  }

  get m() { return this.core.m; }

  close() {
    if (!this.game) return;
    this.pause();
    this.flushBattery();
    this.m._vba_close();
    this.game = null;
    this.drawn = false;
    this.battery = null;
    this.slots = new Array(10);
    this.clearHistory();
    this.emit("game");
  }

  applyPrefs() {
    this.sound.setVolume(Number(this.prefs.volume) / 100, this.prefs.mute);
    if (!this.prefs.rewind) this.clearHistory();
    if (!this.game) return;
    this.m._vba_config(Number(this.prefs.frameskip), this.prefs.layers, Number(this.prefs.color),
      Number(this.prefs.mono), this.prefs.channels, +this.prefs.printer, +this.prefs.agbPrint, +this.prefs.cheats);
    this.updateSensors();
  }

  updateSensors() {
    if (this.game) this.m._vba_sensors(Number(this.prefs.tiltX), Number(this.prefs.tiltY),
      Number(this.prefs.gyro), Number(this.prefs.sun));
  }

  resetTiming() {
    this.prevTimestamp = null;
    this.elapsed = 0;
    this.sound.clear();
  }

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resetTiming();
    this.emit("mode");
  }

  resume() {
    if (!this.game || this.running) return;
    this.running = true;
    this.resetTiming();
    this.fps = 0;
    this.lastFpsAt = null;
    this.raf = requestAnimationFrame(time => this.tick(time));
    this.emit("mode");
  }

  clearInput() {
    this.pressedKeys.clear();
    this.pointers.clear();
    this.fast = false;
  }

  input() {
    let bits = 0;
    for (const name in BUTTON_BITS) {
      if (this.pressedKeys.has(this.prefs.keys[name])) bits |= BUTTON_BITS[name];
    }
    for (const name of this.pointers.values()) bits |= BUTTON_BITS[name];
    let gamepads = [];
    try { gamepads = navigator.getGamepads?.() ?? []; } catch { /* permissions policy can disable gamepads */ }
    const configured = Number(this.prefs.gamepad);
    const pad = configured === -1 ? [...gamepads].find(candidate => candidate?.connected) : gamepads[configured];
    this.consideredGamepad = pad;
    if (pad?.connected) {
      for (const name in BUTTON_BITS) {
        if (pad.buttons[this.prefs.pad[name]]?.pressed) bits |= BUTTON_BITS[name];
      }
      if (pad.axes[0] < -.5) bits |= BUTTON_BITS.Left;
      if (pad.axes[0] > .5) bits |= BUTTON_BITS.Right;
      if (pad.axes[1] < -.5) bits |= BUTTON_BITS.Up;
      if (pad.axes[1] > .5) bits |= BUTTON_BITS.Down;
    }
    return bits;
  }

  runFrame(speed, buttons) {
    // Turbo A/B precisa seguir quadros emulados, não a taxa de atualização do monitor.
    if (this.frameNumber % 6 >= 3) {
      if (this.prefs.turboA) buttons &= ~BUTTON_BITS.A;
      if (this.prefs.turboB) buttons &= ~BUTTON_BITS.B;
    }
    const rendered = this.m._vba_run(buttons);
    const count = this.m._vba_audio_size();
    if (count) {
      const start = this.m._vba_audio() >> 1;
      const chunk = this.m.HEAP16.subarray(start, start + count);
      this.sound.push(chunk, speed, !this.running);
    }
    const serial = this.m._vba_print_serial();
    if (serial !== this.printSerial) {
      this.printSerial = serial;
      this.emit("printing");
    }
    this.frameNumber++;
    this.batteryDirty = !!this.m._vba_save_pending() || this.batteryDirty;
    return rendered;
  }

  tick(timestamp) {
    this.raf = 0;
    if (!this.running || !this.game) return;
    const speed = this.speed;
    if (this.prevSpeed !== speed) {
      this.sound.clear();
      this.prevSpeed = speed;
    }
    if (this.busy) {
      this.prevTimestamp = null;
      this.raf = requestAnimationFrame(time => this.tick(time));
      return;
    }
    const elapsed = this.prevTimestamp === null ? FRAME_MS : Math.min(100, timestamp - this.prevTimestamp);
    this.prevTimestamp = timestamp;
    this.elapsed = Math.min(this.elapsed + elapsed * speed, FRAME_MS * 28);
    let rendered = false;
    try {
      let budget = 28;
      // Leitura do teclado e Gamepad API uma única vez por atualização visual.
      // Em 10×, antes eram até 28 consultas ao gamepad em um mesmo tick.
      const buttons = this.input();
      while (this.elapsed + .005 >= FRAME_MS && budget-- > 0) {
        rendered = this.runFrame(speed, buttons) || rendered;
        this.elapsed -= FRAME_MS;
        if (this.prefs.rewind && this.frameNumber % 60 === 0 && timestamp - this.lastHistoryAt >= 750) {
          this.keepHistory();
          this.lastHistoryAt = timestamp;
        }
      }
      if (rendered) {
        this.draw();
        this.rumble();
      }
      this.updateStats(timestamp);
      if (timestamp - this.lastSaveAt > 2200) {
        this.lastSaveAt = timestamp;
        if (this.batteryDirty || this.game.type === 2) this.flushBattery();
      }
    } catch (error) {
      this.pause();
      this.fault(this.core.reason("A emulação foi interrompida") + " " + error.message);
      return;
    }
    this.raf = requestAnimationFrame(time => this.tick(time));
  }

  updateStats(timestamp) {
    if (this.lastFpsAt === null) {
      this.lastFpsAt = timestamp;
      this.lastFpsCount = this.frameNumber;
    } else if (timestamp - this.lastFpsAt >= 650) {
      this.fps = Math.round((this.frameNumber - this.lastFpsCount) * 1000 / (timestamp - this.lastFpsAt));
      this.lastFpsAt = timestamp;
      this.lastFpsCount = this.frameNumber;
      this.emit("stats");
    }
  }

  rumble() {
    const actuator = this.consideredGamepad?.vibrationActuator;
    const now = performance.now();
    if (actuator?.playEffect && this.m._vba_rumble() && (!this.lastRumbleAt || now - this.lastRumbleAt > 100)) {
      this.lastRumbleAt = now;
      actuator.playEffect("dual-rumble", {
        duration: 110, strongMagnitude: .36, weakMagnitude: .25
      }).catch(() => {});
    }
  }

  draw() {
    if (!this.game) return;
    const filter = Math.max(0, Number(this.prefs.filter));
    const scale = this.m._vba_filter_scale(filter);
    const width = this.m._vba_width();
    const height = this.m._vba_height();
    const video = this.m._vba_display(filter, Number(this.prefs.blend));
    if (!video) return;
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;
    const sizeChange = width !== this.frameWidth || height !== this.frameHeight;
    const firstDraw = !this.drawn;
    if (!this.frameData || scaledWidth !== this.canvas.width || scaledHeight !== this.canvas.height) {
      this.canvas.width = scaledWidth;
      this.canvas.height = scaledHeight;
      this.frameData = this.g.createImageData(scaledWidth, scaledHeight);
    }
    this.frameData.data.set(this.m.HEAPU8.subarray(video, video + scaledWidth * scaledHeight * 4));
    this.g.putImageData(this.frameData, 0, 0);
    this.frameWidth = width;
    this.frameHeight = height;
    this.drawn = true;
    if (firstDraw || sizeChange) this.emit("resolution");
  }

  step(instruction = false) {
    if (!this.game) return;
    this.pause();
    if (instruction) {
      this.m._vba_step_instruction();
    } else {
      this.m._vba_config(0, this.prefs.layers, Number(this.prefs.color), Number(this.prefs.mono),
        this.prefs.channels, +this.prefs.printer, +this.prefs.agbPrint, +this.prefs.cheats);
      try { this.runFrame(1, this.input()); } finally { this.applyPrefs(); }
    }
    this.draw();
  }

  reset() {
    if (!this.game) return;
    this.flushBattery();
    this.m._vba_reset();
    this.clearHistory();
    this.resetTiming();
    this.frameNumber = 0;
    this.applyPrefs();
    this.draw();
  }

  flushBattery(force = false) {
    if (!this.game) return;
    const rom = this.game;
    const bytes = this.core.io(SAVE_ACTION.batteryOut);
    this.batteryDirty = false;
    if (!bytes || (!force && sameBytes(bytes, this.battery))) return;
    this.battery = bytes;
    this.vault.write("battery:" + rom.id, { bytes, updated: Date.now() }).then(persisted => {
      if (this.game === rom && this.battery === bytes) this.emit("battery", { persisted, written: true });
    });
  }

  importBattery(bytes, action = SAVE_ACTION.batteryIn) {
    const backup = this.core.io(SAVE_ACTION.batteryOut);
    if (!this.core.io(action, bytes)) {
      const message = this.core.reason("O save foi rejeitado. Confira o arquivo e o tipo de save.");
      if (backup) this.core.io(SAVE_ACTION.batteryIn, backup);
      throw new Error(message);
    }
    this.m._vba_reset();
    this.applyPrefs();
    this.clearHistory();
    this.resetTiming();
    this.flushBattery(true);
  }

  createState() {
    const bytes = this.core.io(SAVE_ACTION.stateOut);
    if (!bytes) throw new Error(this.core.reason("O núcleo não salvou o estado."));
    return bytes;
  }

  snapshotScreen() {
    const width = this.m._vba_width();
    const height = this.m._vba_height();
    const pointer = this.m._vba_raw_video();
    return pointer ? {
      width, height, pixels: this.m.HEAPU8.slice(pointer, pointer + (width + 1) * height * 4)
    } : null;
  }

  restoreScreen(screen) {
    if (screen?.width === this.m._vba_width() && screen?.height === this.m._vba_height()) {
      const pointer = this.m._vba_raw_video();
      if (pointer && screen.pixels.length === (screen.width + 1) * screen.height * 4) {
        this.m.HEAPU8.set(screen.pixels, pointer);
      }
    }
  }

  saveSlot(index) {
    const game = this.game;
    this.slots[index] = { bytes: this.createState(), screen: this.snapshotScreen(), updated: Date.now() };
    this.emit("slots");
    return this.vault.write("state:" + game.id + ":" + index, this.slots[index]);
  }

  loadState(bytes, restoreBattery = this.prefs.stateBattery, screen = null) {
    const backup = this.createState();
    const previousScreen = this.snapshotScreen();
    const battery = restoreBattery ? this.core.io(SAVE_ACTION.batteryOut) : null;
    const success = this.core.io(SAVE_ACTION.stateIn, bytes, +restoreBattery);
    if (!success) {
      const message = this.core.reason("O estado foi rejeitado. Confira a ROM, a BIOS e a versão do estado.");
      this.core.io(SAVE_ACTION.stateIn, backup, 1);
      if (battery) this.core.io(SAVE_ACTION.batteryIn, battery);
      this.restoreScreen(previousScreen);
      throw new Error(message);
    }
    if (restoreBattery) this.flushBattery(true);
    this.restoreScreen(screen);
    this.applyPrefs();
    this.resetTiming();
    this.draw();
  }

  loadSlot(index) {
    const saved = this.slots[index];
    this.loadState(saved.bytes, this.prefs.stateBattery, saved.screen);
    this.clearHistory();
  }

  clearHistory() {
    this.history.length = 0;
    this.historySize = 0;
    this.lastHistoryAt = -Infinity;
    this.emit("history");
  }

  keepHistory() {
    const bytes = this.core.io(SAVE_ACTION.stateOut);
    if (!bytes) return;
    const screen = this.snapshotScreen();
    const size = bytes.length + (screen?.pixels.length || 0);
    this.history.push({ frame: this.frameNumber, bytes, screen, size });
    this.historySize += size;
    while (this.history.length > 36 || this.historySize > 24 * 1024 * 1024) {
      this.historySize -= this.history.shift().size;
    }
    this.emit("history");
  }

  rewind() {
    if (!this.game || !this.history.length) return false;
    const latest = this.history[this.history.length - 1];
    if (this.history.length >= 2 && this.frameNumber - latest.frame < 12) {
      this.historySize -= this.history.pop().size;
    }
    const point = this.history.pop();
    this.historySize -= point.size;
    this.loadState(point.bytes, false, point.screen);
    this.frameNumber = point.frame;
    this.lastFpsAt = null;
    this.emit("history");
    return true;
  }

  cheatList() {
    const count = this.m._vba_cheat_count();
    return Array.from({ length: Math.min(count, 256) }, (_, i) => ({
      name: this.core.cheatText(i, 0), code: this.core.cheatText(i, 1), enabled: !!this.m._vba_cheat_on(i)
    }));
  }

  async saveCheats() {
    const list = this.core.io(SAVE_ACTION.cheatsOut);
    await this.vault.write("cheats:" + this.game.id, list || undefined);
    this.emit("cheats");
  }
}
