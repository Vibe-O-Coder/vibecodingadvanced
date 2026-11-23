// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const $ = id => document.getElementById(id);
const all = (query, within = document) => [...within.querySelectorAll(query)];
const prefs = getPrefs();
const vault = new LocalVault(BUNDLED_ROMS.map(entry =>
  "battery:" + romIdentity(entry.system === "GBC" ? 2 : 1, entry.size, entry.checksum)));
const audio = new EmulatorAudio();
const em = new VbaEmulator($("display"), prefs, vault, audio);
const filePicker = $("file-picker");
const stage = $("console");
const screen = $("screen");
const selectedFormat = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short", timeStyle: "short"
});
const romAccept = ".gba,.agb,.bin,.mb,.gb,.gbc,.cgb,.dmg,.sgb,.zip,.gz,.z";
const accelerationKeys = new Set(["KeyQ", "Space"]);
const heldAccelerationKeys = new Set();
const hotkeys = new Set(["KeyP", "KeyQ", "Space", "KeyR", "KeyF", "KeyC", "Comma", "Escape", "Tab"]);
const saveTypes = ["Automático", "EEPROM", "SRAM", "Flash", "EEPROM + sensor", "Sem save"];
let slot = 0;
let notificationTimer = 0;
let keyLearning = null;
let padLearning = null;
let latestPadButtons = new Set();
let rewinding = false;
let rewindTimer = 0;
let autoPaused = false;
let videoRecord = null;
let audioName = "";
let activeTab = "capture";

function notice(message, error = false) {
  const element = $("notice");
  const dialogs = all("dialog[open]");
  (dialogs.at(-1) || document.fullscreenElement || document.body).append(element);
  element.textContent = message;
  element.dataset.error = String(error);
  element.hidden = false;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { element.hidden = true; }, error ? 7300 : 3300);
}

const debuggerPanel = new DebuggerPanel(em, notice);

function report(error) {
  notice(error instanceof Error ? error.message : String(error), true);
}

function run(action) {
  try { Promise.resolve(action()).catch(report); } catch (error) { report(error); }
}

async function busy(action) {
  if (em.busy) return;
  em.busy = true;
  renderStatus();
  try {
    await action();
  } finally {
    em.busy = false;
    renderStatus();
    if (!all("dialog[open]").length) focusGame();
  }
}

function pick(accept, action) {
  filePicker.value = "";
  filePicker.accept = accept;
  filePicker.onchange = () => {
    const file = filePicker.files[0];
    if (file) run(() => busy(() => action(file)));
  };
  filePicker.click();
}

function pickArchiveEntry(entries) {
  const dialog = $("archive-dialog");
  const choices = $("archive-entries");
  choices.replaceChildren(...entries.map((entry, index) => new Option(entry.name, index)));
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "open" ? entries[Number(choices.value)] : null);
    }, { once: true });
  });
}

function focusGame() {
  if (em.game && !all("dialog[open]").length) em.canvas.focus({ preventScroll: true });
}

function drawSlots() {
  for (const [index, button] of [...$("slots").children].entries()) {
    const active = index === slot;
    const filled = !!em.slots[index];
    button.classList.toggle("selected", active);
    button.classList.toggle("filled", filled);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", "Slot " + (index + 1) + (filled ? ", salvo" : ", vazio"));
    button.disabled = !em.game || em.busy;
  }
  const entry = em.slots[slot];
  $("slot-status").textContent = "Slot " + (slot + 1) + (entry ?
    " salvo em " + selectedFormat.format(entry.updated) : " vazio");
  $("load-state").disabled = $("export-state").disabled = !entry || em.busy;
}

function renderStatus() {
  const state = em.busy ? "busy" : !em.game ? "idle" : em.running ? "running" : "paused";
  const labels = { busy: "Processando arquivo", idle: "Aguardando ROM", running: "Em execução", paused: "Pausado" };
  $("play-status").dataset.status = state;
  $("play-status").lastElementChild.textContent = labels[state];
  $("pause").textContent = em.running ? "Pausar" : "Continuar";
  for (const button of all("[data-game]")) button.disabled = !em.game || em.busy;
  for (const button of all('[data-action="rom"],[data-dialog="library"],[data-library-rom]')) button.disabled = em.busy;
  $("rewind").disabled = !em.history.length || em.busy;
  $("print-button").disabled = !em.game || !em.m._vba_print_size();
  renderStats();
  drawSlots();
}

function renderStats() {
  const { fps } = em;
  const speed = em.speed.toLocaleString("pt-BR") + "×";
  $("speed-stats").textContent = !em.game ? "VBA-M 2.2.3" : (em.running && fps ? fps + " FPS · " : "") + speed;
  $("video-stats").textContent = (em.game ? em.frameWidth : 240) + " × " + (em.game ? em.frameHeight : 160);
}

function renderGame() {
  const game = em.game;
  $("welcome").hidden = !!game;
  $("display").hidden = !game;
  $("game-title").textContent = game?.title || "Nenhuma ROM aberta";
  $("system-label").textContent = (game?.system || "Game Boy Advance").toUpperCase();
  $("game-meta").textContent = game ?
    [game.filename, game.code, game.type === 1 ? saveTypes[em.m._vba_battery_type()] : undefined]
      .filter(Boolean).join(" · ") : "GBA, GB e GBC. Aceita ZIP e GZIP.";
  if (!game) $("save-status").textContent = "Local";
  else {
    slot = 0;
    stopRewind(false);
  }
  if ($("tools").open && !game) $("tools").close();
  updateCheats();
  renderStatus();
  resizeCanvas();
}

function resizeCanvas() {
  if (!em.game) return;
  const { frameWidth: width, frameHeight: height } = em;
  const available = Math.max(0.01, Math.min(screen.clientWidth / width, screen.clientHeight / height));
  const inFullscreen = document.fullscreenElement === stage || stage.classList.contains("full-window");
  // Tela cheia ignora o zoom da janela para ocupar toda a área possível sem esticar a imagem.
  const wanted = inFullscreen || prefs.scale === "fit" ? available : prefs.scale === "integer" ?
    Math.max(1, Math.floor(available)) : Number(prefs.scale);
  em.canvas.style.setProperty("--canvas-width", (width * Math.min(wanted, available)).toFixed(2) + "px");
  em.canvas.style.setProperty("--canvas-ratio", width + "/" + height);
  em.canvas.classList.toggle("smooth", prefs.filter === "-1");
}

