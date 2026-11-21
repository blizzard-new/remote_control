import { attachInput } from "./input.mjs";
import {
  DEFAULT_RELAY,
  newInvite,
  Relay,
  formatInvite,
  parseInvite,
} from "./relay.mjs";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("host");
if (location.hash) history.replaceState(null, "", location.pathname);
$("hostbox").hidden = !token;
if (token) $("lan").href = "/#host=" + encodeURIComponent(token);
$("relay").value = localStorage.getItem("rc-relay") || DEFAULT_RELAY;
const canvas = $("picture"),
  ctx = canvas.getContext("2d");
let active = null;
const decoder = new TextDecoder();
function say(value) {
  $("message").textContent = value;
}
function closeSession(s, message) {
  if (active !== s) return;
  active = null;
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
  $("invite").type = "password";
  $("show").textContent = "顯示";
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
    invite: host ? newInvite() : $("code").value.trim(),
  });
  $("status").textContent = "正在連線";
  $("joinbox").hidden = host;
  $("start").hidden = true;
  $("connect").disabled = true;
  $("settings").hidden = true;
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
  p.ws?.close();
  p.pc?.close();
  p.video?.pause();
  clearTimeout(p.timeout);
  p.row?.remove();
  if (active === s && !s.host) closeSession(s, "分享已結束。");
}
function connectRelay(s) {
  const address = $("relay").value.trim();
  s.relay = new Relay(address, s.host, s.invite, {
    ready() {
      if (active !== s) return;
      clearTimeout(s.deadline);
      $("status").textContent = "等候連線";
      $("invitation").hidden = false;
      $("invite").value = formatInvite(address, s.invite);
      say("將邀請碼交給另一台已安裝的裝置。");
    },
    paired(id) {
      if (active !== s) return;
      const p = { id, approved: false };
      s.peers.set(id, p);
      p.timeout = setTimeout(() => s.relay.drop(id), 120000);
      if (!s.host) {
        clearTimeout(s.deadline);
        s.relay.json(id, { t: "request", name: $("name").value.trim() });
        say("請等候分享端同意。");
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
        clearTimeout(p.timeout);
        p.approved = true;
        p.control = m.control === true;
        $("joinbox").hidden = true;
        $("stage").hidden = false;
        $("status").textContent = "已連線";
        say(
          p.control
            ? "已獲准操作。可點選畫面後使用鍵盤、滑鼠或雙指捲動。"
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
  });
  localStorage.setItem("rc-relay", address);
  return s.relay.start();
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
  const track = s.stream?.getVideoTracks()[0],
    cap = s.cap;
  if (!track || !cap?.control || track.readyState !== "live" || track.muted)
    return false;
  const { displaySurface, width, height } = track.getSettings();
  return (
    displaySurface === "monitor" &&
    width > 0 &&
    height > 0 &&
    Math.abs(width / height / (cap.width / cap.height) - 1) < 0.015
  );
}
function request(s, p, name) {
  if (!name) return s.relay.drop(p.id);
  p.name = name;
  p.ws = localSocket();
  p.ws.onopen = () =>
    p.ws.send(JSON.stringify({ type: "join", name, code: s.localCode }));
  p.ws.onmessage = (e) => {
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
      s.relay.json(p.id, { t: "approved", control: p.control });
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
  name.textContent = p.name;
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
  if (typeof RTCPeerConnection === "undefined" || p.pc) return;
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
function streamFallback(s) {
  const c = document.createElement("canvas"),
    v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = s.stream;
  v.play().catch(() => {});
  let busy = false;
  s.frames = setInterval(async () => {
    for (const p of s.peers.values()) {
      if (p.control && !eligible(s)) s.relay.drop(p.id);
    }
    const targets = [...s.peers.values()].filter(
      (p) => p.approved && !p.direct,
    );
    if (busy || !targets.length || !v.videoWidth || v.readyState < 2) return;
    busy = true;
    try {
      const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      c.width = Math.max(1, Math.round(v.videoWidth * scale));
      c.height = Math.max(1, Math.round(v.videoHeight * scale));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      const b = await new Promise((resolve) =>
        c.toBlob(resolve, "image/jpeg", 0.62),
      );
      if (b && b.size < 340000 && active === s) {
        const data = new Uint8Array(await b.arrayBuffer());
        for (const p of targets)
          if (s.peers.get(p.id) === p && p.approved)
            s.relay.send(p.id, 2, data);
      }
    } finally {
      busy = false;
    }
  }, 140);
}
$("start").onclick = async () => {
  if (!token || active) return;
  const s = begin(true);
  try {
    s.stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    if (active !== s) {
      s.stream.getTracks().forEach((t) => t.stop());
      return;
    }
    s.stream.getVideoTracks()[0].onended = () =>
      closeSession(s, "畫面分享已停止。");
    s.local = localSocket();
    s.local.onopen = () =>
      s.local.send(JSON.stringify({ type: "host", token }));
    s.local.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "hosted") {
        s.localCode = m.code;
        s.cap = m.capabilities;
        streamFallback(s);
        try {
          await connectRelay(s);
        } catch (err) {
          closeSession(s, err.message);
        }
      }
      if (m.type === "error" && m.id)
        for (const p of s.peers.values()) {
          if (p.localId === m.id) s.relay.drop(p.id);
        }
    };
    s.local.onclose = () => closeSession(s, "本機分享服務已停止。");
  } catch (err) {
    closeSession(
      s,
      err.name === "NotAllowedError" ? "尚未授權擷取螢幕。" : err.message,
    );
  }
};
$("join").onsubmit = async (e) => {
  e.preventDefault();
  if (active) return;
  try {
    const parsed = parseInvite($("code").value, $("relay").value.trim());
    $("relay").value = parsed.address;
    const s = begin(false);
    s.invite = parsed.invite;
    try {
      await connectRelay(s);
    } catch (err) {
      closeSession(s, err.message);
    }
  } catch (err) {
    say(err.message);
  }
};
$("show").onclick = () => {
  const hidden = $("invite").type === "password";
  $("invite").type = hidden ? "text" : "password";
  $("show").textContent = hidden ? "隱藏" : "顯示";
};
$("copy").onclick = () =>
  navigator.clipboard
    .writeText($("invite").value)
    .catch(() => say("請按「顯示」後手動複製邀請碼。"));
$("stop").onclick = $("leave").onclick = () => {
  if (active) closeSession(active, "連線已結束。");
};
window.addEventListener("pagehide", () => {
  if (active) closeSession(active, "連線已結束。");
});
