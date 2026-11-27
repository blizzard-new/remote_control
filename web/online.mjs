import {
  EDGES,
  SINGLE_IMAGE,
  MAX_IMAGE,
  ImageAssembly,
  sameImage,
  jpegReference,
  rowPatch,
  restoreRowPatch,
} from "./video.mjs";
import {
  HostChannels,
  findPin,
  resumeOffers,
  resumeAnswer,
} from "./pairing.mjs";
import { devices } from "./devices.mjs";
import { attachInput, pictureBounds } from "./input.mjs";
import { DEFAULT_RELAY, Relay, parseInvite } from "./relay.mjs";
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const suppliedToken = params.get("host");
const reload = performance.getEntriesByType("navigation")[0]?.type === "reload";
const token =
  suppliedToken || (reload && sessionStorage.getItem("rc-host-token"));
if (suppliedToken) {
  sessionStorage.setItem("rc-host-token", suppliedToken);
  sessionStorage.setItem("rc-managed-host", params.get("managed") || "");
}
const managedHost = token && sessionStorage.getItem("rc-managed-host") === "1";
if (location.hash) history.replaceState(null, "", location.pathname);
$("hostbox").hidden = !token;
if (token) $("lan").href = "/#host=" + encodeURIComponent(token);
$("relay").value = localStorage.getItem("rc-relay") || DEFAULT_RELAY;
const canvas = $("picture"),
  ctx = canvas.getContext("2d");
let hostSession = null;
let viewerSession = null;
let hostRetry = null;
let hostFailures = 0;
function current(s) {
  return s === (s.host ? hostSession : viewerSession);
}
const genericName = (name) =>
  ["我的電腦", "我的 Mac", "已配對裝置"].includes(name);