function selectSlot(index) {
  slot = index;
  drawSlots();
}

function syncPrefs() {
  for (const input of all("[data-pref]")) {
    if (input.type === "checkbox") input.checked = !!prefs[input.dataset.pref];
    else input.value = prefs[input.dataset.pref];
  }
  for (const input of all("[data-layer]")) input.checked = !!(prefs.layers & Number(input.dataset.layer));
  for (const input of all("[data-channel]")) input.checked = !!(prefs.channels & Number(input.dataset.channel));
  $("touch-controls").dataset.touch = prefs.touch;
  $("mute").setAttribute("aria-pressed", String(prefs.mute));
  $("mute").textContent = prefs.mute ? "Sem som" : "Som";
  audio.setVolume(Number(prefs.volume) / 100, prefs.mute);
}

function prefChanged(input) {
  const key = input.dataset.pref;
  if (key) prefs[key] = input.type === "checkbox" ? input.checked : input.value;
  if (input.dataset.layer) {
    const bit = Number(input.dataset.layer);
    prefs.layers = input.checked ? prefs.layers | bit : prefs.layers & ~bit;
  }
  if (input.dataset.channel) {
    const bit = Number(input.dataset.channel);
    prefs.channels = input.checked ? prefs.channels | bit : prefs.channels & ~bit;
  }
  savePrefs(prefs);
  syncPrefs();
  if (["tiltX", "tiltY", "gyro", "sun"].includes(key)) em.updateSensors();
  else if (input.dataset.layer || input.dataset.channel ||
      ["color", "mono", "frameskip", "printer", "agbPrint", "cheats", "rewind"].includes(key)) {
    em.applyPrefs();
  }
  if (["filter", "blend", "scale"].includes(key)) {
    resizeCanvas();
    if (key !== "scale") em.draw();
  }
  if (key === "speed" || key === "turbo") {
    // O pipeline de áudio continua ativo em todas as velocidades.
    audio.unlock();
    renderStats();
  }
}

function keyText(code) {
  const names = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Espaço",
    Enter: "Enter", Backspace: "Backspace", ShiftLeft: "Shift esq.", ShiftRight: "Shift dir."
  };
  return names[code] || code.replace(/^(Key|Digit)/, "");
}

function updateBindings() {
  const rows = Object.entries(BUTTON_NAMES).map(([name, label]) => {
    const row = document.createElement("div");
    row.className = "key-binding";
    const title = document.createElement("span");
    title.textContent = label;
    const keyboard = document.createElement("button");
    keyboard.type = "button";
    keyboard.dataset.bindKey = name;
    keyboard.classList.toggle("listening", name === keyLearning);
    keyboard.textContent = name === keyLearning ? "Pressione…" : keyText(prefs.keys[name]);
    keyboard.setAttribute("aria-label", "Alterar tecla de " + label + " (" + keyText(prefs.keys[name]) + ")");
    const gamepad = document.createElement("button");
    gamepad.type = "button";
    gamepad.dataset.bindPad = name;
    gamepad.classList.toggle("listening", name === padLearning);
    gamepad.textContent = name === padLearning ? "Pressione…" : "Joy " + prefs.pad[name];
    gamepad.setAttribute("aria-label", "Alterar botão do controle para " + label);
    const keys = document.createElement("div");
    keys.className = "actions";
    keys.append(keyboard, gamepad);
    row.append(title, keys);
    return row;
  });
  $("bindings").replaceChildren(...rows);
  const learning = keyLearning ? "[data-bind-key=" + keyLearning + "]" :
    padLearning ? "[data-bind-pad=" + padLearning + "]" : null;
  if (learning) $("bindings").querySelector(learning)?.focus({ preventScroll: true });
}

function readGamepads() {
  try { return [...(navigator.getGamepads?.() || [])].filter(pad => pad?.connected); } catch { return []; }
}

function updateGamepads() {
  const pads = readGamepads();
  const select = $("gamepad");
  select.replaceChildren(new Option("Primeiro disponível", -1),
    ...pads.map(pad => new Option(pad.id, pad.index)));
  if (prefs.gamepad !== "-1" && !pads.some(pad => String(pad.index) === prefs.gamepad)) {
    select.add(new Option("Controle " + prefs.gamepad + " desconectado", prefs.gamepad));
  }
  select.value = prefs.gamepad;
}

function pollPadBinding() {
  if (!padLearning || !$("controls").open) return;
  const pads = readGamepads();
  const pad = prefs.gamepad === "-1" ? pads[0] : pads.find(item => String(item.index) === prefs.gamepad);
  if (!pad) return;
  const pressed = new Set(pad.buttons.flatMap((button, i) => button.pressed ? [i] : []));
  const newButton = [...pressed].find(index => !latestPadButtons.has(index));
  latestPadButtons = pressed;
  if (newButton === undefined) return;
  const conflicting = Object.keys(prefs.pad).find(name => name !== padLearning && prefs.pad[name] === newButton);
  if (conflicting) prefs.pad[conflicting] = prefs.pad[padLearning];
  prefs.pad[padLearning] = newButton;
  padLearning = null;
  savePrefs(prefs);
  updateBindings();
}

function startRewind() {
  if (rewinding || !em.history.length) return;
  rewinding = true;
  const resume = em.running;
  em.pause();
  const rewindOnce = () => {
    if (!em.rewind()) stopRewind();
  };
  stopRewind.resumeGame = resume;
  run(rewindOnce);
  if (rewinding) rewindTimer = setInterval(() => run(rewindOnce), 210);
}

function stopRewind(resume = true) {
  if (!rewinding) return;
  rewinding = false;
  clearInterval(rewindTimer);
  if (resume && stopRewind.resumeGame) em.resume();
}

