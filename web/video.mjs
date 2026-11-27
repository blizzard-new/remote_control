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

// A JPEG restart interval is independently encoded. An exact row can be copied
// from the last acknowledged full image even if scrolling moved it vertically.
const ROW_PATCH = 0x55524431;
const LITERAL = 0xffffffff;
function restartRows(image) {
  if (image[0] !== 255 || image[1] !== 216) return null;
  let pos = 2, restart = false;
  while (pos + 4 < image.length && image[pos] === 255) {
    const marker = image[pos + 1], size = (image[pos + 2] << 8) | image[pos + 3];
    if (size < 2 || pos + size + 2 > image.length) return null;
    pos += size + 2;
    if (marker === 0xdd) restart = true;
    if (marker !== 0xda) continue;
    if (!restart) return null;
    const rows = [];
    let start = pos;
    while ((pos = image.indexOf(255, pos)) >= 0) {
      const code = image[++pos];
      if (code === 0) continue;
      if ((code < 0xd0 || code > 0xd7) && code !== 0xd9) return null;
      const end = pos - 1;
      if (rows.length >= 512 || end <= start) return null;
      let hash = 2166136261;
      for (let i = start; i < end; i++) hash = Math.imul(hash ^ image[i], 16777619);
      rows.push({ start, end, hash });
      if (code === 0xd9) return rows;
      start = pos + 1;
    }
    return null;
  }
  return null;
}

export function jpegReference(serial, image) {
  const rows = restartRows(image);
  if (!rows) return null;
  return { serial, image, rows: new Map(rows.map((row) => [row.hash, row])) };
}

export function rowPatch(base, image) {
  if (!base || image.length <= SINGLE_IMAGE || image.length > MAX_IMAGE) return null;
  const rows = restartRows(image);
  if (!rows) return null;
  const chunks = [];
  let size = 12, literal = 0;
  function add(offset, length, data) {
    chunks.push({ offset, length, data });
    size += 8 + (data?.length || 0);
  }
  for (const row of rows) {
    const ref = base.rows.get(row.hash);
    if (!ref || ref.end - ref.start !== row.end - row.start ||
        !sameImage(base.image.subarray(ref.start, ref.end), image.subarray(row.start, row.end))) continue;
    if (row.start > literal) add(LITERAL, row.start - literal, image.subarray(literal, row.start));
    add(ref.start, row.end - row.start);
    literal = row.end;
    if (size > SINGLE_IMAGE) return null;
  }
  if (literal < image.length) add(LITERAL, image.length - literal, image.subarray(literal));
  if (size > SINGLE_IMAGE || size > image.length * 0.8) return null;
  const packet = new Uint8Array(size);
  const header = new DataView(packet.buffer);
  header.setUint32(0, ROW_PATCH);
  header.setUint32(4, base.serial);
  header.setUint32(8, image.length);
  let position = 12;
  for (const { offset, length, data } of chunks) {
    header.setUint32(position, offset);
    header.setUint32(position + 4, length);
    position += 8;
    if (data) {
      packet.set(data, position);
      position += length;
    }
  }
  return packet;
}

export function restoreRowPatch(base, packet) {
  if (packet[0] === 255) return packet; // Ordinary, independently decodable JPEG.
  if (!base || packet.length < 20 || packet.length > SINGLE_IMAGE) return null;
  const header = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const length = header.getUint32(8);
  if (header.getUint32(0) !== ROW_PATCH || header.getUint32(4) !== base.serial ||
      length <= SINGLE_IMAGE || length > MAX_IMAGE) return null;
  const image = new Uint8Array(length);
  let position = 12, output = 0, count = 0;
  while (position + 8 <= packet.length && ++count <= 1025) {
    const offset = header.getUint32(position), size = header.getUint32(position + 4);
    position += 8;
    const literal = offset === LITERAL;
    const source = literal ? packet : base.image;
    const from = literal ? position : offset;
    if (!size || size > length - output || size > source.length - from) return null;
    image.set(source.subarray(from, from + size), output);
    output += size;
    if (literal) position += size;
  }
  return output === length && position === packet.length ? image : null;
}
