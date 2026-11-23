import assert from "node:assert/strict";
import test from "node:test";
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
  const finish = imagePiece(image, 2 * PIECE_BYTES);
  const first = imagePiece(image, 0);
  const middle = imagePiece(image, PIECE_BYTES);
  assert.equal(receiver.accept(middle), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(finish), undefined);
  assert.equal(receiver.accept(middle), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(first), undefined);
  assert.equal(receiver.accept(middle), undefined);
  assert.deepEqual(receiver.accept(finish), image);
  const malformed = first.slice();
  new DataView(malformed.buffer).setUint32(0, MAX_IMAGE + 1);
  assert.equal(receiver.accept(malformed), undefined);
  assert.equal(receiver.image, null);
});
