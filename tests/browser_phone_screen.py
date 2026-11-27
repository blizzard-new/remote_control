import asyncio
from base64 import b64decode
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
from native.monitors import Monitor
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
    async def test_scrolling_preserves_selected_resolution_and_uses_native_jpeg(self):
        source = Image.effect_noise((2560, 1760), 67).convert("RGB")
        draw = ImageDraw.Draw(source)
        draw.rectangle((0, 0, 780, 1760), fill="#f1f4f9")
        for y in range(25, 1760, 44):
            draw.text((32, y), f"{y:04}   Desktop scrolling fixture", fill="#1f3456")
        # Scroll a viewport over a taller document so newly exposed rows must travel.
        images = [source.crop((0, y, 2560, y + 1600)) for y in range(0, 161, 32)]
        frames = {
            (edge, sharp): [PrimaryScreen._encode(image.copy(), edge, sharp) for image in images]
            for edge, sharp in [(3840, True), (1920, True)]
        }
        self.assertGreater(len(frames[3840, True][0]), 500000)

        class ScrollingScreen(Screen):
            position = 0

            async def frame(self, *, edge, sharp):
                self.position = (self.position + 1) % len(images)
                return frames[edge, sharp][self.position]

        with TemporaryDirectory() as tmp:
            desktop_db, device_db = Path(tmp) / "desktop", Path(tmp) / "viewer"
            native = RecordingDesktop()
            desktop = create_app("desktop", native, device_store=desktop_db, primary_capture=ScrollingScreen(b""))
            viewer = create_app("viewer", RecordingDesktop(), device_store=device_db, primary_capture=Screen(b""))
            async with AsyncExitStack() as stack:
                relay = await stack.enter_async_context(TestServer(relay_app()))
                desktop_site = await stack.enter_async_context(TestServer(desktop))
                viewer_site = await stack.enter_async_context(TestServer(viewer))
                address = str(relay.make_url("/")).rstrip("/")
                a, b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
                update(desktop_db, "save", dict(listen=a, dial=b, name="Controller", address=address, grant="control"))
                update(device_db, "save", dict(listen=b, dial=a, name="PC", platform="Windows", address=address, grant=""))
                browser = await launch_browser(stack)
                laptop = await open_device(browser, desktop_site, address, "PC", "Windows", "desktop")
                controller = os.environ.get("REMOTE_DESKTOP_PLATFORM", "Android")
                page = await open_device(browser, viewer_site, address, "Controller", controller, "viewer")
                await laptop.evaluate("""async () => {
                    const { Relay } = await import('/relay.mjs');
                    const send = Relay.prototype.sendImage;
                    window.relayFrames = [];
                    Relay.prototype.sendImage = function(id, bytes, parts) {
                        window.relayFrames.push([bytes[0], bytes.length]);
                        return send.call(this, id, bytes, parts);
                    };
                    const original = window.createImageBitmap;
                    window.hostDecodes = 0;
                    window.createImageBitmap = (...args) => {
                        window.hostDecodes++;
                        return original(...args);
                    };
                }""")
                await page.evaluate("""() => {
                    localStorage.setItem('rc-video-smooth', 'on');
                    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
                    window.painted = [];
                    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
                        if (this.canvas.id === 'picture') window.painted.push(this.canvas.width);
                        return drawImage.apply(this, args);
                    };
                }""")
                await page.locator("#remembered button").first.click()
                await page.locator("#action-connect").click()
                canvas = page.locator("#picture")
                await page.wait_for_function("() => document.querySelector('#picture').width === 2560", timeout=25000)

                async def scroll():
                    return await canvas.evaluate("""async (canvas) => {
                        const rect = canvas.getBoundingClientRect();
                        const start = painted.length;
                        const timer = setInterval(() => canvas.dispatchEvent(new WheelEvent('wheel', {
                            bubbles: true, cancelable: true, deltaY: 54,
                            clientX: rect.left + rect.width / 2,
                            clientY: rect.top + rect.height / 2
                        })), 38);
                        await new Promise(done => setTimeout(done, 3000));
                        clearInterval(timer);
                        return painted.slice(start);
                    }""")

                full = await scroll()
                self.assertGreaterEqual(len(full), 3)
                self.assertEqual(set(full), {2560})
                packets = await laptop.evaluate("window.relayFrames")
                patches = [size for marker, size in packets if marker == 0x55]
                self.assertTrue(patches, packets[:12])
                self.assertLess(max(patches), len(frames[3840, True][0]) // 5)
                print(f"Full JPEG {len(frames[3840, True][0]):,} bytes; largest row update {max(patches):,} bytes.", flush=True)
                self.assertFalse(native.wheel.empty())
                await expect(page.locator("#smooth-scroll")).to_have_count(0)
                await page.locator("#quality").evaluate("""(field) => {
                    field.value = '1920';
                    field.dispatchEvent(new Event('change'));
                }""")
                await page.wait_for_function("() => document.querySelector('#picture').width === 1920", timeout=25000)
                lower = await scroll()
                self.assertGreaterEqual(len(lower), 3)
                self.assertEqual(set(lower), {1920})
                self.assertEqual(await laptop.evaluate("window.hostDecodes"), 0)
                print(f"{controller}: {len(full)} frames at 2560px and {len(lower)} at 1920px over 3s each. "
                      "The host did not decode either stream.", flush=True)

    async def test_phone_switches_monitors_and_clicks_the_visible_screen(self):
        primary = Monitor("main", (0, 0, 640, 360), True)
        hdmi = Monitor("hdmi", (-480, 0, 0, 640))

        class TwoScreens(Screen):
            windows_screenshots = True
            screenshots = []
            monitors = [primary, hdmi]

            def displays(self):
                return self.monitors

            async def screenshot(self, mode, monitor):
                self.screenshots.append((mode, monitor.id))
                return "Uniway_screenshot.png" if mode == "save" else None

            async def frame(self, *, edge, sharp, monitor=None):
                if monitor is None:
                    monitor = self.monitors[0]
                return jpeg(Image.new("RGB", monitor.size, "green" if monitor.primary else "red"))

        class DesktopWithMonitors(RecordingDesktop):
            def apply(self, event, monitor=None):
                super().apply(dict(event, monitor=monitor.id if monitor else None))

        with TemporaryDirectory() as tmp:
            desktop_db, phone_db = Path(tmp) / "desktop", Path(tmp) / "phone"
            native, screens = DesktopWithMonitors(), TwoScreens(b"")
            host = create_app("desktop", native, device_store=desktop_db, primary_capture=screens)
            viewer = create_app("phone", RecordingDesktop(), device_store=phone_db, primary_capture=Screen(b""))
            async with AsyncExitStack() as stack:
                relay = await stack.enter_async_context(TestServer(relay_app()))
                laptop = await stack.enter_async_context(TestServer(host))
                handset = await stack.enter_async_context(TestServer(viewer))
                address = str(relay.make_url("/")).rstrip("/")
                a, b = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
                update(desktop_db, "save", dict(listen=a, dial=b, name="Phone", platform="Android", address=address, grant="control"))
                update(phone_db, "save", dict(listen=b, dial=a, name="PC", platform="Windows", address=address, grant=""))
                browser = await launch_browser(stack)
                await open_device(browser, laptop, address, "PC", "Windows", "desktop")
                phone = await open_device(browser, handset, address, "Phone", "Android", "phone")
                await phone.locator("#remembered button").first.click()
                await phone.locator("#action-connect").click()
                button = phone.locator("#switch-display")
                picture = phone.locator("#picture")
                await expect(button).to_have_text("螢幕 1 / 2")
                await phone.wait_for_function("() => document.querySelector('#picture').width === 640")
                for width, height in [(1280, 720), (360, 640), (800, 360), (640, 240)]:
                    await phone.set_viewport_size({"width": width, "height": height})
                    await phone.locator("#video-menu summary").click()
                    panel = await phone.locator(".video-options").bounding_box()
                    rail = await phone.locator(".viewer-bar").bounding_box()
                    self.assertGreaterEqual(panel["x"], 0)
                    self.assertGreaterEqual(panel["y"], 0)
                    self.assertLessEqual(panel["x"] + panel["width"], rail["x"])
                    self.assertLessEqual(panel["y"] + panel["height"], height)
                    self.assertGreaterEqual(rail["y"], 39)
                    self.assertTrue(await phone.evaluate(
                        "() => document.elementFromPoint(innerWidth-15, 15).id === 'picture'"))
                    await phone.locator("#video-menu summary").click()
                await phone.set_viewport_size({"width": 360, "height": 420})
                await phone.locator("#video-menu summary").click()
                await phone.locator("#view-scale").select_option("native")
                await phone.locator("#video-menu summary").click()
                pan = phone.locator("#pan-view")
                await expect(pan).to_be_visible()
                await pan.click(position={"x": 2, "y": 10})
                await phone.wait_for_function("() => document.querySelector('#screen-viewport').scrollLeft === 0")
                await phone.mouse.click(80, 210)
                async with asyncio.timeout(5):
                    while (event := await native.events.get())["kind"] != "button" or not event["down"]:
                        pass
                self.assertAlmostEqual(event["x"], 80 / 640, places=2)
                self.assertAlmostEqual(event["y"], 0.5, places=2)
                await pan.press("ArrowRight")
                await phone.wait_for_function("() => document.querySelector('#screen-viewport').scrollLeft > 0")
                await phone.locator("#video-menu summary").click()
                await phone.locator("#view-scale").select_option("fit")
                await phone.locator("#video-menu summary").click()
                await expect(pan).to_be_hidden()
                await phone.set_viewport_size({"width": 1000, "height": 640})
                await button.click()
                await expect(button).to_have_text("螢幕 2 / 2")
                await phone.wait_for_function("""() => {
                    const canvas = document.querySelector('#picture');
                    return canvas.height === 640 &&
                      canvas.getContext('2d').getImageData(10,10,1,1).data[0] > 220;
                }""")
                await picture.click()
                async with asyncio.timeout(5):
                    while (event := await native.events.get())["kind"] != "button" or not event["down"]:
                        pass
                self.assertEqual(event["monitor"], "hdmi")
                menu = phone.locator("#screenshot-menu summary")
                notice = phone.locator("#screenshot-status")
                await menu.click()
                await phone.locator("#save-screenshot").click()
                await expect(notice).to_contain_text("Uniway_screenshot.png")
                await asyncio.sleep(0.7)
                await menu.click()
                await phone.locator("#open-snip").click()
                await expect(notice).to_contain_text("請在遠端 Windows 畫面框選")
                await asyncio.sleep(0.7)
                await phone.keyboard.press("Control+Alt+Shift+S")
                await expect(notice).to_contain_text("Uniway_screenshot.png")
                expected = [("save", "hdmi"), ("snip", "hdmi"), ("save", "hdmi")]
                if os.environ.get("REMOTE_BROWSER", "chromium") == "chromium":
                    await asyncio.sleep(0.7)
                    await notice.evaluate("(notice) => { notice.textContent = ''; }")
                    await phone.keyboard.press("PrintScreen")
                    await expect(notice).to_contain_text("Uniway_screenshot.png")
                    expected.append(("save", "hdmi"))
                self.assertEqual(screens.screenshots, expected)
                screens.monitors = [primary]
                await expect(button).to_be_hidden()
                await phone.wait_for_function("() => document.querySelector('#picture').width === 640")
                await expect(phone.locator("#first-picture")).to_be_hidden()

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
                read = """() => {
                    const sample = document.createElement('canvas');
                    sample.width = 256;
                    sample.height = 64;
                    sample.getContext('2d').drawImage(document.querySelector('#picture'), 32, 32, 256, 64, 0, 0, 256, 64);
                    return sample.toDataURL('image/png').split(',')[1];
                }"""

                async def sample_image():
                    pixels = b64decode(await phone.evaluate(read))
                    with Image.open(BytesIO(pixels)) as image:
                        return image.convert("RGB")

                def text_error(image):
                    return sum(ImageStat.Stat(ImageChops.difference(source.crop(sample), image)).mean)/3
                sharp_pixels = await sample_image()
                self.assertGreater(len(encoded[3840, True]), 340000)
                await phone.locator("#detail-quality").select_option("balanced")
                await desktop.wait_for_function("() => window.testCaptureRequest?.sharp === false")
                async with asyncio.timeout(25):
                    while True:
                        standard_pixels = await sample_image()
                        if text_error(standard_pixels) > text_error(sharp_pixels) + 2:
                            break
                        await asyncio.sleep(0.1)
                await phone.locator("#quality").select_option("1280")
                await phone.locator("#fps").select_option("60")
                await desktop.wait_for_function("() => window.testCaptureRequest?.fps === 60 && window.testCaptureRequest.edge === 1280")
                await phone.wait_for_function("() => document.querySelector('#picture').width === 1280", timeout=20000)
                self.assertEqual(await phone.locator("#picture").evaluate("c=>c.height"), 800)
                await expect(phone.locator("#stats")).to_contain_text("1280 × 800")
                await expect(phone.locator("#stats")).to_contain_text("fps · 中繼 JPEG")
                print(f"Desktop JPEG {len(encoded[3840, True]):,} bytes, decoded 2560x1600 to 1280x800. "
                      f"Colored-text mean error {text_error(sharp_pixels):.2f} clear vs {text_error(standard_pixels):.2f} standard.")
