"""Installed Windows app keeps its dashboard and host together in the notification area."""
import asyncio
import ctypes as ct
from ctypes import wintypes as wt
import logging
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import winreg


RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
INSTANCE = r"Local\UniwayRemote.Desktop"


class Instance:
    def __init__(self):
        self.kernel = ct.WinDLL("kernel32", use_last_error=True)
        for name, result, args in (
            ("CreateMutexW", wt.HANDLE, (ct.c_void_p, wt.BOOL, wt.LPCWSTR)),
            ("CreateEventW", wt.HANDLE, (ct.c_void_p, wt.BOOL, wt.BOOL, wt.LPCWSTR)),
            ("SetEvent", wt.BOOL, (wt.HANDLE,)),
            ("WaitForSingleObject", wt.DWORD, (wt.HANDLE, wt.DWORD)),
            ("WaitForMultipleObjects", wt.DWORD, (wt.DWORD, ct.POINTER(wt.HANDLE), wt.BOOL, wt.DWORD)),
            ("ReleaseMutex", wt.BOOL, (wt.HANDLE,)),
            ("CloseHandle", wt.BOOL, (wt.HANDLE,)),
        ):
            function = getattr(self.kernel, name)
            function.restype, function.argtypes = result, args
        self.show = self.kernel.CreateEventW(None, False, False, INSTANCE + ".show")
        self.exit = self.kernel.CreateEventW(None, False, False, INSTANCE + ".exit")
        self.mutex = self.kernel.CreateMutexW(None, True, INSTANCE)
        self.owner = ct.get_last_error() != 183
        if not all((self.show, self.exit, self.mutex)):
            raise ct.WinError(ct.get_last_error())

    def close(self):
        if self.owner:
            self.kernel.ReleaseMutex(self.mutex)
        for handle in (self.mutex, self.exit, self.show):
            self.kernel.CloseHandle(handle)

    def signal(self, handle, *, wait=False):
        self.kernel.SetEvent(handle)
        if wait:
            if self.kernel.WaitForSingleObject(self.mutex, 20000) not in (0, 128):
                raise RuntimeError("遠端桌面仍在結束，請稍候再試。")
            self.kernel.ReleaseMutex(self.mutex)

    def listen(self, show_window, quit_app):
        events = (wt.HANDLE * 2)(self.exit, self.show)
        while True:
            result = self.kernel.WaitForMultipleObjects(2, events, False, 0xFFFFFFFF)
            if result == 1:
                show_window()
            else:
                if result == 0:
                    quit_app()
                return


def show_message(message):
    ct.windll.user32.MessageBoxW(None, str(message), "Uniway Remote", 0x10)


def run(start_online, port, *, background=False, exit_only=False):
    instance = Instance()
    try:
        if not instance.owner:
            if exit_only:
                instance.signal(instance.exit, wait=True)
            elif not background:
                instance.signal(instance.show)
            return
        if exit_only:
            return
        launch(start_online, port, instance, background)
    finally:
        instance.close()


def launch(start_online, port, instance, background):
    import pystray
    import webview
    from PIL import Image
    from aiohttp import web
    from webview.platforms import winforms
    from server.app import WEB_DIR

    if winforms.renderer != "edgechromium":
        raise RuntimeError("請先安裝 Microsoft Edge WebView2 Runtime，才能使用 Windows 版 Uniway Remote。")
    state = Path(os.environ["LOCALAPPDATA"]) / "RemoteControlHost"
    state.mkdir(parents=True, exist_ok=True)
    ready = queue.Queue()

    def server_ready(url):
        ready.put((url, asyncio.get_running_loop()))

    def serve():
        try:
            start_online(port, on_ready=server_ready, handle_signals=False)
        except (OSError, ValueError, RuntimeError) as error:
            ready.put((str(error), None))

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    try:
        url, loop = ready.get(timeout=15)
    except queue.Empty as error:
        raise RuntimeError("本機遠端桌面未能在 15 秒內啟動。") from error
    if loop is None:
        raise RuntimeError(url)

    # Keep WebSocket timers and canvas capture running while the window is hidden.
    flags = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling"
    env = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
    os.environ[env] = (os.environ.get(env, "") + " " + flags).strip()
    window = webview.create_window("Uniway Remote", url + "&managed=1", width=1040, height=740,
                                   min_size=(680, 520), hidden=background)
    quitting = threading.Event()

    def open_window(*_):
        if not quitting.is_set():
            window.show()

    def quit_app(*_):
        if quitting.is_set():
            return
        quitting.set()
        window.destroy()

    def attach_close():
        if getattr(sys, "frozen", False):
            window.native.Icon = winforms.Icon.ExtractAssociatedIcon(sys.executable)

        def hide_on_close(sender, args):
            if args.CloseReason == winforms.WinForms.CloseReason.UserClosing and not quitting.is_set():
                args.Cancel = True
                sender.Hide()

        window.native.FormClosing += hide_on_close

    window.events.before_show += attach_close
    with Image.open(WEB_DIR / "icons" / "uniway-remote.png") as artwork:
        image = artwork.resize((64, 64), Image.Resampling.LANCZOS)
    tray = pystray.Icon("UniwayRemote", image, "Uniway Remote",
                        pystray.Menu(pystray.MenuItem("開啟 Uniway Remote", open_window, default=True),
                                     pystray.MenuItem("結束遠端待命", quit_app)))

    def started():
        if not window.events.shown.wait(15):
            logging.error("Uniway Remote could not show its dashboard")
            return
        if not background and getattr(sys, "frozen", False):
            try:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                    winreg.SetValueEx(key, "UniwayRemote", 0, winreg.REG_SZ,
                                      subprocess.list2cmdline([sys.executable, "--background"]))
            except OSError:
                logging.exception("Could not enable Uniway Remote at sign-in")
                show_message("無法設定 Windows 登入時啟動。你仍可手動開啟 Uniway Remote。")
        tray.run_detached()
        instance.listen(open_window, quit_app)

    def stop_server():
        raise web.GracefulExit()

    try:
        webview.start(started, gui="edgechromium", private_mode=False, storage_path=str(state / "WebView"))
    finally:
        quitting.set()
        tray.stop()
        instance.kernel.SetEvent(instance.exit)
        if not loop.is_closed():
            loop.call_soon_threadsafe(stop_server)
        server.join(timeout=8)
