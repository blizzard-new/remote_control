"""Quartz input for one macOS display. All positions use global display points."""

import ctypes as ct
from pathlib import Path
import subprocess
import sys
from math import trunc
from time import monotonic


ACCESS_HINT = "請在 Mac 的「系統設定 → 隱私權與安全性 → 輔助使用」允許啟動主機的終端機或 Python，然後重新啟動主機。也可使用 --request-control 顯示系統授權提示。"

# Physical DOM positions mapped to the virtual key codes in Carbon Events.h.
# The current Mac input source determines the resulting characters.
KEY_CODES = {
    "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04,
    "KeyG": 0x05, "KeyZ": 0x06, "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09,
    "IntlBackslash": 0x0A, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E,
    "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11, "Digit1": 0x12, "Digit2": 0x13,
    "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17, "Equal": 0x18,
    "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C, "Digit0": 0x1D,
    "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21,
    "KeyI": 0x22, "KeyP": 0x23, "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26,
    "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29, "Backslash": 0x2A, "Comma": 0x2B,
    "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F, "Tab": 0x30,
    "Space": 0x31, "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35,
    "MetaRight": 0x36, "MetaLeft": 0x37, "ShiftLeft": 0x38, "CapsLock": 0x39,
    "AltLeft": 0x3A, "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D,
    "ControlRight": 0x3E, "Fn": 0x3F, "NumpadDecimal": 0x41, "NumpadMultiply": 0x43,
    "NumpadAdd": 0x45, "NumLock": 0x47, "NumpadDivide": 0x4B, "NumpadEnter": 0x4C,
    "NumpadSubtract": 0x4E, "NumpadEqual": 0x51, "Numpad0": 0x52, "Numpad1": 0x53,
    "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56, "Numpad5": 0x57,
    "Numpad6": 0x58, "Numpad7": 0x59, "Numpad8": 0x5B, "Numpad9": 0x5C,
    "IntlYen": 0x5D, "IntlRo": 0x5E, "NumpadComma": 0x5F, "Lang2": 0x66, "Lang1": 0x68,
    "Insert": 0x72, "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "End": 0x77,
    "PageDown": 0x79, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,
}
for n, code in enumerate((122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103,
                          111, 105, 107, 113, 106, 64, 79, 80, 90), 1):
    KEY_CODES[f"F{n}"] = code

MODIFIERS = {"Fn": 1 << 23}
for name, flag in (("Shift", 1 << 17), ("Control", 1 << 18), ("Alt", 1 << 19), ("Meta", 1 << 20)):
    MODIFIERS[name + "Left"] = MODIFIERS[name + "Right"] = flag

# Indexed by the browser's button: Quartz button, down event, up event, drag.
BUTTONS = ((0, 1, 2, 6), (2, 25, 26, 27), (1, 3, 4, 7))


class Point(ct.Structure):
    _fields_ = [("x", ct.c_double), ("y", ct.c_double)]


class Size(ct.Structure):
    _fields_ = [("width", ct.c_double), ("height", ct.c_double)]


class Rect(ct.Structure):
    _fields_ = [("origin", Point), ("size", Size)]


def _bind(lib, name, result, *arguments):
    function = getattr(lib, name)
    function.argtypes, function.restype = list(arguments), result
    return function


