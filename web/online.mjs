import { HostChannels, findPin } from "./pairing.mjs";
import { devices } from "./devices.mjs";
import { attachInput } from "./input.mjs";
import { DEFAULT_RELAY, Relay, parseInvite } from "./relay.mjs";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const suppliedToken = params.get("host");
const reload = performance.getEntriesByType("navigation")[0]?.type === "reload";
const token =
  suppliedToken || (reload && sessionStorage.getItem("rc-host-token"));
if (suppliedToken) sessionStorage.setItem("rc-host-token", suppliedToken);
if (location.hash) history.replaceState(null, "", location.pathname);
$("hostbox").hidden = !token;
if (token) $("lan").href = "/#host=" + encodeURIComponent(token);
$("relay").value = localStorage.getItem("rc-relay") || DEFAULT_RELAY;
const canvas = $("picture"),
  ctx = canvas.getContext("2d");
let active = null;
const defaultName = window.PhoneDevices
  ? window.PhoneDevices.name()
  : navigator.platform.includes("Mac")
    ? "我的 Mac"
    : "我的電腦";
$("name").value = localStorage.getItem("rc-name") || defaultName;
let contacts = [];
async function refreshDevices(action, item) {
  const loaded = await devices(token, action, item);
  if (!Array.isArray(loaded)) throw Error("無法儲存配對，請先解除舊裝置。");
  contacts = loaded;
  const list = $("remembered");
  list.replaceChildren();
  for (const pair of contacts) {
    const row = document.createElement("div");
    const connect = document.createElement("button"),
      forget = document.createElement("button");
    connect.type = forget.type = "button";
    connect.textContent = pair.name;
    connect.onclick = () => joinDevice(pair);
    forget.textContent = "解除配對";
    forget.onclick = async () => {
      if (!confirm("解除與「" + pair.name + "」的配對？")) return;
      active?.relay?.forget?.(pair.listen);
      try {
        await refreshDevices("forget", pair);
      } catch (err) {
        say(err.message);
      }
    };
    row.append(connect, forget);
    list.append(row);
  }
  $("known").hidden = !contacts.length;
}
refreshDevices().catch((err) => say(err.message));
const decoder = new TextDecoder();
function say(value) {
  $("message").textContent = value;
}
function closeSession(s, message) {
  if (active !== s) return;
  active = null;
  mobileView(false);
  s.abort.abort();
  s.relay?.close();
  s.local?.close();
  s.stream?.getTracks().forEach((t) => t.stop());
  for (const p of s.peers.values()) {
    p.ws?.close();
    p.pc?.close();
    clearTimeout(p.timeout);
    p.video?.pause();
  }
  clearTimeout(s.deadline);
  clearInterval(s.frames);
  clearInterval(s.captureTimer);
  s.detach?.();
  $("start").hidden = $("connect").disabled = false;
  $("joinbox").hidden =
    $("stage").hidden =
    $("invitation").hidden =
    $("stop").hidden =
    $("leave").hidden =
      true;
  $("joinbox").hidden = false;
  $("hostbox").hidden = !token;
  $("settings").hidden = false;
  $("invite").value = "";

  $("devices").replaceChildren();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $("status").textContent = "待命";
  say(message);
}
function begin(host) {
  if (active) throw Error("已有連線。");
  const s = (active = {
    host,
    peers: new Map(),
    abort: new AbortController(),
  });
  $("status").textContent = "正在連線";
  $("joinbox").hidden = false;
  $("start").hidden = true;
  $("connect").disabled = !host;
  $("settings").hidden = !host;
  $("hostbox").hidden = !host;
  $("stop").hidden = !host;
  $("leave").hidden = host;
  s.deadline = setTimeout(
    () =>
      closeSession(s, "配對服務未回應。請確認兩台裝置的服務網址，然後重試。"),
    100000,
  );
  return s;
}
function safeText(value, len = 60) {
  return typeof value === "string" ? value.slice(0, len) : "";
}
function peerLeft(s, id) {
  const p = s.peers.get(id);
  if (!p) return;
  s.peers.delete(id);
  if (s.host && ![...s.peers.values()].some((v) => v.approved)) {
    s.reading = false;
    s.hasFrame = false;
  }
  p.ws?.close();
  p.pc?.close();
  p.video?.pause();
  clearTimeout(p.timeout);
  p.row?.remove();
  if (active === s && !s.host) closeSession(s, "分享已結束。");
}
async function connectRelay(s) {
  const address = new URL($("relay").value.trim()).href.replace(/\/+$/, "");
  s.address = address;
  $("relay").value = address;
  const events = {
    ready(code) {
      if (active !== s) return;
      clearTimeout(s.deadline);
      $("status").textContent = "等候連線";
      $("invitation").hidden = false;
      $("invite").value = code;
      say("將邀請碼交給另一台已安裝的裝置。");
    },
    paired(id, pair) {
      if (active !== s) return;
      const p = { id, approved: false, pair };
      s.peers.set(id, p);
      p.timeout = setTimeout(() => s.relay.drop(id), 120000);
      if (!s.host) {
        clearTimeout(s.deadline);
        s.relay.json(id, { t: "request", name: $("name").value.trim() });
        say(
          s.pair?.check
            ? "請與分享端核對 " + s.pair.check + "，並等候同意。"
            : "已向對方送出連線請求。",
        );
      }
    },
    left(id) {
      peerLeft(s, id);
    },
    unavailable() {
      closeSession(s, "找不到這次分享。請確認邀請碼、配對服務及分享端狀態。");
    },
    closed() {
      closeSession(s, "網路連線已結束。重新分享即可取得新的邀請碼。");
    },
    async packet(id, type, data) {
      if (active !== s) return;
      const p = s.peers.get(id);
      if (!p) return;
      if (type === 2) {
        if (!s.host && p.approved && !p.direct && !p.painting) {
          p.painting = true;
          createImageBitmap(new Blob([data], { type: "image/jpeg" }))
            .then((image) => {
              try {
                if (active === s && s.peers.has(id) && !p.direct)
                  paint(image, image.width, image.height);
              } finally {
                image.close();
              }
            })
            .catch(() => {})
            .finally(() => (p.painting = false));
        }
        return;
      }
      if (type !== 1 || data.length > 96000) return;
      const m = JSON.parse(decoder.decode(data));
      if (s.host) {
        if (m.t === "request" && !p.ws)
          return request(s, p, safeText(m.name, 48));
        if (!p.approved) return;
        if (
          m.t === "input" &&
          p.control &&
          s.hasFrame &&
          eligible(s) &&
          m.event &&
          s.local.readyState === 1
        ) {
          s.local.send(
            JSON.stringify({ type: "input", id: p.localId, event: m.event }),
          );
        } else if (m.t === "answer" && p.pc)
          await p.pc.setRemoteDescription(m.sdp);
        else if (m.t === "direct") p.direct = m.on === true;
      } else if (m.t === "approved" && !p.approved) {
        if (s.pair && !s.pair.saved && m.remembered) {
          const { listen, dial } = s.pair;
          try {
            await refreshDevices("save", {
              listen,
              dial,
              address,
              name: safeText(m.name) || "已配對裝置",
            });
          } catch (err) {
            say(err.message);
          }
        }
        clearTimeout(p.timeout);
        p.approved = true;
        p.control = m.control === true;
        $("joinbox").hidden = true;
        $("stage").hidden = false;
        mobileView(true);
        canvas.focus({ preventScroll: true });
        $("status").textContent = "已連線";
        say(
          p.control
            ? "已獲准操作。點一下可操作該位置，雙指可捲動。"
            : "已獲准觀看。",
        );
        if (p.control)
          s.detach = attachInput(canvas, (event) =>
            s.relay.json(id, { t: "input", event }),
          );
      } else if (!s.host && p.approved && m.t === "offer") {
        await direct(s, p, m.sdp).catch(() => {
          p.pc?.close();
          p.pc = null;
        });
      }
    },
  };
  localStorage.setItem("rc-relay", address);
  if (s.host) {
    s.relay = new HostChannels(address, events);
    await refreshDevices();
    if (active === s) await s.relay.start(contacts);
  } else {
    s.relay = new Relay(address, false, s.invite, events);
    await s.relay.start();
  }
}
function paint(image, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(image, 0, 0, w, h);
}
function localSocket() {
  return new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/ws",
  );
}
function eligible(s) {
  return s.primary && s.cap?.control;
}
function request(s, p, name) {
  if (!name) return s.relay.drop(p.id);
  p.name = name;
  p.ws = localSocket();
  p.ws.onopen = () =>
    p.ws.send(JSON.stringify({ type: "join", name, code: s.localCode }));
  p.ws.onmessage = async (e) => {
    if (active !== s || !s.peers.has(p.id)) return;
    const m = JSON.parse(e.data);
    if (m.type === "pending") {
      p.localId = m.id;
      renderRequest(s, p);
    }
    if (m.type === "approved") {
      clearTimeout(p.timeout);
      p.control = m.control;
      p.approved = true;
      renderRequest(s, p);
      let remembered = !!p.pair?.saved;
      if (p.pair && !remembered) {
        const { listen, dial } = p.pair;
        try {
          await refreshDevices("save", {
            listen,
            dial,
            address: s.address,
            name: p.name,
          });
          s.relay.remember(p.pair);
          remembered = true;
        } catch (err) {
          say(err.message);
        }
      }
      s.relay.json(p.id, {
        t: "approved",
        control: p.control,
        remembered,
        name: $("name").value.trim() || defaultName,
      });
      direct(s, p).catch(() => {
        p.pc?.close();
        p.pc = null;
      });
    }
    if (["error", "left", "denied"].includes(m.type)) s.relay.drop(p.id);
  };
  p.ws.onclose = () => s.relay.drop(p.id);
}
function renderRequest(s, p) {
  p.row?.remove();
  const row = (p.row = document.createElement("div"));
  row.className = "card device";
  const name = document.createElement("strong");
  name.textContent = p.pair?.saved
    ? p.pair.name + "（已配對）"
    : p.name + (p.pair?.check ? " · 核對 " + p.pair.check : "");
  row.append(name);
  const button = (label, fn) => {
    const b = document.createElement("button");
    b.className = "secondary";
    b.textContent = label;
    b.onclick = fn;
    row.append(b);
  };
  if (!p.approved) {
    const approve = (control) => {
      for (const b of row.querySelectorAll("button")) b.disabled = true;
      s.local.send(JSON.stringify({ type: "approve", id: p.localId, control }));
    };
    button("允許觀看", () => approve(false));
    if (eligible(s) && ![...s.peers.values()].some((v) => v.control))
      button("允許操作", () => approve(true));
    button("拒絕", () => s.relay.drop(p.id));
  } else button("中斷連線", () => s.relay.drop(p.id));
  $("devices").append(row);
}
async function direct(s, p, offer) {
  if (typeof RTCPeerConnection === "undefined" || p.pc || (s.host && !s.stream))
    return;
  const pc = (p.pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  }));
  if (s.host) {
    pc.addTrack(s.stream.getVideoTracks()[0], s.stream);
    await pc.setLocalDescription(await pc.createOffer());
  } else {
    pc.ontrack = (e) => {
      const v = (p.video = document.createElement("video"));
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([e.track]);
      v.play().catch(() => {});
      const draw = () => {
        if (
          active !== s ||
          !s.peers.has(p.id) ||
          pc.connectionState === "closed"
        )
          return;
        if (v.readyState >= 2 && pc.connectionState === "connected") {
          paint(v, v.videoWidth, v.videoHeight);
          if (!p.direct) {
            p.direct = true;
            s.relay.json(p.id, { t: "direct", on: true });
          }
        }
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(draw);
        else setTimeout(draw, 40);
      };
      draw();
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(pc.connectionState)) {
        p.direct = false;
        s.relay.json(p.id, { t: "direct", on: false });
      }
    };
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
  }
  if (pc.iceGatheringState !== "complete")
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", changed);
        resolve();
      };
      const changed = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, 3500);
      pc.addEventListener("icegatheringstatechange", changed);
    });
  if (active === s && s.peers.has(p.id))
    s.relay.json(p.id, {
      t: s.host ? "offer" : "answer",
      sdp: pc.localDescription,
    });
}
function mobileView(on) {
  const immersive =
    on && (window.ViewerScreen || matchMedia("(pointer: coarse)").matches);
  document.body.classList.toggle("remote-viewing", Boolean(immersive));
  window.ViewerScreen?.setActive(Boolean(immersive));
}
function startCapture(s) {
  const source = (s.source = document.createElement("canvas"));
  source.width = source.height = 2;
  s.stream = source.captureStream?.(30);
  const fallback = document.createElement("canvas");
  let nextRelayFrame = 0;
  s.captureTimer = setInterval(() => {
    if (
      active !== s ||
      s.reading ||
      ![...s.peers.values()].some((p) => p.approved)
    )
      return;
    s.reading = true;
    s.local.send(JSON.stringify({ type: "primary-frame" }));
  }, 40);
  return async (data) => {
    const image = await createImageBitmap(
      new Blob([data], { type: "image/jpeg" }),
    );
    try {
      if (active !== s || ![...s.peers.values()].some((p) => p.approved))
        return;
      if (source.width !== image.width || source.height !== image.height) {
        source.width = image.width;
        source.height = image.height;
      }
      source.getContext("2d").drawImage(image, 0, 0);
      s.hasFrame = true;
      const targets = [...s.peers.values()].filter(
        (p) => p.approved && !p.direct,
      );
      if (!targets.length || performance.now() < nextRelayFrame) return;
      nextRelayFrame = performance.now() + 120;
      let jpeg = data;
      if (data.byteLength >= 340000) {
        const scale = Math.min(1, 960 / Math.max(image.width, image.height));
        fallback.width = Math.max(1, Math.round(image.width * scale));
        fallback.height = Math.max(1, Math.round(image.height * scale));
        fallback
          .getContext("2d")
          .drawImage(image, 0, 0, fallback.width, fallback.height);
        const blob = await new Promise((resolve) =>
          fallback.toBlob(resolve, "image/jpeg", 0.62),
        );
        if (!blob || blob.size >= 340000) return;
        jpeg = await blob.arrayBuffer();
      }
      for (const p of targets)
        if (active === s && s.peers.get(p.id) === p)
          s.relay.send(p.id, 2, new Uint8Array(jpeg));
    } finally {
      image.close();
    }
  };
}
function standby() {
  if (!token || active) return;
  const s = begin(true);
  s.local = localSocket();
  s.local.binaryType = "arraybuffer";
  s.local.onopen = () => s.local.send(JSON.stringify({ type: "host", token }));
  s.local.onmessage = async (e) => {
    if (active !== s) return;
    try {
      if (e.data instanceof ArrayBuffer) {
        try {
          await s.frame(e.data);
        } finally {
          s.reading = false;
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === "hosted") {
        s.localCode = m.code;
        s.cap = m.capabilities;
        s.primary = m.primaryCapture;
        if (!s.primary) throw Error("請開啟新版桌面程式以連接主螢幕。");
        s.frame = startCapture(s);
        await connectRelay(s);
      }
      if (m.type === "capture-error") throw Error(m.message);
      if (m.type === "error" && !m.id) throw Error(m.message);
      if (m.type === "error" && m.id)
        for (const p of s.peers.values())
          if (p.localId === m.id) s.relay.drop(p.id);
    } catch (err) {
      closeSession(s, err.message);
    }
  };
  s.local.onclose = () => closeSession(s, "本機連線服務已停止。");
}
$("start").onclick = standby;
$("relay").onchange = () => {
  if (active?.host && !active.peers.size) {
    closeSession(active, "");
    standby();
  }
};
async function joinDevice(saved) {
  if (active?.host && !active.peers.size) closeSession(active, "");
  if (active) {
    say("請先結束目前的連線。");
    return;
  }
  const s = begin(false);
  try {
    localStorage.setItem("rc-name", $("name").value.trim() || defaultName);
    const value = $("code").value.trim();
    if (saved) {
      $("relay").value = saved.address;
      s.pair = { ...saved, saved: true };
    } else if (/^[0-9]{4}$/.test(value)) {
      s.pair = await findPin($("relay").value.trim(), value, s.abort.signal);
    } else {
      const parsed = parseInvite(value, $("relay").value.trim());
      $("relay").value = parsed.address;
      s.invite = parsed.invite;
    }
    if (active !== s) return;
    if (s.pair) s.invite = s.pair.dial;
    await connectRelay(s);
  } catch (err) {
    closeSession(s, err.message);
  }
}
$("join").onsubmit = (e) => {
  e.preventDefault();
  joinDevice();
};
$("copy").onclick = () =>
  navigator.clipboard
    .writeText($("invite").value)
    .catch(() => say("請手動輸入畫面上的四位數。"));
$("stop").onclick = $("leave").onclick = () => {
  if (active) closeSession(active, "連線已結束。");
};
window.addEventListener("pagehide", () => {
  if (active) closeSession(active, "連線已結束。");
});

standby();

if (token) {
  async function update(action) {
    const check = $("check-update"),
      install = $("install-update"),
      status = $("update-status");
    if (action === "install" && active && (!active.host || active.peers.size)) {
      status.textContent = "請先結束遠端連線，再安裝更新。";
      return;
    }
    check.disabled = install.disabled = true;
    status.textContent =
      action === "check" ? "正在檢查版本…" : "正在下載並驗證安裝檔…";
    try {
      const response = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Host-Token": token },
        body: JSON.stringify({ action }),
      });
      if ([404, 405].includes(response.status)) {
        $("updates").hidden = true;
        return;
      }
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "更新服務暫時無法使用。");
      if (result.installing) {
        status.textContent = "已開啟安裝程式。完成後請重新開啟遠端桌面。";
        install.hidden = true;
      } else {
        status.textContent = result.available
          ? "目前版本 " + result.current + "，可更新至 " + result.latest
          : "目前版本 " + result.current + " 已是最新。";
        install.hidden = !result.available;
      }
    } catch (err) {
      status.textContent = "更新失敗，可再試一次。" + err.message;
    } finally {
      check.disabled = install.disabled = false;
    }
  }
  $("updates").hidden = false;
  $("check-update").onclick = () => update("check");
  $("install-update").onclick = () => update("install");
  update("check");
}
