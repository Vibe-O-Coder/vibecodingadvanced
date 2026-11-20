// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

function read16(bytes, offset) {
  return (bytes[offset] || 0) | ((bytes[offset + 1] || 0) << 8);
}

function color15(pixel) {
  const r = pixel & 31;
  const g = (pixel >> 5) & 31;
  const b = (pixel >> 10) & 31;
  return (0xff000000 | ((b << 3 | b >> 2) << 16) |
    ((g << 3 | g >> 2) << 8) | (r << 3 | r >> 2)) >>> 0;
}

function numberInput(text, base = 16) {
  const value = text.trim();
  const pattern = base === 16 ? /^(?:0x)?[\da-f]{1,8}$/i : /^(?:0x[\da-f]{1,8}|\d{1,10})$/i;
  if (!pattern.test(value)) throw new Error("Informe um número válido.");
  const number = base === 16 ? Number.parseInt(value.replace(/^0x/i, ""), 16) : Number(value);
  if (number > 0xffffffff) throw new Error("O valor ultrapassa 32 bits.");
  return number >>> 0;
}

class DebuggerPanel {
  constructor(session, notice) {
    this.session = session;
    this.notice = notice;
    const el = id => document.getElementById(id);
    this.view = el("debug-view");
    this.mode = el("debug-mode");
    this.address = el("debug-address");
    this.graphics = el("debug-graphics");
    this.depth = el("debug-depth");
    this.graph = el("debug-canvas");
    this.result = el("debug-output");
    this.log = el("agb-log");
    this.searchValue = el("search-value");
    this.searchWidth = el("search-width");
    this.searchMode = el("search-mode");
    this.searchCount = el("search-count");
    this.searchResults = el("search-results");
    this.search = null;
    session.addEventListener("game", () => this.reset());
    for (const input of [this.view, this.mode, this.address, this.graphics, this.depth]) {
      input.addEventListener("change", () => this.safely(() => this.render()));
    }
    this.searchWidth.addEventListener("change", () => this.clearSearch());
    setInterval(() => {
      if (session.game && el("tools").open && !el("debug-view").closest("[data-panel]").hidden && !session.busy) {
        this.safely(() => this.render());
      }
    }, 350);
  }

  get gb() { return this.session.game?.type === 2; }
  get core() { return this.session.core; }
  get m() { return this.session.m; }

  safely(action) {
    try { action(); } catch (error) { this.notice(error.message, true); }
  }

  reset() {
    this.address.value = this.gb ? "C000" : "02000000";
    this.result.textContent = "";
    this.graph.hidden = true;
    this.clearSearch();
  }

  run(name) {
    if (!this.session.game) return;
    this.safely(() => {
      if (name === "instruction") this.session.step(true);
      if (name === "poke") this.poke();
      if (name === "dump") this.dump();
      if (name === "search-start") return this.startSearch();
      if (name === "search-filter") return this.filterSearch();
      this.render();
    });
  }

  render() {
    if (!this.session.game) return;
    const type = this.view.value;
    const picture = ["palette", "tiles", "map", "sprites"].includes(type);
    document.getElementById("debug-mode-label").hidden = this.gb || type !== "register";
    document.getElementById("debug-address-label").hidden = type !== "memory";
    document.getElementById("debug-graphics-label").hidden = !["tiles", "map", "sprites"].includes(type) ||
      this.gb && type !== "tiles";
    document.getElementById("debug-depth-label").hidden = this.gb || type !== "tiles";
    document.getElementById("memory-actions").hidden = type !== "memory";
    this.graph.hidden = !picture;
    this.log.textContent = this.session.prefs.agbPrint ? this.core.agbLog() : "";
    if (picture) {
      this.result.textContent = this.draw(type) || "";
    } else if (type === "register") {
      this.result.textContent = this.registers();
    } else {
      const base = type === "io" ? (this.gb ? 0xff00 : 0x04000000) :
        numberInput(this.address.value) & (this.gb ? 0xffff : 0xffffffff);
      this.result.textContent = this.memoryDump(base >>> 0);
    }
  }

