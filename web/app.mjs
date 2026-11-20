import { attachInput } from "./input.mjs";

const el = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get("host");
const isHost = Boolean(token);
const qualityLevels = {
  balanced: { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  clear: { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  smooth: { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
  fast: { width: 2560, height: 1440, fps: 120, bitrate: 40_000_000 },
  ultra: { width: 3840, height: 2160, fps: 60, bitrate: 50_000_000 },
};
const entries = new Map();
let socket = null;
let stream = null;
let capabilities = {};
let iceServers = [];
let hosted = false;
let codeVisible = false;
let privacy = false;
let privacyPending = false;
let privacyRequested = false;
let privacyTimer;
let monitorTimer;
let displayRequest = 0;

function status(message, live = false) {
  el("status").textContent = message;
  el("status").dataset.live = String(live);
}

function notice(message = "") {
  el("notice").textContent = message;
  el("notice").hidden = !message;
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function action(label, callback, primary = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "primary" : "secondary";
  button.textContent = label;
  button.addEventListener("click", callback);
  return button;
}

function displayEligible() {
  const track = stream?.getVideoTracks()[0];
  if (!capabilities.control || !track || track.readyState !== "live" || track.muted) return false;
  const { displaySurface, width, height } = track.getSettings();
  if (displaySurface !== "monitor" || !(width > 0 && height > 0 && capabilities.width > 0 && capabilities.height > 0)) return false;
  // A downscaled full monitor preserves its aspect ratio (allow encoder rounding).
  return Math.abs((width / height) / (capabilities.width / capabilities.height) - 1) < 0.015;
}

function canControl() {
  return el("allow-control").checked && displayEligible();
}

function disconnectEntry(id) {
  send({ type: "leave", id });
  removeEntry(id);
}

function updateEligibility() {
  const eligible = displayEligible();
  el("allow-control").disabled = !eligible;
  if (!eligible) {
    el("allow-control").checked = false;
    for (const [id, entry] of entries) {
      if (entry.control || entry.requestedControl) disconnectEntry(id);
    }
  }
  el("control-note").textContent = !capabilities.control
    ? capabilities.controlHint || "此主機目前僅支援觀看。"
    : eligible
      ? "每次只能有一台裝置操作。其他裝置仍可同時觀看。"
      : "要使用遠端操作，請重新分享並選取整個主螢幕。視窗、分頁及無法辨識的來源僅支援觀看。";
  renderHost();
}

function activeController() {
  return [...entries.values()].find((entry) => entry.control || entry.requestedControl);
}

function answerRequest(entry, control) {
  if (entry.busy || (control && (!canControl() || activeController()))) return;
  const allowPrivacy = control && capabilities.privacy === true && el("allow-privacy").checked;
  if (send({ type: "approve", id: entry.id, control, allowPrivacy })) {
    entry.allowPrivacy = allowPrivacy;
    entry.busy = true;
    entry.requestedControl = control;
    renderHost();
  }
}

function renderHost() {
  if (!isHost) return;
  const hasViewers = [...entries.values()].some((entry) => entry.pc);
  if (!hasViewers) codeVisible = false;
  el("invite-code").type = hasViewers && !codeVisible ? "password" : "text";
  el("reveal").hidden = !hasViewers;
  el("reveal").textContent = codeVisible ? "隱藏" : "顯示";
  el("reveal").setAttribute("aria-pressed", String(codeVisible));
  el("devices").replaceChildren();
  el("count").textContent = entries.size;
  el("empty").hidden = entries.size > 0;
  el("empty").textContent = hosted ? "正在等候裝置提出連線請求。" : "開始分享後，裝置的連線請求會顯示在這裡。";
  for (const entry of entries.values()) {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const state = document.createElement("small");
    state.textContent = !entry.pc ? (entry.busy ? "處理中" : "等候同意") :
      (entry.connected ? "已連線" : "正在連接影像") + (entry.control ? " · 可操作" : " · 僅觀看");
    const buttons = document.createElement("div");
    buttons.className = "actions";
    if (entry.pc) {
      buttons.append(action("中斷連線", () => disconnectEntry(entry.id)));
    } else if (!entry.busy) {
      buttons.append(action("允許觀看", () => answerRequest(entry, false), true));
      if (canControl() && !activeController()) {
        buttons.append(action("允許操作", () => answerRequest(entry, true)));
      }
      buttons.append(action("拒絕", () => {
        if (send({ type: "deny", id: entry.id })) {
          entry.busy = true;
          renderHost();
        }
      }));
    }
    row.append(name, state, buttons);
    el("devices").append(row);
  }
  const controller = activeController();
  el("privacy-permission").hidden = !capabilities.privacy || !canControl() || Boolean(controller);
  el("privacy-panel").hidden = !(controller?.allowPrivacy && controller.channel?.readyState === "open") && !privacy;
  el("privacy-toggle").disabled = privacyPending;
  el("privacy-toggle").textContent = privacy ? "關閉隱私模式" : "開啟隱私模式";
  el("privacy-ask").hidden = !privacyRequested;
  el("privacy-ask").textContent = privacyRequested ? controller?.name + " 請求開啟本機螢幕隱私模式。" : "";
  el("privacy-deny").hidden = !privacyRequested;
}

function removeEntry(id) {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  clearTimeout(entry.disconnectTimer);
  clearTimeout(entry.negotiationTimer);
  clearInterval(entry.statsTimer);
  entry.dropInput?.();
  entry.channel?.close();
  entry.pc?.close();
  if (isHost && entry.control) {
    privacyRequested = false;
    el("allow-privacy").checked = false;
    // The server also restores the display as part of revoking the controller.
    if (privacy || privacyPending) send({ type: "privacy", enabled: false });
  }
  renderHost();
}

function reset(message = "") {
  displayRequest++;
  clearTimeout(privacyTimer);
  clearInterval(monitorTimer);
  const previous = socket;
  socket = null;
  previous?.close();
  for (const id of [...entries.keys()]) removeEntry(id);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  hosted = privacy = privacyPending = privacyRequested = false;
  capabilities = {};
  iceServers = [];
  el("screen").srcObject = el("local-screen").srcObject = null;
  el("screen").muted = true;
  el("sound").hidden = el("audio-note").hidden = true;
  el("sound").textContent = "開啟聲音";
  el("sound").setAttribute("aria-pressed", "false");
  el("share-audio").disabled = false;
  el("start").disabled = false;
  el("start").hidden = el("join").disabled = false;
  el("invite").hidden = el("stop").hidden = el("session").hidden = el("cancel").hidden = true;
  el("join-layout").hidden = false;
  el("code").disabled = el("name").disabled = false;
  el("allow-control").checked = el("allow-privacy").checked = false;
  el("invite-code").value = "";
  el("input-hint").hidden = el("request-privacy").hidden = true;
  el("video-wait").hidden = false;
  el("video-stats").textContent = "";
  status("待命");
  notice(message);
  renderHost();
}

function openSession(firstMessage) {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const session = new WebSocket(url);
  socket = session;
  session.onopen = () => { if (session === socket) send(firstMessage); };
  let queuedMessages = Promise.resolve();
  session.onmessage = ({ data }) => {
    queuedMessages = queuedMessages.then(async () => {
      if (socket !== session) return;
      const message = JSON.parse(data);
      try {
        await receive(message);
      } catch (error) {
        if (socket !== session) return;
        if (message.id && isHost) {
          disconnectEntry(message.id);
          notice("無法建立該裝置的影像連線。請重新連線並檢查網路或 TURN 設定。");
        } else {
          reset("無法建立遠端連線。請重新連線並檢查網路或 TURN 設定。");
        }
      }
    }).catch(() => {
      if (socket === session) reset("連線服務回應異常，請重新連線。");
    });
  };
  session.onclose = () => { if (socket === session) reset("與分享服務的連線已中斷。"); };
  session.onerror = () => { if (socket === session) reset("無法連到分享服務。請確認觀看網址與連線狀態。"); };
}

function qualityConstraints() {
  const { width, height, fps } = qualityLevels[el("quality").value];
  return {
    width: { ideal: width, max: width }, height: { ideal: height, max: height },
    frameRate: { ideal: fps, max: fps },
  };
}

async function configureSender(entry) {
  const sender = entry.pc?.getSenders().find((item) => item.track?.kind === "video");
  if (!sender || entry.pc.signalingState !== "stable") return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  for (const encoding of parameters.encodings) {
    // Only apply encoding limits to the captured video sender.
    encoding.maxBitrate = qualityLevels[el("quality").value].bitrate;
    encoding.maxFramerate = qualityLevels[el("quality").value].fps;
  }
  // A browser may support capture constraints without exposing encoder controls.
  await sender.setParameters(parameters).catch(() => {});
}

async function startSharing() {
  notice();
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice("此瀏覽器無法擷取電腦畫面。請使用桌面版瀏覽器，從 HTTPS 或本機 localhost 開啟分享端。");
    return;
  }
  el("start").disabled = true;
  const attempt = ++displayRequest;
  try {
    // getDisplayMedia forbids max constraints in the initial user-gesture call.
    const { width, height, fps } = qualityLevels[el("quality").value];
    const shareAudio = el("share-audio").checked;
    el("share-audio").disabled = true;
    const captured = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
      audio: shareAudio, systemAudio: shareAudio ? "include" : "exclude", surfaceSwitching: "exclude",
    });
    if (displayRequest !== attempt) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = captured;
    if (shareAudio) {
      el("audio-note").hidden = false;
      el("audio-note").textContent = captured.getAudioTracks().length ? "目前也在分享此來源的音訊。" : "此來源未提供音訊，畫面仍會正常分享。";
    }
    const track = captured.getVideoTracks()[0];
    track.addEventListener("ended", () => { if (captured === stream) reset("畫面分享已停止。"); });
    track.addEventListener("mute", updateEligibility);
    await track.applyConstraints(qualityConstraints()).catch(() => {});
    if (displayRequest !== attempt) return;
    el("local-screen").srcObject = stream;
    status("正在建立分享");
    el("stop").hidden = false;
    openSession({ type: "host", token });
  } catch (error) {
    if (displayRequest === attempt) reset(error.name === "NotAllowedError" ?
      "尚未授權分享畫面。你可以重新選擇畫面。" : "無法開始分享，請檢查系統的螢幕錄製權限。");
  }
}

function wireChannel(entry, channel) {
  if (!entry.control || entry.channel || channel.label !== "actions") {
    channel.close();
    return;
  }
  entry.channel = channel;
  function transmit(data) {
    if (channel.readyState === "open") channel.send(JSON.stringify(data));
  }
  channel.onopen = () => {
    if (entries.get(entry.id) !== entry) return;
    if (isHost) {
      transmit({ kind: "privacyState", supported: Boolean(entry.allowPrivacy), enabled: privacy });
      renderHost();
    } else {
      // Coalesce high-polling mice and high-resolution touchpads without
      // rounding fractional wheel deltas or reordering clicks and key presses.
      let queued = null;
      let timer;
      function flush() {
        clearTimeout(timer);
        if (queued) transmit(queued);
        queued = null;
      }
      const detach = attachInput(el("screen"), (event) => {
        const continuous = event.kind === "move" || event.kind === "wheel";
        if (!continuous || queued?.kind !== event.kind) flush();
        if (!continuous) { transmit(event); return; }
        if (event.kind === "move" && channel.bufferedAmount > 64 * 1024) return;
        if (!queued) timer = setTimeout(flush, 12);
        if (queued && event.kind === "wheel") {
          queued = { ...event, dx: queued.dx + event.dx, dy: queued.dy + event.dy };
        } else {
          queued = event;
        }
      });
      entry.dropInput = () => { detach(); clearTimeout(timer); queued = null; };
      el("input-hint").hidden = false;
    }
  };
  channel.onclose = () => {
    entry.dropInput?.();
    entry.dropInput = null;
    if (entries.get(entry.id) !== entry) return;
    disconnectEntry(entry.id);
    if (!isHost) reset("操作通道已關閉。");
  };
  channel.onmessage = ({ data }) => {
    if (entries.get(entry.id) !== entry || typeof data !== "string" || data.length > 2048) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event !== "object") return;
    if (isHost) {
      if (!canControl()) { disconnectEntry(entry.id); return; }
      if (event.kind === "requestPrivacy") {
        if (entry.allowPrivacy && !privacy) { privacyRequested = true; renderHost(); }
      } else if (["move", "button", "wheel", "key", "release"].includes(event.kind)) {
        // Isolate a flooding data channel before it can close the host's
        // signaling socket and interrupt the other viewers.
        const now = performance.now();
        if (!entry.inputWindow || now - entry.inputWindow >= 1000) {
          entry.inputWindow = now;
          entry.inputCount = 0;
        }
        if (++entry.inputCount > 350) { disconnectEntry(entry.id); return; }
        send({ type: "input", id: entry.id, event });
      }
    } else if (event.kind === "privacyState") {
      el("request-privacy").hidden = !event.supported;
      el("request-privacy").disabled = event.enabled;
      el("request-privacy").textContent = event.enabled ? "隱私模式已開啟" : "請求隱私模式";
    }
  };
}

