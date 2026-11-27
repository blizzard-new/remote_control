"""Host input for one local X11 screen. Browser wheel units are CSS pixels."""

import ctypes as C
import os
import re
import subprocess
from .monitors import Monitor


# DOM code and XKB key names both describe physical positions on the keyboard.
# Looking up XKB names preserves the host's layout, including non-QWERTY layouts.
_KEY_NAMES = {
    "Backquote": "TLDE", "Minus": "AE11", "Equal": "AE12", "Backspace": "BKSP",
    "BracketLeft": "AD11", "BracketRight": "AD12", "Backslash": "BKSL",
    "Semicolon": "AC10", "Quote": "AC11", "Comma": "AB08", "Period": "AB09",
    "Slash": "AB10", "IntlBackslash": "LSGT", "IntlRo": "AB11", "IntlYen": "AE13",
    "Escape": "ESC", "Tab": "TAB", "Enter": "RTRN", "Space": "SPCE",
    "CapsLock": "CAPS", "ShiftLeft": "LFSH", "ShiftRight": "RTSH",
    "ControlLeft": "LCTL", "ControlRight": "RCTL", "AltLeft": "LALT",
    "AltRight": "RALT", "MetaLeft": "LWIN", "MetaRight": "RWIN", "ContextMenu": "COMP",
    "Insert": "INS", "Delete": "DELE", "Home": "HOME", "End": "END",
    "PageUp": "PGUP", "PageDown": "PGDN", "ArrowUp": "UP", "ArrowDown": "DOWN",
    "ArrowLeft": "LEFT", "ArrowRight": "RGHT", "NumLock": "NMLK", "Pause": "PAUS",
    "PrintScreen": "PRSC", "ScrollLock": "SCLK", "NumpadDivide": "KPDV",
    "NumpadMultiply": "KPMU", "NumpadSubtract": "KPSU", "NumpadAdd": "KPAD",
    "NumpadDecimal": "KPDL", "NumpadEnter": "KPEN", "NumpadEqual": "KPEQ",
}
for row, letters in (("AD", "QWERTYUIOP"), ("AC", "ASDFGHJKL"), ("AB", "ZXCVBNM")):
    _KEY_NAMES.update({f"Key{key}": f"{row}{i:02d}" for i, key in enumerate(letters, 1)})
_KEY_NAMES.update({f"Digit{d}": f"AE{i:02d}" for i, d in enumerate("1234567890", 1)})
_KEY_NAMES.update({f"Numpad{i}": f"KP{i}" for i in range(10)})
_KEY_NAMES.update({f"F{i}": f"FK{i:02d}" for i in range(1, 25)})

_DISPLAY = C.c_void_p
_INT = C.c_int
_INT_PTR = C.POINTER(_INT)
_UINT = C.c_uint
_ULONG = C.c_ulong


class _Monitor(C.Structure):
    _fields_ = [
        ("name", _ULONG), ("primary", _INT), ("automatic", _INT), ("noutput", _INT),
        ("x", _INT), ("y", _INT), ("width", _INT), ("height", _INT),
        ("mwidth", _INT), ("mheight", _INT), ("outputs", C.POINTER(_ULONG)),
    ]


def _bind(lib, name, result, *args):
    function = getattr(lib, name)
    function.restype, function.argtypes = result, args


