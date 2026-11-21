"""Run the shipped executable, verify its LAN CA, bundled assets, and authenticated WSS."""
import argparse
import asyncio
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import subprocess
import tempfile
import time

from aiohttp import ClientSession, ClientTimeout


async def verify(port, root, token):
    tls = ssl.create_default_context(cafile=str(root))
    base = f"https://127.0.0.1:{port}"
    async with ClientSession(timeout=ClientTimeout(total=10)) as client:
        for asset in ("/", "/app.mjs", "/input.mjs", "/style.css"):
            async with client.get(base + asset, ssl=tls) as response:
                response.raise_for_status()
                if not await response.read():
                    raise RuntimeError(f"Empty packaged asset {asset}")
        async with client.ws_connect(base + "/ws", ssl=tls, origin=base) as ws:
            await ws.send_json({"type": "host", "token": token})
            hosted = await ws.receive_json(timeout=5)
            if hosted.get("type") != "hosted" or not hosted.get("code"):
                raise RuntimeError("Packaged server did not open an authenticated host room")


def smoke(executable):
    with tempfile.TemporaryDirectory() as tmp:
        state = Path(tmp) / "state"
        address = "192.0.2.13"  # TLS identity only. Test traffic uses loopback.
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        path = Path(tmp) / "launcher.log"
        with open(path, "wb") as output:
            proc = subprocess.Popen(
                [str(executable), "--address", address, "--port", str(port),
                 "--state-dir", str(state), "--no-browser"],
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
            )
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    log = path.read_bytes()
                    # Fragments stay local. Never print the link or token in CI logs.
                    match = re.search(rb"/#host=([\w-]+)\r?\n", log)
                    if proc.poll() is not None:
                        diagnostic = re.sub(rb"/#host=[\w-]+", b"/#host=[redacted]", log)
                        raise RuntimeError(diagnostic.decode("utf-8", errors="replace"))
                    if match:
                        break
                    time.sleep(0.1)
                else:
                    raise TimeoutError("Packaged host did not start within 60 seconds")
                asyncio.run(verify(port, state / address / "trusted-root.crt", match[1].decode("ascii")))
            finally:
                if proc.poll() is None:
                    if os.name == "nt":
                        # One-file PyInstaller uses a parent bootloader and a child process.
                        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                                       check=True, stdout=subprocess.DEVNULL)
                    else:
                        os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=10)
    print("Packaged host passed TLS, static assets, and authenticated WebSocket checks.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    smoke(parser.parse_args().executable.resolve(strict=True))
