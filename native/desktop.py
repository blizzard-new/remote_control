"""Native capabilities for a host with one physical desktop display."""

import sys


def _number(value, lower, upper):
    # Bounds also reject NaN and infinity. A JSON boolean is not a coordinate.
    return type(value) in (int, float) and lower <= value <= upper


def validate_event(event):
    if not isinstance(event, dict):
        raise ValueError("輸入事件格式錯誤")
    kind = event.get("kind")
    if kind not in ("move", "button", "wheel", "key", "release"):
        raise ValueError("不支援的輸入事件")
    if kind == "move" or "x" in event or "y" in event:
        if kind not in ("move", "button", "wheel") or not all(_number(event.get(axis), 0, 1) for axis in ("x", "y")):
            raise ValueError("游標超出分享畫面")
    if kind in ("key", "button") and type(event.get("down")) is not bool:
        raise ValueError("缺少按下或放開的狀態")
    if kind == "button" and (type(event.get("button")) is not int or event["button"] not in (0, 1, 2)):
        raise ValueError("不支援的滑鼠按鈕")
    if kind == "key" and (not isinstance(event.get("code"), str) or not 1 <= len(event["code"]) <= 32):
        raise ValueError("鍵盤代碼錯誤")
    if kind == "wheel" and not all(_number(event.get(axis), -8192, 8192) for axis in ("dx", "dy")):
        raise ValueError("捲動幅度超出範圍")


class Desktop:
    def __init__(self, *, primary_only=False):
        self._backend = None
        self._failure = ""
        try:
            if sys.platform == "win32":
                from .windows import WindowsBackend
                self._backend = WindowsBackend(primary_only=primary_only)
            elif sys.platform == "darwin":
                from .macos import MacBackend
                self._backend = MacBackend(primary_only=primary_only)
            elif sys.platform.startswith("linux"):
                from .x11 import X11Backend
                self._backend = X11Backend()
        except (AttributeError, ImportError, OSError, RuntimeError) as exc:
            # Video sharing still works without a usable native desktop.
            self._failure = str(exc)

    @property
    def capabilities(self):
        hint = getattr(self, "_failure", "")
        try:
            width, height = self._backend.geometry() if self._backend else (0, 0)
        except (RuntimeError, OSError) as exc:
            width, height = 0, 0
            hint = str(exc)
        result = {
            "control": width > 0 and height > 0,
            "privacy": width > 0 and height > 0 and bool(getattr(self._backend, "privacy_supported", False)),
            "width": width,
            "height": height,
        }
        if hint and not result["control"]:
            result["controlHint"] = hint
        return result

    def request_control(self):
        if hasattr(self._backend, "request_control"):
            return self._backend.request_control()
        return (getattr(self, "_failure", "") or "此平台無需透過系統提示要求遠端輸入權限。")

    @property
    def privacy_enabled(self):
        return bool(getattr(self._backend, "privacy_enabled", False))

    def apply(self, event):
        validate_event(event)
        if event["kind"] == "release":
            self.release()
            return
        if not self.capabilities["control"]:
            self.release()
            raise RuntimeError("遠端輸入需要支援的單螢幕桌面")
        self._backend.apply(event)

    def release(self):
        if self._backend is not None:
            self._backend.release_all()

    def set_privacy(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("隱私模式狀態錯誤")
        if enabled and not self.capabilities["privacy"]:
            raise RuntimeError("此桌面無法啟用隱私模式")
        if getattr(self._backend, "privacy_supported", False):
            self._backend.set_privacy(enabled)
