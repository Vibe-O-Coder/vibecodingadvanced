// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const webCores = [
  { id: "sameboy", name: "SameBoy", system: "Game Boy e Game Boy Color", accept: ".gb,.gbc,.sgb", factory: "createSameBoy" },
  { id: "gameboy-emu", name: "gameboy-emu", system: "Game Boy original", accept: ".gb", factory: "createGameBoyEmu" },
  { id: "snes9x", name: "Snes9x", system: "Super Nintendo", accept: ".sfc,.smc", factory: "createSnes9x" },
  { id: "ppsspp", name: "PPSSPP", system: "PlayStation Portable", frame: "web/ppsspp/index.html" },
  { id: "azahar", name: "Azahar", system: "Nintendo 3DS", frame: "web/azahar/index.html", experimental: true },
  { id: "dolphin", name: "Dolphin", system: "GameCube e Wii", frame: "web/dolphin/index.html", experimental: true },
  {
    id: "pcsx2", name: "PCSX2", system: "PlayStation 2", frame: "web/pcsx2/index.html", experimental: true,
    guide: "Importe a BIOS do seu PlayStation 2 e escolha uma imagem de disco. A interface do porte está em inglês.",
  },
  {
    id: "eden", name: "Eden", system: "Nintendo Switch", frame: "web/eden/index.html", experimental: true,
    guide: "Use um navegador com WebGPU. Abra um homebrew ou importe as chaves e o firmware do seu Switch quando o jogo exigir. A interface do porte está em inglês.",
  },
  { id: "project64", name: "Project64", system: "Nintendo 64", pending: "O Project64 precisa de um núcleo e plug-ins de vídeo, áudio e controle compatíveis com o navegador." },
  { id: "rpcs3", name: "RPCS3", system: "PlayStation 3", pending: "O núcleo Web do RPCS3 inicializou em teste. A execução de jogos continua pendente." },
  { id: "shadps4", name: "shadPS4", system: "PlayStation 4", pending: "O shadPS4 precisa adaptar a execução de código do PS4 e a renderização para o navegador." },
  { id: "xemu", name: "xemu", system: "Xbox original", pending: "O xemu precisa adaptar o núcleo do Xbox e a renderização para o navegador." },
];
const option = new URLSearchParams(location.search).get("core");
const selectedCore = webCores.find(item => item.id === option) || webCores[0];
const get = id => document.getElementById(id);

function startEmbeddedPlayer(config) {
  get("web-open").hidden = true;
  if (!window.crossOriginIsolated) {
    get("web-status").textContent = "Isolamento do navegador necessário";
    get("web-instruction").textContent = location.protocol === "file:"
      ? "Abra Jogar no navegador.cmd na pasta do projeto e volte a escolher este emulador."
      : "Abra o site pelo servidor local do projeto ou por uma hospedagem HTTPS com os cabeçalhos do manual.";
    return;
  }
  get("web-status").textContent = config.experimental ? "Porte Web experimental" : "Porte Web";
  get("web-welcome").hidden = true;
  get("web-bay").dataset.runtime = config.id;
  const frame = get("web-embedded");
  frame.src = config.frame;
  frame.title = config.name + " no navegador";
  frame.hidden = false;
  const standalone = get("web-standalone");
  standalone.href = config.frame;
  standalone.hidden = false;
  get("web-keys").textContent = config.guide || "";
}

const WEB_KEYS = {
  KeyX: 1, KeyZ: 2, Backspace: 4, Enter: 8,
  ArrowRight: 16, ArrowLeft: 32, ArrowUp: 64, ArrowDown: 128,
  KeyW: 256, KeyQ: 512, KeyS: 1024, KeyA: 2048,
};

function coreFactory(config) {
  if (globalThis[config.factory]) return Promise.resolve(globalThis[config.factory]);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "assets/web-cores/" + config.id + ".js";
    script.onload = () => typeof globalThis[config.factory] === "function"
      ? resolve(globalThis[config.factory]) : reject(new Error("O núcleo Web está incompleto."));
    script.onerror = () => { script.remove(); reject(new Error("O núcleo Web não carregou. Confira se todo o ZIP foi extraído.")); };
    document.head.append(script);
  });
}

