// ZIP32, stored entries: no dependency or network access is needed for save exports.
const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dateTime(value) {
  const date = new Date(value);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
  };
}

export function createSaveArchive(entries) {
  if (entries.length > 65535) throw new Error('Troppi file per un archivio ZIP.');
  const local = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') ||
        entry.name.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Percorso non valido nell'archivio: ${entry.name}`);
    }
    const name = encoder.encode(entry.name);
    const data = entry.data;
    if (!(data instanceof Uint8Array) || name.length > 65535 || data.length > 0xffffffff) {
      throw new Error(`File non esportabile: ${entry.name}`);
    }
    const checksum = crc32(data);
    const { date, time } = dateTime(entry.modified);
    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, checksum, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    header.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, checksum, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    record.set(name, 46);
    local.push(header, data);
    central.push(record);
    offset += header.length + data.length;
    centralSize += record.length;
    if (offset + centralSize + 22 > 0xffffffff) throw new Error('Archivio ZIP troppo grande.');
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}
