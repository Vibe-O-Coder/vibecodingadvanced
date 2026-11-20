// Pointer IDs keep simultaneous buttons and sticks independent, including cancellation.
export function bindTouchControls(root) {
  const active = new Map();

  function moveStick(entry, event) {
    const rect = entry.element.getBoundingClientRect();
    const radius = rect.width / 2;
    const x = (event.clientX - rect.left - radius) / radius;
    const y = (event.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.max(1, Math.hypot(x, y));
    entry.x = x / length;
    entry.y = y / length;
    entry.element.style.setProperty('--stick-x', `${entry.x * radius * 0.5}px`);
    entry.element.style.setProperty('--stick-y', `${entry.y * radius * 0.5}px`);
  }

  function release(event) {
    const entry = active.get(event.pointerId);
    if (!entry) return;
    active.delete(event.pointerId);
    if (![...active.values()].some((other) => other.element === entry.element)) {
      entry.element.classList.remove('pressed');
      entry.element.style.removeProperty('--stick-x');
      entry.element.style.removeProperty('--stick-y');
    }
  }

  root.addEventListener('pointerdown', (event) => {
    if (root.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const element = event.target.closest('[data-button], [data-stick]');
    if (!element || !root.contains(element)) return;
    if (element.dataset.stick && [...active.values()].some((entry) => entry.element === element)) return;
    event.preventDefault();
    const entry = { element, x: 0, y: 0 };
    active.set(event.pointerId, entry);
    element.classList.add('pressed');
    element.setPointerCapture(event.pointerId);
    if (element.dataset.stick) moveStick(entry, event);
  });
  root.addEventListener('pointermove', (event) => {
    const entry = active.get(event.pointerId);
    if (entry?.element.dataset.stick) {
      event.preventDefault();
      moveStick(entry, event);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(type, release);
  }
  root.addEventListener('contextmenu', (event) => event.preventDefault());

  return {
    read() {
      let buttons = 0;
      const axes = [0, 0, 0, 0];
      for (const { element, x, y } of active.values()) {
        if (element.dataset.button !== undefined) buttons |= 1 << Number(element.dataset.button);
        else {
          const index = element.dataset.stick === 'left' ? 0 : 2;
          axes[index] = x;
          axes[index + 1] = y;
        }
      }
      return { buttons, axes };
    },
    reset() {
      for (const pointerId of [...active.keys()]) release({ pointerId });
    },
  };
}