  registers() {
    const names = this.gb ? ["AF", "BC", "DE", "HL", "SP", "PC", "IFF"] :
      Array.from({ length: 17 }, (_, i) => ["SP", "LR", "PC", "CPSR"][i - 13] || "R" + i);
    const lines = [];
    let row = [];
    for (let i = 0; i < names.length; i++) {
      row.push(names[i].padEnd(4) + hex(this.m._vba_register(i), this.gb ? 4 : 8));
      if (row.length === 4 || i === names.length - 1) {
        lines.push(row.join("   "));
        row = [];
      }
    }
    const pc = this.m._vba_register(this.gb ? 5 : 15) >>> 0;
    return lines.join("\n") + "\n\n" + this.core.instructions(pc, Number(this.mode.value), 18).join("\n");
  }

  memoryDump(base) {
    const rows = [];
    const bytes = this.core.memory(base, 256);
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = [...bytes.subarray(i, i + 16)];
      const preview = chunk.map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".").join("");
      const address = (base + i) >>> 0;
      rows.push(hex(this.gb ? address & 0xffff : address, this.gb ? 4 : 8) + "  " +
        chunk.map(byte => hex(byte)).join(" ") + "   " + preview);
    }
    return rows.join("\n");
  }

  poke() {
    const address = numberInput(this.address.value);
    const value = numberInput(document.getElementById("poke-value").value);
    const size = value > 0xffff ? 4 : value > 0xff ? 2 : 1;
    const ranges = this.gb ? [[0xc000, 0xdfff], [0xff80, 0xfffe]] :
      [[0x02000000, 0x0203ffff], [0x03000000, 0x03007fff]];
    if (!ranges.some(([min, max]) => address >= min && address + size - 1 <= max) ||
        address % size || (this.gb && size !== 1)) {
      throw new Error("Use um endereço alinhado de WRAM, IWRAM ou HRAM. No Game Boy, escreva um byte por vez.");
    }
    this.m._vba_poke(address, value, size);
  }

  dump() {
    const base = numberInput(this.address.value);
    downloadFile("memoria-" + hex(base, this.gb ? 4 : 8) + ".bin", this.core.memory(base, 256));
  }

  draw(view) {
    return this.gb ? this.gbGraphics(view) : this.gbaGraphics(view);
  }

  image(width, height, draw) {
    this.graph.width = width;
    this.graph.height = height;
    const context = this.graph.getContext("2d", { alpha: false });
    const frame = context.createImageData(width, height);
    const pixels = new Uint32Array(frame.data.buffer);
    pixels.fill(0xff1a1410);
    const put = (x, y, value) => {
      if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = color15(value);
    };
    draw(put);
    context.putImageData(frame, 0, 0);
  }

  paletteImage(colors) {
    this.image(256, Math.ceil(colors.length / 16) * 12, put => {
      for (let i = 0; i < colors.length; i++) {
        for (let y = 0; y < 11; y++) for (let x = 0; x < 15; x++) {
          put(i % 16 * 16 + x, Math.floor(i / 16) * 12 + y, colors[i]);
        }
      }
    });
  }

  gbaGraphics(view) {
    const palette = this.core.memory(0x05000000, 1024);
    const colors = Uint16Array.from({ length: 512 }, (_, i) => read16(palette, i * 2));
    if (view === "palette") {
      this.paletteImage(colors);
      return "Primeiras 16 linhas · BG\nÚltimas 16 linhas · OBJ";
    }
    const vram = this.core.memory(0x06000000, 0x18000);
    const io = this.core.memory(0x04000000, 16);
    const videoMode = io[0] & 7;
    const bank = Number(this.graphics.value);
    const tilePixel = (offset, x, y, eightBits) => {
      if (eightBits) return vram[offset + y * 8 + x] || 0;
      const byte = vram[offset + y * 4 + (x >> 1)] || 0;
      return (byte >> ((x & 1) * 4)) & 15;
    };

    if (view === "tiles") {
      const eightBits = this.depth.value === "8";
      const length = eightBits ? 64 : 32;
      this.image(256, 128, put => {
        for (let tile = 0; tile < 512; tile++) {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const index = tilePixel(bank * 0x4000 + tile * length, x, y, eightBits);
            put(tile % 32 * 8 + x, (tile >> 5) * 8 + y, colors[index]);
          }
        }
      });
      return "VRAM 0x" + hex(0x06000000 + bank * 0x4000, 8);
    }

    if (view === "map") {
      if (videoMode >= 3 && videoMode <= 5) {
        const width = videoMode === 5 ? 160 : 240;
        const height = videoMode === 5 ? 128 : 160;
        const page = videoMode !== 3 && (io[0] & 16) ? 0xa000 : 0;
        this.image(width, height, put => {
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const index = y * width + x;
            put(x, y, videoMode === 4 ? colors[vram[page + index]] : read16(vram, page + index * 2));
          }
        });
        return "BG2 · bitmap · modo " + videoMode;
      }
      const affine = (videoMode === 1 && bank === 2) || (videoMode === 2 && bank >= 2);
      const control = read16(io, 8 + bank * 2);
      const size = control >> 14;
      const width = affine ? Math.min(512, 128 << size) : (size & 1) ? 512 : 256;
      const height = affine ? width : (size & 2) ? 512 : 256;
      const charStart = ((control >> 2) & 3) * 0x4000;
      const screenStart = ((control >> 8) & 31) * 0x800;
      const eight = affine || !!(control & 128);
      const tilesAcross = affine ? (128 << size) / 8 : width / 8;
      this.image(width, height, put => {
        for (let ty = 0; ty < height / 8; ty++) for (let tx = 0; tx < width / 8; tx++) {
          const block = ((ty >> 5) * (width >> 8) + (tx >> 5)) * 0x800;
          const mapOffset = screenStart + block + (((ty & 31) * 32 + (tx & 31)) * 2);
          const entry = affine ? vram[screenStart + ty * tilesAcross + tx] || 0 : read16(vram, mapOffset);
          const offset = charStart + (entry & (affine ? 255 : 1023)) * (eight ? 64 : 32);
          const colorBank = eight ? 0 : (entry >> 12) * 16;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const sx = entry & 0x400 ? 7 - x : x;
            const sy = entry & 0x800 ? 7 - y : y;
            put(tx * 8 + x, ty * 8 + y, colors[colorBank + tilePixel(offset, sx, sy, eight)]);
          }
        }
      });
      return "BG" + bank + " · " + (affine ? "afim" : "tiles") + " · " + width + " × " + height;
    }

    const oam = this.core.memory(0x07000000, 1024);
    const sizes = [
      [[8, 8], [16, 16], [32, 32], [64, 64]],
      [[16, 8], [32, 8], [32, 16], [64, 32]],
      [[8, 16], [8, 32], [16, 32], [32, 64]]
    ];
    const entries = [];
    this.image(512, 4 * 64, put => {
      for (let i = 0; i < 32; i++) {
        const index = bank * 32 + i;
        const a0 = read16(oam, index * 8);
        const a1 = read16(oam, index * 8 + 2);
        const a2 = read16(oam, index * 8 + 4);
        entries.push(hex(index) + "  " + [a0, a1, a2].map(value => hex(value, 4)).join(" "));
        const shape = a0 >> 14;
        if (shape === 3 || (a0 & 0x300) === 0x200) continue;
        const [w, h] = sizes[shape][a1 >> 14];
        const eight = !!(a0 & 0x2000);
        const tileStart = (a2 & 1023) & (eight ? ~1 : ~0);
        const colorBank = eight ? 256 : 256 + (a2 >> 12) * 16;
        const pitch = io[0] & 0x40 ? (w / 8) * (eight ? 2 : 1) : 32;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const tile = tileStart + (y >> 3) * pitch + (x >> 3) * (eight ? 2 : 1);
          const pixel = tilePixel(0x10000 + tile * 32, x & 7, y & 7, eight);
          if (pixel) put((i % 8) * 64 + x, (i >> 3) * 64 + y, colors[colorBank + pixel]);
        }
      }
    });
    return "OBJ   ATR0 ATR1 ATR2\n" + entries.join("\n");
  }

  gbGraphics(view) {
    const palette = this.m._vba_gb_palette() >> 1;
    const colors = new Uint16Array(this.m.HEAPU8.buffer).slice(palette, palette + 64);
    if (view === "palette") {
      this.paletteImage(colors);
      return "Paletas BG e OBJ";
    }
    const bank = Number(this.graphics.value) & 1;
    const readBank = number => this.core.withHeap(8192, pointer => {
      this.m._vba_gb_graphics(number, pointer);
      return this.m.HEAPU8.slice(pointer, pointer + 8192);
    });
    const vram = [readBank(0), readBank(1)];
    const io = this.core.memory(0xff40, 0x30);
    const gbc = this.session.game.gbc || Number(this.session.prefs.board) === 1;
    const tile = (bankIndex, base, x, y) => {
      const low = vram[bankIndex][base + y * 2] || 0;
      const high = vram[bankIndex][base + y * 2 + 1] || 0;
      return (low >> (7 - x) & 1) | ((high >> (7 - x) & 1) << 1);
    };
    if (view === "tiles") {
      this.image(192, 128, put => {
        for (let i = 0; i < 384; i++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          put((i % 24) * 8 + x, Math.floor(i / 24) * 8 + y, colors[tile(bank, i * 16, x, y)]);
        }
      });
      return "Banco VRAM " + bank;
    }
    if (view === "map") {
      const base = io[0] & 8 ? 0x1c00 : 0x1800;
      this.image(256, 256, put => {
        for (let i = 0; i < 1024; i++) {
          const index = vram[0][base + i];
          const attr = gbc ? vram[1][base + i] : 0;
          const offset = (io[0] & 16) ? index * 16 : 0x1000 + ((index << 24) >> 24) * 16;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const sx = attr & 32 ? 7 - x : x;
            const sy = attr & 64 ? 7 - y : y;
            const pixel = tile(attr >> 3 & 1, offset, sx, sy);
            const colorIndex = gbc ? (attr & 7) * 4 + pixel : (io[7] >> (pixel * 2)) & 3;
            put((i % 32) * 8 + x, (i >> 5) * 8 + y, colors[colorIndex]);
          }
        }
      });
      return "Mapa BG em 0x" + hex(0x8000 + base, 4);
    }
    const oam = this.core.memory(0xfe00, 160);
    const h = io[0] & 4 ? 16 : 8;
    this.image(160, 4 * 20, put => {
      for (let i = 0; i < 40; i++) {
        const attr = oam[i * 4 + 3];
        const index = oam[i * 4 + 2] & (h === 16 ? 254 : 255);
        for (let y = 0; y < h; y++) for (let x = 0; x < 8; x++) {
          const pixel = tile(gbc ? (attr >> 3) & 1 : 0, index * 16,
            attr & 32 ? 7 - x : x, attr & 64 ? h - 1 - y : y);
          const objPalette = attr & 16 ? 1 : 0;
          const colorIndex = gbc ? 32 + (attr & 7) * 4 + pixel :
            4 + objPalette * 4 + ((io[8 + objPalette] >> (pixel * 2)) & 3);
          if (pixel) put((i % 10) * 16 + x, Math.floor(i / 10) * 20 + y, colors[colorIndex]);
        }
      }
    });
    return "40 objetos · " + h + " linhas por sprite";
  }

  clearSearch() {
    this.search = null;
    this.searchCount.textContent = "";
    this.searchResults.textContent = "";
  }

  captureRam() {
    return [new DataView(this.core.memory(0x02000000, 0x40000).buffer),
      new DataView(this.core.memory(0x03000000, 0x8000).buffer)];
  }

  startSearch() {
    if (this.gb) throw new Error("A busca de valores está disponível no GBA.");
    this.search = { previous: this.captureRam(), matches: null, width: Number(this.searchWidth.value) };
    this.searchCount.textContent = "RAM capturada. Altere o valor no jogo ou faça o primeiro filtro.";
    this.searchResults.textContent = "";
  }

  filterSearch() {
    if (!this.search) throw new Error("Capture a RAM antes do primeiro filtro.");
    const mode = this.searchMode.value;
    const wanted = mode === "eq" || mode === "ne" ? numberInput(this.searchValue.value, 10) : 0;
    const { previous, matches, width } = this.search;
    const current = this.captureRam();
    const read = ["", "getUint8", "getUint16", "", "getUint32"][width];
    const compare = {
      eq: (now) => now === wanted,
      ne: (now) => now !== wanted,
      changed: (now, old) => now !== old,
      same: (now, old) => now === old,
      up: (now, old) => now > old,
      down: (now, old) => now < old
    }[mode];
    const output = [];
    const bases = [0x02000000, 0x03000000];
    this.search.matches = current.map((view, bank) => {
      const next = [];
      const candidates = matches?.[bank] || Array.from({ length: view.byteLength / width }, (_, i) => i * width);
      for (const offset of candidates) {
        const now = view[read](offset, true);
        if (compare(now, previous[bank][read](offset, true))) {
          next.push(offset);
          if (output.length < 80) output.push(hex(bases[bank] + offset, 8) + "  " + now);
        }
      }
      return next;
    });
    this.search.previous = current;
    this.searchCount.textContent = this.search.matches.reduce((count, bank) => count + bank.length, 0) +
      " endereços. A lista mostra até 80.";
    this.searchResults.textContent = output.join("\n");
  }
}
