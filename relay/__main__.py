"""Forward bounded, opaque application packets between outbound WebSockets."""
import asyncio
from collections import deque
from dataclasses import dataclass, field
import os
import re
import secrets
import struct
import time

from aiohttp import WSMsgType, web

ROOM = re.compile(r"[0-9a-f]{32}")
NONCE = re.compile(r"[0-9a-f]{32}")
MAX_PACKET = 384 * 1024


@dataclass
class Room:
    host: web.WebSocketResponse
    viewers: dict = field(default_factory=dict)


def create_app():
    rooms, sockets, attempts = {}, set(), {}
    boot = time.monotonic()
    cleanups = set()

    async def disconnect(room, key, peer, ws):
        sockets.discard(ws)
        if room and room.host is ws:
            rooms.pop(key, None)
            viewers = list(room.viewers.items())
            await asyncio.gather(*(v.send_json({"t": "left", "id": i}) for i, v in viewers), return_exceptions=True)
            await asyncio.gather(*(v.close() for _, v in viewers), return_exceptions=True)
        elif room and peer is not None:
            room.viewers.pop(peer, None)
            if not room.host.closed:
                try:
                    await room.host.send_json({"t": "left", "id": peer})
                except (ConnectionError, RuntimeError):
                    pass
        await ws.close()

    async def socket_handler(request):
        now = time.monotonic()
        address = request.remote
        # Render terminates TLS and appends the originating address to X-Forwarded-For.
        if os.environ.get("RENDER"):
            address = request.headers.get("X-Forwarded-For", address or "").split(",")[-1].strip()
        for ip in list(attempts):
            if not attempts[ip] or attempts[ip][-1] < now - 60:
                del attempts[ip]
        recent = attempts.setdefault(address, deque())
        while recent and recent[0] < now - 60:
            recent.popleft()
        if len(recent) >= 60 or len(sockets) >= 180:
            raise web.HTTPTooManyRequests()
        recent.append(now)
        ws = web.WebSocketResponse(max_msg_size=MAX_PACKET, heartbeat=25, compress=False, timeout=2)
        await ws.prepare(request)
        sockets.add(ws)
        room = key = peer = None
        try:
            hello = await ws.receive_json(timeout=12)
            if not isinstance(hello, dict):
                return ws
            key = hello.get("room")
            if not isinstance(key, str) or not ROOM.fullmatch(key):
                return ws
            if hello.get("role") == "host" and key not in rooms:
                room = rooms[key] = Room(ws)
                await ws.send_json({"t": "ready"})
            elif hello.get("role") == "viewer" and key in rooms:
                nonce = hello.get("nonce")
                room = rooms[key]
                if not isinstance(nonce, str) or not NONCE.fullmatch(nonce) or len(room.viewers) >= 8:
                    return ws
                peer = secrets.randbelow(2**32 - 1) + 1
                while peer in room.viewers:
                    peer = secrets.randbelow(2**32 - 1) + 1
                room.viewers[peer] = ws
                await ws.send_json({"t": "waiting", "id": peer})
                await room.host.send_json({"t": "join", "id": peer, "nonce": nonce})
            else:
                await ws.send_json({"t": "unavailable"})
                return ws
            epoch, count, volume = time.monotonic(), 0, 0
            async for msg in ws:
                moment = time.monotonic()
                if moment - epoch >= 1:
                    epoch, count, volume = moment, 0, 0
                count += 1
                volume += len(msg.data) if isinstance(msg.data, (bytes, str)) else 0
                if count > (550 if peer is None else 350) or volume > (5_000_000 if peer is None else 250_000):
                    break
                if msg.type == WSMsgType.BINARY and len(msg.data) >= 21:
                    dest = struct.unpack_from(">I", msg.data)[0]
                    if peer is not None and dest != peer:
                        break
                    target = room.viewers.get(dest) if peer is None else room.host
                    if target and not target.closed:
                        try:
                            await asyncio.wait_for(target.send_bytes(msg.data), 2)
                        except (ConnectionError, TimeoutError):
                            await target.close()
                elif msg.type == WSMsgType.TEXT and peer is None:
                    command = msg.json()
                    if not isinstance(command, dict) or type(command.get("id")) is not int:
                        break
                    target = room.viewers.get(command["id"])
                    if not target or target.closed:
                        continue
                    if command.get("t") == "hello" and isinstance(command.get("nonce"), str) and NONCE.fullmatch(command["nonce"]):
                        await target.send_json({"t": "hello", "nonce": command["nonce"], "id": command["id"]})
                    elif command.get("t") == "drop":
                        await target.close()
                    else:
                        break
                else:
                    break
        except (ValueError, TypeError, KeyError, ConnectionError, TimeoutError, RuntimeError):
            pass
        finally:
            task = asyncio.create_task(disconnect(room, key, peer, ws))
            cleanups.add(task)
            task.add_done_callback(cleanups.discard)
            await asyncio.shield(task)
        return ws

    async def health(_):
        return web.json_response({"service": "remote-control", "protocol": 1, "uptime": int(time.monotonic() - boot)})

    async def close(_):
        await asyncio.gather(*(s.close() for s in list(sockets)), return_exceptions=True)
        await asyncio.gather(*list(cleanups), return_exceptions=True)

    app = web.Application()
    async def downloads(_):
        raise web.HTTPFound("https://github.com/blizzard-new/remote_control/releases/latest")

    app.router.add_get("/", downloads)
    app.router.add_get("/health", health)
    app.router.add_get("/v1/session", socket_handler)
    app.on_shutdown.append(close)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("PORT", "10000")), access_log=None)
