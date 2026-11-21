import test from 'node:test';
import assert from 'node:assert/strict';
import { attachInput, pictureBounds, screenPoint, wheelPixels } from '../web/input.mjs';

function event(target, type, properties = {}) {
  const value = Object.assign(new Event(type, { cancelable: true }), properties);
  target.dispatchEvent(value);
  return value;
}

function setup() {
  const doc = new EventTarget();
  doc.defaultView = new EventTarget();
  doc.defaultView.getComputedStyle = () => ({ lineHeight: '24px' });
  const video = Object.assign(new EventTarget(), {
    ownerDocument: doc, style: { touchAction: '' }, tabIndex: -1, videoWidth: 800, videoHeight: 400,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    getAttribute: () => null, removeAttribute() {}, setPointerCapture() {}, focus() {},
    blur() { event(video, 'blur'); }
  });
  const sent = [];
  const stop = attachInput(video, message => sent.push(message));
  function pointer(type, id, x, y, options = {}) {
    return event(video, type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, ...options });
  }
  return { doc, video, sent, stop, pointer };
}

test('letterboxed and pillarboxed video exclude the surrounding space and support clamping drags', () => {
  const { video, stop } = setup();
  assert.deepEqual(pictureBounds(video), { left: 0, top: 100, width: 400, height: 200 });
  assert.equal(screenPoint(pictureBounds(video), 100, 25), null);
  assert.deepEqual(screenPoint(pictureBounds(video), 400, 300), { x: 1, y: 1 });
  assert.deepEqual(screenPoint(pictureBounds(video), -5, 350, true), { x: 0, y: 1 });
  video.videoWidth = 200;
  assert.deepEqual(pictureBounds(video), { left: 100, top: 0, width: 200, height: 400 });
  video.videoWidth = 0;
  assert.equal(pictureBounds(video), null);
  stop();
});

test('hardware wheels retain two-dimensional fractional movement and apply line and page units', () => {
  const { video, sent, stop } = setup();
  function wheel(deltaMode, deltaX, deltaY, clientY = 200) {
    return event(video, 'wheel', { clientX: 100, clientY, deltaMode, deltaX, deltaY });
  }
  assert.equal(wheel(0, 0.25, -0.125).defaultPrevented, true);
  wheel(1, -2, 3);
  wheel(2, 0.5, -1);
  assert.equal(wheel(0, 0, 100, 99).defaultPrevented, false);
  assert.deepEqual(sent, [
    { kind: 'wheel', dx: 0.25, dy: -0.125, x: 0.25, y: 0.5 },
    { kind: 'wheel', dx: -48, dy: 72, x: 0.25, y: 0.5 },
    { kind: 'wheel', dx: 200, dy: -200, x: 0.25, y: 0.5 }
  ]);
  assert.equal(wheelPixels({ deltaX: NaN, deltaY: 0, deltaMode: 0 }, pictureBounds(video)), null);
  stop();
  wheel(0, 1, 1);
  assert.equal(sent.length, 4);
});

test('a two-finger touchscreen scroll sends no click, including when the first finger lifts', () => {
  const { pointer, sent, stop } = setup();
  pointer('pointerdown', 1, 100, 200);
  pointer('pointerdown', 2, 200, 200);
  pointer('pointermove', 1, 101, 196);
  pointer('pointermove', 2, 201, 196);
  pointer('pointerup', 1, 101, 196);
  pointer('pointermove', 2, 202, 195);
  pointer('pointerup', 2, 202, 195);
  assert.deepEqual(sent, Array(2).fill({ kind: 'wheel', dx: -0.5, dy: 2, x: 0.375, y: 0.5 }));
  pointer('pointerdown', 3, 100, 200);
  pointer('pointerup', 3, 100, 200);
  assert.deepEqual(sent.slice(2), [true, false].map(down => ({ kind: 'button', button: 0, down, x: 0.25, y: 0.5 })));
  stop();
});

