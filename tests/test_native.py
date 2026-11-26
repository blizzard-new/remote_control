"""Wire validation and Win32 event encoding, including fractional trackpad input."""

import ctypes
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from PIL import Image

from native.desktop import Desktop, validate_event
from native.monitors import Monitor
from native.screen import _save_windows_screenshot
from native.windows import Input, WindowsBackend, windows_monitors


class WindowsScreenshotTests(unittest.TestCase):
    def test_saves_the_selected_screen_at_its_native_resolution(self):
        monitor = Monitor("hdmi", (-1024, 0, 0, 768))
        with TemporaryDirectory() as tmp, patch("native.screen._screenshots_folder", return_value=Path(tmp)), \
                patch("native.screen._windows_grab", return_value=Image.new("RGB", monitor.size, "#00fa7c")) as grab:
            filename = _save_windows_screenshot(monitor)
            grab.assert_called_once_with(monitor)
            with Image.open(Path(tmp) / filename) as screenshot:
                self.assertEqual((screenshot.format, screenshot.size), ("PNG", (1024, 768)))
                self.assertEqual(screenshot.getpixel((5, 5)), (0, 250, 124))

    @unittest.skipUnless(sys.platform == "win32" and os.environ.get("REMOTE_TEST_WINDOWS_CURTAIN") == "1",
                         "requires an opted-in interactive Windows desktop")
    def test_windows_captures_the_display_in_physical_pixels(self):
        monitor = windows_monitors()[0]
        with TemporaryDirectory() as tmp, patch("native.screen._screenshots_folder", return_value=Path(tmp)):
            filename = _save_windows_screenshot(monitor)
            with Image.open(Path(tmp) / filename) as screenshot:
                self.assertEqual((screenshot.format, screenshot.size), ("PNG", monitor.size))


class NativeInputTests(unittest.TestCase):
    def setUp(self):
        # Capture the generated INPUT records without touching a physical desktop.
        self.native = WindowsBackend.__new__(WindowsBackend)
        self.native._keys = set()
        self.native._buttons = set()
        self.native._wheel_pixels = [0.0, 0.0]
        self.records = []
        self.native._send = self.records.append

    def test_move_and_drag_release_use_win32_button_order(self):
        self.native.apply({"kind": "button", "button": 1, "down": True, "x": 1, "y": 0.5})
        self.native.release_all()
        mouse = [r.data.mouse for r in self.records]
        self.assertEqual([(m.flags, m.dx, m.dy) for m in mouse], [
            (0x8001, 65535, 32768), (0x20, 0, 0), (0x40, 0, 0),
        ])

    def test_fractional_wheel_persists_independently_in_both_directions(self):
        for _ in range(192):
            self.native.apply({"kind": "wheel", "dx": -0.25, "dy": 0.5})
        wheels = [(r.data.mouse.flags, ctypes.c_int32(r.data.mouse.data).value) for r in self.records]
        self.assertEqual(wheels, [(0x0800, -120), (0x1000, -120), (0x0800, -120)])
        self.native.apply({"kind": "wheel", "dx": 47, "dy": -47})
        self.native.release_all()
        self.native.apply({"kind": "wheel", "dx": 1, "dy": -1})
        self.assertEqual(len(self.records), 3)

    def test_revoke_releases_extended_keys_once(self):
        self.native.apply({"kind": "key", "code": "ControlRight", "down": True})
        self.native.apply({"kind": "key", "code": "ControlLeft", "down": False})
        self.native.release_all()
        self.native.release_all()
        self.assertEqual([(r.kind, r.data.keyboard.scan, r.data.keyboard.flags) for r in self.records],
                         [(1, 0x1D, 0x09), (1, 0x1D, 0x0B)])

    def test_invalid_input_is_rejected_before_native_calls(self):
        for event in (
            {"kind": "wheel", "dx": float("nan"), "dy": 0},
            {"kind": "wheel", "dx": 0, "dy": float("inf")},
            {"kind": "move", "x": False, "y": 0.2},
            {"kind": "button", "button": True, "down": True},
            {"kind": "button", "button": 0, "down": 1},
            {"kind": "button", "button": 0, "down": True, "x": 0.5},
            {"kind": "key", "code": None, "down": True},
            {"kind": "key", "code": "KeyW", "down": True, "x": 0.5},
            {"kind": "release-all"},
        ):
            with self.subTest(event=event), self.assertRaises(ValueError):
                validate_event(event)

    def test_unsupported_or_changed_desktop_denies_control_and_privacy(self):
        host = Desktop.__new__(Desktop)
        host._backend = Mock(privacy_supported=True)
        host._backend.geometry.side_effect = RuntimeError("display changed")
        self.assertFalse(host.capabilities["control"])
        self.assertFalse(host.capabilities["privacy"])
        with self.assertRaises(RuntimeError):
            host.apply({"kind": "move", "x": 0, "y": 0})
        with self.assertRaises(RuntimeError):
            host.set_privacy(True)
        host.set_privacy(False)
        host.apply({"kind": "release"})
        host._backend.set_privacy.assert_called_once_with(False)
        host._backend.apply.assert_not_called()
        host._backend.release_all.assert_called()

    def test_win32_input_size(self):
        self.assertEqual(ctypes.sizeof(Input), 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28)

    def test_windows_pointer_targets_left_monitor_in_virtual_desktop(self):
        self.native.user = Mock()
        self.native.user.GetSystemMetrics.side_effect = {76: -1280, 77: 0, 78: 3200, 79: 1080}.__getitem__
        hdmi = Monitor("DISPLAY2", (-1280, 0, 0, 720))
        self.native.apply({"kind": "move", "x": 0, "y": 0}, hdmi)
        self.native.apply({"kind": "move", "x": 1, "y": 1}, hdmi)
        first, second = [record.data.mouse for record in self.records]
        self.assertEqual((first.flags, first.dx, first.dy), (0xC001, 0, 0))
        self.assertEqual((second.dx * 3200 // 65536, second.dy * 1080 // 65536), (1279, 719))

    @unittest.skipUnless(sys.platform == "win32", "Windows ABI")
    def test_win32_overlay_layout(self):
        from native.win_curtain import Message, WindowClass
        win64 = ctypes.sizeof(ctypes.c_void_p) == 8
        self.assertEqual(ctypes.sizeof(WindowClass), 72 if win64 else 40)
        self.assertEqual(ctypes.sizeof(Message), 48 if win64 else 32)
