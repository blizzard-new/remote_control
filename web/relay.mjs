import { SINGLE_IMAGE, MAX_IMAGE, PIECE_BYTES, imagePiece } from "./video.mjs";
// The invitation stays on the two devices. Only its hash identifies a relay room.
// Each direction has a separate AES-GCM key and an ordered packet counter.
const utf8 = new TextEncoder();
// Leave headroom below the relay's 5 MB/s host limit for control packets and network jitter.
const MEDIA_BYTES_PER_MS = 3840;
const MEDIA_BURST = 2 * (PIECE_BYTES + 64);
const hex = (bytes) =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
const unhex = (s) =>
  Uint8Array.from(s.match(/../g), (pair) => parseInt(pair, 16));
export const freshNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));
export function newInvite() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}
function secret(invite) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(invite))
    throw new Error("請輸入分享端顯示的完整邀請碼。");
  return Uint8Array.from(
    atob(invite.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function roomName(invite) {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", secret(invite))).slice(
      0,
      16,
    ),
  );
}
export async function sessionCipher(invite, hostNonce, viewerNonce, host) {
  if (
    ![hostNonce, viewerNonce].every(
      (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s),
    )
  )
    throw Error("配對資料無效。");
  const base = await crypto.subtle.importKey(
    "raw",
    secret(invite),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = unhex(hostNonce + viewerNonce);
  const derive = (direction) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: utf8.encode("remote-control/v1/" + direction),
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  const [outgoing, incoming] = await Promise.all([
    derive(host ? "share" : "view"),
    derive(host ? "view" : "share"),
  ]);
  let tx = 0,
    rx = 0;
  const iv = (n) => {
    const bytes = new Uint8Array(12);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(n));
    return bytes;
  };
  return {
    async seal(bytes) {
      return new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: iv(tx++) },
          outgoing,
          bytes,
        ),
      );
    },
    async open(bytes) {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv(rx) },
        incoming,
        bytes,
      );
      rx++;
      return new Uint8Array(plain);
    },
  };
}
export const DEFAULT_RELAY = "https://remote.uniway-tw.com";
export function relayEndpoint(address) {
  const u = new URL(address);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.protocol !== "https:" && !(local && u.protocol === "http:"))
  )
    throw Error("請使用 HTTPS 配對服務。");
  return (
    (u.protocol === "https:" ? "wss://" : "ws://") +
    u.host +
    u.pathname.replace(/\/$/, "") +
    "/v1/session"
  );
}
export class Relay {
  constructor(url, host, invite, events) {
    this.url = url;
    this.host = host;
    this.invite = invite;
    this.events = events;
    this.peers = new Map();
  }
  async start() {
    const room = await roomName(this.invite);
    if (this.closed) return;
    const ws = (this.ws = new WebSocket(relayEndpoint(this.url)));
    ws.binaryType = "arraybuffer";
    this.viewerNonce = freshNonce();
    let incoming = Promise.resolve();
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          role: this.host ? "host" : "viewer",
          room,
          nonce: this.viewerNonce,
        }),
      );
    ws.onmessage = (e) => {
      incoming = incoming
        .then(() => this.receive(e.data))
        .catch(() => this.close());
    };
    // Finish decrypting any final peer message before reporting the socket close.
    ws.onclose = () =>
      incoming.finally(() => {
        this.closed = true;
        this.events.closed();
      });
  }
  async receive(data) {
    if (this.closed) return;
    if (typeof data === "string") {
      const m = JSON.parse(data);
      if (m.t === "ready" && this.host) return this.events.ready();
      if (m.t === "waiting" && !this.host) {
        this.viewerId = m.id;
        return;
      }
      if (m.t === "unavailable") {
        this.events.unavailable();
        return;
      }
      if (m.t === "left") {
        this.peers.get(m.id)?.acknowledge?.();
        this.peers.delete(m.id);
        this.events.left(m.id);
        return;
      }
      if (
        (this.host && m.t === "join") ||
        (!this.host && m.t === "hello" && m.id === this.viewerId)
      ) {
        if (this.peers.has(m.id)) return;
        const hostNonce = this.host ? freshNonce() : m.nonce;
        const cipher = await sessionCipher(
          this.invite,
          hostNonce,
          this.host ? m.nonce : this.viewerNonce,
          this.host,
        );
        if (this.closed) return;
        this.peers.set(m.id, { cipher, queue: Promise.resolve(), pending: 0 });
        if (this.host)
          this.ws.send(
            JSON.stringify({ t: "hello", id: m.id, nonce: hostNonce }),
          );
        this.events.paired(m.id);
      }
      return;
    }
    if (data.byteLength < 21) return;
    const id = new DataView(data).getUint32(0),
      peer = this.peers.get(id);
    if (!peer) return;
    try {
      const plain = await peer.cipher.open(new Uint8Array(data, 4));
      await this.events.packet(id, plain[0], plain.subarray(1));
    } catch {
      this.drop(id);
    }
  }
  send(id, type, payload) {
    const peer = this.peers.get(id);
    if (!peer || this.closed || this.ws.readyState !== 1) return;
    if (type === 2 && (peer.pending > 1 || this.ws.bufferedAmount > 420000))
      return;
    if (peer.pending > 350) {
      this.drop(id);
      return;
    }
    peer.pending++;
    peer.queue = peer.queue
      .then(async () => {
        if (this.peers.get(id) !== peer || this.closed) return;
        const data = new Uint8Array(1 + payload.length);
        data[0] = type;
        data.set(payload, 1);
        const encrypted = await peer.cipher.seal(data);
        if (this.peers.get(id) !== peer || this.closed) return;
        const packet = new Uint8Array(4 + encrypted.length);
        new DataView(packet.buffer).setUint32(0, id);
        packet.set(encrypted, 4);
        this.ws.send(packet);
      })
      .catch(() => this.drop(id))
      .finally(() => peer.pending--);
    return peer.queue;
  }
  imageReceived(id, serial) {
    const peer = this.peers.get(id);
    if (peer && peer.imageSerial === serial) peer.acknowledge?.(true);
  }

  cancelImage(id) {
    const peer = this.peers.get(id);
    if (peer?.sendingImage) {
      peer.imageCancelled = true;
      peer.acknowledge?.();
    }
  }
  mediaDelay(bytes, now) {
    const available = this.mediaTick === undefined ? MEDIA_BURST : Math.min(
      MEDIA_BURST, this.mediaCredit + (now - this.mediaTick) * MEDIA_BYTES_PER_MS,
    );
    this.mediaTick = now;
    this.mediaCredit = available;
    if (available < bytes) return Math.ceil((bytes - available) / MEDIA_BYTES_PER_MS);
    this.mediaCredit -= bytes;
    return 0;
  }

  async sendImage(id, image, parts, patch = false) {
    const peer = this.peers.get(id);
    if (
      !peer ||
      this.closed ||
      peer.sendingImage ||
      image.length > (parts ? MAX_IMAGE : SINGLE_IMAGE)
    )
      return;
    peer.sendingImage = true;
    peer.imageCancelled = false;
    const fragmented = image.length > SINGLE_IMAGE;
    let receipt, timer;
    if (fragmented || patch) {
      peer.imageSerial = ((peer.imageSerial || 0) + 1) >>> 0 || 1;
      receipt = new Promise((done) => {
        peer.acknowledge = done;
      });
    }
    try {
      for (
        let offset = 0;
        offset < image.length;
        offset += fragmented ? PIECE_BYTES : image.length
      ) {
        const size = fragmented
          ? Math.min(PIECE_BYTES, image.length - offset)
          : image.length;
        // Check at send time so viewers share one burst even when timers wake late.
        for (;;) {
          if (this.closed || peer.imageCancelled || this.peers.get(id) !== peer ||
              this.ws.readyState !== 1) return;
          const delay = this.ws.bufferedAmount > PIECE_BYTES
            ? 12 : this.mediaDelay(size + 64, performance.now());
          if (!delay) break;
          await new Promise((done) => setTimeout(done, delay));
        }
        if (patch) {
          const packet = new Uint8Array(4 + image.length);
          new DataView(packet.buffer).setUint32(0, peer.imageSerial);
          packet.set(image, 4);
          await this.send(id, 6, packet);
        } else {
          await this.send(id, fragmented ? 4 : 2,
            fragmented ? imagePiece(image, offset, peer.imageSerial) : image);
        }
      }
      // A slow downstream must finish one large frame before another one is queued.
      if (receipt && !peer.imageCancelled && this.peers.get(id) === peer) {
        timer = setTimeout(peer.acknowledge, 25000);
        if (await receipt) return peer.imageSerial;
      }
    } finally {
      clearTimeout(timer);
      peer.acknowledge = null;
      peer.sendingImage = false;
    }
  }
  json(id, value) {
    return this.send(id, 1, utf8.encode(JSON.stringify(value)));
  }
  drop(id) {
    this.peers.get(id)?.acknowledge?.();
    if (!this.peers.delete(id)) return;
    if (this.host && this.ws?.readyState === 1)
      this.ws.send(JSON.stringify({ t: "drop", id }));
    else if (!this.host) this.close();
    this.events.left(id);
  }
  close() {
    this.closed = true;
    for (const peer of this.peers.values()) peer.acknowledge?.();
    this.peers.clear();
    this.ws?.close();
  }
}

export function formatInvite(address, invite) {
  relayEndpoint(address);
  return (
    "rc1." +
    btoa(new URL(address).href.replace(/\/$/, ""))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "") +
    "." +
    invite
  );
}
export function parseInvite(value, fallback) {
  const parts = value.trim().split(".");
  if (parts.length === 1) {
    secret(parts[0]);
    return { invite: parts[0], address: fallback };
  }
  if (parts.length !== 3 || parts[0] !== "rc1") throw Error("邀請碼格式無效。");
  const address = atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"));
  relayEndpoint(address);
  secret(parts[2]);
  return { invite: parts[2], address };
}
