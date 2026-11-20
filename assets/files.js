// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const FILE_LIMIT = 128 * 1024 * 1024;
const STATE_LIMIT = 16 * 1024 * 1024;
const ROM_EXTENSIONS = /\.(gba|agb|bin|mb|gb|gbc|cgb|dmg|sgb)$/i;
const GB_EXTENSIONS = /\.(gb|gbc|cgb|dmg|sgb)$/i;
const DECODER = new TextDecoder();
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function hex(n, width = 2) {
  return (n >>> 0).toString(16).toUpperCase().padStart(width, "0");
}

function decodeBase64(base64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const parts = [];
  for (let start = 0; start < bytes.length; start += 0x4000) {
    parts.push(String.fromCharCode(...bytes.subarray(start, start + 0x4000)));
  }
  return btoa(parts.join(""));
}

function fileBase(name) {
  return name.split(/[\\/]/).pop();
}

function fileStem(name) {
  return fileBase(name).replace(/\.[^.]+$/, "").replace(/[\x00-\x1F:*?"<>|]/g, "_") || "cartucho";
}

function downloadFile(filename, data, type = "application/octet-stream") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function readFile(file, max = FILE_LIMIT) {
  if (!file.size || file.size > max) {
    throw new Error("O arquivo está vazio ou ultrapassa o limite de " + Math.ceil(max / 1048576) + " MiB.");
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function inflate(bytes, format, max) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Este navegador precisa de uma atualização para ler arquivos compactados.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new Error("O conteúdo descompactado excede o limite permitido.");
      parts.push(value);
    }
    if (!length) throw new Error("O arquivo compactado está vazio.");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) {
      break;
    }
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error("O diretório do ZIP está incompleto.");
  const count = view.getUint16(end + 10, true);
  const start = view.getUint32(end + 16, true);
  const directorySize = view.getUint32(end + 12, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
      view.getUint16(end + 8, true) !== count || count > 4096 || start + directorySize > end) {
    throw new Error("ZIP multipartido, ZIP64 ou diretório inválido.");
  }
  const entries = [];
  let cursor = start;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Entrada do ZIP inválida.");
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (next > start + directorySize) throw new Error("Entrada do ZIP incompleta.");
    const name = DECODER.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const method = view.getUint16(cursor + 10, true);
    const flags = view.getUint16(cursor + 8, true);
    const size = view.getUint32(cursor + 24, true);
    const packed = view.getUint32(cursor + 20, true);
    const offset = view.getUint32(cursor + 42, true);
    const checksum = view.getUint32(cursor + 16, true);
    if (ROM_EXTENSIONS.test(name) && !(flags & 1) && (method === 0 || method === 8) &&
        size > 0 && size <= FILE_LIMIT && packed > 0 && offset + 30 <= start &&
        !name.startsWith("__MACOSX/") && !fileBase(name).startsWith("._")) {
      entries.push({ name, method, size, packed, offset, checksum, end: start });
    }
    cursor = next;
  }
  if (!entries.length) throw new Error("O ZIP não contém uma ROM compatível e desprotegida.");
  return entries;
}

async function extractZip(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.getUint32(entry.offset, true) !== 0x04034b50 ||
      view.getUint16(entry.offset + 8, true) !== entry.method ||
      (view.getUint16(entry.offset + 6, true) & 1)) {
    throw new Error("O cabeçalho da ROM dentro do ZIP é inválido.");
  }
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  if (start + entry.packed > entry.end) throw new Error("A ROM dentro do ZIP está incompleta.");
  const body = bytes.subarray(start, start + entry.packed);
  const data = entry.method === 8 ? await inflate(body, "deflate-raw", entry.size) : body.slice();
  if (data.length !== entry.size || crc32(data) !== entry.checksum) {
    throw new Error("A ROM dentro do ZIP falhou na verificação de integridade.");
  }
  return data;
}

function romType(name, bytes) {
  if (/\.mb$/i.test(name)) return 3;
  if (GB_EXTENSIONS.test(name) || (bytes[0x104] === 0xce && bytes[0x105] === 0xed &&
      bytes[0x106] === 0x66 && bytes[0x107] === 0x66)) return 2;
  if (/\.(gba|agb)$/i.test(name) || bytes[0xb2] === 0x96) return 1;
  throw new Error("Selecione uma ROM de Game Boy Advance, Game Boy ou Game Boy Color.");
}

function romIdentity(type, size, checksum) {
  return type + "-" + size + "-" + hex(checksum, 8);
}

