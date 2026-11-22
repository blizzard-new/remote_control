"""Per-user device pairings shared by this launcher's loopback ports."""
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import urlsplit

KEY = re.compile(r"[A-Za-z0-9_-]{32}")


def device_store():
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    elif sys.platform == "darwin":
        root = Path.home() / "Library/Application Support"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return root / "RemoteControlHost" / "devices.sqlite3"


def save(db, listen, item, identify):
    dial, name, address = (item.get(k) for k in ("dial", "name", "address"))
    if not isinstance(dial, str) or not KEY.fullmatch(dial):
        raise ValueError("配對金鑰無效")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
        raise ValueError("裝置名稱無效")
    if not isinstance(address, str) or len(address) > 512:
        raise ValueError("服務網址無效")
    url = urlsplit(address)
    local = url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")
    if not url.hostname or url.username or url.password or url.query or url.fragment or (url.scheme != "https" and not local):
        raise ValueError("服務網址無效")
    grant = item.get("grant", "")
    if grant not in ("","view","control"): raise ValueError("無效的裝置權限")
    exists = db.execute("SELECT dial,address,grant_mode FROM devices WHERE listen=?", (listen,)).fetchone()
    if identify:
        if not exists or exists[:2] != (dial, address):
            raise ValueError("找不到配對紀錄")
        grant = exists[2]
    if not exists and db.execute("SELECT count(*) FROM devices").fetchone()[0] >= 16:
        raise ValueError("最多可記住 16 台裝置，請先解除舊配對")
    platform = item.get("platform", "")
    if platform not in ("Windows", "Darwin", "Linux", "Android", "browser"):
        platform = ""
    db.execute("INSERT OR REPLACE INTO devices (listen,dial,name,address,grant_mode,platform) VALUES (?,?,?,?,?,?)",
               (listen, dial, name.strip(), address, grant, platform))


def update(path, action, item):
    if not isinstance(action, str) or action not in {"list", "save", "identify", "forget"} or not isinstance(item, dict):
        raise ValueError("裝置資料無效")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(fd)
    db = sqlite3.connect(path, timeout=4)
    try:
        with db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""CREATE TABLE IF NOT EXISTS devices (
                listen TEXT PRIMARY KEY, dial TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL
            )""")
            columns = {row[1] for row in db.execute("PRAGMA table_info(devices)")}
            if "platform" not in columns:
                db.execute("ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT ''")
            if "grant_mode" not in columns:
                db.execute("ALTER TABLE devices ADD COLUMN grant_mode TEXT NOT NULL DEFAULT ''")
            if action != "list":
                listen = item.get("listen")
                if not isinstance(listen, str) or not KEY.fullmatch(listen):
                    raise ValueError("配對金鑰無效")
                if action == "forget":
                    db.execute("DELETE FROM devices WHERE listen=?", (listen,))
                else:
                    save(db, listen, item, action == "identify")
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT listen,dial,name,address,platform,grant_mode AS [grant] FROM devices ORDER BY name")]
    finally:
        db.close()
