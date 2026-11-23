// Relay messages are bounded independently of a display's resolution.
export const SINGLE_IMAGE = 340000;
export const PIECE_BYTES = 220000;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const EDGES = [960, 1280, 1920, 2560, 3840];

export function imagePiece(image, offset) {
  const pixels = image.subarray(offset, offset + PIECE_BYTES);
  const packet = new Uint8Array(8 + pixels.length);
  const header = new DataView(packet.buffer);
  header.setUint32(0, image.length);
  header.setUint32(4, offset);
  packet.set(pixels, 8);
  return packet;
}

export class ImageAssembly {
  reset() {
    this.image = null;
    this.offset = 0;
  }

  accept(packet) {
    if (packet.length <= 8 || packet.length > PIECE_BYTES + 8) {
      this.reset();
      return;
    }
    const header = new DataView(packet.buffer, packet.byteOffset, 8);
    const total = header.getUint32(0),
      offset = header.getUint32(4);
    if (
      total <= SINGLE_IMAGE ||
      total > MAX_IMAGE ||
      offset >= total ||
      packet.length - 8 !== Math.min(PIECE_BYTES, total - offset)
    ) {
      this.reset();
      return;
    }
    if (offset === 0) {
      this.image = new Uint8Array(total);
      this.offset = 0;
    }
    if (this.image?.length !== total || offset !== this.offset) {
      this.reset();
      return;
    }
    this.image.set(packet.subarray(8), offset);
    this.offset += packet.length - 8;
    if (this.offset === total) {
      const complete = this.image;
      this.reset();
      return complete;
    }
  }
}
