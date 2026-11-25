import asyncio
import tempfile
import unittest
from pathlib import Path
from socket import SHUT_RDWR
from unittest.mock import patch

from aiohttp import WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from server.app import create_app
from server.__main__ import ice_configuration


class DesktopStub:
    capabilities = {"control": True, "privacy": True, "width": 1920, "height": 1080}

    def __init__(self):
        self.events = []
        self.releases = 0
        self.privacy_enabled = False

    def apply(self, event):
        self.events.append(event)

    def release(self):
        self.releases += 1

    def set_privacy(self, enabled):
        self.privacy_enabled = enabled


class SignalingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.desktop = DesktopStub()
        self.assets = tempfile.TemporaryDirectory()
        self.addCleanup(self.assets.cleanup)
        self.ice = [{"urls": "stun:example.test:3478"}]
        self.client = TestClient(TestServer(create_app("admin", self.desktop, self.ice, Path(self.assets.name))))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def socket(self):
        return await self.client.ws_connect("/ws", origin=str(self.client.make_url("/").origin()))

    async def host(self):
        host = await self.socket()
        await host.send_json({"type": "host", "token": "admin"})
        hosted = await self.expect(host, "hosted")
        self.assertEqual(hosted["capabilities"], self.desktop.capabilities)
        return host, hosted["code"]

    async def expect(self, socket, kind):
        message = await socket.receive_json(timeout=5)
        self.assertEqual(message["type"], kind, message)
        return message

    async def join(self, host, code):
        viewer = await self.socket()
        await viewer.send_json({"type": "join", "code": code, "name": "Tablet"})
        pending = await self.expect(viewer, "pending")
        request = await self.expect(host, "request")
        self.assertEqual(request["id"], pending["id"])
        return viewer, request["id"]

    async def approve(self, host, viewer, peer_id, control, allow_privacy=True):
        await host.send_json({"type": "approve", "id": peer_id, "control": control, "allowPrivacy": allow_privacy})
        approved = await self.expect(viewer, "approved")
        self.assertEqual(approved, await self.expect(host, "approved"))
        self.assertEqual(approved["iceServers"], self.ice)
        self.assertEqual(approved["control"], control)

    async def test_busy_desktop_capture_replies_with_the_request_number(self):
        started, finish = asyncio.Event(), asyncio.Event()
        picture = bytes.fromhex("ffd8ffd9")

        class SlowCapture:
            async def frame(self, *, edge, sharp):
                started.set()
                await finish.wait()
                return picture

            async def stop(self):
                pass

        self.client = TestClient(TestServer(create_app(
            "admin", self.desktop, self.ice, Path(self.assets.name), primary_capture=SlowCapture())))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        await self.approve(host, viewer, peer, False)
        await host.send_json({"type": "primary-frame", "frame": 10})
        await asyncio.wait_for(started.wait(), 5)
        await host.send_json({"type": "primary-frame", "frame": 11})
        self.assertEqual((await self.expect(host, "capture-busy"))["frame"], 11)
        finish.set()
        self.assertEqual(await host.receive_bytes(timeout=5), (10).to_bytes(4, "big") + picture)
        await host.send_json({"type": "primary-frame", "frame": 11})
        self.assertEqual(await host.receive_bytes(timeout=5), (11).to_bytes(4, "big") + picture)
        await host.send_json({"type": "primary-frame"})
        self.assertEqual(await host.receive_bytes(timeout=5), picture)

    async def test_two_viewers_and_one_controller(self):
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        controller, master = await self.join(host, code)
        event = {"kind": "wheel", "dx": 0.75, "dy": 0.5}
        await viewer.send_json({"type": "signal", "id": peer, "data": {"candidate": {}}})
        await self.expect(viewer, "error")
        await host.send_json({"type": "input", "id": master, "event": event})
        await self.expect(host, "error")
        await self.approve(host, controller, master, True)
        await host.send_json({"type": "approve", "id": peer, "control": True})
        await self.expect(host, "error")
        await self.approve(host, viewer, peer, False)
        await viewer.send_json({"type": "signal", "id": master, "data": {"candidate": {}}})
        await self.expect(viewer, "error")
        await host.send_json({"type": "input", "id": peer, "event": event})
        await self.expect(host, "error")
        await controller.send_json({"type": "input", "id": master, "event": event})
        await self.expect(controller, "error")
        self.assertEqual(self.desktop.events, [])
        await host.send_json({"type": "input", "id": master, "event": event})
        signal = {"type": "signal", "id": master, "data": {"description": {"type": "offer"}}}
        await host.send_json(signal)
        self.assertEqual(await self.expect(controller, "signal"), signal)
        self.assertEqual(self.desktop.events, [event])
        await host.send_json({"type": "privacy", "enabled": True})
        self.assertTrue((await self.expect(host, "privacy"))["enabled"])
        await controller.close()
        self.assertEqual((await self.expect(host, "left"))["id"], master)
        self.assertFalse((await self.expect(host, "privacy"))["enabled"])
        self.assertFalse(self.desktop.privacy_enabled)
        self.assertEqual(self.desktop.releases, 1)
        signal.update(id=peer, data={"candidate": {"candidate": "test"}})
        await viewer.send_json(signal)
        self.assertEqual(await self.expect(host, "signal"), signal)

    async def test_disconnect_rotates_invite_and_restores_privacy(self):
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        await self.approve(host, viewer, peer, True)
        await host.send_json({"type": "privacy", "enabled": True})
        await self.expect(host, "privacy")
        await host.close()
        self.assertEqual((await self.expect(viewer, "left"))["id"], peer)
        self.assertFalse(self.desktop.privacy_enabled)
        host, next_code = await self.host()
        self.assertNotEqual(code, next_code)
        stale = await self.socket()
        await stale.send_json({"type": "join", "code": code, "name": "old"})
        await self.expect(stale, "error")

    async def test_abrupt_controller_loss_restores_host(self):
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        await self.approve(host, viewer, peer, True)
        await host.send_json({"type": "privacy", "enabled": True})
        await self.expect(host, "privacy")
        # Simulate a tablet losing Wi-Fi without a WebSocket close frame.
        viewer.get_extra_info("socket").shutdown(SHUT_RDWR)
        self.assertEqual((await self.expect(host, "left"))["id"], peer)
        self.assertFalse((await self.expect(host, "privacy"))["enabled"])
        self.assertEqual(self.desktop.releases, 1)

    async def test_denied_and_expired_connections(self):
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        await host.send_json({"type": "deny", "id": peer})
        self.assertEqual(await self.expect(host, "denied"), await self.expect(viewer, "denied"))
        with patch("server.app.APPROVAL_SECONDS", 0):
            stale, _ = await self.join(host, code)
            await self.expect(stale, "denied")
            await self.expect(host, "denied")

    async def test_control_requires_separate_privacy_permission(self):
        host, code = await self.host()
        viewer, peer = await self.join(host, code)
        await self.approve(host, viewer, peer, True, allow_privacy=False)
        await host.send_json({"type": "privacy", "enabled": True})
        self.assertIn("error", await self.expect(host, "privacy"))
        self.assertFalse(self.desktop.privacy_enabled)

    async def test_emergency_privacy_release(self):
        host, code = await self.host()
        await host.send_json({"type": "privacy", "enabled": True})
        self.assertIn("error", await self.expect(host, "privacy"))
        viewer, peer = await self.join(host, code)
        await self.approve(host, viewer, peer, True)
        await host.send_json({"type": "privacy", "enabled": True})
        await self.expect(host, "privacy")
        self.desktop.privacy_enabled = False
        self.assertFalse((await self.expect(host, "privacy"))["enabled"])

    async def test_host_secret_loopback_and_origin(self):
        for origin in (None, "https://other.test"):
            with self.assertRaises(WSServerHandshakeError) as exc:
                await self.client.ws_connect("/ws", origin=origin)
            self.assertEqual(exc.exception.status, 403)
        socket = await self.socket()
        await socket.send_json({"type": "host", "token": "wrong"})
        await self.expect(socket, "error")
        with patch("server.app.is_loopback", return_value=False):
            socket = await self.socket()
            await socket.send_json({"type": "host", "token": "admin"})
            await self.expect(socket, "error")
        await self.host()
        other = await self.socket()
        await other.send_json({"type": "host", "token": "admin"})
        await self.expect(other, "error")

    def test_ice_configuration(self):
        self.assertEqual(ice_configuration('[{"urls":["turn:relay.test"]}]'), [{"urls": ["turn:relay.test"]}])
        for bad in ('5', '[{}]', '[{"urls": []}]', '[{"urls": "https://example.test"}]'):
            with self.assertRaises(ValueError):
                ice_configuration(bad)