function clearInput() {
  heldAccelerationKeys.clear();
  em.clearInput();
  for (const pad of all("[data-pad].pressed")) pad.classList.remove("pressed");
}

function keyDown(event) {
  if (keyLearning) {
    event.preventDefault();
    if (event.code === "Escape") {
      keyLearning = null;
      updateBindings();
    } else if (hotkeys.has(event.code) || /^F\d+$/.test(event.code) || /^(Alt|Control|Meta)/.test(event.code)) {
      notice("Essa tecla está reservada para atalhos.", true);
    } else if (!event.repeat && event.code) {
      const conflicting = Object.keys(prefs.keys).find(name => name !== keyLearning && prefs.keys[name] === event.code);
      if (conflicting) prefs.keys[conflicting] = prefs.keys[keyLearning];
      prefs.keys[keyLearning] = event.code;
      keyLearning = null;
      savePrefs(prefs);
      updateBindings();
    }
    return;
  }

  if (event.code === "Escape" && stage.classList.contains("full-window")) {
    toggleFullscreen();
    return;
  }

  if (!em.game || em.busy || all("dialog[open]").length || event.ctrlKey || event.metaKey || event.altKey ||
      event.target.closest?.("input,select,textarea,[contenteditable]") ||
      (event.target.closest?.("button,a") && ["Enter", "Space"].includes(event.code))) return;

  // Q e Espaço funcionam juntos, mesmo se o usuário mantiver ambos pressionados.
  // Executar antes dos mapeamentos evita que uma configuração antiga capture o atalho.
  if (accelerationKeys.has(event.code)) {
    event.preventDefault(); // Espaço não deve rolar a página.
    if (!event.repeat) {
      heldAccelerationKeys.add(event.code);
      em.fast = true;
      audio.unlock();
      renderStats();
    }
    return;
  }

  if (Object.values(prefs.keys).includes(event.code)) {
    event.preventDefault();
    em.pressedKeys.add(event.code);
    return;
  }

  if (hotkeys.has(event.code) && !["Escape", "Tab"].includes(event.code)) {
    event.preventDefault();
    if (event.repeat) return;
    const action = { KeyP: "pause", KeyF: "fullscreen", KeyC: "png", Comma: "step" }[event.code];
    if (action) run(actions[action]);
    if (event.code === "KeyR") startRewind();
  } else if (/^F([1-9]|10)$/.test(event.code)) {
    event.preventDefault();
    if (event.repeat) return;
    selectSlot(Number(event.code.slice(1)) - 1);
    run(event.shiftKey ? actions["save-state"] : actions["load-state"]);
  }
}

function keyUp(event) {
  em.pressedKeys.delete(event.code);
  if (accelerationKeys.has(event.code) && heldAccelerationKeys.delete(event.code)) {
    em.fast = heldAccelerationKeys.size > 0;
    renderStats();
  }
  if (event.code === "KeyR") stopRewind();
}

function attachPad(button) {
  const remove = event => {
    em.pointers.delete(event.pointerId);
    button.classList.toggle("pressed", [...em.pointers.values()].includes(button.dataset.pad));
  };
  button.addEventListener("pointerdown", event => {
    if (!em.game || em.busy) return;
    event.preventDefault();
    audio.unlock();
    button.setPointerCapture(event.pointerId);
    em.pointers.set(event.pointerId, button.dataset.pad);
    button.classList.add("pressed");
  });
  button.addEventListener("pointerup", remove);
  button.addEventListener("pointercancel", remove);
  button.addEventListener("lostpointercapture", remove);
}

async function openRom(file) {
  const game = await openRomFile(file, pickArchiveEntry);
  if (!game) return;
  stopRecordings();
  await em.open(game);
  focusGame();
}

function chooseRom() {
  audio.unlock();
  pick(romAccept, openRom);
}

function normalizeGameSearch(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function renderLibrary() {
  const grid = $("library-grid");
  const term = normalizeGameSearch($("library-search").value);
  const system = $("library-filter").value;
  const items = BUNDLED_ROMS.filter(item => (system === "all" || item.system === system) &&
    normalizeGameSearch(item.title + " " + item.subtitle + " " + item.filename).includes(term));
  grid.replaceChildren();
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rom-card";
    button.dataset.libraryRom = item.id;
    button.dataset.theme = item.theme;
    button.disabled = em.busy;
    const artwork = document.createElement("span");
    artwork.className = "rom-art";
    artwork.setAttribute("aria-hidden", "true");
    const artText = document.createElement("span");
    artText.textContent = item.system === "GBA" ? "ADVANCE" : "COLOR";
    artwork.append(artText);
    const info = document.createElement("span");
    info.className = "rom-card-content";
    const name = document.createElement("strong");
    name.textContent = item.title;
    const subtitle = document.createElement("span");
    subtitle.textContent = item.subtitle;
    const badges = document.createElement("span");
    badges.className = "rom-card-meta";
    badges.textContent = item.system === "GBA" ? "GAME BOY ADVANCE" : "GAME BOY COLOR";
    info.append(name, subtitle, badges);
    button.append(artwork, info);
    grid.append(button);
  }
  if (!items.length) {
    const message = document.createElement("p");
    message.className = "library-empty";
    message.textContent = "Nenhum jogo corresponde a esses filtros.";
    grid.append(message);
  }
}

async function chooseBundledRom(id) {
  if (em.busy) return;
  const entry = BUNDLED_ROMS.find(item => item.id === id);
  if (!entry) return;
  audio.unlock();
  await busy(async () => {
    const status = $("library-loading");
    status.hidden = false;
    status.textContent = "Carregando " + entry.title + "…";
    try {
      const game = await openBundledRom(id);
      stopRecordings();
      await em.open(game);
      if ($("library").open) $("library").close();
      notice(entry.title + " iniciado.");
    } finally {
      status.hidden = true;
      renderLibrary();
    }
  });
}

