"""Same-origin WebRTC signaling with per-viewer desktop consent."""

import asyncio
from collections import deque
from dataclasses import dataclass
import hmac
import ipaddress
import json
import logging
import os
import platform
import socket
from pathlib import Path
import secrets
import subprocess
from time import monotonic

from aiohttp import web, WSMsgType


WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_PEERS = 16
APPROVAL_SECONDS = 120
LOG = logging.getLogger(__name__)


def is_loopback(address):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return ip.is_loopback or bool(getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped.is_loopback)


def matches(provided, expected):
    return isinstance(provided, str) and provided.isascii() and bool(expected) and hmac.compare_digest(provided, expected)


@dataclass
class Peer:
    id: str
    name: str
    socket: web.WebSocketResponse
    requested: float
    approved: bool = False
    control: bool = False
    allow_privacy: bool = False
    focus_task: object = None
    screenshot_after: float = 0.0


async def send(socket, kind, **fields):
    if socket is not None and not socket.closed:
        try:
            await socket.send_json({"type": kind, **fields})
        except (ConnectionError, RuntimeError):
            # The socket read loop performs the same cleanup on transport loss.
            pass


async def error(socket, message, **fields):
    await send(socket, "error", error=message, message=message, **fields)


class Room:
    def __init__(self, token, desktop, ice_servers, primary_capture=None):
        self.token = token
        self.desktop = desktop
        self.ice_servers = ice_servers
        self.last_capture = 0.0
        self.primary_capture = primary_capture
        self.monitors = {}
        self.frame_task = None
        self.host = None
        self.code = None
        self.peers = {}
        self.privacy = False
        self.connections = set()
        self.attempts = {}
        self.cleanup_tasks = set()
        self.screenshot_task = None

    @property
    def windows_screenshots(self):
        return getattr(self.primary_capture, "windows_screenshots", False) is True

    async def take_screenshot(self, peer, mode, monitor):
        if self.peers.get(peer.id) is not peer or not peer.control:
            return
        try:
            filename = await self.primary_capture.screenshot(mode, monitor)
        except (OSError, RuntimeError, ValueError):
            LOG.exception("Failed to capture a local Windows screenshot")
            message = ("無法開啟 Windows 截圖工具。" if mode == "snip" else
                       "無法把截圖存到 Windows。請確認電腦畫面和截圖資料夾可以使用。")
            await send(peer.socket, "screenshot-result", error=message)
        else:
            await send(peer.socket, "screenshot-result", mode=mode, filename=filename)

    def finish_disconnect(self, operation):
        # A dropped TCP connection can cancel its aiohttp request handler
        # while other viewers still need notifications and display cleanup.
        task = asyncio.create_task(operation)
        self.cleanup_tasks.add(task)
        task.add_done_callback(self.cleanup_tasks.discard)
        return asyncio.shield(task)

    def can_connect(self, address):
        now = monotonic()
        attempts = self.attempts.setdefault(address, deque())
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 40 or len(self.connections) >= 64:
            return False
        attempts.append(now)
        return True

    def release_control(self):
        try:
            self.desktop.release()
        except (OSError, RuntimeError, ValueError):
            LOG.exception("Could not release held input")
        if self.privacy:
            try:
                self.desktop.set_privacy(False)
                self.privacy = False
            except (OSError, RuntimeError, ValueError):
                LOG.exception("Could not restore the display")

    async def remove_peer(self, peer, *, reason="left"):
        if self.peers.pop(peer.id, None) is None:
            return
        if peer.focus_task: peer.focus_task.cancel()
        host = self.host
        private = self.privacy
        if not any(p.approved for p in self.peers.values()):
            await self.stop_capture()
        if peer.control:
            self.release_control()
        await asyncio.gather(send(peer.socket, reason, id=peer.id), send(host, reason, id=peer.id))
        if private and not self.privacy:
            await send(host, "privacy", enabled=False)
        await peer.socket.close()

    async def end_host(self, host):
        if self.host is not host:
            return
        self.host = None
        self.code = None
        peers = list(self.peers.values())
        self.peers.clear()
        for p in peers:
            if p.focus_task: p.focus_task.cancel()
        await self.stop_capture()
        self.release_control()
        await asyncio.gather(*(send(p.socket, "left", id=p.id) for p in peers))
        await asyncio.gather(*(p.socket.close() for p in peers))

    async def privacy_request(self, message):
        enabled = message.get("enabled")
        host = self.host
        reason = None
        if not isinstance(enabled, bool):
            reason = "隱私模式設定無效。"
        elif enabled and not (self.desktop.capabilities.get("privacy") and
                              any(p.control and p.allow_privacy for p in self.peers.values())):
            reason = "開啟隱私模式需要支援的螢幕，以及一台已獲准控制並使用隱私模式的裝置。"
        else:
            try:
                self.desktop.set_privacy(enabled)
                self.privacy = enabled
            except (OSError, ValueError, RuntimeError) as exc:
                reason = str(exc)
        await send(host, "privacy", enabled=self.privacy, **({"error": reason} if reason else {}))

    def display_state(self):
        try:
            monitors = self.primary_capture.displays() if hasattr(self.primary_capture, "displays") else []
        except (OSError, RuntimeError):
            monitors = []
        self.monitors = {monitor.id: monitor for monitor in monitors}
        return [{"id": monitor.id, "primary": monitor.primary} for monitor in monitors]

    async def capture_frame(self, host, fps, edge, sharp, monitor, frame):
        try:
            await asyncio.sleep(max(0, self.last_capture + 1/fps - monotonic()))
            self.last_capture = monotonic()
            profile = {"edge": edge, "sharp": sharp}
            if monitor is not None:
                profile["monitor"] = monitor
            data = await self.primary_capture.frame(**profile)
            if host is self.host and any(p.approved for p in self.peers.values()):
                if frame:
                    data = frame.to_bytes(4, "big") + data
                self.frame_task = None
                await host.send_bytes(data)
        except (RuntimeError, OSError, EOFError, TimeoutError, subprocess.SubprocessError) as exc:
            if host is self.host:
                await send(host, "capture-error", frame=frame, message=str(exc) or "無法擷取主螢幕。",
                           reason="permission" if isinstance(exc, PermissionError) else "unavailable")

    async def stop_capture(self):
        if self.frame_task is not None:
            self.frame_task.cancel()
            await asyncio.gather(self.frame_task, return_exceptions=True)
            self.frame_task = None
        if self.primary_capture is not None:
            await self.primary_capture.stop()

    async def check_keyboard(self, peer, serial):
        await asyncio.sleep(0.12)
        try:
            editable = await asyncio.to_thread(self.desktop.editable_focus)
        except (OSError,RuntimeError):
            editable = False
        if self.peers.get(peer.id) is peer and peer.control:
            await send(peer.socket,"keyboard",editable=editable,serial=serial)

    async def host_message(self, message):
        host = self.host
        kind = message.get("type")
        if kind == "capabilities":
            return await send(host, "capabilities", capabilities=self.desktop.capabilities, screens=self.display_state())
        if kind == "primary-frame":
            if self.primary_capture and any(p.approved for p in self.peers.values()):
                frame = message.get("frame", 0)
                if type(frame) is not int or not 0 <= frame <= 0xffffffff:
                    return
                if self.frame_task is None or self.frame_task.done():
                    edge = message.get("edge")
                    if edge not in (960, 1280, 1920, 2560, 3840):
                        edge = 1920
                    fps = 60 if message.get("fps") == 60 else 30
                    screen = message.get("screen")
                    monitor = self.monitors.get(screen) if isinstance(screen, str) else None
                    if screen is not None and monitor is None:
                        return await send(host, "screen-changed", frame=frame, screens=self.display_state())
                    self.frame_task = asyncio.create_task(self.capture_frame(
                        host, fps, int(edge), message.get("sharp") is True, monitor, frame))
                elif frame:
                    return await send(host, "capture-busy", frame=frame)
            return
        if kind == "privacy":
            return await self.privacy_request(message)
        peer_id = message.get("id")
        peer = self.peers.get(peer_id) if isinstance(peer_id, str) else None
        if peer is None:
            return await error(host, "這台裝置已離線。")
        if kind == "leave" or (kind == "deny" and not peer.approved):
            return await self.finish_disconnect(self.remove_peer(peer, reason="denied" if kind == "deny" else "left"))
        if kind == "approve" and not peer.approved:
            control = message.get("control", False)
            if not isinstance(control, bool):
                return await error(host, "控制權設定無效。", id=peer.id)
            if control and (not self.desktop.capabilities.get("control") or
                            any(p.control for p in self.peers.values())):
                return await error(host, "目前無法授予控制權。請確認主機支援遠端輸入，且其他裝置已結束控制。",
                                   id=peer.id, code="control-unavailable", capabilities=self.desktop.capabilities)
            peer.approved, peer.control = True, control
            peer.allow_privacy = control and message.get("allowPrivacy") is True
            fields = {"id": peer.id, "control": control, "iceServers": self.ice_servers}
            await asyncio.gather(send(host, "approved", **fields), send(peer.socket, "approved", **fields))
        elif kind == "signal" and peer.approved and isinstance(message.get("data"), dict):
            await send(peer.socket, "signal", id=peer.id, data=message["data"])
        elif kind == "screenshot":
            mode, screen = message.get("mode"), message.get("screen")
            if not (peer.control and self.windows_screenshots and mode in ("save", "snip")):
                return await send(peer.socket, "screenshot-result", error="這個連線無法在 Windows 截圖。")
            monitor = self.monitors.get(screen) if isinstance(screen, str) else None
            if screen is not None and monitor is None:
                return await send(peer.socket, "screenshot-result", error="選取的螢幕已離線。")
            now = monotonic()
            if now < peer.screenshot_after or (self.screenshot_task and not self.screenshot_task.done()):
                return await send(peer.socket, "screenshot-result", error="請稍候再截圖。")
            peer.screenshot_after = now + 0.65
            self.screenshot_task = asyncio.create_task(self.take_screenshot(peer, mode, monitor))
        elif kind == "input" and peer.control and isinstance(message.get("event"), dict):
            try:
                event = message["event"]
                screen = message.get("screen")
                if screen is None:
                    self.desktop.apply(event)
                elif isinstance(screen, str) and screen in self.monitors:
                    self.desktop.apply(event, self.monitors[screen])
                else:
                    return
                serial = event.get("tap")
                if (event.get("kind") == "button" and event.get("down") is False and type(serial) is int
                        and 0 < serial <= 2147483647 and self.desktop.capabilities.get("keyboard")):
                    if peer.focus_task: peer.focus_task.cancel()
                    peer.focus_task = asyncio.create_task(self.check_keyboard(peer, serial))
            except (OSError, ValueError, RuntimeError) as exc:
                await error(host, str(exc), id=peer.id)
        else:
            await error(host, "此裝置的權限無法執行這個操作。", id=peer.id)

    async def viewer_message(self, peer, message):
        if message.get("id") != peer.id:
            return await error(peer.socket, "連線識別碼無效。")
        if message.get("type") == "leave":
            return await self.finish_disconnect(self.remove_peer(peer))
        if peer.approved and message.get("type") == "signal" and isinstance(message.get("data"), dict):
            return await send(self.host, "signal", id=peer.id, data=message["data"])
        await error(peer.socket, "目前無法執行這個操作。", id=peer.id)

    async def sweep(self):
        while True:
            await asyncio.sleep(1)
            now = monotonic()
            for address, attempts in list(self.attempts.items()):
                if not attempts or attempts[-1] < now - 60:
                    self.attempts.pop(address, None)
            if self.privacy and not self.desktop.privacy_enabled:
                self.privacy = False
                await send(self.host, "privacy", enabled=False)
            if self.privacy and not any(p.control for p in self.peers.values()):
                self.release_control()
            expired = [p for p in self.peers.values() if not p.approved and now - p.requested > APPROVAL_SECONDS]
            await asyncio.gather(*(self.remove_peer(p, reason="denied") for p in expired))

    async def websocket(self, request):
        if request.headers.get("Origin") != f"{request.scheme}://{request.host}":
            raise web.HTTPForbidden(text="請直接在瀏覽器分頁中開啟主機網址。")
        if not self.can_connect(request.remote):
            raise web.HTTPTooManyRequests(text="連線過於頻繁，請在一分鐘後再試。")
        socket = web.WebSocketResponse(heartbeat=20, max_msg_size=96 * 1024, timeout=2, compress=False)
        await socket.prepare(request)
        self.connections.add(socket)
        peer = None
        try:
            first = await asyncio.wait_for(socket.receive(), timeout=10)
            message = decode(first)
            if message is None:
                return socket
            if (message.get("type") == "host" and self.host is None and
                    is_loopback(request.remote) and matches(message.get("token"), self.token)):
                self.host = socket
                self.code = secrets.token_urlsafe(12)
                await send(socket, "hosted", code=self.code, capabilities=self.desktop.capabilities,
                           iceServers=self.ice_servers, primaryCapture=self.primary_capture is not None,
                           screens=self.display_state(), captureSequence=True,
                           windowsScreenshots=self.windows_screenshots)
            elif (message.get("type") == "join" and self.host is not None and
                  matches(message.get("code"), self.code) and len(self.peers) < MAX_PEERS):
                name = message.get("name")
                if not isinstance(name, str) or not name.strip() or len(name) > 64:
                    await error(socket, "裝置名稱須為 1 至 64 個字。")
                    return socket
                peer = Peer(secrets.token_urlsafe(12), name.strip(), socket, monotonic())
                self.peers[peer.id] = peer
                host = self.host
                fields = {"capabilities": self.desktop.capabilities} if self.primary_capture and is_loopback(request.remote) else {}
                await send(socket, "pending", id=peer.id, **fields)
                await send(host, "request", id=peer.id, name=peer.name)
            else:
                await error(socket, "無法配對。請確認主機已開啟分享、邀請碼正確，且仍有空位。")
                return socket
            window_start = monotonic()
            count = 0
            async for frame in socket:
                message = decode(frame)
                if message is None:
                    await error(socket, "訊息格式錯誤。")
                    break
                now = monotonic()
                if now - window_start >= 1:
                    window_start, count = now, 0
                count += 1
                if count > (600 if self.host is socket else 120):
                    await error(socket, "訊息過於頻繁，連線已中止。")
                    break
                if self.host is socket:
                    await self.host_message(message)
                elif peer and self.peers.get(peer.id) is peer:
                    await self.viewer_message(peer, message)
                else:
                    break
        except (TimeoutError, ConnectionError):
            pass
        finally:
            self.connections.discard(socket)
            if self.host is socket:
                await self.finish_disconnect(self.end_host(socket))
            elif peer:
                await self.finish_disconnect(self.remove_peer(peer))
            await socket.close()
        return socket