class BrowserCore {
  constructor(module) {
    this.m = module;
    this.rom = 0;
  }

  open(bytes) {
    this.rom = this.m._malloc(bytes.length);
    if (!this.rom) throw new Error("O navegador ficou sem memória para carregar o jogo.");
    this.m.HEAPU8.set(bytes, this.rom);
    if (!this.m._web_open(this.rom, bytes.length)) throw new Error("O emulador recusou o cartucho. Confira o formato e a integridade do arquivo.");
    this.frameTime = 1000 / this.m._web_fps();
    this.sampleRate = this.m._web_sample_rate();
  }

  close() {
    if (!this.rom) return;
    this.m._web_close();
    this.m._free(this.rom);
    this.rom = 0;
  }

  battery(bytes = null) {
    const size = bytes?.length ?? this.m._web_battery_size();
    if (!size) return null;
    const buffer = this.m._malloc(size);
    if (!buffer) return null;
    try {
      if (bytes) {
        this.m.HEAPU8.set(bytes, buffer);
        return Boolean(this.m._web_write_battery(buffer, size));
      }
      return this.m._web_read_battery(buffer, size) ? this.m.HEAPU8.slice(buffer, buffer + size) : null;
    } finally {
      this.m._free(buffer);
    }
  }
}

function browserSaveKey(core, id) { return "web-save:" + core.id + ":" + id; }

class BrowserPlayer {
  constructor(config) {
    this.config = config;
    this.library = config.id === "sameboy" ? BUNDLED_ROMS.filter(entry => entry.system === "GBC") : [];
    this.vault = new LocalVault(this.library.map(game => browserSaveKey(config, romIdentity(2, game.size, game.checksum))));
    this.sound = new EmulatorAudio();
    this.canvas = get("web-display");
    this.graphics = this.canvas.getContext("2d", { alpha: false });
    this.keys = new Set();
    this.pointers = new Map();
    this.playing = false;
    this.loading = false;
    this.frameRequest = 0;
    this.frame = this.frame.bind(this);
    this.isSNES = config.id === "snes9x";
  }

  message(text, isError = false) {
    const element = get("web-message");
    element.hidden = !text;
    element.textContent = text;
    element.dataset.error = String(isError);
  }

  async load(loadGame, imported = null) {
    if (this.loading) return;
    this.loading = true;
    const resumeOld = this.playing;
    this.setPlaying(false);
    this.refresh();
    this.message("");
    let staged;
    try {
      await this.sound.unlock();
      const [game, factory] = await Promise.all([loadGame(), coreFactory(this.config)]);
      staged = new BrowserCore(await factory());
      staged.open(game.bytes);
      const key = browserSaveKey(this.config, game.id);
      this.flush();
      const existing = await this.vault.read(key);
      const save = imported || existing?.bytes;
      const restored = save && staged.battery(save);
      if (imported && !restored) throw new Error("Este arquivo de save não corresponde ao tamanho esperado pelo cartucho.");

      this.core?.close();
      this.core = staged;
      this.game = game;
      this.key = key;
      this.battery = staged.battery();
      this.image = null;
      this.lastSaveAt = performance.now();
      if (imported) this.flush(true);
      else if (restored) this.message("Save restaurado neste navegador.");
      else if (save) this.message("O cartucho abriu. Confira o formato do save encontrado.", true);
      this.setPlaying(true);
    } catch (error) {
      if (staged && staged !== this.core) staged.close();
      this.setPlaying(resumeOld);
      this.message(error.message, true);
    } finally {
      this.loading = false;
      this.refresh();
      if (this.playing) this.canvas.focus({ preventScroll: true });
    }
  }

