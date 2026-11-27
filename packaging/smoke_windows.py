"""Run the shipped desktop executable in LAN mode and with its usual local port occupied."""
import argparse
import asyncio
from contextlib import contextmanager
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout


async def verify(base, token, assets, tls=True):
    async with ClientSession(timeout=ClientTimeout(total=10)) as client:
        for asset in assets:
            async with client.get(base + asset, ssl=tls) as response:
                response.raise_for_status()
                if not await response.read():
                    raise RuntimeError(f"Empty packaged asset {asset}")
        async with client.ws_connect(base + "/ws", ssl=tls, origin=base) as ws:
            await ws.send_json({"type": "host", "token": token})
            hosted = await ws.receive_json(timeout=5)
            if hosted.get("type") != "hosted" or not hosted.get("code"):
                raise RuntimeError("Packaged server did not open an authenticated host room")


@contextmanager
def running_host(executable, args, log_path):
    with log_path.open("wb") as output:
        proc = subprocess.Popen(
            [str(executable), "--no-browser", *args],
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt",
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                log = log_path.read_bytes()
                if proc.poll() is not None:
                    diagnostic = re.sub(rb"#host=[\w-]+", b"#host=[redacted]", log)
                    raise RuntimeError(diagnostic.decode("utf-8", errors="replace"))
                match = re.search(rb"(https?://\S+?#host=[\w-]+)\r?\n", log)
                if match:
                    yield urlsplit(match[1].decode("ascii"))
                    return
                time.sleep(0.1)
            raise TimeoutError("Packaged host did not start within 60 seconds")
        finally:
            if proc.poll() is None:
                if os.name == "nt":
                    # One-file PyInstaller uses a parent bootloader and a child process.
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                   check=True, stdout=subprocess.DEVNULL)
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=10)


def smoke(executable):
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state"
        path = Path(tmp) / "launcher.log"
        address = "192.0.2.13"  # TLS identity only. Test traffic uses loopback.
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        args = ["--address", address, "--port", str(port), "--state-dir", str(state)]
        with running_host(executable, args, path) as url:
            assert url.scheme == "https" and url.port == port and url.path == "/"
            tls = ssl.create_default_context(cafile=str(state / address / "trusted-root.crt"))
            asyncio.run(verify(f"https://127.0.0.1:{port}", url.fragment.removeprefix("host="),
                               ["/", "/app.mjs", "/input.mjs", "/style.css"], tls))

        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 8443))
            occupied.listen()
            with running_host(executable, [], path) as url:
                assert url.scheme == "http" and url.hostname == "127.0.0.1"
                assert url.port and url.port != 8443 and url.path == "/online.html"
                asyncio.run(verify(f"http://{url.netloc}", url.fragment.removeprefix("host="),
                                   [url.path, "/online.mjs", "/relay.mjs"]))
    print("Packaged host passed LAN TLS, occupied-port fallback, assets, and WebSocket checks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    smoke(parser.parse_args().executable.resolve(strict=True))