async function describeRom(name, bytes, forcedType = 0, knownChecksum = null) {
  const type = forcedType || romType(name, bytes);
  const max = type === 2 ? 8 * 1024 * 1024 : type === 3 ? 256 * 1024 : FILE_LIMIT;
  if (bytes.length < (type === 2 ? 0x150 : 0xc0) || bytes.length > max) {
    throw new Error("O tamanho do cartucho é inválido.");
  }

  const rawText = (start, end) => DECODER.decode(bytes.subarray(start, end))
    .split("\0")[0].replace(/[^\x20-\x7e]/g, "").trim();
  const gbc = type === 2 && !!(bytes[0x143] & 0x80);
  const sgb = type === 2 && bytes[0x146] === 3 && bytes[0x14b] === 0x33;
  const system = type !== 2 ? "Game Boy Advance" : gbc ? "Game Boy Color" : sgb ? "Super Game Boy" : "Game Boy";
  const nameInRom = type === 2 ? rawText(0x134, gbc ? 0x143 : 0x144) : rawText(0xa0, 0xac);
  const code = type === 1 ? rawText(0xac, 0xb0) : "";
  const id = romIdentity(type, bytes.length, knownChecksum ?? crc32(bytes));
  return { bytes, type, gbc, system, code, id, filename: fileBase(name), title: nameInRom || fileStem(name) };
}

async function openRomFile(file, pickEntry) {
  let bytes = await readFile(file, FILE_LIMIT + 2 * 1024 * 1024);
  let name = file.name;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  if (zip || /\.zip$/i.test(name)) {
    const entries = zipDirectory(bytes);
    const entry = entries.length === 1 ? entries[0] : await pickEntry(entries);
    if (!entry) return null;
    bytes = await extractZip(bytes, entry);
    name = entry.name;
  } else if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || /\.(gz|z)$/i.test(name)) {
    bytes = await inflate(bytes, "gzip", FILE_LIMIT);
    name = name.replace(/\.(gz|z)$/i, "");
  }
  return describeRom(name, bytes);
}

async function validateState(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error("O estado precisa estar no formato .sgm do VisualBoyAdvance.");
  }
  try {
    await inflate(bytes, "gzip", STATE_LIMIT);
  } catch {
    throw new Error("O estado está incompleto, corrompido ou grande demais.");
  }
}

const sameBytes = (left, right) =>
  left === right || (left && right && left.length === right.length && left.every((byte, i) => byte === right[i]));

const LOCAL_BATTERY_PREFIX = "vba-web-library-save:";

class LocalVault {
  constructor(libraryBatteryKeys = []) {
    this.memory = new Map();
    this.libraryBatteryKeys = new Set(libraryBatteryKeys);
    this.db = null;
    this.ready = new Promise(resolve => {
      try {
        const request = indexedDB.open("vba-web-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onsuccess = () => {
          this.db = request.result;
          this.db.onversionchange = () => {
            this.db.close();
            this.db = null;
          };
          resolve();
        };
        request.onerror = request.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async read(key) {
    if (this.libraryBatteryKeys.has(key)) {
      const stored = await this.readDatabase(key);
      // A cópia síncrona pode ser mais recente que a última transação confirmada.
      let latest = this.memory.get(key);
      for (const record of [stored, this.readBatteryCopy(key)]) {
        if (record?.bytes?.length && (record.updated ?? 0) >= (latest?.updated ?? 0)) latest = record;
      }
      if (latest) this.memory.set(key, latest);
      return latest;
    }

    if (this.memory.has(key)) return this.memory.get(key);
    const stored = await this.readDatabase(key);
    if (!this.memory.has(key)) this.memory.set(key, stored);
    return this.memory.get(key);
  }

  async readDatabase(key) {
    await this.ready;
    if (!this.db) return undefined;
    return new Promise(resolve => {
      try {
        const request = this.db.transaction("files").objectStore("files").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  readBatteryCopy(key) {
    try {
      const record = JSON.parse(localStorage.getItem(LOCAL_BATTERY_PREFIX + key));
      if (typeof record?.data !== "string" || !record.data || !Number.isFinite(record.updated)) return undefined;
      return { bytes: decodeBase64(record.data), updated: record.updated };
    } catch {
      return undefined;
    }
  }

  writeBatteryCopy(key, { bytes, updated }) {
    try {
      localStorage.setItem(LOCAL_BATTERY_PREFIX + key, JSON.stringify({ data: encodeBase64(bytes), updated }));
      return true;
    } catch {
      return false;
    }
  }

  canStoreBattery(key) {
    if (this.db) return true;
    if (!this.libraryBatteryKeys.has(key)) return false;
    try {
      const probe = LOCAL_BATTERY_PREFIX + "available";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  async write(key, value) {
    const isLibrarySave = this.libraryBatteryKeys.has(key) && value !== undefined;
    if (isLibrarySave) {
      const previous = this.memory.get(key)?.updated ?? 0;
      value = { ...value, updated: Math.max(value.updated, previous + 1) };
    }
    this.memory.set(key, value);
    // Grava dentro do evento de saída, quando o IndexedDB ainda pode ser interrompido.
    const copied = isLibrarySave && this.writeBatteryCopy(key, value);
    const committed = this.writeDatabase(key, value);
    return copied || await committed;
  }

  async writeDatabase(key, value) {
    if (!this.db) await this.ready;
    if (!this.db) return false;
    return new Promise(resolve => {
      try {
        const tx = this.db.transaction("files", "readwrite");
        const store = tx.objectStore("files");
        if (value === undefined) store.delete(key);
        else store.put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onabort = tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }
}
