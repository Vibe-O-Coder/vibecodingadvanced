// SPDX-License-Identifier: GPL-3.0-or-later
// Controller input: keyboard, the on-screen Joy-Cons and browser gamepads, sent to the engine's
// virtual gamepads. Keyboard and touch drive player 1; gamepads drive player 1 too, or one player
// each when multiplayer is on. Rumble the game asks for is played on the matching gamepad.

/// VirtualGamepad::VirtualButton ids in the engine.
export const Button = {
  A: 0, B: 1, X: 2, Y: 3, LStick: 4, RStick: 5, L: 6, R: 7, ZL: 8, ZR: 9,
  Plus: 10, Minus: 11, Left: 12, Up: 13, Right: 14, Down: 15, Home: 18, Capture: 19,
  SL: 16, SR: 17,
};
const Stick = { Left: 0, Right: 1 };

const KEY_BUTTONS = {
  KeyA: Button.A, KeyS: Button.B, KeyX: Button.X, KeyZ: Button.Y,
  KeyQ: Button.L, KeyE: Button.R, Digit1: Button.ZL, Digit3: Button.ZR,
  Enter: Button.Plus, Backspace: Button.Minus,
  KeyT: Button.Up, KeyG: Button.Down, KeyF: Button.Left, KeyH: Button.Right,
};
// [stick, x, y] for each direction key; +y is up.
const KEY_STICKS = {
  ArrowUp: [Stick.Left, 0, 1], ArrowDown: [Stick.Left, 0, -1],
  ArrowLeft: [Stick.Left, -1, 0], ArrowRight: [Stick.Left, 1, 0],
  KeyI: [Stick.Right, 0, 1], KeyK: [Stick.Right, 0, -1],
  KeyJ: [Stick.Right, -1, 0], KeyL: [Stick.Right, 1, 0],
};
// Standard gamepad mapping. "position" keeps the Switch layout (the bottom face button is B);
// "label" follows Xbox-style labels (the bottom face button, labelled A, is the Switch's A).
const PAD_LAYOUTS = {
  position: [
    Button.B, Button.A, Button.Y, Button.X, Button.L, Button.R, Button.ZL, Button.ZR,
    Button.Minus, Button.Plus, Button.LStick, Button.RStick,
    Button.Up, Button.Down, Button.Left, Button.Right, Button.Home, Button.Capture,
  ],
  label: [
    Button.A, Button.B, Button.X, Button.Y, Button.L, Button.R, Button.ZL, Button.ZR,
    Button.Minus, Button.Plus, Button.LStick, Button.RStick,
    Button.Up, Button.Down, Button.Left, Button.Right, Button.Home, Button.Capture,
  ],
};
const PAD_DEADZONE = 0.12;
const MAX_PLAYERS = 8;
const PREFS_KEY = 'eden-gamepad-prefs';
const buttonKeys = new Map(Object.entries(KEY_BUTTONS).map(([code, button]) => [button, code]));
const buttonLabels = {
  LStick: 'Clique no analógico esquerdo', RStick: 'Clique no analógico direito',
  Plus: '+', Minus: '−', Left: 'Direcional ←', Up: 'Direcional ↑', Right: 'Direcional →', Down: 'Direcional ↓',
  Capture: 'Captura de tela',
};
const buttonActions = Object.entries(Button).map(([name, id]) => ({ id, label: buttonLabels[name] || name, key: buttonKeys.get(id) }));
const stickActions = Object.entries(KEY_STICKS).map(([key, [stick, x, y]]) => {
  const axis = stick * 2 + (y ? 1 : 0);
  const direction = x || -y;
  const arrow = x < 0 ? '←' : x > 0 ? '→' : y > 0 ? '↑' : '↓';
  return { id: `stick:${axis}:${direction}`, key, stick, x, y,
    label: `${stick ? 'Analógico direito' : 'Analógico esquerdo'} ${arrow}`,
    pad: [SiteControls.axisInputs(axis)[direction > 0 ? 1 : 0]],
  };
});
const stickDirections = new Map(stickActions.map(action => [action.id, action]));
const padDefaults = Object.fromEntries(Object.entries(PAD_LAYOUTS).map(([name, layout]) => [name,
  new Map(layout.map((id, index) => [id, [SiteControls.buttonInput(index)]])),
]));

