import json
import os
import secrets
import unittest
from contextlib import AsyncExitStack
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from aiohttp.test_utils import TestServer
from PIL import Image, ImageDraw
from playwright.async_api import async_playwright, expect

from browser_smoke import RecordingDesktop
from relay.__main__ import create_app as relay_app
from server.app import create_app
from server.pairings import update


class Screen:
    def __init__(self, jpeg):
        self.jpeg = jpeg

    async def frame(self):
        return self.jpeg

    async def stop(self):
        pass


def jpeg(image):
    stream = BytesIO()
    image.save(stream, "JPEG")
    return stream.getvalue()


def phone_frame():
    fixture = os.environ.get("REMOTE_ANDROID_FRAME")
    if fixture:
        return Path(fixture).read_bytes()
    image = Image.new("RGB", (320, 640), (26, 200, 130))
    ImageDraw.Draw(image).rectangle((160, 0, 320, 640), fill=(204, 48, 64))
    return jpeg(image)


async def open_device(browser, server, address, name, platform, token):
    page = await browser.new_page()

    async def identify(route):
        if route.request.post_data_json.get("action") == "self":
            await route.fulfill(json={"name": name, "platform": platform})
        else:
            await route.continue_()

    await page.route("**/api/paired", identify)
    await page.add_init_script(
        f"localStorage.setItem('rc-relay', {json.dumps(address)});"
        "window.RTCPeerConnection = undefined;"
    )
    if platform == "Darwin":
        await page.add_init_script("window.createImageBitmap = undefined;")
    await page.goto(str(server.make_url("/online.html")) + "#host=" + token)
    await expect(page.locator("#invitation")).to_be_visible()
    return page


async def visible_phone(page):
    await expect(page.locator("#stage")).to_be_visible()
    await page.wait_for_function("""() => {
      const canvas = document.querySelector('#picture'), ctx = canvas.getContext('2d');
      const left = ctx.getImageData(canvas.width/4, canvas.height/2, 1, 1).data;
      const right = ctx.getImageData(3*canvas.width/4, canvas.height/2, 1, 1).data;
      return left[1] > 160 && left[0] < 65 && right[0] > 160 && right[1] < 85;
    }""", timeout=15000)
    await expect(page.locator("#first-picture")).to_be_hidden()


class PhoneScreenSmoke(unittest.IsolatedAsyncioTestCase):
    async def test_open_phone_screen_from_an_active_incoming_connection(self):
        mac, phone = RecordingDesktop(), RecordingDesktop()
        for device in (mac, phone):
            device.capabilities = {
                **device.capabilities, "control": False, "controlHint": "鍵鼠操作尚未開啟"
            }
        with TemporaryDirectory() as tmp:
            mac_db, phone_db = Path(tmp) / "mac.db", Path(tmp) / "phone.db"
            mac_screen = Screen(jpeg(Image.new("RGB", (480, 320), (25, 57, 220))))
            mac_app = create_app("mac", mac, device_store=mac_db, primary_capture=mac_screen)
            phone_app = create_app("phone", phone, device_store=phone_db, primary_capture=Screen(phone_frame()))
            async with AsyncExitStack() as stack:
                relay = await stack.enter_async_context(TestServer(relay_app()))
                mac_site = await stack.enter_async_context(TestServer(mac_app))
                phone_site = await stack.enter_async_context(TestServer(phone_app))
                address = str(relay.make_url("/")).rstrip("/")
                a, b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
                update(mac_db, "save", dict(listen=a, dial=b, name="Samsung", platform="Android", address=address, grant="view"))
                update(phone_db, "save", dict(listen=b, dial=a, name="MacBook", platform="Darwin", address=address, grant=""))

                playwright = await stack.enter_async_context(async_playwright())
                engine = os.environ.get("REMOTE_BROWSER", "chromium")
                options = {"executable_path": os.environ.get("CHROMIUM_EXECUTABLE")} if engine == "chromium" else {}
                browser = await getattr(playwright, engine).launch(**options)
                stack.push_async_callback(browser.close)
                laptop = await open_device(browser, mac_site, address, "MacBook", "Darwin", "mac")
                handset = await open_device(browser, phone_site, address, "Samsung", "Android", "phone")

                await handset.locator("#remembered button").first.click()
                await handset.locator("#action-view").click()
                await expect(laptop.locator("#connected-list")).to_contain_text("正在觀看本機")
                await handset.wait_for_function("""() => {
                  const canvas = document.querySelector('#picture');
                  const pixel = canvas.getContext('2d').getImageData(canvas.width/2, canvas.height/2, 1, 1).data;
                  return pixel[2] > 180 && pixel[0] < 65 && pixel[1] < 85;
                }""", timeout=15000)

                await laptop.locator("#connected-list").get_by_role("button", name="觀看手機畫面").click()
                await expect(laptop.locator("#joining")).to_be_visible()
                await expect(laptop.locator("#stage")).to_be_hidden()
                await handset.locator("#incoming-requests").get_by_role("button", name="允許觀看").click()
                await visible_phone(laptop)
                await expect(laptop.locator("#view-mode")).to_be_visible()
                await laptop.locator("#leave").click()
                await expect(laptop.locator("#connected-count")).to_have_text("1")
                await expect(handset.locator("#stage")).to_be_visible()

                await laptop.locator("#remembered button").first.click()
                await laptop.locator("#action-connect").click()
                await laptop.get_by_role("button", name="先觀看畫面").click()
                await visible_phone(laptop)
                await expect(laptop.locator("#view-mode")).to_be_visible()
                await laptop.locator("#picture").click()
                self.assertTrue(phone.events.empty())
