"""Run with: python -m unittest discover -s tests -p browser_smoke.py -v"""
import asyncio
from contextlib import AsyncExitStack
import json
import os
import secrets
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from aiohttp.test_utils import TestServer
from playwright.async_api import async_playwright, expect

from server.app import create_app
from server.__main__ import ice_configuration


class RecordingDesktop:
    """Receives inputs at the same boundary as the production OS adapter."""

    capabilities = {"control": True, "privacy": False, "width": 320, "height": 180}
    privacy_enabled = False

    def __init__(self):
        self.events = asyncio.Queue()
        self.wheel = asyncio.Queue()
        self.released = asyncio.Event()

    def apply(self, event):
        self.events.put_nowait(event)
        if event["kind"] == "wheel":
            self.wheel.put_nowait(event)

    def release(self):
        self.released.set()


# Replace only the OS screen chooser in the host page. The video encoding,
# transport, decoding, pairing flow and input data channel all run normally.
CANVAS_CAPTURE = """
navigator.mediaDevices.getDisplayMedia = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  let frame = 0;
  function draw() {
    ctx.fillStyle = '#10c850';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#f09030';
    ctx.fillRect(frame++ % 300, 0, 20, 20);
  }
  draw();
  const timer = setInterval(draw, 60);
  const stream = canvas.captureStream(16);
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings.bind(track);
  track.getSettings = () => ({...settings(), displaySurface: 'monitor'});
  window.testCapture = track;
  window.addEventListener('pagehide', () => clearInterval(timer));
  return stream;
};
"""


async def check_decoded_video(page):
    # Verify a recognizable source pixel after multiple decoded frames.
    await page.wait_for_function("""() => {
      const video = document.getElementById('screen');
      if (video.videoWidth !== 320 || video.videoHeight !== 180 ||
          video.getVideoPlaybackQuality().totalVideoFrames < 2 || video.readyState < 2) return false;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 160, 90, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return g > 145 && r < 70 && b < 135;
    }""", timeout=20_000)


async def request_viewer(browser, url, host, name, code):
    viewer = await browser.new_page()
    await viewer.goto(url)
    await viewer.locator("#name").fill(name)
    await viewer.locator("#code").fill(code)
    await viewer.locator("#join").click()
    row = host.locator("#devices > li").filter(has_text=name)
    await expect(row).to_be_visible()
    await expect(viewer.locator("#session")).to_be_hidden()
    return viewer, row