function downloadFromCore(action, extension, fallback) {
  const bytes = em.core.io(action);
  if (!bytes) throw new Error(em.core.reason(fallback));
  const types = { png: "image/png", bmp: "image/bmp" };
  downloadFile(fileStem(em.game.filename) + "." + extension, bytes, types[extension]);
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else if (stage.classList.contains("full-window")) {
    stage.classList.remove("full-window");
    document.body.classList.remove("full-window-open");
  } else {
    try {
      if (!stage.requestFullscreen) throw new Error();
      await stage.requestFullscreen();
    } catch {
      stage.classList.add("full-window");
      document.body.classList.add("full-window-open");
    }
  }
  resizeCanvas();
  focusGame();
}

async function syncBiosStatus() {
  const files = await Promise.all(["gba", "gbc", "gb"].map(type => vault.read("bios:" + type)));
  $("bios-status").textContent = files.filter(Boolean).map(file => file.name).join(" · ") || "BIOS interna";
}

async function importBios(file) {
  const names = { 256: "gb", 2304: "gbc", 16384: "gba" };
  const type = names[file.size];
  if (!type) throw new Error("Tamanho de BIOS inválido. Use 256 B (GB), 2.304 B (GBC) ou 16.384 B (GBA).");
  const persisted = await vault.write("bios:" + type, { name: file.name, bytes: await readFile(file, 16384) });
  await syncBiosStatus();
  notice(persisted ? "BIOS de " + type.toUpperCase() + " salva. Reabra a ROM para usá-la." :
    "BIOS carregada nesta sessão. Reabra a ROM para usá-la.");
}

function captureVideo() {
  if (videoRecord) {
    videoRecord.recorder.stop();
    return;
  }
  if (!window.MediaRecorder || !em.canvas.captureStream) {
    throw new Error("Este navegador não permite gravar vídeo da tela.");
  }
  const stream = em.canvas.captureStream(60);
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error("O navegador não gerou uma faixa de vídeo.");
  const audioTrack = audio.outputStream?.stream.getAudioTracks()[0]?.clone();
  if (audioTrack) stream.addTrack(audioTrack);
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
  const chunks = [];
  const name = fileStem(em.game.filename);
  let size = 0;
  videoRecord = { recorder };
  recorder.ondataavailable = event => {
    if (event.data.size) {
      chunks.push(event.data);
      size += event.data.size;
    }
    if (size >= RECORD_LIMIT && recorder.state !== "inactive") recorder.stop();
  };
  recorder.onstop = () => {
    for (const track of stream.getTracks()) track.stop();
    videoRecord = null;
    updateRecording();
    if (!chunks.length) return notice("O navegador não registrou quadros.", true);
    const type = recorder.mimeType || "video/webm";
    downloadFile(name + (type.includes("mp4") ? ".mp4" : ".webm"), new Blob(chunks, { type }));
  };
  recorder.onerror = () => {
    for (const track of stream.getTracks()) track.stop();
    videoRecord = null;
    updateRecording();
    notice("O navegador interrompeu a gravação.", true);
  };
  recorder.start(1000);
  updateRecording();
}

function captureAudio() {
  if (audio.recording) {
    const recording = audio.stopWav();
    if (recording) downloadFile(audioName + ".wav", recording);
    else notice("Nenhuma amostra de áudio foi gravada.", true);
  } else {
    audioName = fileStem(em.game.filename);
    audio.startWav();
  }
  updateRecording();
}

function stopRecordings() {
  if (videoRecord?.recorder.state === "recording") videoRecord.recorder.stop();
  if (audio.recording) captureAudio();
}

function updateRecording() {
  $("record-video").textContent = videoRecord ? "Parar e baixar vídeo" : "Gravar vídeo";
  $("record-audio").textContent = audio.recording ? "Parar e baixar WAV" : "Gravar WAV";
  const labels = [];
  if (videoRecord) labels.push("Vídeo");
  if (audio.recording) labels.push("Áudio");
  $("record-status").textContent = labels.length ? labels.join(" e ") + " em gravação" : "";
}

function downloadPrinter() {
  const length = em.m._vba_print_size();
  if (!length) throw new Error("Nenhuma impressão recebida.");
  const pointer = em.m._vba_print_data();
  const bytes = em.m.HEAPU8.subarray(pointer, pointer + length);
  const mapping = em.m._vba_print_palette();
  const padding = em.m._vba_print_margin();
  const top = (padding >> 4 & 15) * 8;
  const bottom = (padding & 15) * 8;
  const image = document.createElement("canvas");
  image.width = 160;
  image.height = Math.ceil(length / 320) * 8 + top + bottom;
  const ctx = image.getContext("2d", { alpha: false });
  const frame = ctx.createImageData(image.width, image.height);
  frame.data.fill(255);
  for (let i = 0; i < length; i += 16) {
    const tile = i >> 4;
    for (let y = 0; y < 8; y++) {
      const a = bytes[i + y * 2] || 0;
      const b = bytes[i + y * 2 + 1] || 0;
      for (let x = 0; x < 8; x++) {
        const index = ((a >> (7 - x)) & 1) | (((b >> (7 - x)) & 1) << 1);
        const gray = 255 - ((mapping >> (index * 2)) & 3) * 85;
        const offset = ((top + Math.floor(tile / 20) * 8 + y) * 160 + tile % 20 * 8 + x) * 4;
        frame.data[offset] = frame.data[offset + 1] = frame.data[offset + 2] = gray;
      }
    }
  }
  ctx.putImageData(frame, 0, 0);
  image.toBlob(blob => { if (blob) downloadFile(fileStem(em.game.filename) + "-impressao.png", blob); });
}

// Presets de Pokémon: os códigos são vinculados ao CRC da ROM fornecida,
// e não apenas ao nome, para evitar aplicação acidental a outro jogo.
let presetRomId = null;
let presetSpecies = 25;
const presetTag = preset => "PK-" + preset.id + (preset.id === "wild" ? "-" + preset.speciesId : "");
const presetEntries = (name, entries) => entries.map((entry, index) => ({ ...entry, index }))
  .filter(entry => entry.name === name);
