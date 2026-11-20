// Local game library: lists the games inside a folder chosen by the user without copying them.
// Only the folder handle (Chromium) and a small metadata list are kept in the browser; the game
// file is opened when it is launched and then read lazily by the worker (WORKERFS).
export const GAME_EXTENSIONS = ['.3ds', '.cci', '.cxi', '.app', '.3dsx', '.elf'];
export const MAX_GAMES = 2000;
export const MAX_DEPTH = 8;

export function isGameFile(name) {
  const lower = name.toLowerCase();
  return !lower.startsWith('.') && GAME_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isHidden(name) {
  return name.startsWith('.') || name === '__MACOSX';
}

export function sortGames(games) {
  return games.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }));
}

// Fallback for browsers without showDirectoryPicker (Safari, Firefox): the FileList produced by
// <input type="file" webkitdirectory>. Each File stays valid only for this page session.
export function gamesFromFileList(files) {
  const games = [];
  let truncated = false;
  let folderName = '';
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).split('/');
    folderName ||= parts.length > 1 ? parts[0] : '';
    const inner = parts.length > 1 ? parts.slice(1) : parts;
    if (inner.length > MAX_DEPTH + 1 || inner.slice(0, -1).some(isHidden) || !isGameFile(file.name)) continue;
    if (games.length >= MAX_GAMES) {
      truncated = true;
      break;
    }
    games.push({ name: file.name, path: inner.join('/'), size: file.size, lastModified: file.lastModified, file });
  }
  return { folderName, games: sortGames(games), truncated };
}

// Chromium: walks a FileSystemDirectoryHandle. Only metadata is read (getFile() does not read data).
export async function scanDirectoryHandle(root) {
  const games = [];
  let truncated = false;
  async function walk(dir, prefix, depth) {
    for await (const entry of dir.values()) {
      if (truncated) return;
      if (entry.kind === 'directory') {
        if (depth < MAX_DEPTH && !isHidden(entry.name)) await walk(entry, `${prefix}${entry.name}/`, depth + 1);
        continue;
      }
      if (!isGameFile(entry.name)) continue;
      if (games.length >= MAX_GAMES) {
        truncated = true;
        return;
      }
      const file = await entry.getFile();
      games.push({ name: entry.name, path: prefix + entry.name, size: file.size, lastModified: file.lastModified, handle: entry });
    }
  }
  await walk(root, '', 0);
  return { folderName: root.name, games: sortGames(games), truncated };
}

// Opens the game right before launch and checks it is still readable (moved/changed files fail here).
export async function openGame(game) {
  const file = game.handle ? await game.handle.getFile() : game.file;
  if (!file) throw new Error('File non disponibile: riseleziona la cartella.');
  await file.slice(0, 1).arrayBuffer();
  return file;
}

export function metadataOf(library) {
  return {
    folderName: library.folderName,
    truncated: library.truncated,
    scannedAt: Date.now(),
    games: library.games.map(({ name, path, size, lastModified }) => ({ name, path, size, lastModified })),
  };
}

// ---------------------------------------------------------------- persistence (folder handle only)
const DB_NAME = 'gaemboy3ds-library';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const loadRootHandle = () => withStore('readonly', (store) => store.get('root'));
export const saveRootHandle = (handle) => withStore('readwrite', (store) => store.put(handle, 'root'));
export const forgetRootHandle = () => withStore('readwrite', (store) => store.delete('root'));
