"""Exercise the packaged Windows dashboard, tray mode, and the sign-in command."""
import argparse
import asyncio
from contextlib import AsyncExitStack
import ctypes as ct
from ctypes import wintypes as wt
import os
from pathlib import Path
import socket
import subprocess
import winreg

from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright, expect

from native.windows_app import RUN_KEY
from relay.__main__ import create_app


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
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        debug_port = sock.getsockname()[1]
    env = dict(os.environ, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f"--remote-debugging-port={debug_port}")
    proc = None

    async def stop():
        await asyncio.to_thread(subprocess.run, [str(executable), "--exit"], check=True, timeout=25)
        await asyncio.to_thread(proc.wait, timeout=15)

    async with AsyncExitStack() as stack:
        relay = await stack.enter_async_context(TestServer(create_app()))
        addr = str(relay.make_url("/")).rstrip("/")
        playwright = await stack.enter_async_context(async_playwright())
        phone_browser = await playwright.chromium.launch()
        stack.push_async_callback(phone_browser.close)

        async def dashboard():
            endpoint = f"http://127.0.0.1:{debug_port}"
            for _ in range(30):
                try:
                    browser = await playwright.chromium.connect_over_cdp(endpoint, timeout=3000)
                    for context in browser.contexts:
                        for page in context.pages:
                            if "/online.html" in page.url:
                                await expect(page.locator("#invite")).to_have_value(r_pin, timeout=20000)
                                return page
                except Exception:
                    pass
                await asyncio.sleep(.35)
            raise RuntimeError("No packaged WebView2 dashboard or no active four-digit code")

        import re
        r_pin = re.compile(r"^\d{4}$")
        try:
            proc = subprocess.Popen([str(executable)], env=env)
            page = await dashboard()
            url = page.url
            await page.locator('nav [data-page="settings"]').click()
            await page.locator("#relay").fill(addr)
            await page.locator("#relay").press("Tab")
            await expect(page.locator("#invite")).to_have_value(r_pin, timeout=20000)
            await expect(page.locator("#relay")).to_have_value(addr)

            phone = await phone_browser.new_page()
            await phone.add_init_script(f"localStorage.setItem('rc-relay', '{addr}')")
            await phone.goto(url)
            await phone.locator("#add").click()
            await phone.locator("#code").fill(await page.locator("#invite").input_value())
            await page.get_by_role("button", name="允許觀看").click(timeout=20000)
            await expect(phone.locator("#stage")).to_be_visible(timeout=20000)
            await expect(phone.locator("#first-picture")).to_be_hidden(timeout=20000)

            handle = await window_is(True)
            user = ct.WinDLL("user32")
            user.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
            assert user.PostMessageW(handle, 0x0010, 0, 0)  # WM_CLOSE
            await window_is(False)
            assert proc.poll() is None
            await expect(phone.locator("#stage")).to_be_visible()
            await phone.locator("#leave").click()
            await phone.locator("#remembered button").first.click()
            await phone.locator("#action-view").click()
            await expect(phone.locator("#stage")).to_be_visible(timeout=20000)
            await expect(phone.locator("#first-picture")).to_be_hidden(timeout=20000)
            await phone.locator("#leave").click()

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                startup = winreg.QueryValueEx(key, "UniwayRemote")[0]
            assert "--background" in startup
            await stop()
            proc = subprocess.Popen(startup, env=env)
            await dashboard()
            await window_is(False)
            await phone.locator("#action-view").click()
            await expect(phone.locator("#stage")).to_be_visible(timeout=20000)
            await expect(phone.locator("#first-picture")).to_be_hidden(timeout=20000)
            await asyncio.to_thread(subprocess.run, [str(executable)], check=True, timeout=20)
            await window_is(True)
            print("Packaged Windows host remains reachable on close, after background startup, and when reopened.")
        finally:
            if proc and proc.poll() is None:
                await stop()
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
