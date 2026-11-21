"""Win32 SendInput adapter for a single interactive monitor."""

import ctypes as ct
import math
import sys
from pathlib import Path

from ctypes import wintypes as wt


# PC keyboard scan codes. Extended keys have the E0 prefix encoded as bit 8.
SCAN_CODES = {
    "Escape": 0x01, "Minus": 0x0C, "Equal": 0x0D, "Backspace": 0x0E, "Tab": 0x0F,
    "BracketLeft": 0x1A, "BracketRight": 0x1B, "Enter": 0x1C, "ControlLeft": 0x1D,
    "Semicolon": 0x27, "Quote": 0x28, "Backquote": 0x29, "ShiftLeft": 0x2A,
    "Backslash": 0x2B, "Comma": 0x33, "Period": 0x34, "Slash": 0x35, "ShiftRight": 0x36,
    "NumpadMultiply": 0x37, "AltLeft": 0x38, "Space": 0x39, "CapsLock": 0x3A,
    "NumLock": 0x45, "ScrollLock": 0x46, "Numpad7": 0x47, "Numpad8": 0x48, "Numpad9": 0x49,
    "NumpadSubtract": 0x4A, "Numpad4": 0x4B, "Numpad5": 0x4C, "Numpad6": 0x4D,
    "NumpadAdd": 0x4E, "Numpad1": 0x4F, "Numpad2": 0x50, "Numpad3": 0x51,
    "Numpad0": 0x52, "NumpadDecimal": 0x53, "IntlBackslash": 0x56, "F11": 0x57, "F12": 0x58,
    "NumpadEnter": 0x11C, "ControlRight": 0x11D, "NumpadDivide": 0x135, "AltRight": 0x138,
    "Home": 0x147, "ArrowUp": 0x148, "PageUp": 0x149, "ArrowLeft": 0x14B, "ArrowRight": 0x14D,
    "End": 0x14F, "ArrowDown": 0x150, "PageDown": 0x151, "Insert": 0x152, "Delete": 0x153,
    "MetaLeft": 0x15B, "MetaRight": 0x15C, "ContextMenu": 0x15D,
}
for first, row in ((0x10, "QWERTYUIOP"), (0x1E, "ASDFGHJKL"), (0x2C, "ZXCVBNM")):
    SCAN_CODES.update({f"Key{char}": first + index for index, char in enumerate(row)})
SCAN_CODES.update({f"Digit{digit}": 2 + index for index, digit in enumerate("1234567890")})
SCAN_CODES.update({f"F{i}": 0x3A + i for i in range(1, 11)})


class MouseInput(ct.Structure):
    _fields_ = [
        ("dx", ct.c_int32), ("dy", ct.c_int32), ("data", ct.c_uint32),
        ("flags", ct.c_uint32), ("time", ct.c_uint32), ("extra", ct.c_size_t),
    ]


class KeyboardInput(ct.Structure):
    _fields_ = [
        ("vk", ct.c_uint16), ("scan", ct.c_uint16), ("flags", ct.c_uint32),
        ("time", ct.c_uint32), ("extra", ct.c_size_t),
    ]


class InputData(ct.Union):
    _fields_ = [("mouse", MouseInput), ("keyboard", KeyboardInput)]


class Input(ct.Structure):
    _fields_ = [("kind", ct.c_uint32), ("data", InputData)]