class BrowserSmoke(unittest.IsolatedAsyncioTestCase):
    async def test_consent_stream_input_and_cleanup(self):
        desktop = RecordingDesktop()
        token = secrets.token_urlsafe(32)
        ice = ice_configuration(os.environ.get("REMOTE_ICE_SERVERS", "[]"))
        server = TestServer(create_app(token, desktop, ice))
        async with server, async_playwright() as playwright, AsyncExitStack() as sessions:
            browser = await sessions.enter_async_context(await playwright.chromium.launch(
                executable_path=os.environ.get("CHROMIUM_EXECUTABLE") or None,
                args=["--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                      "--allow-loopback-in-peer-connection"],
            ))
            url = str(server.make_url("/"))
            host = await browser.new_page()
            # Install the ephemeral host credential without logging an invite URL.
            await host.add_init_script("history.replaceState(null, '', " + json.dumps("#host=" + token) + ");")
            await host.add_init_script(CANVAS_CAPTURE)
            await host.goto(url)
            await host.locator("#start").click()
            await expect(host.locator("#invite")).to_be_visible()
            code = await host.locator("#invite-code").input_value()
            await host.locator("#allow-control").check()

            rejected, row = await request_viewer(browser, url, host, "Denied", code)
            await row.get_by_role("button", name="拒絕").click()
            await expect(rejected.locator("#notice")).to_contain_text("未同意")
            self.assertTrue(await rejected.locator("#screen").evaluate("v => v.srcObject === null"))

            controller, row = await request_viewer(browser, url, host, "Controller", code)
            await row.get_by_role("button", name="允許操作").click()
            observer, observer_row = await request_viewer(browser, url, host, "Observer", code)
            await observer_row.get_by_role("button", name="允許觀看").click()
            try:
                await asyncio.gather(check_decoded_video(controller), check_decoded_video(observer))
            except Exception:
                for page in (host, controller, observer):
                    print(await page.evaluate("""() => {
                      const v = document.querySelector(document.querySelector('#host').hidden ? '#screen' : '#local-screen');
                      return {status: document.querySelector('#status').textContent,
                              notice: document.querySelector('#notice').textContent, w:v.videoWidth,
                              h:v.videoHeight, ready:v.readyState, frames:v.getVideoPlaybackQuality().totalVideoFrames};
                    }"""))
                raise
            await expect(controller.locator("#input-hint")).to_be_visible()
            await expect(observer.locator("#input-hint")).to_be_hidden()
            await expect(host.locator("#count")).to_have_text("2")

            # Inject the fractional wheel event a touchpad-capable browser emits.
            # Pixel values must survive browser → WebRTC → host → server intact.
            await controller.locator("#screen").evaluate("""v => {
              const rect = v.getBoundingClientRect();
              v.dispatchEvent(new WheelEvent('wheel', {
                cancelable: true, clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2, deltaX: -0.25, deltaY: 2.5
              }));
            }""")
            wheel = await asyncio.wait_for(desktop.wheel.get(), timeout=5)
            self.assertEqual((wheel["dx"], wheel["dy"]), (-0.25, 2.5))
            self.assertAlmostEqual(wheel["x"], 0.5, delta=0.01)
            self.assertAlmostEqual(wheel["y"], 0.5, delta=0.01)

            # The Android wrapper bypasses DOM wheel only when this hook accepts
            # the hardware event. A viewer without control has no such hook.
            await controller.bring_to_front()
            await controller.locator("#screen").scroll_into_view_if_needed()
            accepted = await controller.locator("#screen").evaluate("""v => {
              const rect = v.getBoundingClientRect();
              const port = window.visualViewport;
              return window.remoteControlAndroidWheel(
                (rect.left + rect.width / 2 - port.offsetLeft) / port.width,
                (rect.top + rect.height / 2 - port.offsetTop) / port.height,
                0.125 / port.width, -1.5 / port.height
              );
            }""")
            self.assertTrue(accepted)
            hardware_wheel = await asyncio.wait_for(desktop.wheel.get(), timeout=5)
            self.assertAlmostEqual(hardware_wheel["dx"], 0.125)
            self.assertAlmostEqual(hardware_wheel["dy"], -1.5)
            self.assertTrue(await observer.evaluate("window.remoteControlAndroidWheel === undefined"))

            await row.get_by_role("button", name="中斷連線").click()
            await expect(controller.locator("#session")).to_be_hidden()
            self.assertTrue(await controller.evaluate("window.remoteControlAndroidWheel === undefined"))
            await asyncio.wait_for(desktop.released.wait(), timeout=5)
            await expect(host.locator("#count")).to_have_text("1")
            await expect(observer.locator("#session")).to_be_visible()
            frames = await observer.locator("#screen").evaluate("v => v.getVideoPlaybackQuality().totalVideoFrames")
            await observer.wait_for_function(
                "n => document.querySelector('#screen').getVideoPlaybackQuality().totalVideoFrames > n", arg=frames
            )

            await host.locator("#stop").click()
            await expect(observer.locator("#session")).to_be_hidden()
            self.assertTrue(await observer.locator("#screen").evaluate("v => v.srcObject === null"))
            self.assertEqual(await host.evaluate("window.testCapture.readyState"), "ended")
            await expect(host.locator("#count")).to_have_text("0")


class InternetRelaySmoke(unittest.IsolatedAsyncioTestCase):
    async def test_two_apps_use_only_outbound_relay_for_approved_screen_and_input(self):
        from relay.__main__ import create_app as relay_app
        desktop = RecordingDesktop()
        secret = secrets.token_urlsafe(32)
        state = TemporaryDirectory()
        self.addCleanup(state.cleanup)
        host_db, viewer_db = (Path(state.name) / n for n in ("host.db","viewer.db"))
        from io import BytesIO
        from PIL import Image

        class Display:
            def __init__(self):
                self.frames = 0
                with BytesIO() as out:
                    Image.new("RGB", (320,180), (16,200,80)).save(out, format="JPEG")
                    self.jpeg = out.getvalue()
            async def frame(self):
                self.frames += 1
                return self.jpeg
            async def stop(self): pass

        screen = Display()
        desktop.capabilities = {**desktop.capabilities, "keyboard": True}
        desktop.editable_focus = lambda: True
        async with TestServer(relay_app()) as relay, TestServer(create_app(secret, desktop, device_store=host_db, primary_capture=screen)) as sharing, \
                TestServer(create_app("viewer-only", RecordingDesktop(), device_store=viewer_db, primary_capture=Display())) as viewing, async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE") or None,
                args=["--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
            try:
                host = await browser.new_page()
                viewer = await browser.new_page(viewport={"width": 400, "height": 800}, is_mobile=True, has_touch=True)
                address = json.dumps(str(relay.make_url("/")).rstrip("/"))
                for page in (host, viewer):
                    await page.add_init_script("localStorage.setItem('rc-relay'," + address + ")")

                # Simulate a pair of networks where no direct media path is possible.
                await host.add_init_script("window.RTCPeerConnection = undefined")
                await viewer.add_init_script("window.RTCPeerConnection = undefined")
                await host.goto(str(sharing.make_url("/online.html")) + "#host=" + secret)
                await expect(host.locator("#invitation")).to_be_visible()
                invite = await host.locator("#invite").input_value()
                self.assertRegex(invite, r"^[0-9]{4}$")
                await viewer.goto(str(viewing.make_url("/online.html"))+"#host=viewer-only")
                await viewer.locator("nav [data-page=settings]").click()
                await viewer.locator("#name").fill("測試平板")
                await viewer.locator("nav [data-page=connect]").click()
                await viewer.locator("#code").fill(invite)
                # The fourth digit submits the pairing request.
                await expect(host.get_by_role("button", name="允許操作")).to_be_visible()
                await expect(viewer.locator("#stage")).to_be_hidden()
                self.assertEqual(screen.frames, 0)
                await host.get_by_role("button", name="允許操作").click()
                await viewer.wait_for_function("""() => {const c=document.querySelector('#picture');
                    return c.width===320 && c.getContext('2d').getImageData(160,90,1,1).data[1]>155}""")
                box = await viewer.locator("#picture").bounding_box()
                self.assertEqual((box["width"],box["height"]), (400,800))
                await viewer.keyboard.press("a")
                key = await asyncio.wait_for(desktop.events.get(),5)
                self.assertEqual((key["kind"],key["code"],key["down"]),("key","KeyA",True))
                await desktop.events.get()
                await viewer.touchscreen.tap(300,400)
                tap = await asyncio.wait_for(desktop.events.get(),5)
                self.assertEqual((tap["kind"], tap["down"]), ("button",True))
                self.assertAlmostEqual(tap["x"], 0.75, places=2)
                self.assertAlmostEqual(tap["y"], 0.5, places=2)
                await expect(viewer.locator("#ime")).to_be_focused()
                await viewer.keyboard.insert_text("你好")
                while True:
                    received = await asyncio.wait_for(desktop.events.get(),5)
                    if received["kind"] == "text": break
                self.assertEqual(received["text"],"你好")
                await viewer.keyboard.press("Escape")
                await viewer.locator("#video-menu summary").click()
                await viewer.locator("#quality").select_option("1280")
                await viewer.locator("#fps").select_option("60")
                await viewer.locator("#video-menu summary").click()
                await viewer.locator("#picture").evaluate("""c=>{
                    const r=c.getBoundingClientRect();
                    c.dispatchEvent(new WheelEvent('wheel',{cancelable:true,clientX:r.left+r.width/2,
                      clientY:r.top+r.height/2,deltaY:1.25,deltaX:-0.5}));}""")
                event = await asyncio.wait_for(desktop.wheel.get(), timeout=5)
                self.assertEqual((event["dx"],event["dy"]),(-0.5,1.25))
                await host.locator("#stop").click()
                await expect(viewer.locator("#stage")).to_be_hidden()
                await asyncio.wait_for(desktop.released.wait(),timeout=5)
                # Start a fresh session after reloading both dashboards and reconnect by name.
                await host.goto("about:blank")
                await host.goto(str(sharing.make_url("/online.html")) + "#host=" + secret)
                await viewer.goto("about:blank")
                await viewer.goto(str(viewing.make_url("/online.html"))+"#host=viewer-only")
                await expect(host.locator("#invitation")).to_be_visible()
                await expect(viewer.locator("#code")).to_have_value("")
                await viewer.locator("#remembered button").first.click()
                await viewer.locator("#action-connect").click()
                await expect(host.get_by_role("button",name="中斷連線")).to_be_visible()
                await expect(host.get_by_role("button",name="允許操作")).to_have_count(0)
                await expect(host.locator("#status")).to_contain_text("遠端操作中")
                await expect(viewer.locator("#stage")).to_be_visible()
                await host.locator("#stop").click()
                await expect(viewer.locator("#stage")).to_be_hidden()
                # The same pairing also works in reverse without entering a new PIN.
                await viewer.goto("about:blank")
                await viewer.goto(str(viewing.make_url("/online.html")) + "#host=viewer-only")
                await viewer.locator("#self").click()
                await expect(viewer.locator("#invitation")).to_be_visible()
                await host.locator("#remembered button").first.click()
                await host.locator("#action-connect").click()
                await viewer.get_by_role("button",name="允許觀看").click()
                await expect(host.locator("#stage")).to_be_visible()

            finally:
                await browser.close()


class UpdateScreenSmoke(unittest.IsolatedAsyncioTestCase):
    async def test_launch_checks_then_user_starts_install_from_desktop(self):
        class Updater:
            def __init__(self):
                self.calls = []
            async def run(self, action, busy):
                self.calls.append(action)
                if action == "install":
                    return {"installing": True}
                return {"current":"0.4.0", "latest":"0.5.0", "available":True}
        updater = Updater()
        async with TestServer(create_app("test-console", RecordingDesktop(), updater=updater)) as server, async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path=os.environ.get("CHROMIUM_EXECUTABLE") or None)
            try:
                page = await browser.new_page()
                await page.goto(str(server.make_url("/online.html")) + "#host=test-console")
                await page.locator("nav [data-page=settings]").click()
                await expect(page.locator("#update-status")).to_contain_text("0.5.0")
                await page.get_by_role("button", name="檢查更新").click()
                await expect(page.locator("#update-status")).to_contain_text("0.5.0")
                await page.get_by_role("button",name="立即更新").click()
                await expect(page.locator("#update-status")).to_contain_text("已開啟安裝程式")
                self.assertEqual(updater.calls,["check","check","install"])
                response = await page.request.post(str(server.make_url("/api/update")),data={"action":"install"})
                self.assertEqual(response.status,403)
            finally:
                await browser.close()
