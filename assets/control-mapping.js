// SPDX-License-Identifier: GPL-2.0-or-later
"use strict";

const SiteControls = (() => {
  const padInputs = new Map();
  const padModels = new WeakMap();
  const keyboardLabels = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Espaço",
    Backspace: "Backspace", ShiftLeft: "Shift esquerdo", ShiftRight: "Shift direito",
  };
  const validPadInput = /^(button:\d{1,3}|axis:\d{1,3}:(-1|1))$/;
  const axisInputs = (index) => [`axis:${index}:-1`, `axis:${index}:1`];
  const buttonInput = (index) => `button:${index}`;
  function modelName(pad) {
    if (!padModels.has(pad)) padModels.set(pad, `${pad.id} (${pad.mapping || "sem layout padrão"})`);
    return padModels.get(pad);
  }

  function gamepads() {
    try { return Array.from(navigator.getGamepads?.() || []).filter(pad => pad?.connected); }
    catch { return []; }
  }

  function padValue(pad, input) {
    if (!input || !pad) return 0;
    if (!padInputs.has(input)) {
      const [kind, index, direction] = input.split(":");
      padInputs.set(input, { axis: kind === "axis", index: Number(index), direction: Number(direction) });
    }
    const { axis, index, direction } = padInputs.get(input);
    if (axis) return Math.max(0, (pad.axes[index] || 0) * direction);
    const button = pad.buttons[index];
    return button?.value || (button?.pressed ? 1 : 0);
  }

  function inputLevel(pad, inputs) {
    let level = 0;
    for (const input of inputs) level = Math.max(level, padValue(pad, input));
    return level;
  }

  function keyLabel(code) {
    return code ? keyboardLabels[code] || code.replace(/^(Key|Digit)/, "") : "Sem tecla";
  }

  function padLabel(input) {
    const [kind, index, direction] = input.split(":");
    return kind === "axis" ? `Eixo ${Number(index) + 1} ${direction < 0 ? "−" : "+"}` : `Botão ${Number(index) + 1}`;
  }

  function activeInputs(pad) {
    const active = [];
    if (!pad) return active;
    pad.buttons.forEach((button, index) => {
      if (button.pressed || button.value > .7) active.push(buttonInput(index));
    });
    pad.axes.forEach((value, index) => {
      if (Math.abs(value) > .65) active.push(axisInputs(index)[value < 0 ? 0 : 1]);
    });
    return active;
  }

  function create({ id, actions, button, clearInput, focusGame, defaultPad }) {
    const storageKey = `web-controls:${id}`;
    let preferences;
    try { preferences = JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { /* Storage can be blocked. */ }
    const keyboard = Object.assign(Object.create(null), preferences?.keyboard);
    const profiles = Object.assign(Object.create(null), preferences?.profiles);
    const actionList = new Map(actions.map(action => [action.id, action]));
    for (const [id, key] of Object.entries(keyboard)) {
      if (key !== null && typeof key !== "string") delete keyboard[id];
    }
    for (const [model, profile] of Object.entries(profiles)) {
      if (!profile || typeof profile !== "object") { delete profiles[model]; continue; }
      for (const [id, inputs] of Object.entries(profile)) {
        if (!Array.isArray(inputs) || !inputs.every(input => typeof input === "string" && validPadInput.test(input))) {
          delete profile[id];
        }
      }
    }
    const keyMap = new Map();
    const keyFor = (action) => Object.hasOwn(keyboard, action.id) ? keyboard[action.id] : action.key;
    function refreshKeyMap() {
      keyMap.clear();
      for (const action of actions) {
        const key = keyFor(action);
        if (typeof key === "string" && key) keyMap.set(key, action.id);
      }
    }
    refreshKeyMap();

    function inputsFor(pad, action) {
      const stored = pad && profiles[modelName(pad)]?.[action.id];
      if (Array.isArray(stored)) return stored;
      return defaultPad?.(action) ?? action.pad ?? [];
    }

    const save = () => {
      try { localStorage.setItem(storageKey, JSON.stringify({ keyboard, profiles })); } catch { /* This session still has the mapping. */ }
    };
    const dialog = document.createElement("dialog");
    dialog.className = "site-controls-dialog";
    dialog.lang = "pt-BR";
    dialog.setAttribute("aria-label", "Configurar controles");
    dialog.innerHTML = `<header><h2>Controles</h2><button type="button" data-close>Fechar</button></header>
      <div class="site-controls-options"><label>Controle físico <select data-pad></select></label></div>
      <p class="site-controls-message" role="status"></p>
      <div class="site-controls-grid" aria-label="Mapeamento de comandos">
        <strong>Comando</strong><strong>Teclado</strong><strong>Controle físico</strong>
      </div>
      <footer><button type="button" data-reset-keyboard>Restaurar teclado</button>
        <button type="button" data-reset-pad>Restaurar controle</button></footer>`;
    const select = dialog.querySelector("[data-pad]");
    const status = dialog.querySelector("[role=status]");
    const grid = dialog.querySelector(".site-controls-grid");
    const resetPad = dialog.querySelector("[data-reset-pad]");
    const rows = new Map();
    let capture = null;
    let frame = 0;
    let padList = "";
    const selectedPad = (pads = gamepads()) => pads.find(pad => String(pad.index) === select.value);

    function refreshDevices(pads) {
      const names = JSON.stringify(pads.map(pad => [pad.index, modelName(pad)]));
      if (names === padList) return;
      padList = names;
      const previous = select.value;
      select.replaceChildren(...pads.map(pad => new Option(pad.id || "Controle físico", pad.index)));
      if (pads.some(pad => String(pad.index) === previous)) select.value = previous;
      if (!pads.length) select.add(new Option("Nenhum controle detectado", ""));
      select.disabled = !pads.length;
      render(selectedPad(pads));
    }

    function render(pad = selectedPad()) {
      resetPad.disabled = !pad;
      for (const action of actions) {
        const row = rows.get(action.id);
        const isLearning = capture?.action === action;
        row.key.textContent = isLearning && capture.kind === "key" ? "Pressione…" : keyLabel(keyFor(action));
        row.pad.textContent = isLearning && capture.kind === "pad" ? "Pressione…" : inputsFor(pad, action).map(padLabel).join(" / ") || "Vincular";
      }
    }

    function begin(action, kind) {
      const pad = selectedPad();
      capture = { action, kind, model: pad ? modelName(pad) : null, blocked: new Set(activeInputs(pad)) };
      status.textContent = kind === "key" ? `Pressione a tecla para ${action.label}.` :
        `Pressione um botão ou mova um analógico para ${action.label}.`;
      render();
    }

    function assignKey(code) {
      const { action } = capture;
      const old = keyFor(action);
      const conflict = keyMap.get(code);
      if (conflict && conflict !== action.id) keyboard[conflict] = old || null;
      keyboard[action.id] = code;
      refreshKeyMap();
    }

    function assignPad(pad, input) {
      const { action } = capture;
      const model = modelName(pad);
      const profile = profiles[model] = Object.assign(Object.create(null), profiles[model]);
      const conflict = actions.find(item => item !== action && inputsFor(pad, item).includes(input));
      if (conflict) profile[conflict.id] = inputsFor(pad, action).filter(value => value !== input);
      profile[action.id] = [input];
    }

    function finish() {
      save();
      status.textContent = `${capture.action.label} atualizado.`;
      capture = null;
      render();
    }

    function poll() {
      const pads = gamepads();
      refreshDevices(pads);
      const pad = selectedPad(pads);
      if (capture?.kind === "pad" && pad) {
        const model = modelName(pad);
        if (capture.model !== model) {
          capture.model = model;
          capture.blocked.clear();
        }
        const held = activeInputs(pad);
        for (const input of capture.blocked) if (!held.includes(input)) capture.blocked.delete(input);
        const binding = held.find(input => !capture.blocked.has(input) && validPadInput.test(input));
        if (binding) {
          assignPad(pad, binding);
          finish();
        }
      }
      frame = requestAnimationFrame(poll);
    }

    function captureKey(event) {
      if (!dialog.open || !capture || event.key === "Tab") return;
      if (event.key !== "Escape" && capture.kind !== "key") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        capture = null;
        status.textContent = "Alteração cancelada.";
        render();
      } else if (!event.repeat && event.code && event.code !== "Unidentified" &&
                 !event.ctrlKey && !event.metaKey && !event.altKey) {
        assignKey(event.code);
        finish();
      }
    }

    for (const action of actions) {
      const label = document.createElement("span");
      label.textContent = action.label;
      const key = document.createElement("button");
      const pad = document.createElement("button");
      for (const [element, kind, device] of [[key, "key", "tecla"], [pad, "pad", "controle físico"]]) {
        element.type = "button";
        element.setAttribute("aria-label", `Alterar ${device} de ${action.label}`);
        element.addEventListener("click", () => begin(action, kind));
      }
      rows.set(action.id, { key, pad });
      grid.append(label, key, pad);
    }
    document.body.append(dialog);
    dialog.querySelector("[data-close]").onclick = close;
    select.onchange = () => { capture = null; status.textContent = "Escolha um comando para alterar."; render(); };
    dialog.querySelector("[data-reset-keyboard]").onclick = () => {
      for (const key of Object.keys(keyboard)) delete keyboard[key];
      refreshKeyMap();
      capture = null;
      save();
      status.textContent = "Teclado restaurado.";
      render();
    };
    resetPad.onclick = () => {
      const pad = selectedPad();
      if (pad) delete profiles[modelName(pad)];
      capture = null;
      save();
      status.textContent = "Controle restaurado.";
      render();
    };
    const open = () => {
      const container = document.fullscreenElement || document.body;
      if (dialog.parentElement !== container) container.append(dialog);
      dialog.showModal();
      clearInput?.();
      status.textContent = "Escolha um comando para alterar. As mudanças são salvas neste navegador.";
      const pads = gamepads();
      refreshDevices(pads);
      render(selectedPad(pads));
      frame = requestAnimationFrame(poll);
    };
    for (const item of Array.isArray(button) ? button : [button]) item.onclick = open;
    function close() {
      cancelAnimationFrame(frame);
      capture = null;
      clearInput?.();
      dialog.close();
      if (dialog.parentElement !== document.body) document.body.append(dialog);
      focusGame?.();
    }
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      close();
    });
    window.addEventListener("keydown", captureKey, true);

    return {
      get editing() { return dialog.open; },
      keyAction: (code) => keyMap.get(code),
      value(pad, actionId) {
        if (dialog.open || !pad) return 0;
        const action = actionList.get(actionId);
        return action ? inputLevel(pad, inputsFor(pad, action)) : 0;
      },
      overrideValue(pad, actionId) {
        if (dialog.open || !pad) return 0;
        const inputs = profiles[modelName(pad)]?.[actionId];
        return inputs === undefined ? undefined : inputLevel(pad, inputs);
      },
    };
  }

  return Object.freeze({ create, gamepads, axisInputs, buttonInput });
})();

globalThis.SiteControls = SiteControls;