  refresh() {
    const active = Boolean(this.core);
    get("web-status").textContent = this.loading ? "Carregando…" :
      active ? (this.playing ? this.game.title : "Pausado") : "Aguardando jogo";
    get("web-welcome").hidden = active;
    this.canvas.hidden = !active;
    get("web-toolbar").hidden = !active;
    get("web-touch").hidden = !active;
    get("web-open").disabled = this.loading;
    get("web-pause").textContent = this.playing ? "Pausar" : "Continuar";
    get("web-export").disabled = !this.battery || this.loading;
    get("web-import-save").disabled = !this.battery || this.loading;
    get("web-stop").disabled = this.loading;
    for (const button of get("web-game-list").children) button.disabled = this.loading;
  }

  flush(force = false) {
    if (!this.core) return;
    const current = this.core;
    const bytes = current.battery();
    if (!bytes || (!force && sameBytes(bytes, this.battery))) return;
    this.battery = bytes;
    this.vault.write(this.key, { bytes, updated: Date.now() }).then(stored => {
      if (current === this.core) this.message(stored ? "Save guardado neste navegador." :
        "Save disponível nesta sessão. Use Baixar .sav para guardar uma cópia.", !stored);
    });
  }

  setPlaying(playing) {
    this.playing = playing && Boolean(this.core);
    cancelAnimationFrame(this.frameRequest);
    this.lastFrameAt = null;
    this.elapsed = 0;
    if (this.playing) this.frameRequest = requestAnimationFrame(this.frame);
    else this.sound.clear();
    this.refresh();
  }

  input() {
    let bits = 0;
    for (const key of this.keys) bits |= WEB_KEYS[key];
    for (const key of this.pointers.values()) bits |= WEB_KEYS[key];
    let pad;
    try { pad = Array.from(navigator.getGamepads?.() || []).find(item => item?.connected); } catch { /* API may be disabled. */ }
    if (!pad) return bits;
    const map = this.isSNES ? [2, 1, 2048, 1024] : [1, 2, 0, 0];
    const bindings = [...map, 512, 256, 0, 0, 4, 8, 0, 0, 64, 128, 32, 16];
    bindings.forEach((value, index) => { if (pad.buttons[index]?.pressed) bits |= value; });
    if (pad.axes[0] < -.5) bits |= 32;
    if (pad.axes[0] > .5) bits |= 16;
    if (pad.axes[1] < -.5) bits |= 64;
    if (pad.axes[1] > .5) bits |= 128;
    return bits;
  }

  frame(now) {
    if (!this.playing) return;
    const { m, frameTime, sampleRate } = this.core;
    this.elapsed += this.lastFrameAt === null ? frameTime : Math.min(80, now - this.lastFrameAt);
    this.lastFrameAt = now;
    const input = this.input();
    let redraw = false;
    try {
      while (this.elapsed + .01 >= frameTime) {
        this.elapsed -= frameTime;
        if (!m._web_run(input)) throw new Error("O núcleo interrompeu a emulação deste cartucho.");
        const index = m._web_audio() >> 1;
        this.sound.push(m.HEAP16.subarray(index, index + m._web_audio_length()), 1, false, sampleRate);
        redraw = true;
      }
      if (redraw) {
        const width = m._web_width(), height = m._web_height();
        if (!this.image || this.canvas.width !== width || this.canvas.height !== height) {
          this.canvas.width = width;
          this.canvas.height = height;
          this.image = this.graphics.createImageData(width, height);
        }
        const ptr = m._web_pixels();
        this.image.data.set(m.HEAPU8.subarray(ptr, ptr + width * height * 4));
        this.graphics.putImageData(this.image, 0, 0);
      }
      if (now - this.lastSaveAt > 2000) {
        this.lastSaveAt = now;
        this.flush();
      }
    } catch (error) {
      this.setPlaying(false);
      this.message(error.message, true);
      return;
    }
    this.frameRequest = requestAnimationFrame(this.frame);
  }

