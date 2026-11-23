import {
  HostChannels,
  findPin,
  resumeOffers,
  resumeAnswer,
} from "./pairing.mjs";
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
let hostSession = null;
let viewerSession = null;
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
  button.onclick = () =>
    go(button.dataset.page, button.dataset.page !== "devices");
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
    if (!response.ok)
      throw Error(
        "無法讀取目前程序的權限，請使用從「應用程式」開啟的新版 RemoteControl 分頁。",
      );
    const result = await response.json();
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
    $("view-mode").hidden = $("share-request").hidden = true;
    $("stats").textContent = "正在接收畫面";
    $("video-menu").open = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    clearTimeout(s.mediaTimer);
    s.detach?.();
  }
  s.abort.abort();
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
        const watch = document.createElement("button");
        watch.textContent = "觀看手機畫面";
        watch.onclick = () => joinDevice(pair, true);
        row.append(watch);
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
      say("正在重新連接配對服務，請保持這個分頁開啟。");
    },
    ready(code) {
      if (!current(s)) return;
      clearTimeout(s.deadline);
      s.ready = true;
      renderConnections();
      $("invitation").hidden = false;
      $("invite").value = code;
      say("請保持此分頁開啟。新裝置可輸入四碼，已配對裝置可直接重連。");
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
          avc: false,
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
              ? "正在等候手機開放分享。請在手機點「切換為分享手機」，或在裝置列表點「我的手機連線碼」並開放整個螢幕連線。"
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
            ? "手機尚未開放分享。請在手機點「我的手機連線碼」→「開放整個螢幕連線」，再點觀看手機畫面。"
            : "配對服務找不到這台裝置。請喚醒對方，開啟 Uniway Remote 並保持主機分頁顯示「等候連線」，再按遠端控制。若對方已重新安裝，可使用目前顯示的四碼配對。",
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
      if (type === 2) {
        if (!s.host && p.approved && !p.direct && !p.painting) {
          p.painting = true;
          decodeJpeg(data)
            .then((image) => {
              try {
                if (current(s) && s.peers.has(id) && !p.direct)
                  paint(s, p, image, image.width, image.height, "jpeg");
              } finally {
                image.close?.();
              }
            })
            .catch(() => {})
            .finally(() => (p.painting = false));
        }
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
          "「" + p.name + "」想觀看這支手機的畫面。";
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
          s.viewOnly || !m.canView || !["access", "busy"].includes(m.reason);
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
        if (m.t === "quality") {
          p.profile = profile(m);
          tuneSender(s, p);
          return;
        }
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
        s.wasApproved = true;
        p.control = m.control === true;
        $("view-mode").hidden = p.control;
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
            if (s.hasPicture) s.relay.json(id, { t: "input", event });
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
      } else if (!s.host && p.approved && m.t === "offer") {
        await direct(s, p, m.sdp).catch(() => {
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
  }
  ctx.drawImage(image, 0, 0, w, h);
  if (!s.hasPicture) {
    s.hasPicture = true;
    clearTimeout(s.mediaTimer);
    $("first-picture").hidden = true;
    $("stats").textContent = w + " × " + h;
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
  {
    const now = performance.now();
    if (!s.sampleTime) {
      s.sampleTime = now;
      s.frameCount = 0;
    }
    s.frameCount++;
    if (now - s.sampleTime >= 1000) {
      $("stats").textContent =
        w +
        " × " +
        h +
        " · 實收 " +
        Math.round((s.frameCount * 1000) / (now - s.sampleTime)) +
        " fps";
      s.sampleTime = now;
      s.frameCount = 0;
    }
  }
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
    if (m.type === "approved") {
      clearTimeout(p.timeout);
      p.control = m.control;
      p.claiming = false;
      p.approved = true;
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
        remembered,
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
        if (platform === "Darwin" && s.cap?.controlReason !== "unavailable") {
          const link = document.createElement("a");
          link.href =
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
          link.textContent = "開啟 Mac 輔助使用設定";
          row.append(link);
        }
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
  if (typeof RTCPeerConnection === "undefined" || p.pc || (s.host && !s.stream))
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
      const draw = () => {
        if (
          !current(s) ||
          !s.peers.has(p.id) ||
          pc.connectionState === "closed"
        )
          return;
        if (v.readyState >= 2 && pc.connectionState === "connected") {
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
  if (current(s) && s.peers.has(p.id))
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
function profile(values) {
  const edge = Number(values ? values.edge : $("quality").value);
  const fps = Number(values ? values.fps : $("fps").value);
  return {
    edge: [960, 1280, 1920].includes(edge) ? edge : 1920,
    fps: fps === 60 ? 60 : 30,
  };
}
for (const [id, key, defaultValue] of [
  ["quality", "edge", 1920],
  ["fps", "fps", 30],
]) {
  const select = $(id);
  select.value =
    localStorage.getItem("rc-video-" + key) || String(defaultValue);
  if (!select.value) select.value = String(defaultValue);
  select.onchange = () => {
    const settings = profile();
    localStorage.setItem("rc-video-" + key, settings[key]);
    if (viewerSession)
      for (const peer of viewerSession.peers.values())
        if (peer.approved)
          viewerSession.relay.json(peer.id, {
            t: "quality",
            ...settings,
            avc: !!peer.avcRequested && !peer.noAVC,
          });
  };
}
async function tuneSender(s, p) {
  if (!p.sender || !p.profile || !s.hasFrame || p.tuning) return;
  const { edge, fps } = p.profile,
    size = Math.max(s.source.width, s.source.height);
  const key = [edge, fps, size].join("/");
  if (p.tuned === key) return;
  try {
    p.tuning = true;
    const params = p.sender.getParameters();
    if (!params.encodings?.length) return;
    Object.assign(params.encodings[0], {
      maxFramerate: fps,
      scaleResolutionDownBy: Math.max(1, size / edge),
      maxBitrate: Math.round(edge * edge * fps * 0.11),
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
  const peers = [...s.peers.values()].filter((p) => p.approved && !p.ending);
  if (!current(s) || !peers.length || s.reading || s.local.readyState !== 1)
    return;
  s.reading = true;
  s.local.send(
    JSON.stringify({
      type: "primary-frame",
      fps: Math.max(...peers.map((p) => p.profile?.fps || 30)),
    }),
  );
}
function startCapture(s) {
  const source = (s.source = document.createElement("canvas"));
  source.width = source.height = 2;
  s.stream = source.captureStream?.(60);
  const fallback = document.createElement("canvas");
  return async (data) => {
    const image = await decodeJpeg(data);
    try {
      if (!current(s)) return;
      if (source.width !== image.width || source.height !== image.height) {
        source.width = image.width;
        source.height = image.height;
      }
      source.getContext("2d").drawImage(image, 0, 0);
      s.hasFrame = true;
      const encoded = new Map(),
        now = performance.now();
      for (const p of s.peers.values()) {
        if (!p.approved) continue;
        tuneSender(s, p);
        if (p.direct || now < (p.nextFrame || 0)) continue;
        const { edge, fps } = p.profile || { edge: 1920, fps: 30 };
        let jpeg = encoded.get(edge);
        if (!jpeg) {
          const scale = Math.min(1, edge / Math.max(image.width, image.height));
          if (scale === 1 && data.byteLength < 340000)
            jpeg = new Uint8Array(data);
          else {
            fallback.width = Math.max(1, Math.round(image.width * scale));
            fallback.height = Math.max(1, Math.round(image.height * scale));
            fallback
              .getContext("2d")
              .drawImage(image, 0, 0, fallback.width, fallback.height);
            for (const q of [0.88, 0.72, 0.54, 0.36]) {
              const blob = await new Promise((done) =>
                fallback.toBlob(done, "image/jpeg", q),
              );
              if (blob && blob.size < 340000) {
                jpeg = new Uint8Array(await blob.arrayBuffer());
                break;
              }
            }
          }
          if (!jpeg) continue;
          encoded.set(edge, jpeg);
        }
        if (!current(s) || s.peers.get(p.id) !== p) continue;
        p.nextFrame = now + Math.max(1000 / fps - 2, (jpeg.length + 64) / 3800);
        s.relay.send(p.id, 2, jpeg);
      }
    } finally {
      image.close?.();
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
  if (!token || hostSession) return;
  const s = begin(true);
  s.local = localSocket();
  s.local.binaryType = "arraybuffer";
  s.local.onopen = () => s.local.send(JSON.stringify({ type: "host", token }));
  s.local.onmessage = async (e) => {
    if (!current(s)) return;
    try {
      if (e.data instanceof ArrayBuffer) {
        try {
          await s.frame(e.data);
        } catch {
          await captureFailed(
            s,
            "無法處理主螢幕畫面。請重新連線，或用新版瀏覽器開啟主機分頁。",
          );
        } finally {
          s.reading = false;
          nextFrame(s);
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.type === "hosted") {
        clearTimeout(s.deadline);
        s.localCode = m.code;
        s.cap = m.capabilities;
        s.primary = m.primaryCapture;
        if (!s.primary) throw Error("請開啟新版桌面程式以連接主螢幕。");
        s.frame = startCapture(s);
        await connectRelay(s);
      }
      if (m.type === "capture-error")
        await captureFailed(s, m.message, m.reason);
      if (m.type === "capabilities") {
        const changed =
          JSON.stringify(s.cap) !== JSON.stringify(m.capabilities);
        s.cap = m.capabilities;
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
        hostSession.relay.json(incoming.id, { t: "ask-phone-screen" });
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
  if (hostSession) closeSession(hostSession, "已停止接受連線。");
};
window.addEventListener("pagehide", () => {
  if (viewerSession) closeSession(viewerSession, "連線已結束。");
  if (hostSession) closeSession(hostSession, "連線已結束。");
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
        status.textContent = "已開啟安裝程式。完成後請重新開啟遠端桌面。";
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
