// Relay messages are bounded independently of a display's resolution.
export const SINGLE_IMAGE = 340000;
export const PIECE_BYTES = 220000;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const EDGES = [960, 1280, 1920, 2560, 3840];
export const MOTION_PACKET = 150000;
export const MOTION_TYPE = 5;

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

// Desktop scrolling frames share the JPEG relay, but use an interframe codec.
export class MotionEncoder {
  constructor(send) {
    this.send = send;
    this.canvas = document.createElement("canvas");
  }

  submit(image, edge, fps) {
    if (this.failed || typeof VideoEncoder !== "function" || typeof VideoFrame !== "function")
      return false;
    const scale = Math.min(1, edge / Math.max(image.width, image.height));
    const width = Math.max(2, Math.floor(image.width * scale / 2) * 2);
    const height = Math.max(2, Math.floor(image.height * scale / 2) * 2);
    const profile = [width, height, fps].join("/");
    const now = performance.now();
    try {
      if (!this.encoder || this.profile !== profile) {
        this.stop();
        this.profile = profile;
        this.canvas.width = width;
        this.canvas.height = height;
        this.keyAt = -Infinity;
        this.deliveryDeadline = now + 900;
        const encoder = this.encoder = new VideoEncoder({
          output: (chunk) => {
            if (this.encoder !== encoder) return;
            if (chunk.byteLength > MOTION_PACKET - 9) {
              this.keyAt = -Infinity;
              return;
            }
            const key = chunk.type === "key";
            if (!key && this.keyAt === -Infinity) return;
            const packet = new Uint8Array(9 + chunk.byteLength);
            packet[0] = key ? 1 : 0;
            new DataView(packet.buffer).setBigUint64(1, BigInt(chunk.timestamp));
            chunk.copyTo(packet.subarray(9));
            if (!this.send(packet)) this.keyAt = -Infinity;
            else {
              if (key) this.keyAt = chunk.timestamp;
              this.deliveryDeadline = performance.now() + 900;
            }
          },
          error: () => {
            if (this.encoder === encoder) this.disable();
          },
        });
        encoder.configure({
          codec: "vp8", width, height, framerate: fps, latencyMode: "realtime",
          bitrate: Math.min(3500000, Math.max(450000, width * height * fps * 0.09)),
        });
      }
      if (now > this.deliveryDeadline) {
        this.disable();
        return false;
      }
      if (this.encoder.encodeQueueSize > 0) return true;
      this.canvas.getContext("2d").drawImage(image, 0, 0, width, height);
      const timestamp = Math.round(performance.now() * 1000);
      const frame = new VideoFrame(this.canvas, { timestamp });
      try {
        this.encoder.encode(frame, { keyFrame: timestamp - this.keyAt >= 750000 });
      } finally {
        frame.close();
      }
      return true;
    } catch {
      this.disable();
      return false;
    }
  }

  stop() {
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    this.encoder = null;
  }

  disable() {
    this.stop();
    this.failed = true;
  }
}

export class MotionDecoder {
  constructor(paint, fallback) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          paint(frame);
        } finally {
          frame.close();
        }
      },
      error: fallback,
    });
    try {
      this.decoder.configure({ codec: "vp8", optimizeForLatency: true });
    } catch (error) {
      this.close();
      throw error;
    }
    this.needKey = true;
  }

  accept(packet) {
    if (packet.length <= 9 || packet.length > MOTION_PACKET || packet[0] > 1) return;
    const key = packet[0] === 1;
    if (this.decoder.decodeQueueSize > 3) {
      this.decoder.reset();
      this.decoder.configure({ codec: "vp8", optimizeForLatency: true });
      this.needKey = true;
    }
    if (this.needKey && !key) return;
    this.needKey = false;
    this.decoder.decode(new EncodedVideoChunk({
      type: key ? "key" : "delta",
      timestamp: Number(new DataView(packet.buffer, packet.byteOffset + 1, 8).getBigUint64(0)),
      data: packet.subarray(9),
    }));
  }

  close() {
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
