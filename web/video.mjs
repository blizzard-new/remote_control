// Relay messages are bounded independently of a display's resolution.
export const SINGLE_IMAGE = 340000;
export const PIECE_BYTES = 220000;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const EDGES = [960, 1280, 1920, 2560, 3840];

export function imagePiece(image, offset, serial) {
  const pixels = image.subarray(offset, offset + PIECE_BYTES);
  const packet = new Uint8Array(12 + pixels.length);
  const header = new DataView(packet.buffer);
  header.setUint32(0, image.length);
  header.setUint32(4, offset);
  header.setUint32(8, serial);
  packet.set(pixels, 12);
  return packet;
}

export class ImageAssembly {
  reset() {
    this.image = null;
    this.offset = 0;
  }

  accept(packet) {
    if (packet.length <= 12 || packet.length > PIECE_BYTES + 12) {
      this.reset();
      return;
    }
    const header = new DataView(packet.buffer, packet.byteOffset, 12);
    const total = header.getUint32(0),
      offset = header.getUint32(4),
      serial = header.getUint32(8);
    if (
      !serial ||
      total <= SINGLE_IMAGE ||
      total > MAX_IMAGE ||
      offset >= total ||
      packet.length - 12 !== Math.min(PIECE_BYTES, total - offset)
    ) {
      this.reset();
      return;
    }
    if (offset === 0) {
      this.serial = serial;
      this.image = new Uint8Array(total);
      this.offset = 0;
    }
    if (
      this.image?.length !== total ||
      offset !== this.offset ||
      this.serial !== serial
    ) {
      this.reset();
      return;
    }
    this.image.set(packet.subarray(12), offset);
    this.offset += packet.length - 12;
    if (this.offset === total) {
      const complete = this.image;
      this.reset();
      return { image: complete, serial };
    }
  }
}

export function sameImage(previous, next) {
  if (previous?.length !== next.length) return false;
  for (let i = 0; i < next.length; i++)
    if (next[i] !== previous[i]) return false;
  return true;
}
