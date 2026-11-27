const legacyStorage = "rc-paired-devices-v1";
export async function devices(token, action = "list", item = {}) {
  if (window.PhoneDevices)
    return JSON.parse(window.PhoneDevices.update(action, JSON.stringify(item)));
  if (token) {
    const response = await fetch("/api/paired", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Host-Token": token },
      body: JSON.stringify({ action, item }),
    });
    if (!response.ok && response.status !== 404 && response.status !== 405)
      throw Error("無法儲存配對裝置。");
    if (response.ok) return response.json();
  }
  if (action === "self") return null;
  let list = JSON.parse(localStorage.getItem(legacyStorage) || "[]");
  if (action === "identify") {
    const index = list.findIndex(
      (p) =>
        p.listen === item.listen &&
        p.dial === item.dial &&
        p.address === item.address,
    );
    if (index < 0) throw Error("找不到配對紀錄。");
    list[index] = { ...list[index], name: item.name, platform: item.platform };
    localStorage.setItem(legacyStorage, JSON.stringify(list));
  } else if (action !== "list") {
    list = list.filter((p) => p.listen !== item.listen);
    if (action === "save") {
      if (list.length >= 16) throw Error("請先解除舊裝置的配對。");
      list.push(item);
    }
    localStorage.setItem(legacyStorage, JSON.stringify(list));
  }
  return list;
}