const activePresetInfo = () => POKEMON_CHEATS.rom(em.game);
const pokemonCheatSourceNames = Object.freeze({
  "retro-lg11": "Libretro: LeafGreen 1.1",
  "retro-emer": "Libretro: Emerald",
  "retro-sapp": "Libretro: Sapphire (revisão não especificada)",
  "poc11": "PokémonCoders: FireRed/LeafGreen 1.1",
  "poc10": "PokémonCoders: FireRed/LeafGreen 1.0",
  "glitch-gs": "Glitch City Wiki: Gold/Silver",
  "pok-gs": "PokeMundo: Gold/Silver",
  "pok-cr": "PokeMundo: Crystal",
  "tech-rs": "Tecnoblog: Ruby/Sapphire"
});

function syncPokemonSpecies(info) {
  const select = $("pokemon-species-select");
  if (!info) { select.replaceChildren(); return; }
  const max = ["gs", "crystal"].includes(info.family) ? 251 : 411;
  const items = POKEMON_CHEATS.species.filter(([id]) => id <= max);
  const term = normalizeGameSearch($("pokemon-species-search").value);
  const matching = items.filter(([id, name]) => !term || String(id).includes(term) || normalizeGameSearch(name).includes(term));
  select.replaceChildren(...matching.map(([id, name]) => new Option(name + "  ·  ID " + id.toString().padStart(3, "0"), String(id))));
  if (matching.some(([id]) => id === presetSpecies)) select.value = String(presetSpecies);
  else if (matching.length) presetSpecies = Number(select.value);
  const limit = ["gs", "crystal"].includes(info.family) ? "251" : "386";
  $("pokemon-species-help").textContent = !matching.length ? "Nenhum Pokémon corresponde à busca." :
    limit + " Pokémon. Os números exibidos são IDs internos do jogo; na Geração 3, eles diferem da Pokédex Nacional para muitos Pokémon de Hoenn.";
}

function renderPokemonPresets() {
  const container = $("pokemon-presets");
  const info = activePresetInfo();
  container.hidden = !info;
  if (!info) return;
  if (presetRomId !== info.id) {
    presetRomId = info.id;
    presetSpecies = 25;
    $("pokemon-species-search").value = "";
    $("preset-search").value = "";
    $("preset-category").value = "all";
    syncPokemonSpecies(info);
  }
  $("pokemon-cheat-version").textContent = info.rev + (info.modified ? " · ROM modificada: compatibilidade não garantida" : "");
  const selected = Number($("pokemon-species-select").value);
  if (selected) presetSpecies = selected;
  const cheats = em.cheatList();
  const q = normalizeGameSearch($("preset-search").value);
  const category = $("preset-category").value;
  const allPresets = POKEMON_CHEATS.presets(info, presetSpecies);
  const filtered = allPresets.filter(preset => (category === "all" || preset.category === category) &&
    (!q || normalizeGameSearch(preset.title + " " + preset.detail + " " + preset.category).includes(q)));
  $("pokemon-preset-count").textContent = allPresets.filter(preset => presetEntries(presetTag(preset), cheats).some(entry => entry.enabled)).length + " ativos";
  const grid = $("preset-grid");
  grid.replaceChildren();
  for (const preset of filtered) {
    const registered = presetEntries(presetTag(preset), cheats);
    const isOn = registered.length >= preset.codes.length && registered.some(entry => entry.enabled);
    const wildInUse = preset.id === "wild" && cheats.some(entry => entry.enabled && entry.name.startsWith("PK-wild-") && entry.name !== presetTag(preset));
    const item = document.createElement("article"); item.className = "preset-card";
    item.classList.toggle("is-on", isOn);
    const top = document.createElement("div"); top.className = "preset-card-top";
    const title = document.createElement("h4"); title.textContent = preset.title;
    const status = document.createElement("small"); status.textContent = isOn ? "Ativo" : wildInUse ? "Trocar" : "Inativo";
    top.append(title,status);
    const description = document.createElement("p"); description.textContent = preset.detail;
    item.append(top, description);
    if (preset.source) {
      const origin = document.createElement("small");
      origin.className = "preset-source";
      origin.textContent = "Fonte: " + (pokemonCheatSourceNames[preset.source] || preset.source) + " · efeito não testado individualmente";
      item.append(origin);
    }

    if (preset.caution) {
      const caution = document.createElement("span"); caution.className = "preset-caution";
      caution.textContent = "Compatibilidade variável: faça backup antes de usar."; item.append(caution);
    }
    const button = document.createElement("button"); button.type = "button";
    button.dataset.pokemonPreset = preset.id;
    button.dataset.species = String(preset.speciesId || "");
    button.setAttribute("aria-pressed", String(isOn));
    button.textContent = isOn ? "Desativar" : wildInUse ? "Trocar Pokémon" : "Ativar";
    button.disabled = em.busy;
    item.append(button); grid.append(item);
  }
  if (!filtered.length) {
    const empty = document.createElement("p"); empty.className = "preset-empty";
    empty.textContent = "Nenhum cheat disponível com esse filtro."; grid.append(empty);
  }
}

