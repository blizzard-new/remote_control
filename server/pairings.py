"""Private per-user device pairings shared by this launcher's loopback ports."""
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
    else:
        root = Path.home() / "Library/Application Support" if sys.platform == "darwin" else Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    return root / "RemoteControlHost" / "devices.sqlite3"


def update(path, action, item):
    if action not in {"list", "save", "forget"} or not isinstance(item, dict):
        raise ValueError("裝置資料無效")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(fd)
    db = sqlite3.connect(path, timeout=4)
    try:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS devices (listen TEXT PRIMARY KEY, dial TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL)")
            if action != "list":
                listen = item.get("listen")
                if not isinstance(listen,str) or not KEY.fullmatch(listen):
                    raise ValueError("配對金鑰無效")
                if action == "forget":
                    db.execute("DELETE FROM devices WHERE listen=?", (listen,))
                else:
                    dial, name, address = (item.get(k) for k in ("dial", "name", "address"))
                    if not all(isinstance(x,str) for x in (dial,name,address)) or not KEY.fullmatch(dial) or not 1 <= len(name.strip()) <= 64 or len(address)>512:
                        raise ValueError("裝置資料無效")
                    u = urlsplit(address)
                    if not u.hostname or u.username or u.password or u.query or u.fragment or not (u.scheme=="https" or (u.scheme=="http" and u.hostname in ("127.0.0.1","localhost","::1"))):
                        raise ValueError("服務網址無效")
                    db.execute("BEGIN IMMEDIATE")
                    if not db.execute("SELECT 1 FROM devices WHERE listen=?", (listen,)).fetchone() and db.execute("SELECT count(*) FROM devices").fetchone()[0] >= 16:
                        raise ValueError("最多可記住 16 台裝置，請先解除舊配對")
                    db.execute("INSERT OR REPLACE INTO devices VALUES (?,?,?,?)",(listen,dial,name.strip(),address))
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM devices ORDER BY name")]
    finally:
        db.close()
