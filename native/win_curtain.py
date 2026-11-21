"""An opt-in, click-through black window excluded from Windows screen capture."""

import ctypes as ct
from ctypes import wintypes as wt
import threading
import uuid


WNDPROC = ct.WINFUNCTYPE(ct.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)


class WindowClass(ct.Structure):
    _fields_ = [
        ("style", wt.UINT), ("wndproc", WNDPROC), ("cls_extra", ct.c_int),
        ("wnd_extra", ct.c_int), ("instance", wt.HINSTANCE), ("icon", wt.HICON),
        ("cursor", wt.HANDLE), ("background", wt.HBRUSH), ("menu", wt.LPCWSTR),
        ("name", wt.LPCWSTR),
    ]


class Message(ct.Structure):
    # Include lPrivate explicitly, including on 32-bit Python.
    _fields_ = [
        ("hwnd", wt.HWND), ("message", wt.UINT), ("wparam", wt.WPARAM),
        ("lparam", wt.LPARAM), ("time", wt.DWORD), ("point", wt.POINT),
        ("private", wt.DWORD),
    ]


def _function(dll, name, result, *arguments):
    func = getattr(dll, name)
    func.restype = result
    func.argtypes = list(arguments)
    return func


class PrivacyCurtain:
    def __init__(self):
        self._thread = None
        self._ready = threading.Event()
        self._active = threading.Event()
        self._stop = threading.Event()
        self._error = None

    @property
    def active(self):
        return self._active.is_set()

    def show(self):
        if self.active:
            return
        # A locally dismissed window may still be unregistering its class.
        self.close()
        self._stop.clear()
        self._ready.clear()
        self._error = None
        self._thread = threading.Thread(target=self._run, name="display-curtain", daemon=True)
        self._thread.start()
        if not self._ready.wait(2):
            self.close()
            raise RuntimeError("Windows 隱私遮罩啟動逾時")
        if self._error or not self.active:
            raise RuntimeError(self._error or "Windows 隱私遮罩未開啟")

    def close(self):
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(2)
        if self._thread.is_alive():
            raise RuntimeError("無法關閉隱私遮罩，請在本機按 Ctrl+Alt+Shift+F10")
        self._thread = None

    def _run(self):
        try:
            self._window_loop()
        except (OSError, RuntimeError) as exc:
            self._error = f"無法啟用 Windows 隱私遮罩：{exc}"
        finally:
            self._active.clear()
            self._ready.set()

    def _window_loop(self):
        user = ct.WinDLL("user32", use_last_error=True)
        kernel = ct.WinDLL("kernel32", use_last_error=True)
        gdi = ct.WinDLL("gdi32", use_last_error=True)
        _function(user, "SetThreadDpiAwarenessContext", ct.c_void_p, ct.c_void_p)(ct.c_void_p(-4))
        get_metric = _function(user, "GetSystemMetrics", ct.c_int, ct.c_int)
        if get_metric(80) != 1:
            raise RuntimeError("隱私模式需要單一啟用中的螢幕")
        width, height = get_metric(0), get_metric(1)
        default_proc = _function(user, "DefWindowProcW", ct.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        destroy = _function(user, "DestroyWindow", wt.BOOL, wt.HWND)
        quit_loop = _function(user, "PostQuitMessage", None, ct.c_int)

        @WNDPROC
        def window_proc(hwnd, msg, wparam, lparam):
            if msg in (0x0312, 0x007E, 0x02E0, 0x0010):  # HOTKEY / DISPLAYCHANGE / DPICHANGED / CLOSE
                destroy(hwnd)
                return 0
            if msg == 0x0113 and self._stop.is_set():  # WM_TIMER
                destroy(hwnd)
                return 0
            if msg == 0x0002:  # WM_DESTROY
                self._active.clear()
                quit_loop(0)
                return 0
            if msg == 0x0084:  # WM_NCHITTEST
                return -1  # HTTRANSPARENT
            return default_proc(hwnd, msg, wparam, lparam)

        instance = _function(kernel, "GetModuleHandleW", wt.HINSTANCE, wt.LPCWSTR)(None)
        black = _function(gdi, "GetStockObject", wt.HGDIOBJ, ct.c_int)(4)
        name = f"RemoteControlCurtain{uuid.uuid4().hex}"
        cls = WindowClass(wndproc=window_proc, instance=instance, background=black, name=name)
        if not _function(user, "RegisterClassW", wt.ATOM, ct.POINTER(WindowClass))(ct.byref(cls)):
            raise ct.WinError(ct.get_last_error())
        hwnd = None
        try:
            create = _function(user, "CreateWindowExW", wt.HWND, wt.DWORD, wt.LPCWSTR, wt.LPCWSTR,
                               wt.DWORD, ct.c_int, ct.c_int, ct.c_int, ct.c_int, wt.HWND, wt.HMENU,
                               wt.HINSTANCE, wt.LPVOID)
            # WS_EX_NOACTIVATE | LAYERED | TOOLWINDOW | TRANSPARENT | TOPMOST
            hwnd = create(0x080800A8, name, "Remote Control Privacy", 0x80000000,
                          0, 0, width, height, None, None, instance, None)
            if not hwnd:
                raise ct.WinError(ct.get_last_error())
            if not _function(user, "SetLayeredWindowAttributes", wt.BOOL, wt.HWND, wt.DWORD, wt.BYTE,
                             wt.DWORD)(hwnd, 0, 255, 2):
                raise ct.WinError(ct.get_last_error())
            # Never show the cover if Windows rejects exclusion or silently
            # downgrades to WDA_MONITOR, which would black out remote video.
            affinity = wt.DWORD()
            protect = _function(user, "SetWindowDisplayAffinity", wt.BOOL, wt.HWND, wt.DWORD)
            inspect = _function(user, "GetWindowDisplayAffinity", wt.BOOL, wt.HWND, ct.POINTER(wt.DWORD))
            if not protect(hwnd, 0x11) or not inspect(hwnd, ct.byref(affinity)) or affinity.value != 0x11:
                raise RuntimeError("顯示驅動程式未允許擷取排除")
            hotkey = _function(user, "RegisterHotKey", wt.BOOL, wt.HWND, ct.c_int, wt.UINT, wt.UINT)
            if not hotkey(hwnd, 1, 0x4007, 0x79):  # MOD_NOREPEAT | SHIFT | CTRL | ALT, VK_F10
                raise RuntimeError("無法註冊本機還原快捷鍵 Ctrl+Alt+Shift+F10")
            timer = _function(user, "SetTimer", ct.c_size_t, wt.HWND, ct.c_size_t, wt.UINT, wt.LPVOID)
            if not timer(hwnd, 1, 100, None):
                raise ct.WinError(ct.get_last_error())
            if self._stop.is_set():
                return
            _function(user, "ShowWindow", wt.BOOL, wt.HWND, ct.c_int)(hwnd, 8)  # SW_SHOWNA
            _function(user, "UpdateWindow", wt.BOOL, wt.HWND)(hwnd)
            self._active.set()
            self._ready.set()
            message = Message()
            get_message = _function(user, "GetMessageW", ct.c_int, ct.POINTER(Message), wt.HWND, wt.UINT, wt.UINT)
            dispatch = _function(user, "DispatchMessageW", ct.c_ssize_t, ct.POINTER(Message))
            while True:
                status = get_message(ct.byref(message), None, 0, 0)
                if status == -1:
                    raise ct.WinError(ct.get_last_error())
                if status == 0:
                    break
                dispatch(ct.byref(message))
        finally:
            if hwnd and _function(user, "IsWindow", wt.BOOL, wt.HWND)(hwnd):
                destroy(hwnd)
            _function(user, "UnregisterClassW", wt.BOOL, wt.LPCWSTR, wt.HINSTANCE)(name, instance)
