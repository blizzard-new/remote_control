"""Capture an approved desktop viewer's selected display."""
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
    def __init__(self, desktop=None):
        self.lock = asyncio.Lock()
        self.mac_prompted = False
        self.desktop = desktop

    def displays(self):
        if sys.platform == "win32":
            from .windows import windows_monitors
            return windows_monitors()
        if sys.platform == "darwin":
            from .macos import Quartz, display_bridge
            if int(platform.mac_ver()[0].split(".")[0]) >= 14 and hasattr(display_bridge(), "rc_capture_display_jpeg"):
                return Quartz().monitors()
        if sys.platform.startswith("linux") and self.desktop:
            return self.desktop.monitors()
        return []

    def _snapshot(self, edge, sharp, monitor=None):
        if sys.platform == "darwin":
            # Source installs and older Macs use Apple's system capture tool.
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "display.png"
                subprocess.run(["/usr/sbin/screencapture", "-x", "-D", "1", "-t", "png", str(path)],
                               check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                with Image.open(path) as image:
                    return self._encode(image, edge, sharp)
        if sys.platform == "win32":
            user = ctypes.windll.user32
            if hasattr(user, "SetThreadDpiAwarenessContext"):
                user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        if sys.platform.startswith("linux"):
            import os
            if not os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland":
                raise RuntimeError("請登入 Linux 的原生 X11 桌面來分享整個畫面。")
            # Explicit X11 selection avoids platform tools or XWayland fallbacks.
            with ImageGrab.grab(xdisplay="", bbox=monitor.bounds if monitor else None) as image:
                return self._encode(image, edge, sharp)
        with ImageGrab.grab(bbox=monitor.bounds if monitor else None,
                            all_screens=monitor is not None, include_layered_windows=True) as image:
            return self._encode(image, edge, sharp)

    @staticmethod
    def _encode(image, edge, sharp):
        image.thumbnail((edge, edge), Image.Resampling.LANCZOS if sharp else Image.Resampling.BILINEAR)
        with BytesIO() as out:
            image.convert("RGB").save(out, format="JPEG", quality=95 if sharp else 80, subsampling=0 if sharp else 2)
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

    def _frame(self, edge, sharp, monitor=None):
        if sys.platform == "darwin":
            from .macos import capture_jpeg, display_bridge
            if int(platform.mac_ver()[0].split(".")[0]) >= 14:
                bridge = display_bridge()
                if bridge is not None:
                    return capture_jpeg(bridge, edge, sharp, int(monitor.id) if monitor else 0)
            self._mac_permission()
        return self._snapshot(edge, sharp, monitor)

    async def frame(self, edge=1920, sharp=False, monitor=None):
        async with self.lock:
            return await asyncio.to_thread(self._frame, edge, sharp, monitor)

    async def stop(self):
        # Each screenshot has a bounded lifetime and runs only on demand.
        pass