class Quartz:
    def __init__(self):
        cg = ct.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cf = ct.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        ref, uint, sint = ct.c_void_p, ct.c_uint32, ct.c_int32
        self._release = _bind(cf, "CFRelease", None, ref)
        self.has_access = _bind(cg, "CGPreflightPostEventAccess", ct.c_bool)
        self.request_access = _bind(cg, "CGRequestPostEventAccess", ct.c_bool)
        self._displays = _bind(cg, "CGGetActiveDisplayList", sint, uint, ct.POINTER(uint), ct.POINTER(uint))
        self._main = _bind(cg, "CGMainDisplayID", uint)
        self._bounds = _bind(cg, "CGDisplayBounds", Rect, uint)
        self._create = _bind(cg, "CGEventCreate", ref, ref)
        self._location = _bind(cg, "CGEventGetLocation", Point, ref)
        self._set_location = _bind(cg, "CGEventSetLocation", None, ref, Point)
        self._mouse = _bind(cg, "CGEventCreateMouseEvent", ref, ref, uint, Point, uint)
        self._key = _bind(cg, "CGEventCreateKeyboardEvent", ref, ref, ct.c_uint16, ct.c_bool)
        self._unicode = _bind(cg, "CGEventKeyboardSetUnicodeString", None, ref, ct.c_ulong, ct.POINTER(ct.c_uint16))
        # The non-variadic API uses the same ABI on Intel and Apple Silicon.
        self._wheel = _bind(cg, "CGEventCreateScrollWheelEvent2", ref, ref, uint, uint, sint, sint, sint)
        self._field = _bind(cg, "CGEventSetIntegerValueField", None, ref, uint, ct.c_int64)
        self._flags = _bind(cg, "CGEventGetFlags", ct.c_uint64, ref)
        self._set_flags = _bind(cg, "CGEventSetFlags", None, ref, ct.c_uint64)
        self._post = _bind(cg, "CGEventPost", None, uint, ref)

    def bounds(self, primary=False):
        displays, count = (ct.c_uint32 * 2)(), ct.c_uint32()
        if not primary and (self._displays(2, displays, ct.byref(count)) or count.value != 1):
            raise RuntimeError("Mac 的遠端操作需要單一啟用中的顯示器。")
        rect = self._bounds(self._main() if primary else displays[0])
        if rect.size.width < 1 or rect.size.height < 1:
            raise RuntimeError("無法讀取 Mac 顯示器的尺寸。")
        return rect.origin.x, rect.origin.y, int(rect.size.width), int(rect.size.height)

    def cursor(self):
        event = self._create(None)
        if not event:
            raise RuntimeError("無法取得 Mac 游標位置。")
        try:
            point = self._location(event)
            return point.x, point.y
        finally:
            self._release(event)

    def _emit(self, event, flags, *, clear=0, fields=(), position=None):
        if not event:
            raise RuntimeError("macOS 無法建立輸入事件。")
        try:
            self._set_flags(event, (self._flags(event) & ~clear) | flags)
            for field, value in fields:
                self._field(event, field, value)
            if position is not None:
                self._set_location(event, Point(*position))
            self._post(0, event)  # kCGHIDEventTap
        finally:
            self._release(event)

    def mouse(self, event_type, position, button, flags, click_count):
        event = self._mouse(None, event_type, Point(*position), button)
        self._emit(event, flags, fields=((1, click_count),))  # kCGMouseEventClickState

    def key(self, keycode, down, flags, clear, repeat):
        event = self._key(None, keycode, down)
        self._emit(event, flags, clear=clear, fields=((8, int(repeat)),))  # kCGKeyboardEventAutorepeat

    def text(self, value):
        # Keep supplementary characters together at Quartz's event boundary.
        for char in value:
            raw = char.encode("utf-16-le")
            units = (ct.c_uint16 * (len(raw)//2)).from_buffer_copy(raw)
            for down in (True,False):
                event = self._key(None,0,down)
                if not event: raise RuntimeError("無法建立文字輸入事件。")
                self._unicode(event,len(units),units)
                self._emit(event,0)

    def scroll(self, dx, dy, position, flags):
        # Pixel units, wheel 1 vertical / wheel 2 horizontal. Quartz positive
        # means up/left, while DOM positive scrolls the content down/right.
        self._emit(self._wheel(None, 0, 2, -dy, -dx, 0), flags, position=position)


class MacBackend:
    privacy_supported = False

    def __init__(self, quartz=None, *, primary_only=False):
        self.primary_only = primary_only
        self.quartz = quartz if quartz is not None else Quartz()
        self._keys = set()
        self._buttons = {}
        self._clicks = {}
        self._wheel_pixels = [0.0, 0.0]

    def request_control(self):
        if self.quartz.has_access() or self.quartz.request_access():
            return "Mac 已允許此主機傳送鍵鼠輸入。"
        return ACCESS_HINT

    def geometry(self):
        if not self.quartz.has_access():
            raise RuntimeError(ACCESS_HINT)
        self._display = self.quartz.bounds(primary=True) if self.primary_only else self.quartz.bounds()
        return self._display[2:]

    def _flags(self, keys):
        flags = 0
        for key in keys:
            flags |= MODIFIERS.get(key, 0)
        return flags

    def _position(self, event):
        if "x" not in event:
            return self.quartz.cursor()
        x, y, width, height = self._display
        return x + event["x"] * (width - 1), y + event["y"] * (height - 1)

    def _key(self, code, down):
        if code not in KEY_CODES or (not down and code not in self._keys):
            return
        repeat = down and code in self._keys
        next_keys = self._keys | {code} if down else self._keys - {code}
        self.quartz.key(KEY_CODES[code], down, self._flags(next_keys), MODIFIERS.get(code, 0), repeat)
        self._keys = next_keys

    def _button(self, button, down, position):
        if down == (button in self._buttons):
            return
        cg_button, press, release, _ = BUTTONS[button]
        if down:
            now = monotonic()
            last_time, (x, y), count = self._clicks.get(button, (-1, position, 0))
            close_to_last = max(abs(x - position[0]), abs(y - position[1])) <= 4
            count = count + 1 if now - last_time <= 0.45 and close_to_last else 1
            self.quartz.mouse(press, position, cg_button, self._flags(self._keys), count)
            self._buttons[button] = count
            self._clicks[button] = (now, position, count)
        else:
            self.quartz.mouse(release, position, cg_button, self._flags(self._keys), self._buttons[button])
            del self._buttons[button]

    def editable_focus(self):
        path = Path(getattr(sys,"_MEIPASS",Path(__file__).resolve().parents[1] / "build")) / "PrimaryDisplay"
        if not path.is_file(): return False
        try:
            return subprocess.run([str(path),"--editable"],capture_output=True,timeout=1.5).stdout.strip() == b"1"
        except (OSError,subprocess.TimeoutExpired):
            return False

    def apply(self, event):
        kind = event["kind"]
        if kind == "text":
            self.quartz.text(event["text"])
        elif kind == "key":
            self._key(event["code"], event["down"])
        elif kind == "button":
            self._button(event["button"], event["down"], self._position(event))
        elif kind == "move":
            held = next(reversed(self._buttons), None)
            button, event_type = (0, 5) if held is None else (BUTTONS[held][0], BUTTONS[held][3])
            self.quartz.mouse(event_type, self._position(event), button, self._flags(self._keys),
                              self._buttons.get(held, 0))
        elif kind == "wheel":
            total = [self._wheel_pixels[0] + event["dx"], self._wheel_pixels[1] + event["dy"]]
            dx, dy = (trunc(pixels) for pixels in total)
            if dx or dy:
                self.quartz.scroll(dx, dy, self._position(event), self._flags(self._keys))
            self._wheel_pixels[:] = [total[0] - dx, total[1] - dy]

    def release_all(self):
        failures = []
        for code in tuple(self._keys):
            try:
                self._key(code, False)
            except (RuntimeError, OSError) as exc:
                failures.append(exc)
        for button in tuple(self._buttons):
            try:
                self._button(button, False, self.quartz.cursor())
            except (RuntimeError, OSError) as exc:
                failures.append(exc)
        self._clicks.clear()
        self._wheel_pixels[:] = [0.0, 0.0]
        if failures:
            raise failures[0]