async function togglePokemonPreset(id, species) {
  const info = activePresetInfo();
  if (!info || !em.game) throw new Error("Abra uma ROM da biblioteca para usar os cheats prontos.");
  const preset = POKEMON_CHEATS.presets(info, species || presetSpecies).find(entry => entry.id === id);
  if (!preset) throw new Error("O cheat selecionado não está disponível para esta ROM.");
  if (preset.codes.some(({type, code}) => !cheatPatterns[type].test(normalizeCheat(code, type)))) {
    throw new Error("A biblioteca contém um código inválido; nada foi aplicado.");
  }
  const cheats = em.cheatList();
  const tag = presetTag(preset);
  const matching = presetEntries(tag, cheats);
  const active = matching.length >= preset.codes.length && matching.some(entry => entry.enabled);
  if (active) {
    for (const entry of matching.reverse()) em.m._vba_cheat_set(entry.index, -1);
    await em.saveCheats();
    notice(preset.title + " desativado.");
    return;
  }
  // Primeiro preparamos todos os códigos. Em caso de erro, removemos apenas os recém-instalados.
  if (cheats.length + preset.codes.length > 256) throw new Error("Limite de 256 códigos atingido. Remova alguns cheats antes de continuar.");
  const before = em.m._vba_cheat_count();
  try {
    for (const {type, code} of preset.codes) {
      if (!em.core.addCheat(type, normalizeCheat(code, type), tag)) {
        throw new Error(em.core.reason("O núcleo VBA-M recusou o código de " + preset.title));
      }
    }
  } catch (error) {
    for (let i = em.m._vba_cheat_count() - 1; i >= before; i--) em.m._vba_cheat_set(i, -1);
    throw error;
  }
  // Itens que substituem o mesmo slot e diferentes espécies não podem coexistir.
  if (preset.group) {
    const ids = POKEMON_CHEATS.presets(info, species || presetSpecies).filter(entry => entry.group === preset.group).map(entry => entry.id);
    const previous = cheats.map((entry, index) => ({ entry, index })).filter(({entry}) =>
      entry.name.startsWith("PK-") && (preset.group === "wild-species" ? entry.name.startsWith("PK-wild-") :
      ids.some(other => entry.name === "PK-" + other)));
    for (const {index} of previous.reverse()) em.m._vba_cheat_set(index, -1);
  }
  // Remove entradas desativadas da mesma opção para não acumular duplicatas.
  else for (const entry of matching.reverse()) em.m._vba_cheat_set(entry.index, -1);
  if (!prefs.cheats) {
    prefs.cheats = true;
    savePrefs(prefs);
    em.applyPrefs();
    syncPrefs();
  }
  await em.saveCheats();
  notice(preset.title + " ativado. Desative depois de obter o efeito.");
}

const gbaCheatFormats = [[0, "VBA direto (endereço:valor)"], [1, "CodeBreaker"],
  [2, "GameShark 1/2"], [3, "Action Replay / GameShark 3"]];
const gbCheatFormats = [[4, "GameShark GB"], [5, "Game Genie"]];
const cheatPatterns = [
  /^[\dA-F]{8}:(?:[\dA-F]{2}|[\dA-F]{4}|[\dA-F]{8})$/,
  /^[\dA-F]{8} [\dA-F]{4}$/,
  /^[\dA-F]{16}$/,
  /^[\dA-F]{16}$/,
  /^[\dA-F]{8}$/,
  /^[\dA-F]{3}-[\dA-F]{3}(?:-[\dA-F]{3})?$/
];

function normalizeCheat(raw, type) {
  let code = raw.trim().toUpperCase();
  if (type === 1) {
    const clean = code.replace(/\s+/g, "");
    code = clean.slice(0, 8) + " " + clean.slice(8);
  } else {
    code = code.replace(/\s+/g, "");
  }
  return code;
}

function updateCheats() {
  const select = $("cheat-type");
  const before = select.value;
  const formats = em.game?.type === 2 ? gbCheatFormats : gbaCheatFormats;
  select.replaceChildren(...formats.map(([value, title]) => new Option(title, value)));
  if (formats.some(([value]) => String(value) === before)) select.value = before;
  const list = em.game ? em.cheatList() : [];
  renderPokemonPresets();
  $("cheat-list").replaceChildren(...list.map((entry, index) => {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const flag = document.createElement("input");
    flag.type = "checkbox";
    flag.checked = entry.enabled;
    flag.dataset.cheat = index;
    const text = document.createElement("span");
    text.textContent = entry.name ? entry.name + " · " : "";
    const code = document.createElement("code");
    code.textContent = entry.code;
    label.append(flag, text, code);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remover";
    remove.dataset.deleteCheat = index;
    remove.setAttribute("aria-label", "Remover trapaça " + (entry.name || entry.code));
    row.append(label, remove);
    return row;
  }));
}

async function addCheats() {
  if (!em.game || em.busy) return;
  const type = Number($("cheat-type").value);
  const name = $("cheat-name").value.trim();
  const encoder = new TextEncoder();
  const encoded = encoder.encode(name);
  const safeName = encoded.length > 31 ? DECODER.decode(encoded.slice(0, 28)) : name;
  const codes = $("cheat-code").value.split(/\r?\n/).filter(line => line.trim())
    .map(line => normalizeCheat(line, type));
  if (!codes.length || codes.some(code => !cheatPatterns[type].test(code))) {
    throw new Error("Confira o formato escolhido e coloque um código por linha.");
  }
  let success = 0;
  let reason = "";
  for (const code of codes) {
    if (em.core.addCheat(type, code, safeName)) success++;
    else reason = em.core.reason("O núcleo recusou um dos códigos.");
  }
  if (success) await em.saveCheats();
  if (success === codes.length) $("cheat-code").value = "";
  notice(success + " de " + codes.length + " códigos adicionados." + (reason ? " " + reason : ""), !!reason);
}

function selectToolPanel(tab) {
  activeTab = tab;
  for (const button of all("[data-tab]")) button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  for (const panel of all("[data-panel]")) panel.hidden = panel.dataset.panel !== tab;
  if (tab === "inspect") debuggerPanel.run("refresh");
  if (tab === "cheat") updateCheats();
}

