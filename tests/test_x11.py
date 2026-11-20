"""Exercise native input against an isolated X server, when Xvfb is installed."""

import ctypes as C
import os
import select
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

from native.x11 import X11Backend


class ButtonEvent(C.Structure):
    # Prefix of XButtonEvent, padded to the size of the XEvent union in the caller.
    _fields_ = [
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
        ("display", C.c_void_p), ("window", C.c_ulong), ("root", C.c_ulong),
        ("subwindow", C.c_ulong), ("time", C.c_ulong), ("x", C.c_int), ("y", C.c_int),
        ("x_root", C.c_int), ("y_root", C.c_int), ("state", C.c_uint), ("button", C.c_uint),
    ]


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("Xvfb") and shutil.which("xkbcomp"),
                     "requires Linux, Xvfb and xkbcomp")
class X11InputTest(unittest.TestCase):
    def setUp(self):
        reader, writer = os.pipe()
        self.server = subprocess.Popen(
            ["Xvfb", "-displayfd", str(writer), "-nolisten", "tcp", "-screen", "0", "800x600x24"],
            pass_fds=(writer,), stdout=subprocess.DEVNULL,
        )
        os.close(writer)
        self.addCleanup(self.stop_server)
        with os.fdopen(reader, "rb") as ready:
            self.assertTrue(select.select([ready], [], [], 10)[0], "Xvfb startup timed out")
            number = ready.readline().strip()
        self.assertTrue(number.isdigit(), "Xvfb could not open an isolated display")
        with patch.dict(os.environ, {"DISPLAY": ":" + number.decode(), "WAYLAND_DISPLAY": "",
                                     "XDG_SESSION_TYPE": "x11"}):
            self.backend = X11Backend()
        self.addCleanup(self.backend.close)
        self.x = self.backend.x
        self.display = self.backend.display
        self.x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
        self.x.XSync.argtypes = [C.c_void_p, C.c_int]
        self.x.XPending.argtypes = [C.c_void_p]
        self.x.XNextEvent.argtypes = [C.c_void_p, C.c_void_p]
        self.x.XQueryKeymap.argtypes = [C.c_void_p, C.c_void_p]
        # Subscribe to ButtonPress and ButtonRelease on the empty root window.
        self.x.XSelectInput(self.display, self.backend.root, (1 << 2) | (1 << 3))

    def stop_server(self):
        self.server.terminate()
        try:
            self.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait()

    def button_events(self):
        self.x.XSync(self.display, False)
        result = []
        event = (C.c_long * 24)()
        while self.x.XPending(self.display):
            self.x.XNextEvent(self.display, event)
            value = ButtonEvent.from_buffer(event)
            if value.type in (4, 5):
                result.append((value.type, value.button, value.x_root, value.y_root))
        return result

    def key_is_down(self, code):
        bitmap = (C.c_ubyte * 32)()
        self.x.XQueryKeymap(self.display, bitmap)
        return bool(bitmap[code // 8] & (1 << (code % 8)))

    def test_real_x_events_and_disconnect_cleanup(self):
        self.assertEqual(self.backend.geometry(), (800, 600))
        self.assertFalse(self.backend.privacy_supported)
        self.backend.apply({"kind": "key", "code": "ShiftLeft", "down": True})
        self.assertTrue(self.key_is_down(self.backend.keycodes["ShiftLeft"]))
        self.backend.apply({"kind": "button", "x": 1, "y": 0, "button": 2, "down": True})
        self.assertEqual(self.button_events(), [(4, 3, 799, 0)])
        self.backend.release_all()
        self.assertFalse(self.key_is_down(self.backend.keycodes["ShiftLeft"]))
        self.assertEqual(self.button_events(), [(5, 3, 799, 0)])
        self.backend.release_all()
        self.assertEqual(self.button_events(), [])

        scroll = {"kind": "wheel", "x": 0, "y": 1, "dx": -12, "dy": 12}
        for _ in range(3):
            self.backend.apply(scroll)
        self.assertEqual(self.button_events(), [])
        self.backend.apply(scroll)
        self.assertEqual(self.button_events(), [
            (4, 6, 0, 599), (5, 6, 0, 599), (4, 5, 0, 599), (5, 5, 0, 599),
        ])

        self.backend.apply(scroll)
        self.backend.release_all()
        self.backend.apply({"kind": "wheel", "dx": -36, "dy": 36})
        self.assertEqual(self.button_events(), [])


if __name__ == "__main__":
    unittest.main()