function reportPrivacy() {
  const controller = activeController();
  const channel = controller?.channel;
  if (channel?.readyState === "open") {
    channel.send(JSON.stringify({ kind: "privacyState", supported: Boolean(controller.allowPrivacy), enabled: privacy }));
  }
}

function togglePrivacy(enabled) {
  const controller = activeController();
  if (!enabled || (canControl() && controller?.allowPrivacy && controller.channel?.readyState === "open")) {
    if (send({ type: "privacy", enabled })) {
      privacyPending = true;
      privacyRequested = false;
      renderHost();
    }
  }
}

function checkPrivateVideo() {
  const video = el("local-screen");
  if (!privacy) return;
  let visibleContent = false;
  try {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let offset = 0; offset < data.length; offset += 4) {
        if (Math.max(data[offset], data[offset + 1], data[offset + 2]) > 24) { visibleContent = true; break; }
      }
    }
  } catch { /* Restore local display if the capture cannot be inspected. */ }
  if (!visibleContent) {
    togglePrivacy(false);
    notice("隱私模式啟用後未偵測到可見的分享內容，正在恢復本機螢幕。");
  }
}

async function showVideoStats(entry) {
  try {
    const report = await entry.pc.getStats();
    if (entries.get(entry.id) !== entry) return;
    report.forEach((stat) => {
      if (stat.type !== "inbound-rtp" || stat.kind !== "video") return;
      const { videoWidth, videoHeight } = el("screen");
      if (!videoWidth) return;
      const metrics = [videoWidth + " × " + videoHeight];
      if (Number.isFinite(stat.framesPerSecond)) metrics.push(Math.round(stat.framesPerSecond) + " fps");
      el("video-stats").textContent = metrics.join(" · ");
    });
  } catch { /* A closed connection no longer has playback statistics. */ }
}

