"""Capture the primary display only while at least one locally approved viewer is present."""
import asyncio
import ctypes
from io import BytesIO
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile

from PIL import Image, ImageGrab


class PrimaryScreen:
    def __init__(self):
        self.helper = None
        self.lock = asyncio.Lock()
        self.mac_access = False

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
        self.mac_access = bool(cg.CGPreflightScreenCaptureAccess() or cg.CGRequestScreenCaptureAccess())
        if not self.mac_access:
            raise RuntimeError("請在 Mac 的「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」（舊版為「螢幕錄製」）允許 RemoteControl，再依系統提示重新開啟程式。")

    async def frame(self):
        async with self.lock:
            if sys.platform == "darwin" and not self.mac_access:
                await asyncio.to_thread(self._mac_permission)
            helper = Path(getattr(sys, "_MEIPASS", Path(__file__).parent)) / "PrimaryDisplay"
            if sys.platform != "darwin" or not helper.is_file() or int(platform.mac_ver()[0].split(".")[0]) < 14:
                return await asyncio.to_thread(self._snapshot)
            if self.helper is None:
                self.helper = await asyncio.create_subprocess_exec(str(helper), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            proc = self.helper
            try:
                proc.stdin.write(b"F")
                await proc.stdin.drain()
                length, = struct.unpack(">I", await asyncio.wait_for(proc.stdout.readexactly(4), 10))
                if not 0 < length <= 16 * 1024 * 1024:
                    raise ValueError("Invalid frame length")
                return await asyncio.wait_for(proc.stdout.readexactly(length), 5)
            except (OSError, EOFError, TimeoutError, ValueError) as exc:
                raise RuntimeError("Mac 無法擷取主螢幕。請喚醒 Mac，確認螢幕錄製已允許 RemoteControl，再重新連線。") from exc

    async def stop(self):
        async with self.lock:
            self.mac_access = False
            proc, self.helper = self.helper, None
            if proc is not None:
                proc.stdin.close()
                try:
                    await asyncio.wait_for(proc.wait(), 1)
                except TimeoutError:
                    proc.kill()
                    await proc.wait()