const actions = {
  rom: chooseRom,
  pause: () => {
    if (!em.game || em.busy) return;
    if (em.running) {
      em.pause();
      em.flushBattery();
    } else {
      audio.unlock();
      em.resume();
    }
    focusGame();
  },
  step: () => { em.step(); focusGame(); },
  rewind: () => {
    if (!em.rewind()) notice("Jogue por mais um instante para guardar quadros no histórico.");
    focusGame();
  },
  reset: () => { em.reset(); focusGame(); },
  close: () => {
    stopRewind(false);
    stopRecordings();
    em.close();
    if (document.fullscreenElement || stage.classList.contains("full-window")) run(toggleFullscreen);
  },
  mute: () => {
    audio.unlock();
    prefs.mute = !prefs.mute;
    savePrefs(prefs);
    syncPrefs();
    focusGame();
  },
  fullscreen: toggleFullscreen,
  "import-save": () => pick(".sav,.srm,.dat,.bin", async file => {
    em.importBattery(await readFile(file, 1024 * 1024));
    notice("Save importado. O cartucho foi reiniciado.");
  }),
  "export-save": () => downloadFromCore(SAVE_ACTION.batteryOut, "sav", "Este cartucho não tem um save de bateria para baixar."),
  "save-state": async () => {
    if (!em.game || em.busy) return;
    const number = slot + 1;
    const persisted = await em.saveSlot(slot);
    notice("Estado salvo no slot " + number + (persisted ? "." : " nesta sessão. Baixe o .sgm para guardar."));
    focusGame();
  },
  "load-state": () => {
    if (!em.slots[slot]) return notice("O slot " + (slot + 1) + " está vazio.");
    em.loadSlot(slot);
    notice("Estado do slot " + (slot + 1) + " carregado.");
    focusGame();
  },
  "import-state": () => pick(".sgm,.state,.gz", async file => {
    const bytes = await readFile(file, STATE_LIMIT);
    await validateState(bytes);
    em.loadState(bytes);
    em.clearHistory();
    notice("Estado importado.");
  }),
  "export-state": () => {
    const bytes = em.slots[slot]?.bytes;
    if (bytes) downloadFile(fileStem(em.game.filename) + "-slot" + (slot + 1) + ".sgm", bytes);
  },
  png: () => downloadFromCore(SAVE_ACTION.png, "png", "A captura PNG falhou."),
  bmp: () => downloadFromCore(SAVE_ACTION.bmp, "bmp", "A captura BMP falhou."),
  audio: captureAudio,
  video: () => { audio.unlock(); captureVideo(); },
  print: downloadPrinter,
  bios: () => pick(".bin,.rom,.bios", importBios),
  "clear-bios": () => busy(async () => {
    for (const type of ["gba", "gbc", "gb"]) await vault.write("bios:" + type, undefined);
    await syncBiosStatus();
    notice("BIOS removida. Reabra uma ROM para usar a BIOS interna.");
  }),
  "default-keys": () => {
    prefs.keys = { ...DEFAULT_KEYS };
    prefs.pad = { ...DEFAULT_PAD };
    keyLearning = padLearning = null;
    savePrefs(prefs);
    updateBindings();
  },
  "import-cheats": () => pick(".clt", async file => {
    const bytes = await readFile(file, 2 * 1024 * 1024);
    const backup = em.core.io(SAVE_ACTION.cheatsOut);
    if (!em.core.io(SAVE_ACTION.cheatsIn, bytes)) {
      const reason = em.core.reason("Lista de trapaças inválida para o cartucho aberto.");
      if (backup) em.core.io(SAVE_ACTION.cheatsIn, backup);
      throw new Error(reason);
    }
    await em.saveCheats();
    notice("Lista de trapaças importada.");
  }),
  "export-cheats": () => downloadFromCore(SAVE_ACTION.cheatsOut, "clt", "A lista de trapaças está vazia."),
  "import-legacy": () => pick(".sps,.xps,.gsv,.gbs", async file => {
    const bytes = await readFile(file, 512 * 1024);
    em.importBattery(bytes, /\.gsv$/i.test(file.name) ? SAVE_ACTION.gsvIn : SAVE_ACTION.legacyIn);
    notice("Save legado importado.");
  }),
  "export-legacy": () => downloadFromCore(SAVE_ACTION.legacyOut, "sps", "Exporte em SharkPort com um cartucho GBA que use SRAM ou Flash."),
  "import-eeprom": () => pick(".eep", async file => {
    const bytes = await readFile(file, 8192);
    if (![512, 8192].includes(bytes.length)) throw new Error("O arquivo EEPROM precisa ter 512 ou 8.192 bytes.");
    if (![1, 4].includes(em.m._vba_battery_type())) throw new Error("Abra um cartucho compatível com EEPROM.");
    em.importBattery(bytes, SAVE_ACTION.eepromIn);
    notice("EEPROM importada.");
  }),
  "export-eeprom": () => downloadFromCore(SAVE_ACTION.eepromOut, "eep", "O cartucho não usa EEPROM."),
  patch: () => pick(".ips,.ups,.bps,.ppf", async file => {
    const extension = file.name.split(".").pop().toLowerCase();
    const bytes = await readFile(file, 32 * 1024 * 1024);
    const magic = { ips: "PATCH", ups: "UPS1", bps: "BPS1", ppf: "PPF" }[extension];
    if (!magic || DECODER.decode(bytes.subarray(0, magic.length)) !== magic) {
      throw new Error("A assinatura do patch não corresponde ao formato.");
    }
    const patched = em.core.patch(em.game.bytes, bytes, extension);
    const name = fileStem(em.game.filename) + "-patch." + (em.game.type === 2 ? em.game.gbc ? "gbc" : "gb" : "gba");
    const game = await describeRom(name, patched, em.game.type);
    stopRecordings();
    await em.open(game);
    notice("Cartucho com patch aberto.");
  })
};

for (let index = 0; index < 10; index++) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.slot = index;
  button.textContent = index + 1;
  $("slots").append(button);
}

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.dialog) {
    clearInput();
    const dialog = $(button.dataset.dialog);
    if (dialog.id === "library") renderLibrary();
    if (dialog.id === "options") {
      updateGamepads();
      run(syncBiosStatus);
    }
    dialog.showModal();
    if (dialog.id === "tools") selectToolPanel(activeTab);
    return;
  }
  if ("dismiss" in button.dataset) {
    button.closest("dialog").close();
    return;
  }
  if (button.dataset.quickCheats !== undefined) {
    if (!em.game) return;
    $("tools").showModal();
    selectToolPanel("cheat");
    return;
  }
  if (button.dataset.pokemonPreset !== undefined) {
    const species = Number(button.dataset.species) || presetSpecies;
    return run(() => busy(() => togglePokemonPreset(button.dataset.pokemonPreset, species)));
  }
  if (button.dataset.libraryRom) return run(() => chooseBundledRom(button.dataset.libraryRom));
  if (button.dataset.tab) return selectToolPanel(button.dataset.tab);
  if (button.dataset.slot !== undefined) return selectSlot(Number(button.dataset.slot));
  if (button.dataset.debug) return debuggerPanel.run(button.dataset.debug);
  if (button.dataset.bindKey) {
    keyLearning = button.dataset.bindKey;
    padLearning = null;
    updateBindings();
    return;
  }
  if (button.dataset.bindPad) {
    padLearning = button.dataset.bindPad;
    keyLearning = null;
    latestPadButtons.clear();
    updateBindings();
    if (!readGamepads().length) notice("Conecte o controle e pressione um botão.");
    return;
  }
  if (button.dataset.deleteCheat !== undefined && em.game) {
    em.m._vba_cheat_set(Number(button.dataset.deleteCheat), -1);
    return run(() => em.saveCheats());
  }
  if (button.dataset.action && actions[button.dataset.action]) run(actions[button.dataset.action]);
});

