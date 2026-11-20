"""Opt-in Windows display tests. The lifecycle test briefly covers the desktop."""

import ctypes as ct
from ctypes import wintypes as wt
import os
import subprocess
import sys
import time
import unittest


@unittest.skipUnless(sys.platform == "win32" and os.getenv("REMOTE_TEST_WINDOWS_CURTAIN") == "1",
                     "requires an opted-in interactive Windows desktop")
class WindowsCurtainTests(unittest.TestCase):
    def setUp(self):
        from native.desktop import Desktop
        from native.win_curtain import _function

        self.host = Desktop()
        if not self.host.capabilities["privacy"]:
            self.skipTest("requires Windows build 19041+ and one active display")
        user = ct.WinDLL("user32", use_last_error=True)
        desktop = _function(user, "OpenInputDesktop", wt.HANDLE, wt.DWORD, wt.BOOL, wt.DWORD)(0, False, 1)
        if not desktop:
            self.skipTest("the test process cannot open the interactive input desktop")
        try:
            name = ct.create_unicode_buffer(256)
            needed = wt.DWORD()
            inspect = _function(user, "GetUserObjectInformationW", wt.BOOL, wt.HANDLE, ct.c_int, wt.LPVOID,
                                wt.DWORD, ct.POINTER(wt.DWORD))
            if not inspect(desktop, 2, name, ct.sizeof(name), ct.byref(needed)) or name.value.lower() != "default":
                self.skipTest("requires an unlocked Default input desktop")
        finally:
            _function(user, "CloseDesktop", wt.BOOL, wt.HANDLE)(desktop)
        composition = wt.BOOL()
        dwm = ct.WinDLL("dwmapi")
        query = _function(dwm, "DwmIsCompositionEnabled", ct.c_int32, ct.POINTER(wt.BOOL))
        if query(ct.byref(composition)) or not composition.value:
            self.skipTest("Desktop Window Manager composition is unavailable")
        self.find = _function(user, "FindWindowW", wt.HWND, wt.LPCWSTR, wt.LPCWSTR)
        self.visible = _function(user, "IsWindowVisible", wt.BOOL, wt.HWND)
        self.affinity = _function(user, "GetWindowDisplayAffinity", wt.BOOL, wt.HWND, ct.POINTER(wt.DWORD))
        self.rect = _function(user, "GetWindowRect", wt.BOOL, wt.HWND, ct.POINTER(wt.RECT))
        if self.find(None, "Remote Control Privacy"):
            self.skipTest("another privacy curtain is already present")
        self.addCleanup(self.host.set_privacy, False)

    def test_affinity_full_desktop_and_restoration(self):
        self.host.set_privacy(True)
        self.assertTrue(self.host.privacy_enabled)
        hwnd = self.find(None, "Remote Control Privacy")
        self.assertTrue(hwnd)
        self.assertTrue(self.visible(hwnd))
        affinity, rect = wt.DWORD(), wt.RECT()
        self.assertTrue(self.affinity(hwnd, ct.byref(affinity)))
        self.assertEqual(affinity.value, 0x11)  # WDA_EXCLUDEFROMCAPTURE
        self.assertTrue(self.rect(hwnd, ct.byref(rect)))
        caps = self.host.capabilities
        self.assertEqual((rect.left, rect.top, rect.right, rect.bottom), (0, 0, caps["width"], caps["height"]))
        self.host.set_privacy(False)
        self.assertFalse(self.host.privacy_enabled)
        self.assertFalse(self.find(None, "Remote Control Privacy"))

    def test_windows_graphics_capture_sees_updated_content_under_cover(self):
        import tkinter as tk

        # A topmost marker created *before* the cover remains behind it. Change
        # its color in place, so a stale or black capture cannot pass the test.
        marker = tk.Tk()
        self.addCleanup(marker.destroy)
        marker.overrideredirect(True)
        marker.geometry("128x128+40+40")
        marker.attributes("-topmost", True)
        marker.configure(bg="#e32a58")
        marker.update()
        x, y = marker.winfo_rootx() + 64, marker.winfo_rooty() + 64

        def sample(expected):
            # Isolate WGC startup / driver failure and keep pumping window
            # messages. Only this one pixel is returned. No frames are saved.
            process = subprocess.Popen([sys.executable, __file__, "sample", str(x), str(y), expected],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 12
                while process.poll() is None and time.monotonic() < deadline:
                    marker.update()
                    time.sleep(0.02)
                if process.poll() is None:
                    return False, "Windows Graphics Capture did not see the expected marker within 12 seconds"
                stdout, stderr = process.communicate()
                return process.returncode == 0 and "matched marker" in stdout, stderr.strip() or stdout.strip()
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate()

        # Keep a missing test dependency visible. Only operating environment /
        # driver limitations discovered before activating privacy count as skips.
        import windows_capture  # noqa: F401
        ok, detail = sample("e32a58")
        if not ok:
            self.skipTest(f"no baseline WGC marker on this desktop: {detail}")
        try:
            self.host.set_privacy(True)
            self.assertTrue(self.host.privacy_enabled)
            marker.configure(bg="#36b8d4")
            marker.update()
            ok, detail = sample("36b8d4")
            self.assertTrue(ok, detail)
        finally:
            self.host.set_privacy(False)
        self.assertFalse(self.host.privacy_enabled)
        marker.configure(bg="#dea02c")
        marker.update()
        ok, detail = sample("dea02c")
        self.assertTrue(ok, detail)


def sample_marker(x, y, expected):
    from windows_capture import WindowsCapture

    target = bytes.fromhex(expected)
    capture = WindowsCapture(cursor_capture=False, monitor_index=1, window_name=None)

    @capture.event
    def on_frame_arrived(frame, capture_control):
        if y < frame.height and x < frame.width:
            blue, green, red = frame.frame_buffer[y, x, :3]
            if all(abs(int(value) - wanted) <= 20 for value, wanted in zip((red, green, blue), target)):
                print("matched marker", flush=True)
                capture_control.stop()

    @capture.event
    def on_closed():
        pass

    capture.start()


if __name__ == "__main__" and len(sys.argv) == 5 and sys.argv[1] == "sample":
    sample_marker(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