  bind() {
    const file = get("web-file");
    file.accept = this.config.accept;
    get("web-instruction").textContent = "Escolha um cartucho " + file.accept.split(",").join(" ou ") + ".";
    get("web-open").onclick = () => { file.value = ""; this.sound.unlock(); file.click(); };
    file.onchange = () => {
      const cartridge = file.files[0];
      if (!cartridge) return;
      this.load(async () => {
        const extension = /\.[^.]+$/.exec(cartridge.name)?.[0]?.toLowerCase();
        if (!file.accept.split(",").includes(extension)) throw new Error("Escolha um arquivo com a extensão indicada.");
        const bytes = await readFile(cartridge);
        return { bytes, title: fileStem(cartridge.name), id: romIdentity(this.isSNES ? 4 : 2, bytes.length, crc32(bytes)) };
      });
    };
    const gameList = get("web-game-list");
    get("web-library").hidden = !this.library.length;
    for (const entry of this.library) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.title;
      button.onclick = () => this.load(async () => ({ ...await openBundledRom(entry.id), title: entry.title }));
      gameList.append(button);
    }
    get("web-pause").onclick = () => { this.sound.unlock(); this.setPlaying(!this.playing); this.flush(); };
    get("web-stop").onclick = () => {
      this.setPlaying(false);
      this.flush();
      this.core.close();
      this.core = this.game = this.battery = null;
      this.refresh();
    };
    get("web-sound").onclick = event => {
      this.sound.unlock();
      this.sound.setVolume(.65, !this.sound.muted);
      event.currentTarget.setAttribute("aria-pressed", String(this.sound.muted));
      event.currentTarget.textContent = this.sound.muted ? "Ligar som" : "Silenciar";
    };
    get("web-full").onclick = () => get("web-bay").requestFullscreen?.().catch(error => this.message(error.message, true));
    get("web-export").onclick = () => { const bytes = this.core?.battery(); if (bytes) downloadFile(this.game.title + ".sav", bytes); };
    const saveFile = get("web-save-file");
    get("web-import-save").onclick = () => { saveFile.value = ""; saveFile.click(); };
    saveFile.onchange = async () => {
      const file = saveFile.files[0], game = this.game;
      if (!file || !game) return;
      try {
        const bytes = await readFile(file, 1024 * 1024);
        if (game === this.game) await this.load(() => game, bytes);
      } catch (error) { this.message(error.message, true); }
    };
    get("web-keys").textContent = "Setas · A/B: X/Z · Start: Enter · Select: Backspace" + (this.isSNES ? " · X/Y: S/A · L/R: Q/W" : "");
    for (const button of document.querySelectorAll("[data-key]")) {
      button.hidden = button.hasAttribute("data-snes") && !this.isSNES;
      button.onpointerdown = event => { button.setPointerCapture(event.pointerId); this.pointers.set(event.pointerId, button.dataset.key); };
      button.onlostpointercapture = event => this.pointers.delete(event.pointerId);
    }
    window.addEventListener("keydown", event => {
      if (!this.playing || !WEB_KEYS[event.code] || event.ctrlKey || event.metaKey || event.altKey ||
          event.target.closest?.("button, input, select, a")) return;
      this.keys.add(event.code);
      event.preventDefault();
    });
    window.addEventListener("keyup", event => this.keys.delete(event.code));
    const leave = () => { this.keys.clear(); this.pointers.clear(); this.flush(); };
    window.addEventListener("blur", leave);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", () => { if (document.hidden) leave(); });
    this.refresh();
  }
}

get("web-name").textContent = selectedCore.name;
get("web-system").textContent = selectedCore.system;
for (const config of webCores) {
  const link = document.createElement("a");
  link.href = "?core=" + config.id;
  if (config === selectedCore) link.setAttribute("aria-current", "page");
  const system = document.createElement("small");
  system.textContent = config.pending ? `${config.system} · Porte pendente` : config.system;
  link.append(config.name, system);
  get("web-core-list").append(link);
}
if (selectedCore.factory) new BrowserPlayer(selectedCore).bind();
else if (selectedCore.frame) startEmbeddedPlayer(selectedCore);
else {
  get("web-open").hidden = true;
  get("web-status").textContent = "Porte Web pendente";
  get("web-instruction").textContent = selectedCore.pending;
}