class WindowsBackend:
    def __init__(self, *, primary_only=False):
        self.primary_only = primary_only
        from .win_curtain import PrivacyCurtain

        self.user = ct.WinDLL("user32", use_last_error=True)
        self.user.SendInput.argtypes = [wt.UINT, ct.POINTER(Input), ct.c_int]
        self.user.SendInput.restype = wt.UINT
        # Ask for physical pixel dimensions even when display scaling is enabled.
        if hasattr(self.user, "SetThreadDpiAwarenessContext"):
            self.user.SetThreadDpiAwarenessContext.argtypes = [ct.c_void_p]
            self.user.SetThreadDpiAwarenessContext.restype = ct.c_void_p
            self.user.SetThreadDpiAwarenessContext(ct.c_void_p(-4))
        self._keys = set()
        self._buttons = set()
        self._wheel_pixels = [0.0, 0.0]
        self.privacy_supported = sys.getwindowsversion().build >= 19041 and not primary_only
        self._curtain = PrivacyCurtain()

    def editable_focus(self):
        path = Path(getattr(sys,"_MEIPASS",Path(__file__).resolve().parents[1] / "build/focus/Release")) / "EditableFocus.dll"
        if not path.is_file(): return False
        return bool(ct.WinDLL(str(path)).IsEditableFocus())

    def geometry(self):
        if not self.primary_only and self.user.GetSystemMetrics(80) != 1:  # SM_CMONITORS
            raise RuntimeError("遠端控制需要一台啟用的螢幕")
        return self.user.GetSystemMetrics(0), self.user.GetSystemMetrics(1)

    def _send(self, value):
        if self.user.SendInput(1, ct.byref(value), ct.sizeof(Input)) != 1:
            raise OSError("Windows 未允許此輸入。請確認目前使用一般桌面與相同權限的應用程式。")

    def _mouse(self, flags, data=0, x=0, y=0):
        self._send(Input(0, InputData(mouse=MouseInput(x, y, data, flags, 0, 0))))

    def _button(self, button, down):
        down_flag, up_flag = ((0x02, 0x04), (0x20, 0x40), (0x08, 0x10))[button]
        if down and button not in self._buttons:
            self._mouse(down_flag)
            self._buttons.add(button)
        elif not down and button in self._buttons:
            self._mouse(up_flag)
            self._buttons.discard(button)

    def _key(self, code, down):
        scan = SCAN_CODES.get(code)
        if scan is None:
            return  # The browser can send platform-specific physical key codes.
        if not down and code not in self._keys:
            return
        flags = 0x08 | (0x01 if scan & 0x100 else 0) | (0 if down else 0x02)
        self._send(Input(1, InputData(keyboard=KeyboardInput(0, scan & 0xFF, flags, 0, 0))))
        if down:
            self._keys.add(code)
        else:
            self._keys.discard(code)

    def _scroll(self, axis, pixels):
        # A conventional wheel notch scrolls about three 16px lines. Buffer each
        # axis so apps receiving WM_MOUSEWHEEL always see complete WHEEL_DELTAs.
        total = self._wheel_pixels[axis] + pixels
        notches = math.trunc(total / 48)
        if notches:
            # Win32 positive vertical values mean up. Browser positive means down.
            self._mouse(0x1000 if axis == 0 else 0x0800, notches * (120 if axis == 0 else -120))
        self._wheel_pixels[axis] = total - notches * 48

    def apply(self, event):
        kind = event["kind"]
        if kind in ("move", "button", "wheel") and "x" in event:
            self._mouse(0x8001, x=round(event["x"] * 65535), y=round(event["y"] * 65535))
        if kind == "button":
            self._button(event["button"], event["down"])
        elif kind == "text":
            raw = event["text"].encode("utf-16-le")
            for pos in range(0,len(raw),2):
                unit = int.from_bytes(raw[pos:pos+2],"little")
                for flags in (4,6):
                    self._send(Input(1, InputData(keyboard=KeyboardInput(0,unit,flags,0,0))))
        elif kind == "key":
            self._key(event["code"], event["down"])
        elif kind == "wheel":
            self._scroll(0, event["dx"])
            self._scroll(1, event["dy"])

    def release_all(self):
        failures = []
        for code in tuple(self._keys):
            try:
                self._key(code, False)
            except OSError as exc:
                failures.append(exc)
        for button in tuple(self._buttons):
            try:
                self._button(button, False)
            except OSError as exc:
                failures.append(exc)
        self._wheel_pixels[:] = [0.0, 0.0]
        if failures:
            raise failures[0]

    @property
    def privacy_enabled(self):
        return self._curtain.active

    def set_privacy(self, enabled):
        if enabled:
            self._curtain.show()
        else:
            self._curtain.close()
