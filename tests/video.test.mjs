import assert from "node:assert/strict";
import test from "node:test";
import { Relay } from "../web/relay.mjs";
import {
  ImageAssembly,
  imagePiece,
  jpegReference,
  rowPatch,
  restoreRowPatch,
  MAX_IMAGE,
  PIECE_BYTES,
} from "../web/video.mjs";

test("only complete, bounded, ordered relay images reach the decoder", () => {
  const image = new Uint8Array(2 * PIECE_BYTES + 10);
  image.fill(101, PIECE_BYTES);
  image[image.length - 1] = 111;
  const receiver = new ImageAssembly();
  const finish = imagePiece(image, 2 * PIECE_BYTES, 7);
  const first = imagePiece(image, 0, 7);
  const middle = imagePiece(image, PIECE_BYTES, 7);
  assert.equal(receiver.accept(middle), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(finish), undefined);
  assert.equal(receiver.accept(middle), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(middle), undefined);
  assert.deepEqual(receiver.accept(finish), { image, serial: 7 });
  const malformed = first.slice();
  new DataView(malformed.buffer).setUint32(0, MAX_IMAGE + 1);
  assert.equal(receiver.accept(malformed), undefined);
  assert.equal(receiver.image, null);
});

test("switching monitors can cancel a frame without waiting on its acknowledgment", async () => {
  const relay = new Relay("http://127.0.0.1", true, "", {});
  relay.ws = { readyState: 1, bufferedAmount: 0 };
  const peer = {};
  relay.peers.set(7, peer);
  const sent = [];
  relay.send = async (id, type, packet) => {
    sent.push([type, packet]);
    relay.cancelImage(id);
  };
  await relay.sendImage(7, new Uint8Array(3 * PIECE_BYTES), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 4);
  assert.equal(peer.sendingImage, false);
});

test("a cold relay transmits the first two pieces immediately and shares its byte budget", () => {
  const relay = new Relay("", true, "", {});
  const piece = PIECE_BYTES + 64;
  assert.equal(relay.mediaDelay(piece, 0), 0);
  assert.equal(relay.mediaDelay(piece, 0), 0);
  const wait = relay.mediaDelay(piece, 0);
  assert.ok(wait > 0 && wait < 69);
  assert.equal(relay.mediaDelay(piece, wait - 1), 1);
  assert.equal(relay.mediaDelay(piece, wait), 0);
  let inWindow = 0;
  for (let ms = 1000; ms < 2000; ms++)
    while (relay.mediaDelay(piece, ms) === 0) inWindow += piece;
  assert.ok(inWindow > 3_200_000 && inWindow < 4_500_000);
});

test("scroll row references reconstruct the exact compressed image, including shifted markers", () => {
  function image(rows) {
    const bytes = [255, 216, 255, 221, 0, 4, 0, 90, 255, 218, 0, 2];
    rows.forEach((color, i) => {
      bytes.push(...new Array(16000).fill(color), 255, 0, 255, i + 1 === rows.length ? 217 : 208 + i % 8);
    });
    return Uint8Array.from(bytes);
  }
  const rows = Array.from({ length: 30 }, (_, i) => i);
  const original = image(rows), base = jpegReference(5, original);
  const next = image([88, ...rows.slice(0, 29)]);
  const patch = rowPatch(base, next);
  assert.ok(patch.length < 20000);
  assert.deepEqual(restoreRowPatch(base, patch), next);
  assert.equal(restoreRowPatch({ ...base, serial: 6 }, patch), null);
  assert.equal(restoreRowPatch(base, patch.slice(0, -1)), null);
  const corrupt = patch.slice();
  new DataView(corrupt.buffer).setUint32(16, MAX_IMAGE + 1);
  assert.equal(restoreRowPatch(base, corrupt), null);
  assert.equal(rowPatch(base, image(rows.map((c) => c + 100))), null);
  assert.equal(jpegReference(1, new Uint8Array(500)), null);
  assert.equal(restoreRowPatch(null, original), original);
});
