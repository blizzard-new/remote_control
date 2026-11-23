// The four digits locate a temporary room. They never serve as an encryption key.
import { Relay, relayEndpoint } from "./relay.mjs";

const utf8 = new TextEncoder();
const encode = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const hex = (bytes) =>
  Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
const hash = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const keyOptions = { name: "ECDH", namedCurve: "P-256" };
const generate = () =>
  crypto.subtle.generateKey(keyOptions, false, ["deriveBits"]);
const publicBytes = async (key) =>
  new Uint8Array(await crypto.subtle.exportKey("spki", key.publicKey));

// Bind both halves of a saved pairing to this PIN exchange. Neither the PIN
// nor a claimed device name can authorize a return to a remembered channel.
async function resumeProof(secret, role, challenge) {
  const bytes = Uint8Array.from(
    atob(secret.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        utf8.encode("uniway-resume/v1/" + role + "/" + challenge),
      ),
    ),
  );
}
function resumeCandidates(contacts, address) {
  return contacts
    .filter(
      (c) =>
        c.address === address &&
        /^[A-Za-z0-9_-]{32}$/.test(c.listen) &&
        /^[A-Za-z0-9_-]{32}$/.test(c.dial),
    )
    .slice(0, 16);
}
export function resumeOffers(contacts, address, freshDial) {
  return Promise.all(
    resumeCandidates(contacts, address).map(async (pair) => ({
      pair,
      offer: await resumeProof(pair.dial, "controller", freshDial),
      answer: await resumeProof(pair.listen, "host", freshDial),
    })),
  );
}
export async function resumeAnswer(offers, contacts, address, freshListen) {
  if (!Array.isArray(offers) || !offers.length || offers.length > 16)
    return null;
  const priority = (pair) =>
    pair.grant === "control" ? 2 : pair.grant === "view" ? 1 : 0;
  const candidates = resumeCandidates(contacts, address).sort(
    (a, b) => priority(b) - priority(a),
  );
  for (const pair of candidates) {
    if (
      offers.includes(await resumeProof(pair.listen, "controller", freshListen))
    )
      return resumeProof(pair.dial, "host", freshListen);
  }
  return null;
}

async function derive(keys, other, host) {
  const pub = await crypto.subtle.importKey(
    "spki",
    other,
    keyOptions,
    false,
    [],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: pub },
      keys.privateKey,
      256,
    ),
  );
  const key = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveBits",
  ]);
  const bytes = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        info: utf8.encode("remote-control/pair/v1"),
      },
      key,
      432,
    ),
  );
  const incoming = encode(bytes.slice(0, 24)),
    outgoing = encode(bytes.slice(24, 48));
  return {
    listen: host ? incoming : outgoing,
    dial: host ? outgoing : incoming,
    check: hex(bytes.slice(48, 51)).toUpperCase(),
  };
}

function pinCode() {
  const buffer = new Uint16Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= 60000);
  return String(buffer[0] % 10000).padStart(4, "0");
}
async function pinRoom(code) {
  return hex(
    (await hash(utf8.encode("remote-control/pin/v1/" + code))).slice(0, 16),
  );
}
function sendKey(ws, id, bytes) {
  const packet = new Uint8Array(4 + bytes.length);
  new DataView(packet.buffer).setUint32(0, id);
  packet.set(bytes, 4);
  ws.send(packet);
}

export class PinHost {
  constructor(address, onCode, onPair, onError) {
    Object.assign(this, { address, onCode, onPair, onError });
    this.attempts = [];
    this.retries = 0;
  }
  async start() {
    if (this.closed) return;
    const code = pinCode(),
      room = await pinRoom(code);
    if (this.closed) return;
    const ws = (this.ws = new WebSocket(relayEndpoint(this.address)));
    const pending = new Set();
    ws.binaryType = "arraybuffer";
    this.timer = setTimeout(() => ws.close(), 12000);
    ws.onopen = () => ws.send(JSON.stringify({ room, role: "host" }));
    ws.onmessage = async ({ data }) => {
      if (ws !== this.ws || this.closed) return;
      if (typeof data === "string") {
        const m = JSON.parse(data);
        if (m.t === "unavailable" && ++this.retries < 8) return this.rotate();
        if (m.t === "ready") {
          clearTimeout(this.timer);
          this.retries = 0;
          this.onCode(code);
          this.timer = setTimeout(() => this.rotate(), 300000);
        }
        if (m.t === "join") pending.add(m.id);
        if (m.t === "left") pending.delete(m.id);
        return;
      }
      if (data.byteLength !== 95) return;
      const id = new DataView(data).getUint32(0);
      if (!pending.delete(id)) return;
      this.attempts = this.attempts.filter((t) => Date.now() - t < 60000);
      try {
        if (this.attempts.length >= 8) throw Error();
        this.attempts.push(Date.now());
        const keys = await generate();
        const contact = await derive(keys, data.slice(4), true);
        await this.onPair(contact);
        if (ws === this.ws && ws.readyState === 1)
          sendKey(ws, id, await publicBytes(keys));
      } catch {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: "drop", id }));
      }
    };
    ws.onclose = () => {
      if (!this.closed && ws === this.ws) {
        clearTimeout(this.timer);
        this.onError();
      }
    };
  }
  rotate() {
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    return this.start();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}

