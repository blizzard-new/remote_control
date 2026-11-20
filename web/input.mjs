// Matches the visible picture in a centered video with object-fit: contain.
export function pictureBounds(video) {
  const rect = video.getBoundingClientRect();
  if (!(video.videoWidth > 0 && video.videoHeight > 0 && rect.width > 0 && rect.height > 0)) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

export function screenPoint(bounds, clientX, clientY, clamp = false) {
  if (!bounds || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const x = (clientX - bounds.left) / bounds.width;
  const y = (clientY - bounds.top) / bounds.height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function wheelPixels(event, bounds, lineHeight = 16) {
  // Read deltaMode first. Some browsers choose compatible units based on access order.
  const mode = event.deltaMode;
  const dx = event.deltaX * (mode === 2 ? bounds.width : mode === 1 ? lineHeight : 1);
  const dy = event.deltaY * (mode === 2 ? bounds.height : mode === 1 ? lineHeight : 1);
  return Number.isFinite(dx) && Number.isFinite(dy) ? { dx, dy } : null;
}

export function attachInput(video, send) {
  const doc = video.ownerDocument;
  const win = doc.defaultView;
  const cleanup = new AbortController();
  const options = { signal: cleanup.signal, passive: false };
  const previousTabIndex = video.getAttribute('tabindex');
  const previousTouchAction = video.style.touchAction;
  if (video.tabIndex < 0) video.tabIndex = 0;
  video.style.touchAction = 'none';

  const touches = new Map();
  const keys = new Set();
  const buttons = [1, 4, 2]; // PointerEvent.buttons bits in DOM button index order.
  let mouseId = null;
  let mouseButtons = 0;
  let touchStart = null;
  let dragging = false;
  let multiTouch = false;
  let scrollAnchor = null;

  function reset() {
    touches.clear();
    keys.clear();
    mouseId = null;
    mouseButtons = 0;
    touchStart = null;
    dragging = false;
    multiTouch = false;
    scrollAnchor = null;
    send({ kind: 'release' });
  }

  function centroid() {
    if (touches.size !== 2) return null;
    const [a, b] = touches.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function position(event, clamp = false) {
    return screenPoint(pictureBounds(video), event.clientX, event.clientY, clamp);
  }

  function syncButtons(mask, point) {
    buttons.forEach((bit, button) => {
      if ((mouseButtons ^ mask) & bit) send({ kind: 'button', button, down: Boolean(mask & bit), ...point });
    });
    mouseButtons = mask;
  }

  function touchButton(down, point) {
    send({ kind: 'button', button: 0, down, ...point });
  }

  video.addEventListener('pointerdown', event => {
    const point = position(event);
    if (!point) return;
    if (event.pointerType === 'touch') {
      if (mouseId !== null) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 1) {
        touchStart = { x: event.clientX, y: event.clientY, point };
      } else {
        // A second finger turns a pending tap into scroll without clicking.
        if (dragging) touchButton(false);
        dragging = false;
        multiTouch = true;
        const center = centroid();
        if (center) scrollAnchor = screenPoint(pictureBounds(video), center.x, center.y, true);
      }
    } else {
      if (touches.size || mouseId !== null || !(event.buttons & 7)) return;
      mouseId = event.pointerId;
      syncButtons(event.buttons, point);
    }
    event.preventDefault();
    video.focus({ preventScroll: true });
    video.setPointerCapture(event.pointerId);
  }, options);

  video.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') {
      if (touches.size || (mouseId !== null && mouseId !== event.pointerId)) return;
      if (mouseId === null && event.buttons) return;
      const point = position(event, mouseId !== null);
      if (!point) return;
      if (mouseId !== null) syncButtons(event.buttons, point);
      send({ kind: 'move', ...point });
      return;
    }
    if (!touches.has(event.pointerId)) return;
    const before = centroid();
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (multiTouch) {
      const after = centroid();
      if (before && after) {
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (dx || dy) send({ kind: 'wheel', dx, dy, ...scrollAnchor });
      }
      return;
    }
    const point = position(event, true);
    if (!point) return;
    if (!dragging && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) >= 8) {
      touchButton(true, touchStart.point);
      dragging = true;
    }
    if (dragging) send({ kind: 'move', ...point });
  }, options);

  video.addEventListener('pointerup', event => {
    const point = position(event, true);
    if (event.pointerType === 'touch') {
      if (!touches.delete(event.pointerId)) return;
      if (!multiTouch) {
        if (dragging) touchButton(false, point);
        else if (position(event)) {
          touchButton(true, point);
          touchButton(false, point);
        }
      }
      if (!touches.size) {
        dragging = false;
        multiTouch = false;
        touchStart = null;
        scrollAnchor = null;
      }
    } else if (mouseId === event.pointerId) {
      syncButtons(0, point);
      mouseId = null;
    }
  }, options);

  function cancelPointer(event) {
    if (touches.has(event.pointerId) || mouseId === event.pointerId) reset();
  }
  video.addEventListener('pointercancel', cancelPointer, options);
  video.addEventListener('lostpointercapture', cancelPointer, options);
  video.addEventListener('contextmenu', event => {
    if (position(event)) event.preventDefault();
  }, options);
  // The Android viewer intercepts ACTION_SCROLL before WebView handles it.
  // Returning false lets WebView deliver the original event exactly once.
  function androidWheel(xFraction, yFraction, dxFraction, dyFraction) {
    if (cleanup.signal.aborted || doc.hidden) return false;
    if (![xFraction, yFraction, dxFraction, dyFraction].every(Number.isFinite)) return false;
    if (xFraction < 0 || xFraction > 1 || yFraction < 0 || yFraction > 1) return false;
    const viewport = win.visualViewport;
    const width = viewport?.width ?? win.innerWidth;
    const height = viewport?.height ?? win.innerHeight;
    if (!(width > 0 && height > 0)) return false;
    const clientX = (viewport?.offsetLeft ?? 0) + xFraction * width;
    const clientY = (viewport?.offsetTop ?? 0) + yFraction * height;
    if (doc.elementFromPoint(clientX, clientY) !== video) return false;
    const point = screenPoint(pictureBounds(video), clientX, clientY);
    const dx = dxFraction * width;
    const dy = dyFraction * height;
    if (!point || !Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return false;
    send({ kind: 'wheel', dx, dy, ...point });
    return true;
  }
  win.remoteControlAndroidWheel = androidWheel;

  video.addEventListener('wheel', event => {
    const bounds = pictureBounds(video);
    const point = screenPoint(bounds, event.clientX, event.clientY);
    if (!point) return;
    const cssLineHeight = event.deltaMode === 1 ? parseFloat(win.getComputedStyle(video).lineHeight) : 0;
    const delta = wheelPixels(event, bounds, cssLineHeight || 16);
    if (!delta) return;
    event.preventDefault();
    if (delta.dx || delta.dy) send({ kind: 'wheel', ...delta, ...point });
  }, options);
  video.addEventListener('keydown', event => {
    if (event.code === 'Escape' && event.shiftKey) {
      event.preventDefault();
      video.blur();
      return;
    }
    if (!event.code || event.isComposing) return;
    event.preventDefault();
    if (!keys.has(event.code)) {
      keys.add(event.code);
      send({ kind: 'key', code: event.code, down: true });
    }
  }, options);
  video.addEventListener('keyup', event => {
    if (keys.delete(event.code)) {
      event.preventDefault();
      send({ kind: 'key', code: event.code, down: false });
    }
  }, options);
  video.addEventListener('blur', reset, options);
  win.addEventListener('blur', reset, options);
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) reset();
  }, options);
  return () => {
    if (cleanup.signal.aborted) return;
    cleanup.abort();
    if (win.remoteControlAndroidWheel === androidWheel) delete win.remoteControlAndroidWheel;
    reset();
    video.style.touchAction = previousTouchAction;
    if (previousTabIndex === null) video.removeAttribute('tabindex');
    else video.setAttribute('tabindex', previousTabIndex);
  };
}
