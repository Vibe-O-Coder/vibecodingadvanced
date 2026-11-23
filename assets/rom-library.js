// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const BUNDLED_ROMS = Object.freeze(globalThis.document?.documentElement?.dataset?.bundledRoms === "off" ? [] : [
  {
    "id": "pokemon-firered",
    "filename": "Pokemon - FireRed.gba",
    "title": "Pokémon FireRed",
    "subtitle": "Kanto · Vermelho Fogo",
    "system": "GBA",
    "theme": "fire",
    "size": 16777216,
    "checksum": 2230208374
  },
  {
    "id": "pokemon-firered-completo",
    "filename": "FireRed (Pokedex completável sem troca).gba",
    "title": "FireRed: Pokédex sem trocas",
    "subtitle": "Edição modificada · Kanto",
    "system": "GBA",
    "theme": "special",
    "size": 16777216,
    "checksum": 1438878747
  },
  {
    "id": "pokemon-leafgreen",
    "filename": "Pokemon - LeafGreen Version.gba",
    "title": "Pokémon LeafGreen",
    "subtitle": "Kanto · Verde Folha",
    "system": "GBA",
    "theme": "leaf",
    "size": 16777216,
    "checksum": 3674205420
  },
  {
    "id": "pokemon-emerald",
    "filename": "Pokemon - Emerald.gba",
    "title": "Pokémon Emerald",
    "subtitle": "Hoenn · Esmeralda",
    "system": "GBA",
    "theme": "emerald",
    "size": 16777216,
    "checksum": 521931003
  },
  {
    "id": "pokemon-ruby",
    "filename": "Pokemon - Ruby Version.gba",
    "title": "Pokémon Ruby",
    "subtitle": "Hoenn · Rubi",
    "system": "GBA",
    "theme": "ruby",
    "size": 16777216,
    "checksum": 2930537446
  },
  {
    "id": "pokemon-sapphire",
    "filename": "Pokemon - Sapphire Version.gba",
    "title": "Pokémon Sapphire",
    "subtitle": "Hoenn · Safira",
    "system": "GBA",
    "theme": "sapphire",
    "size": 16777216,
    "checksum": 2630107406
  },
  {
    "id": "pokemon-crystal",
    "filename": "Pokemon - Crystal Version.gbc",
    "title": "Pokémon Crystal",
    "subtitle": "Johto · Cristal",
    "system": "GBC",
    "theme": "crystal",
    "size": 2097152,
    "checksum": 861463306
  },
  {
    "id": "pokemon-gold",
    "filename": "Pokemon - Gold Version.gbc",
    "title": "Pokémon Gold",
    "subtitle": "Johto · Ouro",
    "system": "GBC",
    "theme": "gold",
    "size": 2097152,
    "checksum": 1809726526
  },
  {
    "id": "pokemon-silver",
    "filename": "Pokemon - Silver Version.gbc",
    "title": "Pokémon Silver",
    "subtitle": "Johto · Prata",
    "system": "GBC",
    "theme": "silver",
    "size": 2097152,
    "checksum": 2329183798
  }
]);

// ROMs ficam em scripts individuais para funcionar com file:// e HTTP(S).
// Somente o cartucho escolhido é carregado na memória.
function fetchBundledScript(entry) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = "roms/" + entry.id + ".js";
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => {
      script.remove();
      reject(new Error("Não foi possível ler o jogo incluído. Confira se a pasta roms/ foi extraída junto com o site."));
    };
    document.head.appendChild(script);
  });
}

async function openBundledRom(id) {
  const entry = BUNDLED_ROMS.find(item => item.id === id);
  if (!entry) throw new Error("Jogo não encontrado na biblioteca.");
  await fetchBundledScript(entry);
  const data = window.VBA_ROM_PACKS?.[id];
  if (window.VBA_ROM_PACKS) delete window.VBA_ROM_PACKS[id];
  if (typeof data !== "string" || !data.length) throw new Error("Os dados do jogo estão ausentes.");
  const compressed = decodeBase64(data);
  const bytes = await inflate(compressed, "gzip", entry.size);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.checksum) {
    throw new Error("A ROM incluída está incompleta ou corrompida.");
  }
  // A ROM já foi validada acima, reutilize o CRC para o ID dos saves.
  return describeRom(entry.filename, bytes, 0, entry.checksum);
}