def _keycodes(display_name):
    try:
        compiled = subprocess.run(["xkbcomp", "-w", "0", "-xkb", display_name, "-"],
                                  capture_output=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError("需要 xkbcomp 讀取本機 X11 鍵盤配置") from error
    entries = re.findall(rb"^\s*<([^>]+)>\s*=\s*(\d+);", compiled.stdout, re.MULTILINE)
    codes = {name.decode("ascii"): int(code) for name, code in entries if 8 <= int(code) <= 255}
    if not codes:
        raise RuntimeError("X11 鍵盤配置缺少實體鍵碼")
    return {dom: codes[name] for dom, name in _KEY_NAMES.items() if name in codes}


class X11Backend:
    privacy_supported = False

    def __init__(self, *, extended=False):
        self.extended = extended
        display_name = os.environ.get("DISPLAY")
        if not display_name or os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland":
            raise RuntimeError("遠端輸入需要原生 X11 工作階段")
        self.x = C.CDLL("libX11.so.6")
        self.xt = C.CDLL("libXtst.so.6")
        self.rr = C.CDLL("libXrandr.so.2")
        _bind(self.x, "XOpenDisplay", _DISPLAY, C.c_char_p)
        _bind(self.x, "XCloseDisplay", _INT, _DISPLAY)
        _bind(self.x, "XScreenCount", _INT, _DISPLAY)
        _bind(self.x, "XDefaultScreen", _INT, _DISPLAY)
        _bind(self.x, "XRootWindow", _ULONG, _DISPLAY, _INT)
        _bind(self.x, "XGetGeometry", _INT, _DISPLAY, _ULONG, C.POINTER(_ULONG),
              _INT_PTR, _INT_PTR, *(C.POINTER(_UINT),) * 4)
        _bind(self.x, "XQueryExtension", _INT, _DISPLAY, C.c_char_p, *(_INT_PTR,) * 3)
        _bind(self.x, "XFlush", _INT, _DISPLAY)
        _bind(self.xt, "XTestQueryExtension", _INT, _DISPLAY, *(_INT_PTR,) * 4)
        _bind(self.xt, "XTestFakeMotionEvent", _INT, _DISPLAY, _INT, _INT, _INT, _ULONG)
        _bind(self.xt, "XTestFakeKeyEvent", _INT, _DISPLAY, _UINT, _INT, _ULONG)
        _bind(self.xt, "XTestFakeButtonEvent", _INT, _DISPLAY, _UINT, _INT, _ULONG)
        _bind(self.rr, "XRRQueryVersion", _INT, _DISPLAY, _INT_PTR, _INT_PTR)
        try:
            _bind(self.rr, "XRRGetMonitors", C.POINTER(_Monitor), _DISPLAY, _ULONG, _INT, _INT_PTR)
        except AttributeError as error:
            raise RuntimeError("需要 RandR 1.5 以上版本") from error
        _bind(self.rr, "XRRFreeMonitors", None, C.POINTER(_Monitor))

        self.display = self.x.XOpenDisplay(os.fsencode(display_name))
        if not self.display:
            raise RuntimeError("無法開啟 X11 顯示器")
        self.keys, self.buttons = set(), set()
        self.remainder = [0.0, 0.0]
        try:
            scratch = [_INT() for _ in range(4)]
            args = [C.byref(value) for value in scratch]
            if self.x.XQueryExtension(self.display, b"XWAYLAND", *args[:3]):
                raise RuntimeError("XWayland 無法控制整個 Wayland 桌面")
            if not self.xt.XTestQueryExtension(self.display, *args):
                raise RuntimeError("需要 XTEST 擴充功能")
            if not self.rr.XRRQueryVersion(self.display, *args[:2]) or (scratch[0].value, scratch[1].value) < (1, 5):
                raise RuntimeError("需要 RandR 1.5 以上版本")
            self.screen = self.x.XDefaultScreen(self.display)
            self.root = self.x.XRootWindow(self.display, self.screen)
            self.geometry()
            self.keycodes = _keycodes(display_name)
        except Exception:
            self.close()
            raise

    def geometry(self):
        monitors = self.monitors()
        if not monitors or (not self.extended and len(monitors) != 1):
            raise RuntimeError("遠端輸入需要至少一個可用的 X11 顯示器")
        self.size = monitors[0].size
        return self.size

    def monitors(self):
        if not self.display or self.x.XScreenCount(self.display) != 1:
            raise RuntimeError("遠端輸入需要單一 X11 螢幕")
        count = _INT()
        monitors = self.rr.XRRGetMonitors(self.display, self.root, True, C.byref(count))
        if not monitors:
            raise RuntimeError("無法取得 X11 螢幕配置")
        try:
            found = [Monitor(str(monitor.name),
                             (monitor.x, monitor.y, monitor.x + monitor.width, monitor.y + monitor.height),
                             bool(monitor.primary))
                     for monitor in monitors[:count.value] if monitor.noutput == 1]
        finally:
            self.rr.XRRFreeMonitors(monitors)
        root, x, y = _ULONG(), _INT(), _INT()
        size = [_UINT() for _ in range(4)]  # width, height, border, depth
        valid = self.x.XGetGeometry(self.display, self.root, C.byref(root), C.byref(x), C.byref(y),
                                    *(C.byref(value) for value in size))
        width, height = size[0].value, size[1].value
        if not valid or not found or any(
            not (0 <= m.bounds[0] < m.bounds[2] <= width and 0 <= m.bounds[1] < m.bounds[3] <= height)
            for m in found
        ) or (not self.extended and (len(found) != 1 or found[0].bounds != (0, 0, width, height))):
            raise RuntimeError("X11 虛擬桌面與顯示器座標不符")
        return sorted(found, key=lambda m: (not m.primary, m.bounds[0], m.bounds[1]))

    def _edge(self, emit, held, code, down):
        if down == (code in held):
            return
        if not emit(self.display, code, down, 0):
            raise RuntimeError("XTEST 無法傳送輸入事件")
        if down:
            held.add(code)
        else:
            held.remove(code)

    def apply(self, event, monitor=None):
        # Desktop.apply validates the event and refreshes geometry before dispatch.
        kind = event["kind"]
        if kind == "release":
            self.release_all()
            return
        if "x" in event:
            width, height = self.size
            target = monitor or Monitor("", (0, 0, width, height))
            x, y = target.position(event["x"], event["y"])
            if not self.xt.XTestFakeMotionEvent(self.display, self.screen, x, y, 0):
                raise RuntimeError("XTEST 無法移動游標")
        if kind == "button":
            self._edge(self.xt.XTestFakeButtonEvent, self.buttons, event["button"] + 1, event["down"])
        elif kind == "key":
            code = self.keycodes.get(event["code"])
            if code is None:
                raise ValueError("此 X11 鍵盤不支援該按鍵")
            self._edge(self.xt.XTestFakeKeyEvent, self.keys, code, event["down"])
        elif kind == "wheel":
            # Accumulate high-resolution touchpad deltas before emitting X11 wheel clicks.
            for i, (axis, negative, positive) in enumerate((("dx", 6, 7), ("dy", 4, 5))):
                pixels = self.remainder[i] + event[axis]
                ticks = int(pixels / 48)
                self.remainder[i] = pixels - ticks * 48
                button = positive if ticks > 0 else negative
                for _ in range(abs(ticks)):
                    self._edge(self.xt.XTestFakeButtonEvent, self.buttons, button, True)
                    self._edge(self.xt.XTestFakeButtonEvent, self.buttons, button, False)
        self.x.XFlush(self.display)

    def release_all(self):
        if self.display:
            failure = None
            for emit, held in ((self.xt.XTestFakeKeyEvent, self.keys),
                               (self.xt.XTestFakeButtonEvent, self.buttons)):
                for code in tuple(held):
                    try:
                        self._edge(emit, held, code, False)
                    except RuntimeError as error:
                        failure = error
            self.remainder = [0.0, 0.0]
            self.x.XFlush(self.display)
            if failure:
                raise failure

    def close(self):
        if self.display:
            try:
                self.release_all()
            finally:
                self.x.XCloseDisplay(self.display)
                self.display = None