export async function findPin(address, code, signal) {
  const room = await pinRoom(code),
    keys = await generate();
  const pub = await publicBytes(keys);
  if (signal.aborted) throw Error("已取消配對。");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayEndpoint(address));
    ws.binaryType = "arraybuffer";
    let id;
    const finish = (value, error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      ws.onclose = null;
      ws.close();
      if (error) reject(Error(error));
      else resolve(value);
    };
    const cancel = () => finish(null, "已取消配對。");
    const timer = setTimeout(
      () => finish(null, "配對逾時，請確認對方目前顯示的四碼。"),
      15000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          role: "viewer",
          room,
          nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
        }),
      );
    ws.onclose = () => finish(null, "找不到此配對碼，請確認對方正在分享。");
    ws.onmessage = async ({ data }) => {
      try {
        if (typeof data === "string") {
          const m = JSON.parse(data);
          if (m.t !== "waiting")
            return finish(null, "找不到此配對碼，請確認對方正在分享。");
          id = m.id;
          return sendKey(ws, id, pub);
        }
        if (data.byteLength !== 95 || new DataView(data).getUint32(0) !== id)
          throw Error();
        finish(await derive(keys, data.slice(4), false));
      } catch {
        finish(null, "配對資料無效，請重新連線。");
      }
    };
  });
}

// Each remembered device has its own listener and directional credentials.
export class HostChannels {
  constructor(address, events) {
    this.address = address;
    this.events = events;
    this.channels = new Map();
    this.routes = new Map();
    this.next = 0;
    this.saved = new Map();
  }
  async start(contacts) {
    for (const contact of contacts.filter((p) => p.address === this.address)) {
      this.saved.set(contact.listen, { pair: contact, failures: 0 });
      this.listen(contact, true).catch(() => this.retry(contact.listen));
    }
    let failures = 0;
    const retryPin = () => {
      if (this.closed) return;
      this.events.reconnecting?.();
      this.pinTimer = setTimeout(
        () => this.pin.rotate().catch(retryPin),
        Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)),
      );
    };
    this.pin = new PinHost(
      this.address,
      (code) => {
        failures = 0;
        this.events.ready(code);
      },
      (pair) => this.listen(pair, false),
      retryPin,
    );
    await this.pin.start().catch(retryPin);
  }
  retry(key) {
    const saved = this.saved.get(key);
    if (!saved || this.closed || saved.timer || this.channels.has(key)) return;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(saved.failures++, 5));
    saved.timer = setTimeout(
      () => {
        saved.timer = null;
        this.listen(saved.pair, true).catch(() => this.retry(key));
      },
      delay + Math.random() * 1000,
    );
  }
  listen(pair, saved) {
    if (this.closed || this.channels.size >= 24)
      return Promise.reject(Error("已達裝置上限。"));
    return new Promise((resolve, reject) => {
      const ids = new Map();
      const entry = { saved, ids };
      const remove = () => {
        if (this.channels.get(pair.listen) !== entry) return;
        this.channels.delete(pair.listen);
        clearTimeout(entry.timer);
        entry.relay.close();
        for (const id of ids.values()) {
          this.routes.delete(id);
          this.events.left(id);
        }
        ids.clear();
        this.retry(pair.listen);
        reject(Error("裝置連線已結束。"));
      };
      entry.remove = remove;
      const relay = (entry.relay = new Relay(this.address, true, pair.listen, {
        ready: () => {
          clearTimeout(entry.timer);
          const savedRoute = this.saved.get(pair.listen);
          if (savedRoute) savedRoute.failures = 0;
          if (!entry.saved) entry.timer = setTimeout(remove, 150000);
          resolve();
        },
        unavailable: remove,
        closed: () => {
          if (this.channels.get(pair.listen) === entry) remove();
        },
        paired: (remote) => {
          if (ids.size || this.routes.size >= 8) return relay.drop(remote);
          const id = ++this.next;
          ids.set(remote, id);
          this.routes.set(id, { relay, remote });
          this.events.paired(id, { ...pair, saved: entry.saved });
        },
        left: (remote) => {
          const id = ids.get(remote);
          if (id === undefined) return;
          ids.delete(remote);
          this.routes.delete(id);
          this.events.left(id);
          if (!entry.saved && !ids.size) remove();
        },
        packet: (remote, type, data) =>
          this.events.packet(ids.get(remote), type, data),
      }));
      this.channels.set(pair.listen, entry);
      entry.timer = setTimeout(remove, 10000);
      relay.start().catch(remove);
    });
  }
  remember(pair) {
    const entry = this.channels.get(pair.listen);
    if (entry) {
      if (!this.saved.has(pair.listen))
        this.saved.set(pair.listen, { pair, failures: 0 });
      entry.saved = true;
      clearTimeout(entry.timer);
    }
  }
  forget(key) {
    clearTimeout(this.saved.get(key)?.timer);
    this.saved.delete(key);
    this.channels.get(key)?.remove();
  }
  json(id, value) {
    const r = this.routes.get(id);
    return r?.relay.json(r.remote, value);
  }
  send(id, type, data) {
    const r = this.routes.get(id);
    r?.relay.send(r.remote, type, data);
  }
  drop(id) {
    const r = this.routes.get(id);
    r?.relay.drop(r.remote);
  }
  close() {
    this.closed = true;
    clearTimeout(this.pinTimer);
    for (const entry of this.saved.values()) clearTimeout(entry.timer);
    this.saved.clear();
    this.pin?.close();
    for (const entry of [...this.channels.values()]) entry.remove();
  }
}