def decode(frame):
    if frame.type != WSMsgType.TEXT:
        return None
    try:
        message = json.loads(frame.data)
    except (ValueError, RecursionError):
        return None
    return message if isinstance(message, dict) else None


@web.middleware
async def headers(request, handler):
    response = await handler(request)
    if not response.prepared:
        online = request.path == "/online.html"
        connections = "'self' wss: ws://localhost:* ws://127.0.0.1:*" if online else "'self'"
        response.headers.update({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                       f"img-src 'self' data: blob:; media-src 'self' blob:; connect-src {connections}; "
                                       "object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        })
    return response


def create_app(token, desktop, ice_servers=None, web_dir=WEB_DIR, *, device_store=None, primary_capture=None, updater=None):
    room = Room(token, desktop, ice_servers or [], primary_capture)
    app = web.Application(middlewares=[headers])

    def require_local_host(request):
        if (not is_loopback(request.remote) or request.headers.get("Origin") != f"{request.scheme}://{request.host}"
                or not matches(request.headers.get("X-Host-Token"), token)):
            raise web.HTTPForbidden()

    if primary_capture is not None and platform.system() == "Darwin":
        from native.macos import running_app
        relaunching = False

        def quit_after_response():
            raise web.GracefulExit()

        async def mac_permissions(request):
            nonlocal relaunching
            require_local_host(request)
            data = await request.json()
            action = data.get("action") if isinstance(data, dict) else None
            if action not in ("check", "request", "relaunch"):
                raise web.HTTPBadRequest()
            try:
                if action == "relaunch":
                    bundle = running_app()
                    if not bundle:
                        raise ValueError("請從原本的終端機重新啟動程式。")
                    if not relaunching:
                        relaunching = True
                        try:
                            await asyncio.to_thread(subprocess.run, ["/usr/bin/open", "-n", str(bundle)], check=True, timeout=10)
                        except (OSError, subprocess.SubprocessError):
                            relaunching = False
                            raise
                        asyncio.get_running_loop().call_later(1, quit_after_response)
                    return web.json_response({"relaunching": True})
                if action == "request":
                    await asyncio.to_thread(desktop.request_control)
                return web.json_response(desktop.mac_permissions())
            except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
                return web.json_response({"error": str(exc)}, status=400)

        app.router.add_post("/api/mac-permissions", mac_permissions)
    if device_store is not None:
        from .pairings import update
        async def paired_devices(request):
            require_local_host(request)
            try:
                data = await request.json()
                if not isinstance(data, dict):
                    raise ValueError("裝置資料無效")
                if data.get("action") == "self":
                    return web.json_response({"name": socket.gethostname()[:48], "platform": platform.system(),
                                              "relay": os.environ.get("REMOTE_RELAY_URL", "")})
                devices = await asyncio.to_thread(update, device_store, data.get("action"), data.get("item", {}))
            except ValueError as error:
                raise web.HTTPBadRequest(text=str(error))
            return web.json_response(devices)
        app.router.add_post("/api/paired", paired_devices)
    if updater is not None:
        async def software_update(request):
            require_local_host(request)
            try:
                payload = await request.json()
                action = payload.get("action") if isinstance(payload, dict) else None
                result = await updater.run(action, lambda: bool(room.peers))
            except (ValueError, OSError, KeyError, TypeError) as exc:
                return web.json_response({"error": str(exc)}, status=400)
            return web.json_response(result)
        app.router.add_post("/api/update", software_update)
    app.router.add_get("/ws", room.websocket)
    async def index(_):
        return web.FileResponse(web_dir / "index.html")

    app.router.add_get("/", index)
    app.router.add_static("/", web_dir, show_index=False)

    async def housekeeping(_):
        task = asyncio.create_task(room.sweep())
        try:
            yield
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def stop(_):
        if room.host is not None:
            await room.end_host(room.host)
        await asyncio.gather(*(ws.close() for ws in list(room.connections)))
        if room.cleanup_tasks:
            await asyncio.gather(*list(room.cleanup_tasks))
        if room.screenshot_task:
            await room.screenshot_task
        room.release_control()

    app.cleanup_ctx.append(housekeeping)
    app.on_shutdown.append(stop)
    return app
