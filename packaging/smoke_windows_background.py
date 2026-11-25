"""Exercise the packaged Windows dashboard, tray mode, and the sign-in command."""
import argparse
import asyncio
from contextlib import AsyncExitStack
import ctypes as ct
from ctypes import wintypes as wt
import json
import os
from pathlib import Path
import secrets
import subprocess
import winreg

from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright, expect

from native.windows_app import RUN_KEY
from relay.__main__ import create_app
from server.app import create_app as desktop_app
from server.pairings import device_store, update


def dashboard_window():
    user = ct.WinDLL("user32")
    callback = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    user.EnumWindows.argtypes = [callback, wt.LPARAM]
    user.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ct.c_int]
    user.IsWindowVisible.argtypes = [wt.HWND]
    windows = []

    @callback
    def check(handle, _):
        title = ct.create_unicode_buffer(64)
        user.GetWindowTextW(handle, title, len(title))
        if title.value == "Uniway Remote":
            windows.append((handle, bool(user.IsWindowVisible(handle))))
        return True

    user.EnumWindows(check, 0)
    return windows[0] if windows else (None, False)


async def window_is(visible):
    for _ in range(100):
        handle, actual = await asyncio.to_thread(dashboard_window)
        if handle and actual == visible:
            return handle
        await asyncio.sleep(.1)
    raise AssertionError(f"Expected Windows dashboard visibility {visible}")


async def smoke(executable):
    proc = None

    async def stop():
        await asyncio.to_thread(subprocess.run, [str(executable), "--exit"], check=True, timeout=25)
        await asyncio.to_thread(proc.wait, timeout=15)

    async with AsyncExitStack() as stack:
        relay = await stack.enter_async_context(TestServer(create_app()))
        address = str(relay.make_url("/")).rstrip("/")
        env = dict(os.environ, REMOTE_RELAY_URL=address)
        handset = await stack.enter_async_context(TestServer(desktop_app("", None)))
        playwright = await stack.enter_async_context(async_playwright())
        phone_browser = await playwright.chromium.launch()
        stack.push_async_callback(phone_browser.close)
        listen, dial = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        update(device_store(), "save", dict(listen=listen, dial=dial, address=address,
                                            grant="view", name="Test phone", platform="Android"))
        phone = await phone_browser.new_page()
        pair = dict(listen=dial, dial=listen, address=address, name="Test PC", platform="Windows")
        await phone.add_init_script(
            f"localStorage.setItem('rc-relay', {json.dumps(address)});"
            f"localStorage.setItem('rc-paired-devices-v1', {json.dumps(json.dumps([pair]))});"
            "window.RTCPeerConnection = undefined;"
        )
        await phone.goto(str(handset.make_url("/online.html")))

        async def connect():
            await phone.locator("#remembered button").first.click()
            await phone.locator("#action-view").click()
            await expect(phone.locator("#stage")).to_be_visible(timeout=35000)
            await expect(phone.locator("#first-picture")).to_be_hidden(timeout=20000)
            assert await phone.locator("#picture").evaluate("canvas => canvas.width") > 300

        try:
            proc = subprocess.Popen([str(executable)], env=env)
            handle = await window_is(True)
            await connect()
            print("Packaged Windows host served its desktop to a trusted viewer.", flush=True)

            user = ct.WinDLL("user32")
            user.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
            assert user.PostMessageW(handle, 0x0010, 0, 0)  # WM_CLOSE
            await window_is(False)
            assert proc.poll() is None
            await expect(phone.locator("#stage")).to_be_visible()
            await phone.locator("#leave").click()
            await connect()
            await phone.locator("#leave").click()
            print("The hidden dashboard accepted a fresh trusted connection.", flush=True)

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                startup = winreg.QueryValueEx(key, "UniwayRemote")[0]
            assert "--background" in startup
            await stop()
            proc = subprocess.Popen(startup, env=env)
            await window_is(False)
            await connect()
            await asyncio.to_thread(subprocess.run, [str(executable)], check=True, timeout=20)
            await window_is(True)
            print("The sign-in command started the host hidden and it reopened without a duplicate.")
        finally:
            if proc and proc.poll() is None:
                await stop()
            update(device_store(), "forget", {"listen": listen})
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
                try:
                    winreg.DeleteValue(key, "UniwayRemote")
                except FileNotFoundError:
                    pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    executable = parser.parse_args().executable.resolve(strict=True)
    asyncio.run(smoke(executable))
