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
  $("hostbox").hidden = !!selected || !token || (active && !active.host);
  $("phone-share").hidden = !window.PhoneDevices || !!selected;
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
  go("connect");
};
$("action-connect").onclick = () =>
  selected ? joinDevice(selected) : ((requestViewOnly = false), go("connect"));
$("action-view").onclick = () =>
  selected
    ? joinDevice(selected, true)
    : ((requestViewOnly = true), go("connect"));
$("action-settings").onclick = () => go("settings");
$("phone-share").onclick = () => window.PhoneDevices?.openHost();
$("forget").onclick = async () => {
  const pair = selected;
  if (
    !pair ||
    !confirm("解除與「" + displayName(pair) + "」的配對並結束連線？")
  )
    return;
  try {
    await refreshDevices("forget", pair);
    active?.relay?.forget?.(pair.listen);
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
function closeSession(s, message) {
  if (active !== s) return;
  keyboard(false);
  $("keyboard-button").hidden = true;
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
    if (p.decoder && p.decoder.state !== "closed") p.decoder.close();
  }
  clearTimeout(s.deadline);
  clearTimeout(s.retryTimer);
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
  renderConnections();
  $("cancel").hidden = true;
  $("pair-again").hidden = true;
  $("view-mode").hidden = true;
  $("stats").textContent = "正在接收畫面";
  $("video-menu").open = false;
  renderDevices();
  say(message);
}
function begin(host) {
  if (active) throw Error("已有連線。");
  const s = (active = {
    host,
    peers: new Map(),
    abort: new AbortController(),
  });
  renderConnections();
  $("pair-again").hidden = true;
  $("joinbox").hidden = false;
  $("start").hidden = true;
  $("connect").disabled = !host;
  $("settings").hidden = !host;
  $("hostbox").hidden = !host;
  $("stop").hidden = !host;
  $("leave").hidden = host;
  $("cancel").hidden = host;
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
  const peers = [...(active?.peers.values() || [])].filter((p) => p.approved);
  const rows = peers.map((p) => ({
    name: p.name,
    control: p.control,
    incoming: active.host,
  }));
  for (const p of phoneState.peers) rows.push({ ...p, incoming: true });
  const lan = Math.max(0, phoneState.lan);
  const count = rows.length + lan;
  const lines = rows.map((p) => {
    const operation = p.incoming
      ? p.control
        ? "正在操作本機"
        : "正在觀看本機"
      : p.control
        ? "正在操作對方"
        : "正在觀看對方";
    const name = genericName(p.name) || !p.name ? "對方裝置" : p.name;
    return name + " · " + operation;
  });
  if (lan) lines.push("區網觀看連線 · " + lan);
  $("connected-list").replaceChildren(
    ...lines.map((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      return p;
    }),
  );
  $("connected-count").textContent = String(count);
  $("status").dataset.connected = String(count > 0);
  $("status").textContent = count
    ? (rows.some((p) => p.incoming && p.control) ? "遠端操作中" : "已連線") +
      " · " +
      count
    : active?.ready || phoneState.listening
      ? "等候連線"
      : active
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
  if (active && !active.host) return;
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
  renderConnections();
  if (s.host)
    for (const waiting of s.peers.values())
      if (waiting.row && !waiting.approved && !waiting.claiming)
        renderRequest(s, waiting);
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
  let transport;
  const events = {
    reconnecting() {
      if (active !== s) return;
      s.ready = false;
      $("invitation").hidden = true;
      $("invite").value = "";
      renderConnections();
      say("正在重新連接配對服務，請保持這個分頁開啟。");
    },
    ready(code) {
      if (active !== s) return;
      clearTimeout(s.deadline);
      s.ready = true;
      renderConnections();
      $("invitation").hidden = false;
      $("invite").value = code;
      say("請保持此分頁開啟。新裝置可輸入四碼，已配對裝置可直接重連。");
    },
    paired(id, pair) {
      if (active !== s) return;
      const p = { id, approved: false, pair };
      s.peers.set(id, p);
      p.timeout = setTimeout(() => s.relay.drop(id), 120000);
      if (!s.host) {
        clearTimeout(s.deadline);
        s.relay.json(id, {
          t: "request",
          viewOnly: !!s.viewOnly,
          avc: typeof VideoDecoder === "function",
          ...profile(),
          name: $("name").value.trim() || defaultName,
          platform,
        });
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
      if (active !== s || s.relay !== transport) return;
      if (s.pair?.saved) {
        const delays = [1500, 3000, 6000, 10000];
        const attempt = s.attempt || 0;
        if (attempt < delays.length) {
          s.attempt = attempt + 1;
          s.relay = null;
          transport.close();
          say("正在等候已配對裝置恢復連線…");
          s.retryTimer = setTimeout(() => {
            if (active === s)
              connectRelay(s).catch((err) => closeSession(s, err.message));
          }, delays[attempt]);
          return;
        }
        closeSession(
          s,
          "配對服務找不到這台裝置。請喚醒對方，開啟 Uniway Remote 並保持主機分頁顯示「等候連線」，再按遠端控制。若對方已重新安裝，可使用目前顯示的四碼配對。",
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
      if (active !== s) return;
      const p = s.peers.get(id);
      if (!p) return;
      if (type === 3 && !s.host && p.approved && !p.noAVC) {
        receiveVideo(s, p, data);
        return;
      }
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
          m.platform === "Darwin"
            ? "Mac 無法擷取螢幕。請在 Mac 的「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」允許 RemoteControl，依系統提示重新開啟，再點遠端控制。"
            : "對方暫時無法擷取螢幕。請在對方裝置檢查螢幕錄製權限後，再點遠端控制。",
        );
        return;
      }
      if (!s.host && !p.approved && m.t === "control-pending") {
        say(
          m.reason === "access" && m.platform === "Darwin"
            ? "請在 Mac 的「隱私權與安全性 → 輔助使用」開啟 RemoteControl，再回主機分頁按「重新檢查操作權限」。"
            : "已送出操作請求，請在對方的主機分頁確認。",
        );
        return;
      }
      if (s.host) {
        if (m.t === "request" && !p.ws) {
          p.profile = profile(m);
          p.viewOnly = m.viewOnly === true;
          p.platform = platforms.has(m.platform) ? m.platform : "";
          return request(s, p, safeText(m.name, 48));
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
          } catch (err) {
            say(err.message);
          }
        }
        if (active !== s || s.peers.get(id) !== p) return;
        clearTimeout(p.timeout);
        p.approved = true;
        p.control = m.control === true;
        $("view-mode").hidden = p.control;
        $("joinbox").hidden = true;
        $("stage").hidden = false;
        $("cancel").hidden = true;
        mobileView(true);
        canvas.focus({ preventScroll: true });
        renderConnections();
        say(
          p.control
            ? "已獲准操作。點一下可操作該位置，雙指可捲動。"
            : "已獲准觀看。",
        );
        if (p.control) {
          s.sendInput = (event) => s.relay.json(id, { t: "input", event });
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
  localStorage.setItem("rc-relay", address);
  if (s.host) {
    s.relay = transport = new HostChannels(address, events);
    await refreshDevices();
    if (active === s) await s.relay.start(contacts);
  } else {
    s.relay = transport = new Relay(address, false, s.invite, events);
    await s.relay.start();
  }
}
function paint(image, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(image, 0, 0, w, h);
  const s = active;
  if (s && !s.host) {
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
    if (active !== s || !s.peers.has(p.id)) return;
    const m = JSON.parse(e.data);
    if (m.type === "pending") {
      p.localId = m.id;
      const grant =
        p.pair?.saved &&
        contacts.find(
          (c) => c.listen === p.pair.listen && c.address === s.address,
        )?.grant;
      if (m.capabilities) s.cap = m.capabilities;
      const control = grant === "control" && !p.viewOnly && canOfferControl(s);
      if (
        control ||
        (p.viewOnly && (grant === "view" || grant === "control"))
      ) {
        p.claiming = control;
        s.local.send(
          JSON.stringify({ type: "approve", id: p.localId, control }),
        );
        return;
      }
      selected = null;
      renderDevices();
      go("devices");
      renderRequest(s, p);
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
function renderRequest(s, p) {
  p.row?.remove();
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
    hint.textContent = "允許後會記住此裝置與權限，下次可直接連線。";
    row.append(hint);
    button("允許觀看", () => approve(false));
    if (!p.viewOnly) {
      if (canOfferControl(s)) {
        button("允許操作", () => approve(true));
      } else if (!eligible(s)) {
        hint.textContent =
          s.cap?.controlHint ||
          "主機目前無法使用鍵盤及滑鼠操作。請檢查系統權限。";
        button("重新檢查操作權限", () =>
          s.local.send(JSON.stringify({ type: "capabilities" })),
        );
      } else
        hint.textContent =
          "另一台裝置正在操作本機。可先允許觀看，或等對方結束控制。";
      s.relay.json(p.id, {
        t: "control-pending",
        platform,
        reason: eligible(s) ? "approval" : "access",
      });
    }
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
function receiveVideo(s, p, bytes) {
  function fallback() {
    if (p.noAVC) return;
    p.noAVC = true;
    if (p.decoder && p.decoder.state !== "closed") p.decoder.close();
    if (active === s)
      s.relay.json(p.id, { t: "quality", ...profile(), avc: false });
  }
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
              if (active === s && s.peers.get(p.id) === p)
                paint(f, f.displayWidth, f.displayHeight);
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
    if (active && !active.host)
      for (const peer of active.peers.values())
        if (peer.approved)
          active.relay.json(peer.id, {
            t: "quality",
            ...settings,
            avc: !peer.noAVC && typeof VideoDecoder === "function",
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
  if (active !== s || !peers.length || s.reading || s.local.readyState !== 1)
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
    const image = await createImageBitmap(
      new Blob([data], { type: "image/jpeg" }),
    );
    try {
      if (active !== s) return;
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
        if (active !== s || s.peers.get(p.id) !== p) continue;
        p.nextFrame = now + Math.max(1000 / fps - 2, (jpeg.length + 64) / 3800);
        s.relay.send(p.id, 2, jpeg);
      }
    } finally {
      image.close();
    }
  };
}
async function captureFailed(s, reason) {
  if (active !== s) return;
  s.hasFrame = false;
  s.reading = false;
  say(reason || "無法擷取主螢幕，請檢查系統權限後再連線。");
  const viewers = [...s.peers.values()].filter((p) => p.approved && !p.ending);
  for (const peer of viewers) peer.ending = true;
  await Promise.all(
    viewers.map(async (peer) => {
      await s.relay.json(peer.id, { t: "capture-error", platform });
      if (active === s && s.peers.get(peer.id) === peer) s.relay.drop(peer.id);
    }),
  );
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
      if (m.type === "capture-error") await captureFailed(s, m.message);
      if (m.type === "capabilities") {
        s.cap = m.capabilities;
        for (const p of s.peers.values())
          if (p.row && !p.approved && !p.claiming) renderRequest(s, p);
      }
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
$("pair-again").onclick = () => {
  $("pair-again").hidden = true;
  $("code").value = "";
  requestViewOnly = false;
  say("");
  go("connect");
  $("code").focus();
};
$("relay").onchange = () => {
  if (active?.host && !active.peers.size) {
    closeSession(active, "");
    standby();
  }
};
async function joinDevice(saved, viewOnly = false) {
  if (active?.host && !active.peers.size) closeSession(active, "");
  if (active) {
    say("請先結束目前的連線。");
    return;
  }
  const s = begin(false);
  s.viewOnly = viewOnly;
  try {
    await identityReady;
    if (s !== active) return;
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
$("cancel").onclick =
  $("stop").onclick =
  $("leave").onclick =
    () => {
      if (active) closeSession(active, "連線已結束。");
    };
window.addEventListener("pagehide", () => {
  if (active) closeSession(active, "連線已結束。");
});

const ime = $("ime"),
  anchor = "\u200b";
let composing = false;
function keyboard(on) {
  if (on && active?.sendInput) {
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
    active?.sendInput?.({ kind: "key", code, down });
}
function commitIME() {
  if (composing || ime.hidden) return;
  const text = ime.value.replace(anchor, "");
  if (!ime.value) special("Backspace");
  else if (text) {
    const letters = Array.from(text.replace(/[\x00-\x1f]/g, ""));
    while (letters.length)
      active?.sendInput?.({
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
