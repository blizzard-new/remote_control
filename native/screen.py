"""Capture an approved desktop viewer's selected display."""
import asyncio
import ctypes
from datetime import datetime
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
            with _windows_grab(monitor) as image:
                return self._encode(image, edge, sharp)
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
            pixels = image if image.mode == "RGB" else image.convert("RGB")
            pixels.save(out, format="JPEG", quality=95 if sharp else 80, subsampling=0 if sharp else 2,
                        restart_marker_rows=1)
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

    @property
    def windows_screenshots(self):
        return sys.platform == "win32"

    async def screenshot(self, mode, monitor=None):
        if not self.windows_screenshots:
            raise RuntimeError("此功能需要 Windows。")
        if mode == "snip":
            import os
            await asyncio.to_thread(os.startfile, "ms-screenclip:")
            return None
        async with self.lock:
            return await asyncio.to_thread(_save_windows_screenshot, monitor)

    async def stop(self):
        pass


def _windows_grab(monitor):
    user = ctypes.windll.user32
    if hasattr(user, "SetThreadDpiAwarenessContext"):
        user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    return ImageGrab.grab(bbox=monitor.bounds if monitor else None,
                          all_screens=monitor is not None, include_layered_windows=True)


def _screenshots_folder():
    import uuid

    # FOLDERID_Screenshots honors redirected Pictures folders, including OneDrive.
    identifier = (ctypes.c_ubyte * 16).from_buffer_copy(
        uuid.UUID("b7bede81-df94-4682-a7d8-57a52620b86f").bytes_le)
    value = ctypes.c_wchar_p()
    shell = ctypes.WinDLL("shell32")
    shell.SHGetKnownFolderPath.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p),
    ]
    free = ctypes.WinDLL("ole32").CoTaskMemFree
    free.argtypes = [ctypes.c_void_p]
    free.restype = None
    try:
        if shell.SHGetKnownFolderPath(ctypes.byref(identifier), 0x4000, None, ctypes.byref(value)) == 0 and value.value:
            return Path(value.value)
    finally:
        if value:
            free(ctypes.cast(value, ctypes.c_void_p))
    return Path.home() / "Pictures" / "Screenshots"


def _save_windows_screenshot(monitor):
    directory = _screenshots_folder()
    directory.mkdir(parents=True, exist_ok=True)
    name = datetime.now().strftime("Uniway_%Y-%m-%d_%H-%M-%S_%f.png")
    path = directory / name
    with _windows_grab(monitor) as image, path.open("xb") as output:
        try:
            image.save(output, "PNG")
        except (OSError, ValueError):
            output.close()
            path.unlink(missing_ok=True)
            raise
    return name