function loadPrefs() {
  const prefs = { layout: 'position', multiplayer: false, rumble: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')); } catch {}
  if (!Object.hasOwn(PAD_LAYOUTS, prefs.layout)) prefs.layout = 'position';
  return prefs;
}

const BUTTON_SELECTORS = {
  [Button.A]: '.abxy-btn.btn-a', [Button.B]: '.abxy-btn.btn-b',
  [Button.X]: '.abxy-btn.btn-x', [Button.Y]: '.abxy-btn.btn-y',
  [Button.Up]: '.dpad-btn.up', [Button.Down]: '.dpad-btn.down',
  [Button.Left]: '.dpad-btn.left', [Button.Right]: '.dpad-btn.right',
  [Button.Plus]: '.btn-plus', [Button.Minus]: '.btn-minus',
  [Button.Home]: '.btn-home', [Button.Capture]: '.btn-capture',
};
const STICK_SELECTORS = ['.stick-left', '.stick-right'];

/// `getModule` returns the Emscripten module once a game is running, else null. Returns the
/// gamepad controls the page's Gamepads panel uses.
export function setupInput(getModule) {
  // Each source holds its own pressed buttons and stick vectors and the player it drives; each
  // player sees the union of its sources.
  const sources = new Map();
  const emptyState = () => ({ buttons: new Set(), sticks: [[0, 0], [0, 0]] });
  const sent = Array.from({ length: MAX_PLAYERS }, emptyState);
  let sentModule = null;

  function source(name, player = 0) {
    if (!sources.has(name)) sources.set(name, { player, ...emptyState() });
    return sources.get(name);
  }

  function flush() {
    const module = getModule();
    // A new engine instance starts with nothing pressed and only player 1 connected.
    if (module !== sentModule) {
      sentModule = module;
      sent.forEach((state, player) => { sent[player] = emptyState(); });
      connected.clear();
    }
    const players = Array.from({ length: MAX_PLAYERS }, emptyState);
    for (const state of sources.values()) {
      const target = players[state.player];
      state.buttons.forEach(button => target.buttons.add(button));
      state.sticks.forEach(([x, y], i) => { target.sticks[i][0] += x; target.sticks[i][1] += y; });
    }
    players.forEach(({ buttons, sticks }, player) => {
      const last = sent[player];
      if (player > 0 && (buttons.size || sticks.some(([x, y]) => x || y))) connect(module, player);
      for (const button of new Set([...buttons, ...last.buttons])) {
        const pressed = buttons.has(button);
        if (pressed === last.buttons.has(button)) continue;
        module?._eden_set_button(player, button, pressed ? 1 : 0);
        if (player === 0) document.querySelector(BUTTON_SELECTORS[button])?.classList.toggle('pressed', pressed);
      }
      last.buttons = buttons;
      sticks.forEach(([x, y], i) => {
        const length = Math.hypot(x, y);
        if (length > 1) { x /= length; y /= length; }
        if (x === last.sticks[i][0] && y === last.sticks[i][1]) return;
        last.sticks[i] = [x, y];
        module?._eden_set_stick(player, i, x, y);
        const knob = player === 0 ? document.querySelector(STICK_SELECTORS[i]) : null;
        if (knob) {
          knob.style.translate = x || y ? `${x * 25}% ${-y * 25}%` : '';
          knob.classList.toggle('pressed', Boolean(x || y));
        }
      });
    });
  }

  // Players 2 to 8 are plugged in when a gamepad assigned to them is first used.
  const connected = new Set();
  function connect(module, player) {
    if (!module || connected.has(player) || typeof module._eden_set_player_connected !== 'function') return;
    module._eden_set_player_connected(player, 1);
    connected.add(player);
  }

  // Keyboard. Ignored while typing in a form field.
  const keyboard = source('keyboard');
  const pointer = source('pointer');
  const prefs = loadPrefs();
  const heldKeys = new Set();
  const clearPadSources = () => {
    for (const name of sources.keys()) if (name.startsWith('gamepad')) sources.delete(name);
  };
  const controls = SiteControls.create({
    id: 'eden', actions: [...buttonActions, ...stickActions],
    button: [document.getElementById('configure-input'), document.getElementById('btn-fullscreen-controls')],
    defaultPad: action => padDefaults[prefs.layout].get(action.id),
    clearInput() {
      heldKeys.clear();
      pointer.buttons.clear();
      pointer.sticks = [[0, 0], [0, 0]];
      clearPadSources();
      updateKeyboard();
    },
    focusGame: () => { if (getModule()) document.getElementById('canvas').focus({ preventScroll: true }); },
  });
  function updateKeyboard() {
    keyboard.buttons.clear();
    keyboard.sticks = [[0, 0], [0, 0]];
    for (const code of heldKeys) {
      const action = controls.keyAction(code);
      if (typeof action === 'number') keyboard.buttons.add(action);
      const direction = stickDirections.get(action);
      if (direction) {
        keyboard.sticks[direction.stick][0] += direction.x;
        keyboard.sticks[direction.stick][1] += direction.y;
      }
    }
    flush();
  }
  const isTyping = target => target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
  window.addEventListener('keydown', e => {
    if (controls.editing || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
    if (controls.keyAction(e.code) === undefined) return;
    e.preventDefault();
    if (!e.repeat) { heldKeys.add(e.code); updateKeyboard(); }
  });
  window.addEventListener('keyup', e => {
    if (heldKeys.delete(e.code)) updateKeyboard();
  });
  window.addEventListener('blur', () => { heldKeys.clear(); updateKeyboard(); });

  // On-screen buttons: press while a pointer is down on them.
  for (const [button, selector] of Object.entries(BUTTON_SELECTORS)) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const release = () => { pointer.buttons.delete(Number(button)); flush(); };
    element.addEventListener('pointerdown', e => {
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      pointer.buttons.add(Number(button));
      flush();
    });
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
  }
  // On-screen sticks: drag from the stick's centre.
  STICK_SELECTORS.forEach((selector, stick) => {
    const element = document.querySelector(selector);
    if (!element) return;
    let origin = null;
    const move = e => {
      if (!origin) return;
      const reach = Math.max(element.offsetWidth, 24);
      pointer.sticks[stick] = [(e.clientX - origin.x) / reach, -(e.clientY - origin.y) / reach];
      flush();
    };
    const release = () => { origin = null; pointer.sticks[stick] = [0, 0]; flush(); };
    element.addEventListener('pointerdown', e => {
      e.preventDefault();
      element.setPointerCapture(e.pointerId);
      const rect = element.getBoundingClientRect();
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      move(e);
    });
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);
    element.style.touchAction = 'none';
  });

  // Gamepads are polled; the API has no change events for buttons or axes. Polling follows the
  // display while the tab is visible and falls back to a timer when it is hidden (the game keeps
  // running, for example in picture-in-picture).
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };
  const listeners = new Set();
  const rumbleSent = new Map();
  let polling = false;
  let padsSeen = '';
  const axis = value => (Math.abs(value) < PAD_DEADZONE ? 0 : value);
  const padPlayer = slot => (prefs.multiplayer ? Math.min(slot, MAX_PLAYERS - 1) : 0);

  function gamepads() {
    return SiteControls.gamepads();
  }

  function poll() {
    const pads = gamepads();
    clearPadSources();
    if (!controls.editing) pads.forEach((gamepad, slot) => {
      const pad = source(`gamepad${gamepad.index}`, padPlayer(slot));
      for (const { id } of buttonActions) if (controls.value(gamepad, id) > .5) pad.buttons.add(id);
      for (const { id, stick, x, y } of stickActions) {
        const value = axis(controls.value(gamepad, id));
        pad.sticks[stick][0] += value * x;
        pad.sticks[stick][1] += value * y;
      }
    });
    flush();
    playRumble(pads);
    const seen = pads.map(pad => `${pad.index}:${pad.id}:${pad.mapping}`).join('|') + `|${prefs.multiplayer}`;
    if (seen !== padsSeen) {
      padsSeen = seen;
      listeners.forEach(listener => listener(describe(pads)));
    }
    polling = pads.length > 0;
    if (!polling) return;
    if (document.hidden) setTimeout(poll, 16);
    else requestAnimationFrame(poll);
  }

  // The engine reports the rumble the game set per player; a gamepad plays its player's rumble.
  // Effects are renewed while they last, since browsers cap their duration.
  function playRumble(pads) {
    const module = getModule();
    const now = performance.now();
    pads.forEach((gamepad, slot) => {
      const actuator = gamepad.vibrationActuator;
      if (!actuator) return;
      let strong = 0;
      let weak = 0;
      if (prefs.rumble && typeof module?._eden_get_rumble === 'function') {
        const packed = module._eden_get_rumble(padPlayer(slot));
        strong = (packed % 65536) / 65535;
        weak = Math.floor(packed / 65536) / 65535;
      }
      const last = rumbleSent.get(gamepad.index) ?? { strong: 0, weak: 0, at: 0 };
      const changed = Math.abs(strong - last.strong) > 0.02 || Math.abs(weak - last.weak) > 0.02;
      if (!changed && (strong + weak === 0 || now - last.at < 150)) return;
      rumbleSent.set(gamepad.index, { strong, weak, at: now });
      if (strong + weak === 0) {
        actuator.reset?.().catch(() => {});
      } else {
        actuator.playEffect('dual-rumble', { duration: 200, strongMagnitude: strong, weakMagnitude: weak })
          .catch(() => {});
      }
    });
  }

  function describe(pads) {
    return pads.map((pad, slot) => ({
      index: pad.index,
      id: pad.id,
      player: padPlayer(slot) + 1,
      standard: pad.mapping === 'standard',
      rumble: Boolean(pad.vibrationActuator),
    }));
  }

  const start = () => { if (!polling) poll(); };
  window.addEventListener('gamepadconnected', start);
  window.addEventListener('gamepaddisconnected', () => { if (!polling) poll(); });
  document.addEventListener('visibilitychange', start);
  start();

  return {
    prefs,
    /// Calls `listener` with the connected gamepads now and whenever they or their players change.
    onChange(listener) {
      listeners.add(listener);
      listener(describe(gamepads()));
    },
    setLayout(layout) {
      if (!(layout in PAD_LAYOUTS)) return;
      prefs.layout = layout;
      savePrefs();
    },
    setMultiplayer(enabled) {
      prefs.multiplayer = Boolean(enabled);
      savePrefs();
      padsSeen = '';
      start();
    },
    setRumble(enabled) {
      prefs.rumble = Boolean(enabled);
      savePrefs();
    },
    /// Plays a short rumble on every gamepad that supports it.
    testRumble() {
      for (const pad of gamepads()) {
        pad.vibrationActuator?.playEffect('dual-rumble', { duration: 300, strongMagnitude: 0.8, weakMagnitude: 0.5 })
          .catch(() => {});
      }
    },
  };
}