async function connectPeer(entry) {
  const pc = new RTCPeerConnection({ iceServers });
  entry.pc = pc;
  entry.ice = [];
  function fail() {
    if (entries.get(entry.id) !== entry) return;
    disconnectEntry(entry.id);
    const hint = "影像連線失敗。跨網路連線時，請確認伺服器已設定可用的 TURN 中繼。";
    if (isHost) notice(hint); else reset(hint);
  }
  entry.negotiationTimer = setTimeout(fail, 60_000);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && entries.get(entry.id) === entry) {
      send({ type: "signal", id: entry.id, data: { candidate: candidate.toJSON() } });
    }
  };
  pc.onconnectionstatechange = () => {
    if (entries.get(entry.id) !== entry) return;
    clearTimeout(entry.disconnectTimer);
    entry.connected = pc.connectionState === "connected";
    if (entry.connected) clearTimeout(entry.negotiationTimer);
    if (pc.connectionState === "failed") { fail(); return; }
    if (pc.connectionState === "disconnected") entry.disconnectTimer = setTimeout(fail, 12_000);
    if (isHost) renderHost();
    else status(entry.connected ? "已連線" : "正在連接影像", entry.connected);
  };
  if (isHost) {
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    if (entry.control) wireChannel(entry, pc.createDataChannel("actions", { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    if (entries.get(entry.id) === entry) send({ type: "signal", id: entry.id, data: { description: pc.localDescription } });
  } else {
    entry.statsTimer = setInterval(() => showVideoStats(entry), 2000);
    pc.ondatachannel = ({ channel }) => wireChannel(entry, channel);
    pc.ontrack = ({ track, streams }) => {
      if (entries.get(entry.id) !== entry) return;
      if (streams[0]) {
        el("screen").srcObject = streams[0];
      } else {
        const media = el("screen").srcObject || new MediaStream();
        media.addTrack(track);
        el("screen").srcObject = media;
      }
      if (track.kind === "audio") {
        el("sound").hidden = false;
        track.addEventListener("ended", () => {
          if (entries.get(entry.id) === entry) el("sound").hidden = true;
        });
      }
    };
  }
}

async function signal(entry, data) {
  if (!entry?.pc || !data) return;
  const pc = entry.pc;
  if (data.description) {
    const expected = isHost ? "answer" : "offer";
    if (data.description.type !== expected || pc.remoteDescription) return;
    await pc.setRemoteDescription(data.description);
    if (!isHost) {
      await pc.setLocalDescription(await pc.createAnswer());
      if (entries.get(entry.id) === entry) send({ type: "signal", id: entry.id, data: { description: pc.localDescription } });
    } else {
      await configureSender(entry);
    }
    for (const candidate of entry.ice) await pc.addIceCandidate(candidate);
    entry.ice.length = 0;
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else if (entry.ice.length < 128) entry.ice.push(data.candidate);
  }
}

async function receive(message) {
  switch (message.type) {
    case "hosted":
      if (!isHost) return;
      hosted = true;
      capabilities = message.capabilities || {};
      iceServers = message.iceServers || [];
      el("invite-code").value = message.code;
      el("invite").hidden = false;
      el("start").hidden = true;
      updateEligibility();
      monitorTimer = setInterval(() => {
        const eligible = displayEligible();
        if ((!el("allow-control").disabled) !== eligible) updateEligibility();
      }, 1000);
      status("分享中", true);
      break;
    case "pending":
      status("等候分享端同意");
      break;
    case "request":
      if (isHost) {
        entries.set(message.id, { id: message.id, name: message.name });
        renderHost();
      }
      break;
    case "approved": {
      if (!isHost) {
        entries.set(message.id, { id: message.id });
        el("join-layout").hidden = true;
        el("session").hidden = false;
        el("view-mode").textContent = message.control ? "可操作" : "僅觀看";
        iceServers = message.iceServers || [];
        status("正在連接影像");
      }
      const entry = entries.get(message.id);
      if (!entry || entry.pc) return;
      if (isHost && message.control && (!entry.requestedControl || !canControl())) {
        disconnectEntry(entry.id);
        return;
      }
      entry.control = message.control === true;
      entry.requestedControl = false;
      await connectPeer(entry);
      renderHost();
      break;
    }
    case "signal":
      await signal(entries.get(message.id), message.data);
      break;
    case "denied":
    case "left":
      if (isHost) removeEntry(message.id);
      else reset(message.type === "denied" ? "分享端未同意這次請求。" : "此次遠端連線已結束。");
      break;
    case "privacy":
      if (!isHost) return;
      privacyPending = privacyRequested = false;
      privacy = message.enabled === true;
      clearTimeout(privacyTimer);
      if (privacy) privacyTimer = setTimeout(checkPrivateVideo, 1600);
      if (message.error) notice("無法切換隱私模式。" + message.error);
      reportPrivacy();
      renderHost();
      break;
    case "error":
      if (!hosted) reset(message.message || "無法連線，請確認分享端已啟動，且連線碼正確。");
      else {
        const entry = entries.get(message.id);
        if (entry) entry.busy = entry.requestedControl = false;
        notice(message.message || "無法完成連線操作。");
        renderHost();
      }
      break;
  }
}

el("join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = el("name").value.trim();
  const code = el("code").value.trim();
  if (!name || !code) { notice("請輸入裝置名稱與連線碼。"); return; }
  notice();
  status("正在傳送請求");
  el("join").disabled = el("name").disabled = el("code").disabled = true;
  el("cancel").hidden = false;
  try { openSession({ type: "join", name, code }); } catch { reset("無法連到分享服務。"); }
});
el("start").addEventListener("click", startSharing);
el("stop").addEventListener("click", () => reset("畫面分享已停止。"));
el("cancel").addEventListener("click", () => reset());
el("leave").addEventListener("click", () => reset("已中斷連線。"));
el("quality").addEventListener("change", async () => {
  if (!stream) return;
  const select = el("quality");
  select.disabled = true;
  try {
    await stream.getVideoTracks()[0].applyConstraints(qualityConstraints());
    await Promise.all([...entries.values()].map(configureSender));
    updateEligibility();
  } catch {
    notice("此畫面來源無法套用選取的品質，已保留瀏覽器可提供的設定。");
  } finally { select.disabled = false; }
});
el("allow-control").addEventListener("change", () => {
  if (!canControl()) {
    for (const [id, entry] of entries) {
      if (entry.control || entry.requestedControl) disconnectEntry(id);
    }
  }
  renderHost();
});
el("reveal").addEventListener("click", () => {
  codeVisible = !codeVisible;
  renderHost();
});
el("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(el("invite-code").value);
    status("已複製連線碼", true);
  } catch {
    el("invite-code").select();
    notice("請複製已選取的連線碼。");
  }
});
el("privacy-toggle").addEventListener("click", () => togglePrivacy(!privacy));
el("privacy-deny").addEventListener("click", () => {
  privacyRequested = false;
  reportPrivacy();
  renderHost();
});
el("request-privacy").addEventListener("click", () => {
  const channel = activeController()?.channel;
  if (channel?.readyState === "open") {
    channel.send(JSON.stringify({ kind: "requestPrivacy" }));
    el("request-privacy").disabled = true;
    el("request-privacy").textContent = "等候分享端同意";
  }
});
el("sound").addEventListener("click", async () => {
  const video = el("screen");
  video.muted = !video.muted;
  if (!video.muted) {
    try { await video.play(); }
    catch { video.muted = true; notice("無法播放此來源的音訊。"); }
  }
  el("sound").textContent = video.muted ? "開啟聲音" : "靜音";
  el("sound").setAttribute("aria-pressed", String(!video.muted));
});
el("fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (el("stage").requestFullscreen) await el("stage").requestFullscreen();
    else el("screen").webkitEnterFullscreen();
  } catch { notice("此裝置目前無法進入全螢幕。"); }
});
el("screen").addEventListener("playing", () => { el("video-wait").hidden = true; });
el("screen").addEventListener("resize", () => {
  const { videoWidth, videoHeight } = el("screen");
  el("video-stats").textContent = videoWidth ? videoWidth + " × " + videoHeight : "";
});
window.addEventListener("pagehide", () => reset());

if (isHost) {
  history.replaceState(null, "", location.pathname + location.search);
  el("viewer").hidden = true;
  el("host").hidden = false;
}
