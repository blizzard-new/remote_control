"""Capture the primary display only while at least one locally approved viewer is present."""
import asyncio
import ctypes
from io import BytesIO
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

from PIL import Image, ImageGrab


class PrimaryScreen:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.mac_prompted = False

    def _snapshot(self):
        if sys.platform == "darwin":
            # Source installs and older Macs use Apple's system capture tool.
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "display.jpg"
                subprocess.run(["/usr/sbin/screencapture", "-x", "-D", "1", "-t", "jpg", str(path)],
                               check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with Image.open(path) as image:
                    return self._encode(image)
        if sys.platform == "win32":
            user = ctypes.windll.user32
            if hasattr(user, "SetThreadDpiAwarenessContext"):
                user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        with ImageGrab.grab(all_screens=False, include_layered_windows=True) as image:
            return self._encode(image)

    @staticmethod
    def _encode(image):
        image.thumbnail((1920, 1920), Image.Resampling.BILINEAR)
        with BytesIO() as out:
            image.convert("RGB").save(out, format="JPEG", quality=80)
            return out.getvalue()

    def _mac_permission(self):
        cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        cg.CGRequestScreenCaptureAccess.restype = ctypes.c_bool
        if cg.CGPreflightScreenCaptureAccess():
            return
        if not self.mac_prompted:
            self.mac_prompted = True
            if cg.CGRequestScreenCaptureAccess():
                return
        raise PermissionError("macOS 尚未允許這個程序擷取螢幕。若系統已允許 RemoteControl，請重新開啟程式。")

    def _frame(self):
        if sys.platform == "darwin":
            from .macos import capture_jpeg, display_bridge
            if int(platform.mac_ver()[0].split(".")[0]) >= 14:
                bridge = display_bridge()
                if bridge is not None:
                    return capture_jpeg(bridge)
            self._mac_permission()
        return self._snapshot()

    async def frame(self):
        async with self.lock:
            return await asyncio.to_thread(self._frame)

    async def stop(self):
        # Each screenshot has a bounded lifetime and runs only on demand.
        pass
