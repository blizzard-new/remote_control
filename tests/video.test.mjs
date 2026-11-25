import assert from "node:assert/strict";
import test from "node:test";
import { Relay } from "../web/relay.mjs";
import {
  ImageAssembly,
  imagePiece,
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

test("scrolling can cancel a detailed frame without waiting on its acknowledgment", async () => {
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
