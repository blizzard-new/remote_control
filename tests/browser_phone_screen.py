import asyncio
import json
import os
import secrets
import unittest
from contextlib import AsyncExitStack
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from aiohttp.test_utils import TestServer
from PIL import Image, ImageDraw, ImageChops, ImageStat

from native.screen import PrimaryScreen
from playwright.async_api import async_playwright, expect

from browser_smoke import RecordingDesktop
from relay.__main__ import create_app as relay_app
from server.app import create_app
from server.pairings import update


class Screen:
    def __init__(self, jpeg):
        self.jpeg = jpeg

    async def frame(self, *, edge, sharp):
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


async def launch_browser(stack):
    playwright = await stack.enter_async_context(async_playwright())
    engine = os.environ.get("REMOTE_BROWSER", "chromium")
    options = {"executable_path": os.environ.get("CHROMIUM_EXECUTABLE")} if engine == "chromium" else {}
    browser = await getattr(playwright, engine).launch(**options)
    stack.push_async_callback(browser.close)
    return browser


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
        desktop_platform = os.environ.get("REMOTE_DESKTOP_PLATFORM", "Darwin")
        mac, phone = RecordingDesktop(), RecordingDesktop()
        for device in (mac, phone):
            device.capabilities = {
                **device.capabilities, "control": False, "controlHint": "鍵鼠操作尚未開啟"
            }
        phone.capabilities["controlReason"] = "unavailable"
        report = {"application": "/Applications/RemoteControl.app", "accessibility": True,
                  "postEvents": False, "screen": True, "relaunch": True}
        mac.mac_permissions = Mock(return_value=report)
        mac.request_control = Mock()
        with TemporaryDirectory() as tmp:
            mac_db, phone_db = Path(tmp) / "mac.db", Path(tmp) / "phone.db"
            mac_screen = Screen(jpeg(Image.new("RGB", (480, 320), (25, 57, 220))))
            with patch("server.app.platform.system", return_value="Darwin"):
                mac_app = create_app("mac", mac, device_store=mac_db, primary_capture=mac_screen)
            phone_app = create_app("phone", phone, device_store=phone_db, primary_capture=Screen(phone_frame()))
            async with AsyncExitStack() as stack:
                relay = await stack.enter_async_context(TestServer(relay_app()))
                mac_site = await stack.enter_async_context(TestServer(mac_app))
                phone_site = await stack.enter_async_context(TestServer(phone_app))
                address = str(relay.make_url("/")).rstrip("/")
                a, b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
                update(mac_db, "save", dict(listen=a, dial=b, name="Samsung", platform="Android", address=address, grant="view"))
                update(phone_db, "save", dict(listen=b, dial=a, name="Computer", platform=desktop_platform, address=address, grant="view"))

                browser = await launch_browser(stack)
                laptop = await open_device(browser, mac_site, address, "Computer", desktop_platform, "mac")
                handset = await open_device(browser, phone_site, address, "Samsung", "Android", "phone")

                if desktop_platform == "Darwin":
                    await laptop.locator('nav [data-page="settings"]').click()
                    await expect(laptop.locator("#mac-app-path")).to_contain_text(report["application"])
                    await expect(laptop.locator("#mac-access")).to_contain_text("鍵鼠事件 尚未取得")
                    await expect(laptop.locator("#mac-request")).to_be_hidden()
                    await expect(laptop.locator("#mac-relaunch")).to_be_visible()
                    report["postEvents"] = True
                    await laptop.locator("#mac-check").click()
                    await expect(laptop.locator("#mac-access")).to_contain_text("鍵鼠事件 已允許")
                    mac.request_control.assert_not_called()
                    await laptop.locator('nav [data-page="devices"]').click()

                await handset.locator("#remembered button").first.click()
                await handset.locator("#action-view").click()
                await expect(laptop.locator("#connected-list")).to_contain_text("正在觀看本機")
                await handset.wait_for_function("""() => {
                  const canvas = document.querySelector('#picture');
                  const pixel = canvas.getContext('2d').getImageData(canvas.width/2, canvas.height/2, 1, 1).data;
                  return pixel[2] > 180 && pixel[0] < 65 && pixel[1] < 85;
                }""", timeout=15000)

                await laptop.locator("#connected-list").get_by_role("button", name="操作手機").click()
                await expect(laptop.locator("#joining")).to_be_visible()
                await expect(laptop.locator("#stage")).to_be_hidden()
                await expect(handset.locator("#incoming-requests")).to_be_visible()
                self.assertTrue(phone.events.empty())
                phone.capabilities["control"] = True
                await handset.locator("#incoming-requests").get_by_role("button", name="允許操作").click()
                await visible_phone(laptop)
                await expect(laptop.locator("#view-mode")).to_be_hidden()
                await laptop.locator("#picture").click()
                for down in (True, False):
                    async with asyncio.timeout(5):
                        event = await phone.events.get()
                        while event["kind"] != "button":
                            event = await phone.events.get()
                        self.assertEqual(event["down"], down)
                await laptop.locator("#leave").click()
                await expect(laptop.locator("#connected-count")).to_have_text("1")
                await expect(handset.locator("#stage")).to_be_visible()

                phone.capabilities["control"] = False
                await laptop.locator("#remembered button").first.click()
                await laptop.locator("#action-connect").click()
                await laptop.get_by_role("button", name="先觀看畫面").click()
                await visible_phone(laptop)
                await expect(laptop.locator("#view-mode")).to_be_visible()
                while not phone.events.empty():
                    phone.events.get_nowait()
                await laptop.locator("#picture").click()
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(phone.events.get(), 0.25)
                phone.capabilities["control"] = True
                await laptop.locator("#ask-control").click()
                await visible_phone(laptop)
                await expect(laptop.locator("#view-mode")).to_be_hidden()
                await expect(handset.locator("#incoming-requests")).to_be_hidden()

    async def test_phone_receives_the_requested_desktop_detail_and_resolution(self):
        # Small colored stems are sensitive to chroma subsampling. The textured area
        # makes even a single source image larger than one deployed relay packet.
        source = Image.new("RGB", (2560, 1600), "white")
        source.paste(Image.effect_noise((1500, 1400), 75).convert("RGB"), (900, 120))
        drawn = ImageDraw.Draw(source)
        sample = (32, 32, 288, 96)
        drawn.rectangle(sample, fill=(0, 117, 0))
        for y in range(32, 92, 12):
            drawn.text((33, y), "Uniway Remote   RGB   0123456789", fill=(239, 25, 25))
        encoded = {}

        class DetailedScreen(Screen):
            async def frame(self, *, edge, sharp):
                if (edge, sharp) not in encoded:
                    encoded[edge, sharp] = PrimaryScreen._encode(source.copy(), edge, sharp)
                return encoded[edge, sharp]

        with TemporaryDirectory() as tmp:
            desktop_db, phone_db = Path(tmp)/"desktop", Path(tmp)/"phone"
            desktop_app = create_app("desktop", RecordingDesktop(), device_store=desktop_db,
                                     primary_capture=DetailedScreen(b""))
            phone_app = create_app("phone", RecordingDesktop(), device_store=phone_db, primary_capture=Screen(phone_frame()))
            async with AsyncExitStack() as stack:
                relay = await stack.enter_async_context(TestServer(relay_app()))
                site = await stack.enter_async_context(TestServer(desktop_app))
                mobile_site = await stack.enter_async_context(TestServer(phone_app))
                address = str(relay.make_url("/")).rstrip("/")
                a, b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
                update(desktop_db, "save", dict(listen=a, dial=b, name="Phone", platform="Android", address=address, grant="view"))
                update(phone_db, "save", dict(listen=b, dial=a, name="Desktop", platform="Windows", address=address, grant=""))
                browser = await launch_browser(stack)
                desktop = await open_device(browser, site, address, "Desktop", "Windows", "desktop")
                await desktop.evaluate("""() => {
                  const original = WebSocket.prototype.send;
                  WebSocket.prototype.send = function(message) {
                    if (typeof message === 'string') {
                      const data = JSON.parse(message);
                      if (data.type === 'primary-frame') window.testCaptureRequest = data;
                    }
                    return original.call(this, message);
                  };
                }""")
                phone = await open_device(browser, mobile_site, address, "Phone", "Android", "phone")
                await phone.locator("#remembered button").first.click()
                await phone.locator("#action-view").click()
                await phone.wait_for_function("() => document.querySelector('#picture').width === 2560", timeout=30000)
                await phone.locator("#video-menu summary").click()
                await expect(phone.locator("#stats")).to_contain_text("2560 × 1600")
                read = """() => Array.from(document.querySelector('#picture').getContext('2d').getImageData(32,32,256,64).data)"""
                def sample_image(payload):
                    return Image.frombytes("RGBA", (256, 64), bytes(payload)).convert("RGB")
                def text_error(image):
                    return sum(ImageStat.Stat(ImageChops.difference(source.crop(sample), image)).mean)/3
                sharp_pixels = sample_image(await phone.evaluate(read))
                self.assertGreater(len(encoded[3840, True]), 340000)
                await phone.locator("#detail-quality").select_option("balanced")
                await desktop.wait_for_function("() => window.testCaptureRequest?.sharp === false")
                async with asyncio.timeout(25):
                    while True:
                        standard_pixels = sample_image(await phone.evaluate(read))
                        if text_error(standard_pixels) > text_error(sharp_pixels) + 2:
                            break
                        await asyncio.sleep(0.1)
                await phone.locator("#quality").select_option("1280")
                await phone.locator("#fps").select_option("60")
                await desktop.wait_for_function("() => window.testCaptureRequest?.fps === 60 && window.testCaptureRequest.edge === 1280")
                await phone.wait_for_function("() => document.querySelector('#picture').width === 1280", timeout=20000)
                self.assertEqual(await phone.locator("#picture").evaluate("c=>c.height"), 800)
                await expect(phone.locator("#stats")).to_contain_text("1280 × 800")
                await expect(phone.locator("#stats")).to_contain_text("fps · JPEG")
                print(f"Desktop JPEG {len(encoded[3840, True]):,} bytes, decoded 2560×1600 → 1280×800; "
                      f"colored-text mean error {text_error(sharp_pixels):.2f} clear vs {text_error(standard_pixels):.2f} standard.")