test('touch drag and mouse buttons release when the pointer leaves the picture', () => {
  const { pointer, sent, stop } = setup();
  pointer('pointerdown', 1, 100, 200);
  pointer('pointermove', 1, 150, 200);
  pointer('pointerup', 1, 150, 350);
  assert.deepEqual(sent, [
    { kind: 'button', button: 0, down: true, x: 0.25, y: 0.5 },
    { kind: 'move', x: 0.375, y: 0.5 },
    { kind: 'button', button: 0, down: false, x: 0.375, y: 1 }
  ]);
  for (const [mask, index] of [[2, 2], [4, 1], [1, 0]]) {
    pointer('pointerdown', 3, 200, 200, { pointerType: 'mouse', buttons: mask });
    pointer('pointerup', 3, 200, 90, { pointerType: 'mouse', buttons: 0 });
    assert.deepEqual(sent.slice(-2), [
      { kind: 'button', button: index, down: true, x: 0.5, y: 0.5 },
      { kind: 'button', button: index, down: false, x: 0.5, y: 0 }
    ]);
  }
  stop();
});

test('loss of focus, visibility, capture and authorization release inputs', () => {
  const { doc, video, sent, stop, pointer } = setup();
  event(video, 'keydown', { code: 'ShiftLeft' });
  event(video, 'keydown', { code: 'Escape', shiftKey: true });
  event(video, 'keyup', { code: 'ShiftLeft' });
  assert.deepEqual(sent, [{ kind: 'key', code: 'ShiftLeft', down: true }, { kind: 'release' }]);
  pointer('pointerdown', 2, 200, 200, { pointerType: 'mouse', buttons: 1 });
  pointer('lostpointercapture', 2, 200, 200, { pointerType: 'mouse' });
  doc.hidden = true;
  event(doc, 'visibilitychange');
  stop();
  stop();
  event(video, 'keydown', { code: 'KeyA' });
  assert.deepEqual(sent.slice(-3), Array(3).fill({ kind: 'release' }));
  assert.equal(video.style.touchAction, '');
});

test('Android native scroll is consumed only on the authorized picture and preserves fractional axes', () => {
  const { doc, video, sent, stop } = setup();
  const win = doc.defaultView;
  win.innerWidth = 400;
  win.innerHeight = 400;
  doc.elementFromPoint = () => video;
  const wheel = win.remoteControlAndroidWheel;
  assert.equal(wheel(0.25, 0.5, -0.25 / 400, 0.75 / 400), true);
  assert.deepEqual(sent.pop(), { kind: 'wheel', dx: -0.25, dy: 0.75, x: 0.25, y: 0.5 });
  assert.equal(wheel(0.25, 0.05, 0, 0.5), false); // letterbox
  assert.equal(wheel(1.1, 0.5, 1, 0), false);
  assert.equal(wheel(0.25, 0.5, NaN, 0.5), false);
  assert.equal(wheel(0.25, 0.5, 0, 0), false);

  win.visualViewport = { width: 200, height: 200, offsetLeft: 50, offsetTop: 100 };
  doc.elementFromPoint = (x, y) => x === 150 && y === 200 ? video : null;
  assert.equal(wheel(0.5, 0.5, 0.5 / 200, -0.25 / 200), true);
  assert.deepEqual(sent.pop(), { kind: 'wheel', dx: 0.5, dy: -0.25, x: 0.375, y: 0.5 });
  doc.elementFromPoint = () => ({}); // Overlay owns the event.
  assert.equal(wheel(0.5, 0.5, 1, 1), false);
  doc.elementFromPoint = () => video;
  doc.hidden = true;
  assert.equal(wheel(0.5, 0.5, 1, 1), false);
  assert.deepEqual(sent, []);
  stop();
  assert.equal(win.remoteControlAndroidWheel, undefined);
  doc.hidden = false;
  assert.equal(wheel(0.5, 0.5, 1, 1), false);
});