document.addEventListener("change", event => {
  const input = event.target;
  if (input.id === "preset-category") return renderPokemonPresets();
  if (input.id === "pokemon-species-select") {
    presetSpecies = Number(input.value);
    return renderPokemonPresets();
  }
  if (input.id === "library-filter") return renderLibrary();
  if (input.matches("[data-pref],[data-layer],[data-channel]")) return run(() => prefChanged(input));
  if (input.dataset.cheat !== undefined && em.game) {
    em.m._vba_cheat_set(Number(input.dataset.cheat), +input.checked);
    run(() => em.saveCheats());
  }
});

document.addEventListener("input", event => {
  const input = event.target;
  if (input.id === "preset-search") return renderPokemonPresets();
  if (input.id === "pokemon-species-search") {
    syncPokemonSpecies(activePresetInfo());
    return renderPokemonPresets();
  }
  if (input.id === "library-search") return renderLibrary();
  if (!input.matches("input[type=range][data-pref]")) return;
  if (input.dataset.pref === "volume") audio.setVolume(Number(input.value) / 100, prefs.mute);
  if (input.closest('[data-panel="cart"]') && em.game) {
    em.m._vba_sensors(...["tiltX", "tiltY", "gyro", "sun"].map(key => Number(document.querySelector('[data-pref="' + key + '"]').value)));
  }
});

$("cheat-form").addEventListener("submit", event => {
  event.preventDefault();
  run(addCheats);
});

for (const dialog of all("dialog")) dialog.addEventListener("close", () => {
  if (dialog.id === "controls") {
    keyLearning = padLearning = null;
    updateBindings();
  }
  if (dialog.contains($("notice"))) document.body.append($("notice"));
  if (dialog.id !== "archive-dialog") focusGame();
});

for (const button of all("[data-pad]")) attachPad(button);
window.addEventListener("pointerdown", () => { audio.unlock(); }, { once: true, passive: true });
window.addEventListener("keydown", keyDown);
window.addEventListener("keyup", keyUp);
window.addEventListener("blur", () => {
  stopRewind(false);
  clearInput();
  em.flushBattery();
});
window.addEventListener("pagehide", () => em.flushBattery());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInput();
    autoPaused = prefs.autoPause && em.running;
    if (autoPaused) em.pause();
    em.flushBattery();
  } else if (autoPaused) {
    autoPaused = false;
    em.resume();
  }
});
document.addEventListener("fullscreenchange", resizeCanvas);
window.addEventListener("gamepadconnected", updateGamepads);
window.addEventListener("gamepaddisconnected", updateGamepads);
new ResizeObserver(resizeCanvas).observe(screen);

for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    $("drop-message").hidden = em.busy;
    event.dataTransfer.dropEffect = em.busy ? "none" : "copy";
  });
}
window.addEventListener("dragleave", event => {
  if (!event.relatedTarget) $("drop-message").hidden = true;
});
window.addEventListener("drop", event => {
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault();
  $("drop-message").hidden = true;
  if (em.busy) return;
  audio.unlock();
  if (em.game && /\.(sav|srm)$/i.test(file.name)) {
    return run(() => busy(async () => {
      em.importBattery(await readFile(file, 1024 * 1024));
      notice("Save importado. O cartucho foi reiniciado.");
    }));
  }
  if (em.game && /\.sgm$/i.test(file.name)) {
    return run(() => busy(async () => {
      const bytes = await readFile(file, STATE_LIMIT);
      await validateState(bytes);
      em.loadState(bytes);
      em.clearHistory();
      notice("Estado importado.");
    }));
  }
  run(() => busy(() => openRom(file)));
});

em.addEventListener("fault", event => report(event.detail));
em.addEventListener("mode", renderStatus);
em.addEventListener("game", renderGame);
em.addEventListener("stats", renderStats);
em.addEventListener("resolution", () => { renderStats(); resizeCanvas(); });
em.addEventListener("history", () => { $("rewind").disabled = !em.history.length || em.busy; });
em.addEventListener("slots", drawSlots);
em.addEventListener("cheats", updateCheats);
em.addEventListener("printing", () => {
  $("print-button").disabled = false;
  notice("Impressão disponível em Ferramentas.");
});
em.addEventListener("battery", ({ detail }) => {
  const status = detail.restored ? "Save restaurado" : detail.persisted ?
    detail.written ? "Salvo neste navegador" : "Salvamento local" : "Apenas nesta sessão";
  if ($("save-status").textContent !== status) $("save-status").textContent = status;
  if (!detail.persisted && detail.written) notice("O navegador bloqueou o armazenamento. Baixe o save para guardar.", true);
});

setInterval(() => {
  pollPadBinding();
  if (audio.recording?.full) {
    captureAudio();
    notice("Gravação WAV baixada ao atingir o limite de tamanho.");
  }
}, 120);

syncPrefs();
updateBindings();
renderStatus();
// Abrir um jogo escolhido pela biblioteca inicial sem carregar outras ROMs.
// IDs inválidos são ignorados, sem tentar executar caminhos fornecidos pela URL.
em.ready.then(() => {
  if (em.startupError) { report(em.startupError); return; }
  const requested = new URLSearchParams(window.location.search).get("rom");
  if (!requested || !BUNDLED_ROMS.some(entry => entry.id === requested)) return;
  run(() => chooseBundledRom(requested));
});