const platforms = new Map([
  ["Android", "Android"],
  ["Darwin", "macOS"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
  ["browser", "瀏覽器"],
]);
let platform = window.PhoneDevices ? "Android" : "browser";
let defaultName = window.PhoneDevices?.name() || "未命名的瀏覽器";
const previousName = localStorage.getItem("rc-name");
const customName =
  localStorage.getItem("rc-custom-name") ||
  (genericName(previousName) ? "" : previousName);
$("name").value = customName || defaultName;
window.PhoneDevices?.setDisplayName?.(customName || "");
const identityReady = (async () => {
  if (!token || window.PhoneDevices) return;
  try {
    const info = await devices(token, "self");
    if (!info?.name || !platforms.has(info.platform)) return;
    if (!localStorage.getItem("rc-relay") && info.relay) $("relay").value = info.relay;
    if ($("name").value === defaultName && !customName)
      $("name").value = info.name;
    defaultName = info.name;
    platform = info.platform;
    renderDevices();
    if (page === "settings" && platform === "Darwin") macPermissions("check");
  } catch {
    // A browser session can still connect using its own display name.
  }
})();
let messageFor = null;
let contactsLoaded = false;
let listError = false;
let listRequest = 0;
let contacts = [],
  selected = null,
  page = "devices",
  requestViewOnly = false;
function go(destination, showDetail = true) {
  page = destination;
  document.body.dataset.page = destination;
  document.body.classList.toggle("show-detail", showDetail);
  for (const node of document.querySelectorAll("nav button"))
    if (node.dataset.page === page) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  $("detail-panel").hidden = page !== "devices";
  $("connect-panel").hidden = page !== "connect";
  $("settings-panel").hidden = page !== "settings";
  if (page === "settings" && token && platform === "Darwin")
    macPermissions("check");
  if (page === "connect" && matchMedia("(pointer:fine)").matches)
    $("code").focus();
}
function legacyPair(pair) {
  return !pair.platform && genericName(pair.name);
}
function displayName(pair) {
  if (!legacyPair(pair)) return pair.name;
  const keys = contacts
    .filter(legacyPair)
    .map((c) => c.listen)
    .sort();
  return "未命名的配對紀錄 " + (keys.indexOf(pair.listen) + 1);
}
function deviceRow(pair) {
  const row = document.createElement("button");
  row.className = "device-row";
  row.setAttribute("aria-pressed", String(pair.listen === selected?.listen));
  const icon = document.createElement("i"),
    label = document.createElement("span"),
    name = document.createElement("strong"),
    access = document.createElement("small");
  icon.dataset.i =
    pair.platform === "Android"
      ? "phone"
      : ["Windows", "Darwin", "Linux"].includes(pair.platform)
        ? "display"
        : "link-45deg";
  name.textContent = displayName(pair);
  access.textContent = grantName(pair);
  row.onclick = () => {
    selected = pair;
    renderDevices();
    go("devices");
  };
  label.append(name, access);
  row.append(icon, label);
  return row;
}
function grantName(pair) {
  return pair.grant === "control"
    ? "已信任 · 可控制本機"
    : pair.grant === "view"
      ? "已信任 · 可觀看本機"
      : "已配對裝置";
}
function renderDevices() {
  if (selected)
    selected = contacts.find((c) => c.listen === selected.listen) || null;
  const query = $("search").value.trim().toLowerCase(),
    name = $("name").value || defaultName;
  $("self-name").textContent = name;
  $("message").hidden = messageFor !== (selected?.listen || null);
  $("self").setAttribute("aria-pressed", String(!selected));
  $("self").hidden = !!query && !name.toLowerCase().includes(query);
  $("self").querySelector("i").dataset.i = window.PhoneDevices
    ? "phone"
    : "pc-display";
  const saved = contacts.filter((c) => !legacyPair(c));
  const matches = (c) =>
    (displayName(c) + " " + c.name).toLowerCase().includes(query);
  const found = saved.filter(matches);
  const legacy = contacts.filter((c) => legacyPair(c) && matches(c));
  $("device-count").textContent = contactsLoaded
    ? String(contacts.length)
    : "…";
  $("remembered").replaceChildren(...found.map(deviceRow));
  $("legacy").hidden = !legacy.length;
  $("legacy-count").textContent = String(legacy.length);
  $("legacy-list").replaceChildren(...legacy.map(deviceRow));
  $("list-empty").hidden = !!(found.length || legacy.length);
  $("list-empty").textContent = !contactsLoaded
    ? listError
      ? "無法讀取配對紀錄。"
      : "正在讀取配對紀錄…"
    : query
      ? "找不到符合的配對紀錄。"
      : "尚無配對紀錄。";
  $("device-title").textContent = selected ? displayName(selected) : name;
  $("detail-type").textContent = selected ? "已配對裝置" : "本機裝置";
  $("device-subtitle").textContent = selected
    ? grantName(selected) + " · " + new URL(selected.address).hostname
    : platforms.get(platform) + " · 本機裝置";
  $("hostbox").hidden = !!selected || !token || viewerSession;
  $("phone-share").hidden = !window.PhoneDevices || !!selected;
  $("action-connect").querySelector("span").textContent =
    selected?.platform === "Android" ? "操作手機" : "遠端控制";
  $("action-view").querySelector("span").textContent =
    selected?.platform === "Android" ? "觀看手機畫面" : "觀看模式";
  $("forget").hidden = !selected;
}
async function refreshDevices(action, item) {
  const requestId = ++listRequest;
  let loaded;
  try {
    loaded = await devices(token, action, item);
    if (!Array.isArray(loaded)) throw Error("無法存取配對紀錄。");
  } catch (err) {
    listError = true;
    renderDevices();
    throw err;
  }
  if (requestId !== listRequest) return;
  contactsLoaded = true;
  listError = false;
  contacts = loaded;
  renderDevices();
  renderConnections();
}
$("self").onclick = () => {
  selected = null;
  renderDevices();
  go("devices");
};
$("search").oninput = () => {
  renderDevices();
  go("devices", false);
};
$("name").onchange = () => {
  const value = $("name").value.trim();
  localStorage.setItem("rc-custom-name", value);
  localStorage.removeItem("rc-name");
  window.PhoneDevices?.setDisplayName?.(value);
  $("name").value = value || defaultName;
  renderDevices();
};
for (const button of document.querySelectorAll("nav button"))
  button.onclick = () => {
    if (button.dataset.page === "connect") requestViewOnly = false;
    go(button.dataset.page, button.dataset.page !== "devices");
  };
$("back-list").onclick = () => go("devices", false);
$("add").onclick = () => {
  requestViewOnly = false;
  $("code").value = "";
  go("connect");
};
$("action-connect").onclick = () =>
  selected ? joinDevice(selected) : ((requestViewOnly = false), go("connect"));
$("action-view").onclick = () =>
  selected
    ? joinDevice(selected, true)
    : ((requestViewOnly = true), go("connect"));
$("action-settings").onclick = () => go("settings");

let readingMacPermissions = false;
async function macPermissions(action) {
  if (readingMacPermissions || platform !== "Darwin" || !token) return;
  if (
    action === "relaunch" &&
    (viewerSession || hostSession?.peers.size) &&
    !confirm("重新開啟 RemoteControl 會結束這個程式目前的連線。現在重新開啟？")
  )
    return;
  readingMacPermissions = true;
  $("mac-permissions").hidden = false;
  try {
    const response = await fetch("/api/mac-permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Host-Token": token },
      body: JSON.stringify({ action }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Error(
        result.error ||
          "無法讀取目前程序的權限，請使用從「應用程式」開啟的新版 RemoteControl 分頁。",
      );
    if (result.relaunching) {
      $("mac-access").textContent =
        "已要求重新開啟。請使用新開啟的 RemoteControl 分頁。";
      return;
    }
    $("mac-app-path").textContent = "目前執行　" + result.application;
    const status = (allowed) => (allowed ? "已允許" : "尚未取得");
    $("mac-access").textContent =
      "輔助使用 " +
      status(result.accessibility) +
      "　鍵鼠事件 " +
      status(result.postEvents) +
      "　螢幕錄製預檢 " +
      status(result.screen);
    $("mac-request").hidden = result.postEvents || result.accessibility;
    $("mac-relaunch").hidden = !result.relaunch;
    if (hostSession?.local?.readyState === 1)
      hostSession.local.send(JSON.stringify({ type: "capabilities" }));
  } catch (error) {
    $("mac-access").textContent = error.message;
  } finally {
    readingMacPermissions = false;
  }
}
$("mac-check").onclick = () => macPermissions("check");
$("mac-request").onclick = () => macPermissions("request");
$("mac-relaunch").onclick = () => macPermissions("relaunch");
$("phone-share").onclick = () => window.PhoneDevices?.openHost();
$("phone-code").hidden = !window.PhoneDevices;
$("phone-code").onclick = $("phone-share").onclick;
$("forget").onclick = async () => {
  const pair = selected;
  if (
    !pair ||
    !confirm("解除與「" + displayName(pair) + "」的配對並結束連線？")
  )
    return;
  try {
    await refreshDevices("forget", pair);
    hostSession?.relay?.forget(pair.listen);
  } catch (err) {
    say(err.message);
  }
};
$("lan").hidden = !token;
renderDevices();
go("devices", false);
refreshDevices().catch((err) => say(err.message));
const decoder = new TextDecoder();
function say(value) {
  messageFor = selected?.listen || null;
  $("message").hidden = false;
  $("message").textContent = value;
}
function viewerNote(s, message) {
  if (s !== viewerSession) return;
  $("joining-note").textContent = message;
  say(message);
}
function closeSession(s, message) {
  if (!current(s)) return;
  if (s.host) {
    hostSession = null;
    $("stop").hidden = $("invitation").hidden = true;
    $("start").hidden = false;
    $("invite").value = "";
    $("devices").replaceChildren();
    if (managedHost && !s.stopped) {
      const delay = Math.min(30000, 1000 * 2 ** Math.min(hostFailures++, 5));
      hostRetry = setTimeout(standby, delay);
    }
  } else {
    keyboard(false);
    viewerSession = null;
    mobileView(false);
    $("keyboard-button").hidden =
      $("joining").hidden =
      $("stage").hidden =
      $("leave").hidden =
        true;
    $("joinbox").hidden = false;
    $("connect").disabled = false;
    $("ask-control").hidden =
      $("switch-display").hidden =
      $("view-mode").hidden =
      $("share-request").hidden =
        true;
    $("view-scale").value = "fit";
    updateViewScale();
    $("stats").textContent = "正在接收畫面";
    $("video-menu").open = false;
    $("screenshot-menu").open = false;
    $("screenshot-menu").hidden = $("screenshot-status").hidden = true;
    window.ViewerScreen?.setScreenshotEnabled?.(false);
    clearTimeout(s.screenshotTimer);
    clearTimeout(s.screenshotStatusTimer);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    clearTimeout(s.mediaTimer);
    clearInterval(s.statsTimer);
    s.detach?.();
  }
  s.abort.abort();
  clearInterval(s.screenPoll);
  s.relay?.close();
  s.local?.close();
  s.stream?.getTracks().forEach((t) => t.stop());
  for (const p of s.peers.values()) {
    p.row?.remove();
    clearTimeout(p.avcTimer);
    p.ws?.close();
    p.pc?.close();
    clearTimeout(p.timeout);
    clearTimeout(p.retryApproval);
    p.video?.pause();
    if (p.decoder && p.decoder.state !== "closed") p.decoder.close();
  }
  clearTimeout(s.deadline);
  clearTimeout(s.retryTimer);
  clearInterval(s.frames);
  clearInterval(s.captureTimer);
  clearInterval(s.permissionTimer);
  $("pair-again").hidden = true;
  renderConnections();
  renderDevices();
  placeHostRequests();
  say(message);
}
function begin(host) {
  const s = { host, peers: new Map(), abort: new AbortController() };
  if (host) {
    hostSession = s;
    $("start").hidden = true;
    $("stop").hidden = false;
  } else {
    viewerSession = s;
    $("joining").hidden = false;
    $("joining-title").textContent = "正在連接對方裝置";
    $("joining-note").textContent = "正在連接配對服務…";
    $("join-watch").hidden = true;
    $("cancel").focus({ preventScroll: true });
    $("connect").disabled = true;
  }
  renderConnections();
  placeHostRequests();
  $("pair-again").hidden = true;
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
let phoneState = { peers: [], lan: 0, listening: false };
function renderConnections() {
  const rows = [];
  for (const session of [hostSession, viewerSession]) {
    for (const p of session?.peers.values() || []) {
      if (p.approved) rows.push({ ...p, incoming: session.host });
    }
  }
  for (const p of phoneState.peers) rows.push({ ...p, incoming: true });
  const lan = Math.max(0, phoneState.lan);
  const count = rows.length + lan;
  const list = rows.map((p) => {
    const row = document.createElement("p");
    const name = genericName(p.name) || !p.name ? "對方裝置" : p.name;
    const operation = p.incoming
      ? p.control
        ? "正在操作本機"
        : "正在觀看本機"
      : p.control
        ? "正在操作對方"
        : "正在觀看對方";
    row.textContent = name + " · " + operation;
    if (p.incoming && p.platform === "Android") {
      const pair = contacts.find(
        (c) =>
          c.listen === p.pair?.listen && c.address === hostSession?.address,
      );
      if (pair) {
        const control = document.createElement("button");
        control.textContent = "操作手機";
        control.onclick = () => joinDevice(pair);
        row.append(control);
      }
    }
    return row;
  });
  if (lan) {
    const row = document.createElement("p");
    row.textContent = "區網觀看連線 · " + lan;
    list.push(row);
  }
  $("connected-list").replaceChildren(...list);
  $("connected-count").textContent = String(count);
  $("status").dataset.connected = String(count > 0);
  $("status").textContent = count
    ? (rows.some((p) => p.incoming && p.control) ? "遠端操作中" : "已連線") +
      " · " +
      count
    : viewerSession
      ? "正在連線"
      : hostSession?.ready || phoneState.listening
        ? "等候連線"
        : hostSession
          ? "正在連線"
          : "未連線";
}
function syncPhone() {
  if (!window.PhoneDevices?.sessionState) return;
  const next = JSON.parse(window.PhoneDevices.sessionState());
  if (JSON.stringify(phoneState) === JSON.stringify(next)) return;
  phoneState = next;
  renderConnections();
}
window.openDeviceList = () => {
  if (viewerSession) return;
  selected = null;
  renderDevices();
  go("devices", false);
};
window.refreshDashboard = () => {
  syncPhone();
  refreshDevices().catch((err) => say(err.message));
};
if (window.PhoneDevices) {
  syncPhone();
  setInterval(() => {
    if (!document.hidden) syncPhone();
  }, 1000);
}
function peerLeft(s, id) {
  const p = s.peers.get(id);
  if (!p) return;
  s.peers.delete(id);
  p.ws?.close();
  clearTimeout(p.retryApproval);
  clearTimeout(p.avcTimer);
  renderConnections();
  if (s.host)
    for (const waiting of s.peers.values())
      if (waiting.row && !waiting.approved && !waiting.claiming)
        renderRequest(s, waiting);
  if (s.host && ![...s.peers.values()].some((v) => v.approved)) {
    s.reading = false;
    s.hasFrame = false;
  }
  p.pc?.close();
  p.video?.pause();
  clearTimeout(p.timeout);
  p.row?.remove();
  placeHostRequests();
  if (current(s) && !s.host) closeSession(s, "分享已結束。");
}
async function connectRelay(s) {
  const address =
    s.address || new URL($("relay").value.trim()).href.replace(/\/+$/, "");
  s.address = address;
  let transport;
  const events = {
    reconnecting() {
      if (!current(s)) return;
      s.ready = false;
      $("invitation").hidden = true;
      $("invite").value = "";
      renderConnections();
      say(managedHost ? "正在重新連接配對服務…" : "正在重新連接配對服務，請保持這個分頁開啟。");
    },
    ready(code) {
      if (!current(s)) return;
      clearTimeout(s.deadline);
      hostFailures = 0;
      s.ready = true;
      renderConnections();
      $("invitation").hidden = false;
      $("invite").value = code;
      say(managedHost
        ? "關閉視窗後會繼續待命。新裝置可輸入四碼，已配對裝置可直接重連。"
        : "請保持此分頁開啟。新裝置可輸入四碼，已配對裝置可直接重連。");
    },
    paired(id, pair) {
      if (!current(s)) return;
      const p = { id, approved: false, pair };
      s.peers.set(id, p);
      p.timeout = setTimeout(() => s.relay.drop(id), 120000);
      if (!s.host) {
        clearTimeout(s.deadline);
        s.relay.json(id, {
          t: "request",
          viewOnly: !!s.viewOnly,
          monitorControls: true,
          avc: false,
          frameParts: true,
          jpegRows: true,
          screenRequest: !!window.PhoneDevices,
          ...(s.resume?.length ? { resume: s.resume.map((r) => r.offer) } : {}),
          ...profile(),
          name: $("name").value.trim() || defaultName,
          platform,
        });
        viewerNote(
          s,
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
      if (!current(s) || s.relay !== transport) return;
      if (s.pair?.saved) {
        const delays = [1500, 3000, 6000, 10000];
        const attempt = s.attempt || 0;
        if (
          attempt < delays.length ||
          (s.askedPhone && Date.now() < s.waitUntil)
        ) {
          s.attempt = attempt + 1;
          s.relay = null;
          transport.close();
          viewerNote(
            s,
            s.askedPhone
              ? "正在等候手機開放分享。請在手機點邀請上的按鈕，或在裝置列表點「我的手機連線碼」並開放整個螢幕連線。"
              : s.pair.platform === "Android"
                ? "正在尋找手機。請在手機開啟「我的手機連線碼」並開放整個螢幕連線。"
                : "正在等候已配對裝置恢復連線…",
          );
          s.retryTimer = setTimeout(
            () => {
              if (current(s))
                connectRelay(s).catch((err) => closeSession(s, err.message));
            },
            delays[Math.min(attempt, delays.length - 1)],
          );
          return;
        }
        closeSession(
          s,
          s.pair.platform === "Android"
            ? "手機尚未開放分享。請在手機點「我的手機連線碼」→「開放整個螢幕連線」，再從裝置列表連線。"
            : "配對服務找不到這台裝置。請確認對方電腦已喚醒並登入，且 Uniway Remote 正在待命。若對方已重新安裝，可使用目前顯示的四碼配對。",
        );
        $("pair-again").hidden = false;
      } else
        closeSession(s, "找不到這次分享，請使用對方目前顯示的四碼重新連線。");
    },
    closed() {
      if (s.relay === transport)
        closeSession(s, "與配對服務的網路連線已結束。請確認網路後再試。");
    },
    async packet(id, type, data) {
      if (!current(s)) return;
      const p = s.peers.get(id);
      if (!p) return;
      if (type === 3 && !s.host && p.approved && !p.noAVC) {
        receiveVideo(s, p, data);
        return;
      }
      if (type === 4 && !s.host && p.approved) {
        p.assembly ??= new ImageAssembly();
        const frame = p.assembly.accept(data);
        if (!frame) return;
        s.relay.json(id, { t: "image-received", serial: frame.serial });
        p.receivedBase = frame;
        data = frame.image;
        type = 2;
      }
      if (type === 6 && !s.host && p.approved && data.length > 4 && data.length <= SINGLE_IMAGE + 4) {
        const serial = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
        const ack = () => s.relay.json(id, { t: "image-received", serial });
        if (p.direct || p.waitingScreen) return ack();
        const image = restoreRowPatch(p.receivedBase, data.subarray(4));
        if (image) receiveJpeg(s, p, image).finally(ack);
        else {
          s.relay.json(id, { t: "need-full-image" });
          ack();
        }
        return;
      }
      if (type === 2) {
        p.assembly?.reset();
        if (!s.host && p.approved && !p.direct && !p.waitingScreen)
          receiveJpeg(s, p, data);
        return;
      }
      if (type !== 1 || data.length > 96000) return;
      const m = JSON.parse(decoder.decode(data));
      if (
        !s.host &&
        p.approved &&
        m.t === "ask-phone-screen" &&
        window.PhoneDevices &&
        !p.screenRequestShown
      ) {
        p.screenRequestShown = true;
        $("share-requester").textContent =
          "「" +
          p.name +
          (m.control === true
            ? "」要求操作這支手機。"
            : "」想觀看這支手機的畫面。");
        $("switch-share").textContent =
          m.control === true ? "開啟手機操作設定" : "切換為分享手機";
        $("share-request").hidden = false;
        return;
      }
      if (!s.host && !p.approved && m.t === "resume") {
        const match = s.resume?.find((r) => r.answer === m.proof);
        if (!match) return;
        const pair = contacts.find(
          (c) =>
            c.listen === match.pair.listen &&
            c.dial === match.pair.dial &&
            c.address === s.address,
        );
        if (!pair) return closeSession(s, "配對紀錄已變更，請重新連線。");
        closeSession(s, "");
        return joinDevice(pair, s.viewOnly);
      }
      if (
        !s.host &&
        p.control &&
        p.approved &&
        m.t === "keyboard" &&
        s.tap === m.serial
      ) {
        keyboard(m.editable === true);
        return;
      }
      if (!s.host && m.t === "capture-error" && p.approved) {
        closeSession(
          s,
          m.platform === "Darwin" && m.reason === "permission"
            ? "macOS 回報螢幕擷取被拒絕。若「螢幕與系統錄音」已開，請在 Mac 的進階設定重新開啟 RemoteControl。"
            : "對方暫時無法擷取畫面。請確認對方螢幕已喚醒，再重新連線。",
        );
        return;
      }
      if (!s.host && !p.approved && m.t === "control-pending") {
        $("join-watch").hidden =
          s.viewOnly ||
          !m.canView ||
          !["access", "busy", "unavailable"].includes(m.reason);
        viewerNote(
          s,
          m.reason === "busy"
            ? "另一台裝置正在操作。結束操作後，已信任的裝置可自動接上。"
            : m.reason === "projection"
              ? "手機已收到連線。請在手機開啟整個螢幕分享。"
              : m.reason === "access" && m.platform === "Darwin"
                ? "Mac 回報目前的 RemoteControl 程序尚無鍵鼠操作權限。若系統開關已開，請在 Mac 的進階設定查看實際執行路徑與權限。"
                : m.reason === "unavailable"
                  ? "對方目前無法傳送鍵鼠事件。可在對方檢查顯示器狀態，或先觀看畫面。"
                  : m.reason === "access" && m.platform === "Android"
                    ? "請在手機開啟「遠端桌面觸控操作」，並分享整個螢幕。"
                    : s.pair?.check
                      ? "請核對 " + s.pair.check + "，並在對方裝置允許操作。"
                      : "已送出操作請求，請在對方的主機分頁確認。",
        );
        return;
      }
      if (s.host) {
        if (m.t === "request" && !p.requested) {
          p.requested = true;
          if (p.pair && !p.pair.saved && m.resume?.length) {
            const proof = await resumeAnswer(
              m.resume,
              contacts,
              s.address,
              p.pair.listen,
            );
            if (!current(s) || s.peers.get(id) !== p) return;
            if (proof) return s.relay.json(id, { t: "resume", proof });
          }
          p.profile = profile(m);
          p.frameParts = m.frameParts === true;
          p.jpegRows = p.frameParts && m.jpegRows === true;
          p.supportsScreens = m.monitorControls === true;
          p.viewOnly = m.viewOnly === true;
          p.platform = platforms.has(m.platform) ? m.platform : "";
          p.screenRequest =
            m.screenRequest === true && p.platform === "Android";
          return request(s, p, safeText(m.name, 48));
        }
        if (m.t === "view-only" && p.localId && !p.approved && !p.claiming) {
          p.viewOnly = true;
          renderRequest(s, p);
          return;
        }
        if (!p.approved) return;
        if (m.t === "need-full-image" && p.jpegRows) {
          p.jpegBase = null;
          p.lastImage = null;
          return;
        }
        if (m.t === "image-received")
          return s.relay.imageReceived(p.id, m.serial);
        if (m.t === "select-screen" && s.screens.some((screen) => screen.id === m.screen)) {
          selectHostScreen(s, p, m.screen);
          return;
        }
        if (m.t === "quality") {
          p.lastImage = null;
          p.profile = profile(m);
          tuneSender(s, p);
          return;
        }
        if (m.t === "screenshot") {
          if (p.control && s.windowsScreenshots && s.hasFrame && !p.pendingScreen &&
              m.screen === p.screen && s.local.readyState === 1)
            s.local.send(JSON.stringify({ type: "screenshot", id: p.localId, mode: m.mode, screen: p.screen }));
          return;
        }
        if (
          m.t === "input" &&
          p.control &&
          s.hasFrame &&
          eligible(s) &&
          m.event &&
          !p.pendingScreen &&
          (!p.supportsScreens || !p.hasSwitched || m.screen === p.screen) &&
          s.local.readyState === 1
        ) {
          s.local.send(
            JSON.stringify({ type: "input", id: p.localId, event: m.event, screen: p.screen }),
          );
        } else if (m.t === "answer" && p.pc) {
          await p.pc.setRemoteDescription(m.sdp);
          tuneSender(s, p);
        } else if (m.t === "direct") p.direct = m.on === true;
      } else if (m.t === "approved" && !p.approved) {
        p.name = safeText(m.name) || s.pair?.name || "已配對裝置";
        p.platform = platforms.has(m.platform) ? m.platform : s.pair?.platform;
        $("joining").hidden = true;
        $("stage").hidden = false;
        $("leave").hidden = false;
        $("first-picture").hidden = false;
        $("first-picture").textContent =
          "已連到「" + p.name + "」，正在等候第一張畫面…";
        let saveWarning =
          s.pair && m.remembered === false ? "對方未能儲存這次授權。" : "";
        if (s.pair && m.remembered) {
          const { listen, dial } = s.pair;
          try {
            await refreshDevices(s.pair.saved ? "identify" : "save", {
              listen,
              dial,
              address,
              name: p.name,
              platform: platforms.has(m.platform)
                ? m.platform
                : s.pair.platform || "",
              grant: s.pair.grant || "",
            });
            const saved = contacts.find(
              (c) => c.listen === listen && c.address === address,
            );
            if (saved && hostSession?.address === address)
              hostSession.relay?.remember(saved);
          } catch (err) {
            saveWarning = "本機未能儲存配對，請檢查儲存空間與配對數量。";
          }
        }
        if (!current(s) || s.peers.get(id) !== p) return;
        clearTimeout(p.timeout);
        p.approved = true;
        p.screen = m.screen || null;
        viewerScreens(s, p, m.screens);
        s.wasApproved = true;
        p.control = m.control === true && !s.viewOnly;
        if (p.control && m.windowsScreenshots === true) {
          $("screenshot-menu").hidden = false;
          s.screenshot = (mode) => {
            if (!current(s) || !s.hasPicture || s.switchingScreen || s.screenshotTimer) return false;
            $("screenshot-menu").open = false;
            canvas.focus({ preventScroll: true });
            screenshotStatus(s, mode === "snip" ? "正在開啟 Windows 截圖工具…" : "正在 Windows 儲存截圖…", 0);
            s.screenshotTimer = setTimeout(() => {
              s.screenshotTimer = null;
              screenshotStatus(s, "未收到 Windows 的截圖結果。");
            }, 10000);
            s.relay.json(id, { t: "screenshot", mode, screen: p.screen });
            return true;
          };
          window.ViewerScreen?.setScreenshotEnabled?.(true);
        }
        $("quality-compat").hidden = m.qualityControls === true;
        $("view-mode").hidden = p.control;
        $("ask-control").hidden =
          p.control || p.platform !== "Android" || !s.pair || !m.remembered;
        if (!$("ask-control").hidden)
          $("ask-control").onclick = () => {
            const saved = contacts.find(
              (c) => c.listen === s.pair.listen && c.address === s.address,
            );
            if (!saved || !current(s)) return;
            closeSession(s, "");
            joinDevice(saved, false);
          };
        $("save-warning").textContent = saveWarning;
        $("save-warning").hidden = !saveWarning;
        $("joinbox").hidden = true;
        $("stage").hidden = false;
        s.mediaTimer = setTimeout(() => {
          if (current(s) && !s.hasPicture)
            $("first-picture").textContent =
              p.platform === "Android"
                ? "手機尚未送達畫面。請保持手機解鎖，從連線碼頁切回主畫面或開啟一般 App。"
                : "仍在等候對方裝置的畫面。";
        }, 5000);
        mobileView(true);
        canvas.focus({ preventScroll: true });
        renderConnections();
        say(
          p.control
            ? "已獲准操作。點一下可操作該位置，雙指可捲動。"
            : "已獲准觀看。",
        );
        if (p.control) {
          s.sendInput = (event) => {
            if (s.hasPicture && !s.switchingScreen)
              s.relay.json(id, { t: "input", event, screen: p.screen });
          };
          $("keyboard-button").hidden = !m.keyboard;
          s.detach = attachInput(
            canvas,
            (event) => {
              if (event.tap) s.tap = event.tap;
              s.sendInput(event);
            },
            { detectText: m.keyboard === true },
          );
        }
      } else if (p.approved && m.t === "screenshot-result" && s.screenshotTimer) {
        clearTimeout(s.screenshotTimer);
        s.screenshotTimer = null;
        screenshotStatus(s, m.error ? safeText(m.error, 100) : m.mode === "snip"
          ? "請在遠端 Windows 畫面框選要截圖的區域。"
          : "已儲存到 Windows「圖片 → 螢幕擷取畫面」 · " + safeText(m.filename, 80));
      } else if (p.approved && m.t === "desktop-screens") {
        viewerScreens(s, p, m.screens);
      } else if (p.approved && m.t === "screen-active") {
        if (!p.waitingScreen || p.requestedScreen === m.screen) {
          p.screen = m.screen;
          p.waitingScreen = false;
          viewerScreens(s, p, p.screens);
        }
      } else if (!s.host && p.approved && m.t === "offer") {
        // ICE gathering may take seconds. Let incoming relay frames keep painting meanwhile.
        direct(s, p, m.sdp).catch(() => {
          p.pc?.close();
          p.pc = null;
        });
      }
    },
  };
  if (s.host) {
    s.relay = transport = new HostChannels(address, events);
    await refreshDevices();
    if (current(s)) await s.relay.start(contacts);
  } else {
    s.relay = transport = new Relay(address, false, s.invite, events);
    await s.relay.start();
  }
}
async function decodeJpeg(bytes) {
  const blob = new Blob([bytes], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* Try the browser's image loader. */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
function paint(s, p, image, w, h, format) {
  if (!current(s) || s.peers.get(p.id) !== p || w <= 0 || h <= 0) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.setProperty("--frame-width", w + "px");
    canvas.style.setProperty("--frame-height", h + "px");
    updateNavigator();
  }
  ctx.drawImage(image, 0, 0, w, h);
  if (s.switchingScreen) {
    s.switchingScreen = false;
    $("first-picture").hidden = true;
    $("switch-display").disabled = false;
  }
  if (!s.hasPicture) {
    s.hasPicture = true;
    clearTimeout(s.mediaTimer);
    $("first-picture").hidden = true;
    s.statTick = performance.now();
    s.painted = 0;
    s.statsTimer = setInterval(() => {
      const now = performance.now();
      const fps = Math.round((s.painted * 1000) / (now - s.statTick));
      $("stats").textContent =
        `實收 ${canvas.width} × ${canvas.height} · ${fps} fps · ${s.format}`;
      s.statTick = now;
      s.painted = 0;
    }, 1000);
  }
  if (format === "avc") clearTimeout(p.avcTimer);
  if (
    format === "jpeg" &&
    p.platform === "Android" &&
    !p.avcRequested &&
    !p.noAVC &&
    typeof VideoDecoder === "function" &&
    typeof EncodedVideoChunk === "function"
  ) {
    p.avcRequested = true;
    s.relay.json(p.id, { t: "quality", ...profile(), avc: true });
    p.avcTimer = setTimeout(() => compatibleVideo(s, p), 5000);
  }
  s.format = { avc: "H.264", direct: "直連 WebRTC", jpeg: "中繼 JPEG" }[format];
  if (!s.painted && !s.reported) {
    $("stats").textContent = `實收 ${w} × ${h} · ${s.format}`;
    s.reported = true;
  }
  s.painted++;
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
    if (!current(s) || !s.peers.has(p.id)) return;
    const m = JSON.parse(e.data);
    if (m.type === "pending") {
      p.localId = m.id;
      if (m.capabilities) s.cap = m.capabilities;
      renderRequest(s, p);
      if (!p.claiming) {
        selected = null;
        renderDevices();
        go("devices");
      }
    }
    if (m.type === "keyboard" && p.approved && p.control)
      s.relay.json(p.id, {
        t: "keyboard",
        editable: m.editable,
        serial: m.serial,
      });
    if (m.type === "screenshot-result" && p.approved && p.control)
      s.relay.json(p.id, { t: "screenshot-result", mode: m.mode, filename: m.filename, error: m.error });
    if (m.type === "approved") {
      clearTimeout(p.timeout);
      p.control = m.control;
      p.claiming = false;
      p.approved = true;
      p.screen = s.screens[0]?.id || null;
      renderConnections();
      renderRequest(s, p);
      let remembered = !!p.pair?.saved;
      if (p.pair) {
        const { listen, dial } = p.pair;
        try {
          await refreshDevices(
            remembered && !p.localGrant ? "identify" : "save",
            {
              listen,
              dial,
              address: s.address,
              grant:
                p.localGrant ||
                (contacts.find((c) => c.listen === listen)?.grant ?? ""),
              platform: p.platform || p.pair.platform || "",
              name: p.name,
            },
          );
          s.relay.remember(p.pair);
          remembered = true;
        } catch (err) {
          if (p.localGrant) remembered = false;
          say(err.message);
        }
      }
      s.relay.json(p.id, {
        t: "approved",
        control: p.control,
        keyboard: !!s.cap?.keyboard,
        windowsScreenshots: s.windowsScreenshots,
        remembered,
        qualityControls: true,
        screens: s.screens,
        screen: p.screen,
        name: $("name").value.trim() || defaultName,
        platform,
      });
      nextFrame(s);
      direct(s, p).catch(() => {
        p.pc?.close();
        p.pc = null;
      });
    }
    if (["error", "left", "denied"].includes(m.type)) s.relay.drop(p.id);
  };
  p.ws.onclose = () => s.relay.drop(p.id);
}
function canOfferControl(s) {
  return (
    eligible(s) && ![...s.peers.values()].some((v) => v.control || v.claiming)
  );
}
function placeHostRequests() {
  const overlay = $("incoming-requests");
  for (const p of hostSession?.peers.values() || []) {
    if (!p.row?.isConnected) continue;
    const container = viewerSession && !p.approved ? overlay : $("devices");
    if (p.row.parentElement !== container) container.append(p.row);
  }
  overlay.hidden = !overlay.querySelector(".device");
}
function renderRequest(s, p) {
  p.row?.remove();
  if (!p.approved && p.pair?.saved) {
    const grant = contacts.find(
      (c) => c.listen === p.pair.listen && c.address === s.address,
    )?.grant;
    const trustedView = p.viewOnly && (grant === "view" || grant === "control");
    p.trustedControl = !p.viewOnly && grant === "control";
    if (trustedView || (p.trustedControl && canOfferControl(s))) {
      p.claiming = true;
      s.local.send(
        JSON.stringify({
          type: "approve",
          id: p.localId,
          control: p.trustedControl,
        }),
      );
      return;
    }
  }
  const row = (p.row = document.createElement("div"));
  row.className = "card device";
  const name = document.createElement("strong");
  name.textContent = p.pair?.saved
    ? p.name + "（已配對）"
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
      const stored = contacts.find((c) => c.listen === p.pair?.listen);
      p.localGrant =
        control || stored?.grant === "control" ? "control" : "view";
      p.claiming = control;
      for (const b of row.querySelectorAll("button")) b.disabled = true;
      s.local.send(JSON.stringify({ type: "approve", id: p.localId, control }));
    };
    const hint = document.createElement("small");
    hint.textContent =
      !p.viewOnly && eligible(s) && platform === "Darwin"
        ? "macOS 已允許鍵鼠操作。這是此裝置的連線授權，選「允許操作」後會記住。"
        : "允許後會記住此裝置與權限，下次可直接連線。";
    row.append(hint);
    if (!p.viewOnly) {
      if (canOfferControl(s)) {
        button("允許操作", () => approve(true));
      } else if (!eligible(s)) {
        hint.textContent =
          s.cap?.controlHint ||
          "主機目前無法使用鍵盤及滑鼠操作。請檢查系統權限。";
        if (!s.permissionTimer)
          s.permissionTimer = setInterval(() => {
            if (
              current(s) &&
              s.local.readyState === 1 &&
              [...s.peers.values()].some(
                (peer) =>
                  peer.row &&
                  !peer.approved &&
                  !peer.claiming &&
                  !peer.viewOnly,
              )
            )
              s.local.send(JSON.stringify({ type: "capabilities" }));
            else {
              clearInterval(s.permissionTimer);
              s.permissionTimer = null;
            }
          }, 1500);
        if (platform === "Darwin")
          button("查看目前的 Mac 權限", () => go("settings"));
        button("重新檢查操作權限", () =>
          s.local.send(JSON.stringify({ type: "capabilities" })),
        );
      } else
        hint.textContent = p.trustedControl
          ? "這台裝置已獲准操作，正在等候目前的操作者離開。"
          : "另一台裝置正在操作本機。可先允許觀看，或等對方結束控制。";
      const reason = eligible(s)
        ? p.trustedControl
          ? "busy"
          : "approval"
        : s.cap?.controlReason || "access";
      if (p.sentReason !== reason)
        s.relay.json(p.id, {
          t: "control-pending",
          platform,
          reason,
          canView: true,
        });
      p.sentReason = reason;
    }
    if (!p.trustedControl) button("允許觀看", () => approve(false));
    button(p.trustedControl ? "取消等候" : "拒絕", () => s.relay.drop(p.id));
  } else button("中斷連線", () => s.relay.drop(p.id));
  $("devices").append(row);
  placeHostRequests();
}
async function direct(s, p, offer) {
  if (typeof RTCPeerConnection === "undefined" || p.pc ||
      (s.host && (!s.stream || s.screens.length > 1)))
    return;
  const pc = (p.pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  }));
  if (s.host) {
    p.sender = pc.addTrack(s.stream.getVideoTracks()[0], s.stream);
    await pc.setLocalDescription(await pc.createOffer());
  } else {
    pc.ontrack = (e) => {
      const v = (p.video = document.createElement("video"));
      v.muted = true;
      v.playsInline = true;
      v.srcObject = new MediaStream([e.track]);
      v.play().catch(() => {});
      let previousTime = -1;
      const draw = (_now, metadata) => {
        if (
          !current(s) ||
          !s.peers.has(p.id) ||
          pc.connectionState === "closed"
        )
          return;
        const frameTime = metadata?.mediaTime ?? v.currentTime;
        if (
          v.readyState >= 2 &&
          pc.connectionState === "connected" &&
          v.videoWidth > 2 &&
          v.videoHeight > 2 &&
          frameTime !== previousTime
        ) {
          previousTime = frameTime;
          paint(s, p, v, v.videoWidth, v.videoHeight, "direct");
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
  if (current(s) && s.peers.get(p.id) === p && p.pc === pc && pc.signalingState !== "closed")
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
function compatibleVideo(s, p) {
  if (p.noAVC || !current(s) || s.peers.get(p.id) !== p) return;
  clearTimeout(p.avcTimer);
  p.noAVC = true;
  if (p.decoder && p.decoder.state !== "closed") p.decoder.close();
  s.relay.json(p.id, { t: "quality", ...profile(), avc: false });
}
async function receiveJpeg(s, p, data) {
  if (p.painting) {
    // Keep the newest complete frame while an image is being decoded.
    p.nextJpeg = data;
    return;
  }
  p.painting = true;
  const revision = p.screenRevision;
  let image;
  try {
    image = await decodeJpeg(data);
    if (current(s) && s.peers.get(p.id) === p && !p.direct &&
        !p.waitingScreen && p.screenRevision === revision)
      paint(s, p, image, image.width, image.height, "jpeg");
  } catch {
    // A damaged image does not affect subsequent independently encoded frames.
  } finally {
    image?.close?.();
    p.painting = false;
    const next = p.nextJpeg;
    p.nextJpeg = null;
    if (next && current(s) && s.peers.get(p.id) === p && !p.direct && !p.waitingScreen)
      receiveJpeg(s, p, next);
  }
}

function receiveVideo(s, p, bytes) {
  const fallback = () => compatibleVideo(s, p);
  if (bytes.length <= 9 || bytes[0] > 1 || typeof VideoDecoder !== "function")
    return fallback();
  try {
    const data = bytes.subarray(9),
      key = bytes[0] === 1;
    if (key) {
      let codec;
      for (let i = 0; i + 6 < data.length; i++)
        if (
          !data[i] &&
          !data[i + 1] &&
          data[i + 2] === 1 &&
          (data[i + 3] & 31) === 7
        ) {
          codec =
            "avc1." +
            Array.from(data.subarray(i + 4, i + 7), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          break;
        }
      if (!codec) return fallback();
      if (!p.decoder)
        p.decoder = new VideoDecoder({
          output: (f) => {
            try {
              if (current(s) && s.peers.get(p.id) === p)
                paint(s, p, f, f.displayWidth, f.displayHeight, "avc");
            } catch {
              fallback();
            } finally {
              f.close();
            }
          },
          error: fallback,
        });
      if (p.codec !== codec || p.needKey) {
        p.decoder.configure({ codec, optimizeForLatency: true });
        p.codec = codec;
      }
      p.needKey = false;
    }
    if (!p.decoder || p.needKey) return;
    if (p.decoder.decodeQueueSize > 6) {
      p.decoder.reset();
      p.needKey = true;
      return;
    }
    p.decoder.decode(
      new EncodedVideoChunk({
        type: key ? "key" : "delta",
        timestamp: Number(
          new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0),
        ),
        data,
      }),
    );
  } catch {
    fallback();
  }
}
const viewport = $("screen-viewport");
const navigatorButton = $("pan-view");
function updateNavigator() {
  // In portrait, a landscape desktop's title bar may be halfway down the phone.
  const bounds = pictureBounds(canvas);
  const rail = document.querySelector(".viewer-bar");
  const titleBottom = bounds && bounds.left + bounds.width > rail.getBoundingClientRect().left
    ? Math.ceil(bounds.top + Math.max(16, 48 * bounds.width / canvas.width)) : 0;
  rail.style.setProperty("--remote-title-bottom", titleBottom + "px");
  const { clientWidth: w, clientHeight: h, scrollWidth: fullW, scrollHeight: fullH } = viewport;
  navigatorButton.hidden = !viewport.classList.contains("native") || !w || !h ||
    (fullW <= w && fullH <= h);
  if (navigatorButton.hidden) return;
  navigatorButton.style.width = Math.min(92, 76 * fullW / fullH) + "px";
  navigatorButton.style.aspectRatio = fullW + " / " + fullH;
  const thumb = navigatorButton.firstElementChild.style;
  thumb.width = (100 * w / fullW) + "%";
  thumb.height = (100 * h / fullH) + "%";
  thumb.left = (100 * viewport.scrollLeft / fullW) + "%";
  thumb.top = (100 * viewport.scrollTop / fullH) + "%";
}
function updateViewScale() {
  const native = $("view-scale").value === "native";
  viewport.classList.toggle("native", native);
  viewport.scrollTo((viewport.scrollWidth - viewport.clientWidth) / 2,
                    (viewport.scrollHeight - viewport.clientHeight) / 2);
  updateNavigator();
}
$("view-scale").onchange = updateViewScale;
new ResizeObserver(updateNavigator).observe(viewport);
viewport.addEventListener("scroll", updateNavigator);
function panView(event) {
  const rect = navigatorButton.getBoundingClientRect();
  viewport.scrollTo((event.clientX - rect.left) / rect.width * viewport.scrollWidth - viewport.clientWidth / 2,
                    (event.clientY - rect.top) / rect.height * viewport.scrollHeight - viewport.clientHeight / 2);
}
navigatorButton.onpointerdown = (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  navigatorButton.setPointerCapture(event.pointerId);
  panView(event);
};
navigatorButton.onpointermove = (event) => {
  if (navigatorButton.hasPointerCapture(event.pointerId)) panView(event);
};
navigatorButton.onkeydown = (event) => {
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!direction) return;
  event.preventDefault();
  viewport.scrollBy(direction[0] * viewport.clientWidth / 2, direction[1] * viewport.clientHeight / 2);
};
function profile(values) {
  const edge = Number(values ? values.edge : $("quality").value);
  const fps = Number(values ? values.fps : $("fps").value);
  const sharp = values
    ? values.sharp === true
    : $("detail-quality").value === "sharp";
  return {
    edge: EDGES.includes(edge) ? edge : 1920,
    sharp,
    fps: fps === 60 ? 60 : 30,
  };
}
for (const [id, key, defaultValue] of [
  ["quality", "edge", 3840],
  ["detail-quality", "detail", "sharp"],
  ["fps", "fps", 30],
]) {
  const select = $(id);
  select.value =
    localStorage.getItem("rc-video-" + key) || String(defaultValue);
  if (!select.value) select.value = String(defaultValue);
  select.onchange = () => {
    const settings = profile();
    localStorage.setItem("rc-video-" + key, select.value);
    if (viewerSession)
      for (const peer of viewerSession.peers.values())
        if (peer.approved) {
          const s = viewerSession;
          const avc = !!peer.avcRequested && !peer.noAVC;
          if (avc) {
            clearTimeout(peer.avcTimer);
            peer.avcTimer = setTimeout(() => compatibleVideo(s, peer), 5000);
          }
          s.relay.json(peer.id, { t: "quality", ...settings, avc });
        }
  };
}
async function tuneSender(s, p) {
  if (!p.sender || !p.profile || !s.hasFrame || p.tuning) return;
  const { edge, fps, sharp } = p.profile,
    size = Math.max(s.source.width, s.source.height);
  const key = [edge, fps, sharp, size].join("/");
  if (p.tuned === key) return;
  try {
    p.tuning = true;
    const params = p.sender.getParameters();
    if (!params.encodings?.length) return;
    params.degradationPreference = sharp ? "maintain-resolution" : "balanced";
    Object.assign(params.encodings[0], {
      maxFramerate: fps,
      scaleResolutionDownBy: Math.max(1, size / edge),
      maxBitrate: Math.min(
        48000000,
        Math.round(
          s.source.width *
            s.source.height *
            Math.min(1, edge / size) ** 2 *
            fps *
            (sharp ? 0.23 : 0.115),
        ),
      ),
    });
    await p.sender.setParameters(params);
    p.tuned = key;
  } catch {
    /* The captured stream and JPEG relay still follow the target. */
  } finally {
    p.tuning = false;
  }
}
function nextFrame(s) {
  if (!current(s) || s.reading || s.local.readyState !== 1) return;
  // While a relay image is in flight, wait for the writer to request a fresh
  // capture instead of repeatedly capturing and decoding frames it cannot send.
  const peers = [...s.peers.values()].filter((p) => p.approved && !p.ending &&
    (!p.sendingImage || p.direct || p.pc?.connectionState === "connected"));
  if (!peers.length) return;
  s.reading = true;
  s.captureNumber = ((s.captureNumber || 0) + 1) >>> 0 || 1;
  const screens = [...new Set(peers.map((p) => p.screen))];
  const active = (s.screenCursor || 0) % screens.length;
  s.screenCursor = active + 1;
  s.captureScreen = screens[active];
  const selected = peers.filter((p) => p.screen === s.captureScreen);
  s.captureProfiles = new Map(selected.map((p) => [p.id, p.profile]));
  const settings = selected.map((p) => p.profile);
  const now = performance.now();
  s.captureEdge = Math.max(...settings.map((p) => p.edge));
  s.captureSharp = settings.some((p) => p.sharp);
  s.local.send(
    JSON.stringify({
      type: "primary-frame",
      ...(s.captureSequence ? {
        frame: s.captureNumber,
        skipDuplicate: selected.every((p) => p.lastImage && now - p.lastImageAt < 2000 &&
          !p.direct && p.pc?.connectionState !== "connected"),
      } : {}),
      edge: s.captureEdge,
      sharp: s.captureSharp,
      fps: Math.min(60, screens.length * Math.max(...settings.map((p) => p.fps))),
      screen: s.captureScreen,
    }),
  );
}
function viewerScreens(s, p, screens) {
  p.screens = Array.isArray(screens) ? screens : [];
  const button = $("switch-display");
  button.hidden = p.screens.length < 2;
  const active = p.screens.findIndex((screen) => screen.id === p.screen);
  button.textContent = `螢幕 ${Math.max(1, active + 1)} / ${p.screens.length}`;
  button.disabled = s.switchingScreen === true;
  if (p.screens.length > 1 || (p.screen && active < 0)) {
    p.pc?.close();
    p.pc = null;
    p.direct = false;
  }
  if ((!p.waitingScreen && p.screen && active < 0) ||
      (p.waitingScreen && !p.screens.some((screen) => screen.id === p.requestedScreen)))
    waitForScreen(s, p, p.screens[0]?.id ?? null);
  button.onclick = () => {
    const selected = p.screens[(active + 1) % p.screens.length];
    if (!selected || !current(s) || s.switchingScreen) return;
    if (p.control) s.sendInput?.({ kind: "release" });
    waitForScreen(s, p, selected.id);
    s.relay.json(p.id, { t: "select-screen", screen: selected.id });
  };
}
function waitForScreen(s, p, screen) {
  p.nextJpeg = null;
  p.receivedBase = null;
  p.waitingScreen = true;
  p.requestedScreen = screen;
  p.screenRevision = (p.screenRevision || 0) + 1;
  s.switchingScreen = true;
  $("switch-display").disabled = true;
  $("first-picture").textContent = "正在切換螢幕…";
  $("first-picture").hidden = false;
}
function selectHostScreen(s, p, screen) {
  if (p.screen === screen) return;
  if (p.control)
    s.local.send(JSON.stringify({ type: "input", id: p.localId, event: { kind: "release" } }));
  p.screen = screen;
  s.relay.cancelImage(p.id);
  p.jpegBase = null;
  p.hasSwitched = true;
  p.pendingScreen = true;
  p.lastImage = null;
  p.nextFrame = 0;
}
function updateHostScreens(s, screens) {
  if (!Array.isArray(screens) || JSON.stringify(screens) === JSON.stringify(s.screens)) return;
  s.screens = screens;
  for (const p of s.peers.values()) {
    if (!p.approved) continue;
    if (screens.length > 1 || !screens.some((screen) => screen.id === p.screen)) {
      p.pc?.close();
      p.pc = p.sender = null;
      p.direct = false;
    }
    if (!screens.some((screen) => screen.id === p.screen))
      selectHostScreen(s, p, screens[0]?.id ?? null);
    s.relay.json(p.id, { t: "desktop-screens", screens });
  }
}
function startCapture(s) {
  const source = (s.source = document.createElement("canvas"));
  source.width = source.height = 2;
  s.stream = source.captureStream?.(60);
  const track = s.stream?.getVideoTracks()[0];
  const fallback = document.createElement("canvas");
  const sizeLimit = (p) => p.frameParts ? MAX_IMAGE : SINGLE_IMAGE;
  const matchesCapture = (p, data) => p.profile.edge >= s.captureEdge &&
    p.profile.sharp === s.captureSharp && data.byteLength <= sizeLimit(p);

  return async (data, frame) => {
    const now = performance.now();
    const peers = [...s.peers.values()].filter((p) => p.approved && p.screen === s.captureScreen);
    // A quality change during native capture applies to the next capture. Re-encoding
    // an obsolete frame wastes a decode and can briefly show the former setting.
    const viewers = peers.filter((p) => s.captureProfiles.get(p.id) === p.profile &&
      !p.direct && !p.sendingImage && now >= (p.nextFrame || 0));
    const webRTC = peers.some((p) => p.pc?.connectionState === "connected");
    let image;
    try {
      // The native capture is already the correct JPEG for most relay viewers.
      // Only decode it when WebRTC needs pixels or a viewer requests another profile.
      if (webRTC || viewers.some((p) => !matchesCapture(p, data)))
        image = await decodeJpeg(data);
      if (!current(s) || s.captureNumber !== frame) return;
      s.hasFrame = true;
      if (webRTC && image) {
        if (source.width !== image.width || source.height !== image.height) {
          source.width = image.width;
          source.height = image.height;
        }
        if (track && "contentHint" in track) track.contentHint = s.captureSharp ? "detail" : "motion";
        source.getContext("2d").drawImage(image, 0, 0);
        for (const p of peers) tuneSender(s, p);
      }
      const encoded = new Map();
      for (const p of viewers) {
        const { edge, fps, sharp } = p.profile;
        const limit = sizeLimit(p), key = [edge, sharp, limit].join("/");
        let jpeg = encoded.get(key);
        if (!jpeg) {
          if (matchesCapture(p, data)) {
            jpeg = data;
          } else {
            image ??= await decodeJpeg(data);
            const scale = Math.min(1, edge / Math.max(image.width, image.height));
            if (scale === 1 && sharp === s.captureSharp && data.byteLength <= limit) {
              jpeg = data;
            } else {
              fallback.width = Math.max(1, Math.round(image.width * scale));
              fallback.height = Math.max(1, Math.round(image.height * scale));
              fallback.getContext("2d").drawImage(image, 0, 0, fallback.width, fallback.height);
              const levels = p.frameParts ? (sharp ? [0.95, 0.88, 0.78] : [0.8, 0.72]) : [0.88, 0.72, 0.54, 0.36];
              for (const q of levels) {
                const blob = await new Promise((done) => fallback.toBlob(done, "image/jpeg", q));
                if (blob && blob.size <= limit) {
                  jpeg = new Uint8Array(await blob.arrayBuffer());
                  break;
                }
              }
            }
          }
          if (!jpeg) continue;
          encoded.set(key, jpeg);
        }
        if (!current(s) || s.captureNumber !== frame) return;
        if (s.peers.get(p.id) !== p || s.captureProfiles.get(p.id) !== p.profile ||
            p.direct || p.screen !== s.captureScreen) continue;
        p.nextFrame = now + 1000 / fps - 1;
        if (now - p.lastImageAt < 2000 && sameImage(p.lastImage, jpeg)) continue;
        p.lastImage = jpeg;
        p.lastImageAt = now;
        p.sendingImage = true;
        const switchNotice = p.pendingScreen
          ? s.relay.json(p.id, { t: "screen-active", screen: p.screen })
          : null;
        p.pendingScreen = false;
        const screen = p.screen;
        Promise.resolve(switchNotice).then(async () => {
          const patch = rowPatch(p.jpegBase, jpeg);
          const serial = await s.relay.sendImage(p.id, patch || jpeg, p.frameParts, !!patch);
          if (!patch && jpeg.length > SINGLE_IMAGE && p.jpegRows && p.screen === screen)
            p.jpegBase = serial ? jpegReference(serial, jpeg) : null;
        })
          .finally(() => {
            p.sendingImage = false;
            nextFrame(s);
          });
      }
    } finally {
      image?.close?.();
    }
  };
}
async function captureFailed(s, reason, kind = "unavailable") {
  if (!current(s)) return;
  s.hasFrame = false;
  s.reading = false;
  say(reason || "無法擷取主螢幕，請檢查系統權限後再連線。");
  const viewers = [...s.peers.values()].filter((p) => p.approved && !p.ending);
  for (const peer of viewers) peer.ending = true;
  await Promise.all(
    viewers.map(async (peer) => {
      await s.relay.json(peer.id, {
        t: "capture-error",
        platform,
        reason: kind,
      });
      if (current(s) && s.peers.get(peer.id) === peer) s.relay.drop(peer.id);
    }),
  );
}
function standby() {
  clearTimeout(hostRetry);
  if (!token || hostSession) return;
  const s = begin(true);
  s.local = localSocket();
  s.local.binaryType = "arraybuffer";
  s.local.onopen = () => s.local.send(JSON.stringify({ type: "host", token }));
  s.local.onmessage = async (e) => {
    if (!current(s)) return;
    try {
      if (e.data instanceof ArrayBuffer) {
        const frame = s.captureNumber;
        if (s.captureSequence && (e.data.byteLength < 5 || !s.reading ||
            new DataView(e.data).getUint32(0) !== frame)) return;
        try {
          await s.frame(new Uint8Array(e.data, s.captureSequence ? 4 : 0), frame);
        } catch {
          if (s.captureNumber === frame)
            await captureFailed(s, "無法處理主螢幕畫面。請重新連線，或用新版瀏覽器開啟主機分頁。");
        } finally {
          if (s.captureNumber === frame) {
            s.reading = false;
            nextFrame(s);
          }
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === "hosted") {
        clearTimeout(s.deadline);
        s.localCode = m.code;
        s.cap = m.capabilities;
        s.primary = m.primaryCapture;
        s.captureSequence = m.captureSequence === true;
        s.windowsScreenshots = m.windowsScreenshots === true;
        s.screens = m.screens || [];
        if (!s.primary) throw Error("請開啟新版桌面程式以連接主螢幕。");
        s.frame = startCapture(s);
        await connectRelay(s);
        if (current(s)) s.screenPoll = setInterval(() => {
          if (s.local.readyState === 1) s.local.send(JSON.stringify({ type: "capabilities" }));
        }, 2500);
      }
      if (m.type === "screen-changed") {
        if (s.captureSequence && m.frame !== s.captureNumber) return;
        s.reading = false;
        updateHostScreens(s, m.screens);
        nextFrame(s);
      }
      if (m.type === "capture-busy" && m.frame === s.captureNumber) {
        s.reading = false;
        setTimeout(() => nextFrame(s), 20);
      }
      if (m.type === "capture-unchanged" && m.frame === s.captureNumber) {
        s.reading = false;
        nextFrame(s);
      }
      if (m.type === "capture-error")
        if (!s.captureSequence || m.frame === s.captureNumber)
          await captureFailed(s, m.message, m.reason);
      if (m.type === "capabilities") {
        const changed =
          JSON.stringify(s.cap) !== JSON.stringify(m.capabilities);
        s.cap = m.capabilities;
        updateHostScreens(s, m.screens);
        if (changed)
          for (const p of s.peers.values())
            if (p.row && !p.approved && !p.claiming) renderRequest(s, p);
      }
      if (m.type === "error" && !m.id) throw Error(m.message);
      if (m.type === "error" && m.id)
        for (const p of s.peers.values())
          if (p.localId === m.id) {
            if (m.code !== "control-unavailable" || !p.trustedControl) {
              s.relay.drop(p.id);
              continue;
            }
            s.cap = m.capabilities;
            clearTimeout(p.retryApproval);
            p.retryApproval = setTimeout(() => {
              if (!current(s) || s.peers.get(p.id) !== p || p.approved) return;
              p.claiming = false;
              renderRequest(s, p);
            }, 1500);
          }
    } catch (err) {
      closeSession(s, err.message);
    }
  };
  s.local.onclose = () => closeSession(s, "本機連線服務已停止。");
}
$("start").onclick = standby;
$("pair-again").onclick = () => {
  $("pair-again").hidden = true;
  $("code").value = "";
  requestViewOnly = false;
  say("");
  go("connect");
  $("code").focus();
};
$("relay").onchange = () => {
  localStorage.setItem("rc-relay", $("relay").value.trim());
  if (hostSession && !hostSession.peers.size) {
    hostSession.stopped = true;
    closeSession(hostSession, "");
    standby();
  }
};
async function joinDevice(saved, viewOnly = false) {
  if (viewerSession) {
    say("請先結束目前的連線。");
    return;
  }
  const s = begin(false);
  s.viewOnly = viewOnly;
  s.waitUntil = Date.now() + 90000;
  if (saved)
    $("joining-title").textContent =
      (viewOnly ? "觀看" : "連接") + "「" + displayName(saved) + "」";
  try {
    await identityReady;
    if (!current(s)) return;
    const value = $("code").value.trim();
    if (saved) {
      s.address = saved.address;
      s.pair = { ...saved, saved: true };
      const incoming = [...(hostSession?.peers.values() || [])].find(
        (p) =>
          p.approved &&
          p.pair?.listen === saved.listen &&
          hostSession.address === saved.address &&
          p.screenRequest,
      );
      if (incoming) {
        s.askedPhone = true;
        hostSession.relay.json(incoming.id, {
          t: "ask-phone-screen",
          control: !viewOnly,
        });
      }
    } else if (/^[0-9]{4}$/.test(value)) {
      const address = new URL($("relay").value.trim()).href.replace(/\/+$/, "");
      if (
        hostSession?.ready &&
        hostSession.address === address &&
        value === $("invite").value
      ) {
        closeSession(
          s,
          "這是本機的連線碼。要連接手機，請輸入手機「我的手機連線碼」裡的四碼。",
        );
        return;
      }
      s.pair = await findPin(address, value, s.abort.signal);
      await refreshDevices();
      s.resume = await resumeOffers(contacts, address, s.pair.dial);
    } else {
      const parsed = parseInvite(value, $("relay").value.trim());
      s.address = parsed.address;
      s.invite = parsed.invite;
    }
    if (!current(s)) return;
    if (s.pair) s.invite = s.pair.dial;
    await connectRelay(s);
  } catch (err) {
    closeSession(s, err.message);
  }
}
$("code").addEventListener("input", () => {
  if (/^[0-9]{4}$/.test($("code").value) && $("name").value.trim())
    joinDevice(null, requestViewOnly);
});
$("join").onsubmit = (e) => {
  e.preventDefault();
  joinDevice(null, requestViewOnly);
};
$("copy").onclick = () =>
  navigator.clipboard
    .writeText($("invite").value)
    .catch(() => say("請手動輸入畫面上的四位數。"));
$("join-watch").onclick = () => {
  const s = viewerSession;
  if (!s || s.wasApproved) return;
  s.viewOnly = true;
  $("join-watch").hidden = true;
  for (const p of s.peers.values()) s.relay.json(p.id, { t: "view-only" });
  viewerNote(s, "已改為觀看，正在等候分享端。");
};
$("switch-share").onclick = () => {
  if (viewerSession) closeSession(viewerSession, "正在切換分享方向。");
  window.PhoneDevices?.openHost();
};
$("skip-share").onclick = () => {
  $("share-request").hidden = true;
};
$("cancel").onclick = $("leave").onclick = () => {
  if (viewerSession) closeSession(viewerSession, "連線已結束。");
};
$("stop").onclick = () => {
  clearTimeout(hostRetry);
  if (hostSession) {
    hostSession.stopped = true;
    closeSession(hostSession, "已停止接受連線。");
  }
};
window.addEventListener("pagehide", () => {
  clearTimeout(hostRetry);
  if (viewerSession) closeSession(viewerSession, "連線已結束。");
  if (hostSession) {
    hostSession.stopped = true;
    closeSession(hostSession, "連線已結束。");
  }
});

const ime = $("ime"),
  anchor = "\u200b";
let composing = false;
function keyboard(on) {
  if (on && viewerSession?.sendInput) {
    ime.hidden = false;
    ime.value = anchor;
    ime.focus({ preventScroll: true });
    ime.setSelectionRange(1, 1);
    window.ViewerScreen?.keyboard(true);
  } else if (!ime.hidden) {
    ime.hidden = true;
    composing = false;
    ime.value = "";
    window.ViewerScreen?.keyboard(false);
    canvas.focus({ preventScroll: true });
  }
}
function special(code) {
  for (const down of [true, false])
    viewerSession?.sendInput?.({ kind: "key", code, down });
}
function commitIME() {
  if (composing || ime.hidden) return;
  const text = ime.value.replace(anchor, "");
  if (!ime.value) special("Backspace");
  else if (text) {
    const letters = Array.from(text.replace(/[\x00-\x1f]/g, ""));
    while (letters.length)
      viewerSession?.sendInput?.({
        kind: "text",
        text: letters.splice(0, 120).join(""),
      });
  }
  ime.value = anchor;
}
ime.oncompositionstart = () => {
  composing = true;
};
ime.oncompositionend = () => {
  composing = false;
  setTimeout(commitIME, 0);
};
ime.oninput = (e) => {
  if (!e.isComposing) commitIME();
};
ime.onkeydown = (e) => {
  if (e.isComposing || composing) return;
  if (e.key === "Escape") {
    e.preventDefault();
    keyboard(false);
  }
  if (["Enter", "Tab", "Backspace", "Delete"].includes(e.key)) {
    e.preventDefault();
    special(e.key);
  }
};
ime.onbeforeinput = (e) => {
  if (
    !composing &&
    ["insertParagraph", "insertLineBreak", "deleteContentBackward"].includes(
      e.inputType,
    )
  ) {
    e.preventDefault();
    special(e.inputType === "deleteContentBackward" ? "Backspace" : "Enter");
  }
};
$("keyboard-button").onclick = () => keyboard(ime.hidden);
function screenshotStatus(s, message, duration = 5500) {
  clearTimeout(s.screenshotStatusTimer);
  $("screenshot-status").textContent = message;
  $("screenshot-status").hidden = false;
  if (duration) s.screenshotStatusTimer = setTimeout(() => {
    if (current(s)) $("screenshot-status").hidden = true;
  }, duration);
}
$("screenshot-menu").addEventListener("toggle", () => {
  if ($("screenshot-menu").open) $("video-menu").open = false;
});
$("video-menu").addEventListener("toggle", () => {
  if ($("video-menu").open) $("screenshot-menu").open = false;
});
$("save-screenshot").onclick = () => viewerSession?.screenshot?.("save");
$("open-snip").onclick = () => viewerSession?.screenshot?.("snip");
window.remoteControlAndroidScreenshot = () => viewerSession?.screenshot?.("save") === true;
function screenshotKey(event) {
  const s = viewerSession;
  if (!s?.screenshot || !s.hasPicture || s.switchingScreen || event.isComposing) return;
  const print = event.code === "PrintScreen" || event.key === "PrintScreen";
  const shortcut = event.code === "KeyS" && event.ctrlKey && event.altKey && event.shiftKey && !event.metaKey;
  if (!print && !shortcut) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "keydown" && !event.repeat) {
    s.printPressed = print;
    s.screenshot("save");
  } else if (event.type === "keyup" && print) {
    if (!s.printPressed) s.screenshot("save"); // Some desktop browsers deliver only keyup.
    s.printPressed = false;
  }
}
window.addEventListener("keydown", screenshotKey, true);
window.addEventListener("keyup", screenshotKey, true);
identityReady.then(standby);

if (window.PhoneUpdates) {
  $("updates").hidden = false;
  window.phoneUpdateState = (message, available, busy) => {
    $("update-status").textContent = message;
    $("install-update").hidden = !available;
    $("check-update").disabled = $("install-update").disabled = busy;
    $("update-badge").hidden = !available;
  };
  $("check-update").onclick = () => window.PhoneUpdates.action(false);
  $("install-update").onclick = () => window.PhoneUpdates.action(true);
  window.PhoneUpdates.refresh();
} else if (token) {
  async function update(action) {
    const check = $("check-update"),
      install = $("install-update"),
      status = $("update-status");
    if (action === "install" && (viewerSession || hostSession?.peers.size)) {
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
        status.textContent = platform === "Windows"
          ? "已開啟安裝程式。安裝完成後，可從 Windows 開始功能表開啟 RemoteControl。"
          : "已開啟安裝程式。完成後請重新開啟遠端桌面。";
        install.hidden = true;
      } else {
        status.textContent = result.available
          ? "目前版本 " + result.current + "，可更新至 " + result.latest
          : "目前版本 " + result.current + " 已是最新。";
        install.hidden = !result.available;
        $("update-badge").hidden = !result.available;
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
